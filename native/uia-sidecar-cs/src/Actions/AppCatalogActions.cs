// AppCatalogActions.cs — listApps 动作：已安装应用枚举（registry Uninstall ∪ 开始菜单 .lnk）
// 规划定论（.devteam/02-longtask-plan.md Q1）：HKLM 64/32 双视图 + Start Menu .lnk（WScript.Shell 解析目标），
// 按规范化 exePath ∪ DisplayName 去重，registry 优先。冷枚举目标 <2s。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace UiaSidecar
{
    /// <summary>侧车 JSON 参数提取公共工具（NDJSON 单行报文，Program.ExtractParam 不做转义还原，路径参数必须走这里）。</summary>
    public static class JsonExtract
    {
        /// <summary>还原 JSON 字符串转义（\\" \\\\ \\/ \\n \\uXXXX 等）。</summary>
        public static string Unescape(string raw)
        {
            if (raw == null || raw.Length == 0) return raw ?? "";
            if (raw.IndexOf('\\') < 0) return raw;
            var sb = new StringBuilder(raw.Length);
            for (int i = 0; i < raw.Length; i++)
            {
                char c = raw[i];
                if (c != '\\' || i + 1 >= raw.Length) { sb.Append(c); continue; }
                i++;
                char e = raw[i];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 < raw.Length)
                        {
                            int code;
                            if (int.TryParse(raw.Substring(i + 1, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                            {
                                sb.Append((char)code);
                                i += 4;
                            }
                            else { sb.Append(e); }
                        }
                        else { sb.Append(e); }
                        break;
                    default: sb.Append(e); break;
                }
            }
            return sb.ToString();
        }

        /// <summary>取 "key":"value" 字符串参数（正确跨越转义引号并还原转义）。</summary>
        public static string StringParam(string line, string key, string dflt)
        {
            int i = line.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (i < 0) return dflt;
            int colon = line.IndexOf(':', i + key.Length + 2);
            if (colon < 0) return dflt;
            int p = colon + 1;
            while (p < line.Length && (line[p] == ' ' || line[p] == '\t')) p++;
            if (p >= line.Length || line[p] != '"') return dflt;
            int e = p + 1;
            while (e < line.Length)
            {
                if (line[e] == '\\') { e += 2; continue; }
                if (line[e] == '"') break;
                e++;
            }
            if (e >= line.Length) return dflt;
            return Unescape(line.Substring(p + 1, e - p - 1));
        }

        /// <summary>取 "key":number 数字参数。</summary>
        public static int IntParam(string line, string key, int dflt)
        {
            int i = line.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (i < 0) return dflt;
            int colon = line.IndexOf(':', i + key.Length + 2);
            if (colon < 0) return dflt;
            int p = colon + 1;
            while (p < line.Length && (line[p] == ' ' || line[p] == '\t')) p++;
            int end = p;
            while (end < line.Length && (char.IsDigit(line[end]) || line[end] == '-')) end++;
            if (end == p) return dflt;
            int v;
            return int.TryParse(line.Substring(p, end - p), out v) ? v : dflt;
        }

        /// <summary>取 "key":["a","b"] 字符串数组参数（逐串还原转义，非字符串元素跳过）。</summary>
        public static List<string> StringArray(string line, string key)
        {
            var list = new List<string>();
            int i = line.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (i < 0) return list;
            int open = line.IndexOf('[', i);
            if (open < 0) return list;
            int close = line.IndexOf(']', open);
            if (close < 0) return list;
            int p = open + 1;
            while (p < close)
            {
                int q = line.IndexOf('"', p);
                if (q < 0 || q >= close) break;
                int e = q + 1;
                while (e < close)
                {
                    if (line[e] == '\\') { e += 2; continue; }
                    if (line[e] == '"') break;
                    e++;
                }
                if (e >= close) break;
                list.Add(Unescape(line.Substring(q + 1, e - q - 1)));
                p = e + 1;
            }
            return list;
        }

        /// <summary>稳定标识：sha1(规范化 exePath) 小写 hex（规划 §2.1：跨重启可对账）。</summary>
        public static string AppId(string exePath)
        {
            using (var sha = SHA1.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(NormalizePath(exePath)));
                var sb = new StringBuilder(40);
                foreach (byte b in hash) sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
        }

        public static string NormalizePath(string p)
        {
            if (string.IsNullOrEmpty(p)) return "";
            return p.Trim().ToLowerInvariant().Replace('/', '\\');
        }
    }

    public static class AppCatalogActions
    {
        private const string UNINSTALL_KEY = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
        private const int MAX_LNK_DEPTH = 8;

        private sealed class AppEntry
        {
            public string Id = "";
            public string Name = "";
            public string ExePath = "";
            public string LnkPath = "";
            public string DisplayIcon = "";
            public string Source = "registry";
            public long Mtime;
            public long Size;
        }

        /// <summary>listApps {} → {ok, apps:[{id,name,exePath,lnkPath?,displayIcon?,mtime,size,source}], ms}</summary>
        public static string ListApps(string payload)
        {
            var sw = StopwatchStart();
            var apps = new List<AppEntry>();
            var seenPath = new HashSet<string>(StringComparer.Ordinal);
            var seenName = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            ReadUninstallView(RegistryView.Registry64, apps, seenPath, seenName);
            ReadUninstallView(RegistryView.Registry32, apps, seenPath, seenName);
            ScanStartMenu(apps, seenPath, seenName);

            var sb = new StringBuilder(apps.Count * 120 + 64);
            sb.Append("{\"ok\":true,\"count\":").Append(apps.Count)
              .Append(",\"ms\":").Append(ElapsedMs(sw))
              .Append(",\"apps\":[");
            for (int i = 0; i < apps.Count; i++)
            {
                if (i > 0) sb.Append(',');
                AppendEntryJson(sb, apps[i]);
            }
            sb.Append("]}");
            return sb.ToString();
        }

        private static void AppendEntryJson(StringBuilder sb, AppEntry e)
        {
            sb.Append("{\"id\":\"").Append(Json.Escape(e.Id))
              .Append("\",\"name\":\"").Append(Json.Escape(e.Name))
              .Append("\",\"exePath\":\"").Append(Json.Escape(e.ExePath))
              .Append("\",\"source\":\"").Append(Json.Escape(e.Source))
              .Append("\",\"mtime\":").Append(e.Mtime.ToString(CultureInfo.InvariantCulture))
              .Append(",\"size\":").Append(e.Size.ToString(CultureInfo.InvariantCulture));
            if (e.LnkPath.Length > 0) sb.Append(",\"lnkPath\":\"").Append(Json.Escape(e.LnkPath)).Append('"');
            if (e.DisplayIcon.Length > 0) sb.Append(",\"displayIcon\":\"").Append(Json.Escape(e.DisplayIcon)).Append('"');
            sb.Append('}');
        }

        // ---- registry：HKLM Uninstall 双视图 ----

        private static void ReadUninstallView(RegistryView view, List<AppEntry> apps,
            HashSet<string> seenPath, HashSet<string> seenName)
        {
            try
            {
                using (RegistryKey baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                using (RegistryKey root = baseKey.OpenSubKey(UNINSTALL_KEY))
                {
                    if (root == null) return;
                    foreach (string sub in root.GetSubKeyNames())
                    {
                        try
                        {
                            using (RegistryKey k = root.OpenSubKey(sub))
                            {
                                if (k != null) ReadUninstallEntry(k, apps, seenPath, seenName);
                            }
                        }
                        catch { /* 单键异常（权限/损坏）跳过，不影响整体枚举 */ }
                    }
                }
            }
            catch { /* 视图不存在（如 32 位视图缺失）跳过 */ }
        }

        private static void ReadUninstallEntry(RegistryKey k, List<AppEntry> apps,
            HashSet<string> seenPath, HashSet<string> seenName)
        {
            var name = k.GetValue("DisplayName") as string;
            if (string.IsNullOrEmpty(name) || name.Trim().Length == 0) return;
            if (k.GetValue("SystemComponent") as int? == 1) return;               // 系统组件/补丁
            var parent = k.GetValue("ParentDisplayName") as string;
            if (!string.IsNullOrEmpty(parent)) return;                            // Windows/Office 补丁子项
            var release = (k.GetValue("ReleaseType") as string ?? "").ToLowerInvariant();
            if (release.Contains("security update") || release == "hotfix" || release == "updatedefinitions") return;
            name = name.Trim();
            // 卸载器入口不是可启动应用（与 AddLnkEntry 的 Uninstall 前缀规则对齐；中文机多为「卸载X」，含无空格形态）
            if (name.StartsWith("Uninstall", StringComparison.OrdinalIgnoreCase)
                || name.StartsWith("卸载") || name.StartsWith("Remove", StringComparison.OrdinalIgnoreCase)) return;

            string exePath = ResolveRegistryExe(k, name);
            if (exePath.Length == 0) return;                                      // 无落盘可执行文件的路径不进选择器
            if (IsUninstallerPath(exePath)) return;                               // 名字正常但目标就是 uninst.exe
            string keyPath = JsonExtract.NormalizePath(exePath);
            if (!seenPath.Add(keyPath)) return;
            if (!seenName.Add(name)) return;

            var e = NewEntry(name, exePath, "registry");
            e.DisplayIcon = k.GetValue("DisplayIcon") as string ?? "";
            apps.Add(e);
        }

        /// <summary>exePath = DisplayIcon（去 ",index" 后缀）或 InstallLocation 下同名 exe；均须实际存在且为可启动 GUI 载体。</summary>
        private static string ResolveRegistryExe(RegistryKey k, string name)
        {
            string icon = (k.GetValue("DisplayIcon") as string ?? "").Trim();
            string candidate = StripIconIndex(icon);
            if (candidate.Length > 0 && File.Exists(candidate) && IsLaunchable(candidate)) return candidate;
            string loc = (k.GetValue("InstallLocation") as string ?? "").Trim().Trim('"');
            if (loc.Length > 0 && Directory.Exists(loc))
            {
                string guess = Path.Combine(loc, name + ".exe");
                if (File.Exists(guess)) return guess;
            }
            return "";
        }

        /// <summary>
        /// 选择器只收可启动的 GUI 载体：exe / lnk / ClickOnce 入口。
        /// DisplayIcon 很多指向 setup.bat、.msi、.url 之类脚本或安装包——Agent 无法用
        /// UIA 驱动控制台窗口，看门狗的 pid→exe 锚定也会落在 conhost 上，收进来全是噪音，
        /// 因此一律剔除（2026-09-14 用户反馈"bat 都扫出来了"后定下的过滤口径）。
        /// </summary>
        internal static bool IsLaunchable(string path)
        {
            string ext = Path.GetExtension(path).ToLowerInvariant();
            return ext == ".exe" || ext == ".lnk" || ext == ".appref-ms";
        }

        /// <summary>卸载器判据（路径级，比显示名前缀可靠）：文件名含 uninst / 「卸载」即剔除。</summary>
        internal static bool IsUninstallerPath(string path)
        {
            string stem = Path.GetFileNameWithoutExtension(path).ToLowerInvariant();
            return stem.Contains("uninst") || stem.Contains("卸载");
        }

        private static string StripIconIndex(string displayIcon)
        {
            if (string.IsNullOrEmpty(displayIcon)) return "";
            string s = displayIcon.Trim().Trim('"');
            int comma = s.LastIndexOf(',');
            if (comma > 1 && s.IndexOf('.') < comma) // 逗号在小数点之后才算索引（路径含逗号不误伤）
            {
                int idx;
                if (int.TryParse(s.Substring(comma + 1), out idx)) s = s.Substring(0, comma);
            }
            return s.Trim().Trim('"');
        }

        // ---- Start Menu .lnk：两目录递归，WScript.Shell 解析目标 ----

        private static void ScanStartMenu(List<AppEntry> apps, HashSet<string> seenPath, HashSet<string> seenName)
        {
            var dirs = new List<string>();
            AddDir(dirs, Environment.SpecialFolder.CommonStartMenu, "Programs");
            AddDir(dirs, Environment.SpecialFolder.StartMenu, "Programs");
            object shell = null;
            try
            {
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                if (t != null) shell = Activator.CreateInstance(t);
            }
            catch { /* 无 WScript.Shell 时全部退化为 .lnk 路径本身 */ }

            foreach (string dir in dirs)
            {
                try { ScanLnkDir(dir, 0, apps, seenPath, seenName, shell); }
                catch { /* 目录不可读跳过 */ }
            }
        }

        private static void AddDir(List<string> dirs, Environment.SpecialFolder folder, string sub)
        {
            try
            {
                string p = Path.Combine(Environment.GetFolderPath(folder), sub);
                if (Directory.Exists(p)) dirs.Add(p);
            }
            catch { /* 特殊文件夹缺失（精简系统）忽略 */ }
        }

        private static void ScanLnkDir(string dir, int depth, List<AppEntry> apps,
            HashSet<string> seenPath, HashSet<string> seenName, object shell)
        {
            if (depth > MAX_LNK_DEPTH) return;
            foreach (string lnk in Directory.GetFiles(dir, "*.lnk"))
            {
                try { AddLnkEntry(lnk, apps, seenPath, seenName, shell); }
                catch { /* 单个快捷方式失败不影响整体 */ }
            }
            foreach (string child in Directory.GetDirectories(dir))
            {
                try { ScanLnkDir(child, depth + 1, apps, seenPath, seenName, shell); }
                catch { /* 子目录不可读跳过 */ }
            }
        }

        private static void AddLnkEntry(string lnk, List<AppEntry> apps,
            HashSet<string> seenPath, HashSet<string> seenName, object shell)
        {
            string name = Path.GetFileNameWithoutExtension(lnk);
            if (name.Length == 0 || name.StartsWith("Uninstall", StringComparison.OrdinalIgnoreCase)
                || name.Equals("Programs", StringComparison.OrdinalIgnoreCase)) return;

            string target = ResolveLnkTarget(shell, lnk);
            // 解析成功但目标是脚本/安装包 → 整个丢弃：回退启动 .lnk 本体等于照样启动 bat，噪音照旧
            if (target.Length > 0 && File.Exists(target))
            {
                if (!IsLaunchable(target) || IsUninstallerPath(target)) return;
            }
            string exePath = target.Length > 0 && File.Exists(target) ? target : lnk; // 解析失败回 .lnk 本体（openAppSafe 现成 lnk 分支）
            if (IsUninstallerPath(lnk) || IsUninstallerPath(exePath)) return; // 「卸载微信.lnk」「微信卸载.exe」等本体命名也命中
            string keyPath = JsonExtract.NormalizePath(exePath);
            if (!seenPath.Add(keyPath)) return;
            if (!seenName.Add(name)) return;

            var e = NewEntry(name, exePath, "startmenu");
            e.LnkPath = lnk;
            apps.Add(e);
        }

        private static string ResolveLnkTarget(object shell, string lnk)
        {
            if (shell == null) return "";
            try
            {
                dynamic sc = ((dynamic)shell).CreateShortcut(lnk);
                string tp = (string)sc.TargetPath;
                return tp ?? "";
            }
            catch { return ""; }
        }

        // ---- 工具 ----

        private static AppEntry NewEntry(string name, string exePath, string source)
        {
            var e = new AppEntry
            {
                Id = JsonExtract.AppId(exePath),
                Name = name,
                ExePath = exePath,
                Source = source,
            };
            try
            {
                if (File.Exists(exePath))
                {
                    var fi = new FileInfo(exePath);
                    e.Mtime = fi.LastWriteTimeUtc.Ticks / TimeSpan.TicksPerMillisecond;
                    e.Size = fi.Length;
                }
            }
            catch { /* 权限受限的 exe 只缺 mtime，不影响枚举 */ }
            return e;
        }

        private static DateTime StopwatchStart() { return DateTime.UtcNow; }
        private static long ElapsedMs(DateTime start)
        {
            return (long)(DateTime.UtcNow - start).TotalMilliseconds;
        }
    }
}
