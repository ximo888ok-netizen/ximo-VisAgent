// IconActions.cs — getAppIcon / getAppIcons 动作：提取应用图标 → PNG base64
// 规划定论（.devteam/02-longtask-plan.md Q2）：图标走 C# 侧车而非 koffi——System.Drawing 的
// using 块天然管理 GDI 资源；每批 ≤25 个串行处理，hIcon 句柄 finally 中 DestroyIcon，零泄漏。
// 呈现尺寸最大 24px 但高 DPI 屏 + 发糊投诉驱动：优先 PrivateExtractIcons 拉 .ico 内嵌大层
// （现代应用多为 256 PNG），再 HighQualityBicubic 降到请求尺寸；失败回退 SHGetFileInfo 32。
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace UiaSidecar
{
    public static class IconActions
    {
        private const uint SHGFI_ICON = 0x000000100;
        private const uint SHGFI_LARGEICON = 0x000000000;
        private const uint SHGFI_EXEICON = 0x000000400;
        private const int MAX_BATCH = 25;
        private const int DEFAULT_SIZE = 32;
        /** 源层提取边长：.ico 内嵌 256 PNG 层的现代应用直接吃到原分辨率，再降采样 */
        private const int PREFERRED_SOURCE_SIDE = 256;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        private struct SHFILEINFO
        {
            public IntPtr hIcon;
            public int iIcon;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szDisplayName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)]
            public string szTypeName;
        }

        [DllImport("shell32.dll", CharSet = CharSet.Auto)]
        private static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes,
            ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern uint PrivateExtractIcons(string lpszFileName, int nIconIndex,
            int cxIcon, int cyIcon, IntPtr[] phicon, uint[] piconid, uint nIcons, uint wFlags);

        [DllImport("user32.dll")]
        private static extern bool DestroyIcon(IntPtr hIcon);

        /// <summary>getAppIcon {exePath,size} → {ok, pngBase64} | {ok:false, error}</summary>
        public static string GetIcon(string payload)
        {
            string exePath = JsonExtract.StringParam(payload, "exePath", "");
            int size = ClampSize(JsonExtract.IntParam(payload, "size", DEFAULT_SIZE));
            if (exePath.Length == 0) return "{\"ok\":false,\"error\":\"bad exePath\"}";
            string png = ExtractPngBase64(exePath, size);
            if (png == null) return "{\"ok\":false,\"error\":\"icon extract failed: " + Json.Escape(exePath) + "\"}";
            return "{\"ok\":true,\"pngBase64\":\"" + png + "\"}";
        }

        /// <summary>getAppIcons {exePaths:[...],size} → {ok, icons:[{exePath, pngBase64?|error?}]}（≤25/批）</summary>
        public static string GetIcons(string payload)
        {
            int size = ClampSize(JsonExtract.IntParam(payload, "size", DEFAULT_SIZE));
            List<string> paths = JsonExtract.StringArray(payload, "exePaths");
            if (paths.Count > MAX_BATCH) paths = paths.GetRange(0, MAX_BATCH);
            var sb = new StringBuilder(paths.Count * 96 + 32);
            sb.Append("{\"ok\":true,\"icons\":[");
            for (int i = 0; i < paths.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append("{\"exePath\":\"").Append(Json.Escape(paths[i])).Append('"');
                string png = ExtractPngBase64(paths[i], size);
                if (png != null) sb.Append(",\"pngBase64\":\"").Append(png).Append('"');
                else sb.Append(",\"error\":\"extract failed\"");
                sb.Append('}');
            }
            sb.Append("]}");
            return sb.ToString();
        }

        /// <summary>提取成功回 PNG base64，失败回 null（前端字母图标兜底，永不出错）。GDI 句柄全部确定性释放。</summary>
        private static string ExtractPngBase64(string exePath, int size)
        {
            Bitmap raw = ExtractViaPrivateIcons(exePath, PREFERRED_SOURCE_SIDE);
            if (raw == null) raw = ExtractViaShgfi(exePath);
            if (raw == null) return null;
            try
            {
                Bitmap target = raw;
                try
                {
                    if (target.Width != size || target.Height != size) target = Rescale(raw, size);
                    using (var ms = new MemoryStream())
                    {
                        target.Save(ms, ImageFormat.Png);
                        return Convert.ToBase64String(ms.ToArray());
                    }
                }
                finally
                {
                    if (!ReferenceEquals(target, raw)) target.Dispose();
                }
            }
            catch { return null; }
            finally { raw.Dispose(); }
        }

        /// <summary>PrivateExtractIcons 取最匹配的嵌入层（256 请求命中 .ico 的 PNG 大层）。</summary>
        private static Bitmap ExtractViaPrivateIcons(string exePath, int side)
        {
            IntPtr[] handles = new IntPtr[1];
            uint[] ids = new uint[1];
            uint got;
            try
            {
                got = PrivateExtractIcons(exePath, 0, side, side, handles, ids, 1, 0);
            }
            catch { return null; }
            if (got == 0 || handles[0] == IntPtr.Zero) return null;
            try
            {
                using (Icon icon = Icon.FromHandle(handles[0]))
                    return icon.ToBitmap();
            }
            catch { return null; }
            finally { DestroyIcon(handles[0]); }
        }

        /// <summary>SHGetFileInfo 大图标兜底（PEI 失败 / 无嵌入大层的旧式 exe）。</summary>
        private static Bitmap ExtractViaShgfi(string exePath)
        {
            var fi = new SHFILEINFO();
            uint cb = (uint)Marshal.SizeOf(typeof(SHFILEINFO));
            IntPtr res;
            try
            {
                res = SHGetFileInfo(exePath, 0, ref fi, cb, SHGFI_ICON | SHGFI_LARGEICON | SHGFI_EXEICON);
            }
            catch { return null; }
            if (res == IntPtr.Zero || fi.hIcon == IntPtr.Zero) return null;
            try
            {
                using (Icon icon = Icon.FromHandle(fi.hIcon))
                    return icon.ToBitmap();
            }
            catch { return null; }
            finally { DestroyIcon(fi.hIcon); }
        }

        /// <summary>双三次高质量缩到目标尺寸；SourceCopy 直写避免 alpha 在黑底上二次混合出描边晕。</summary>
        private static Bitmap Rescale(Bitmap src, int size)
        {
            var target = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(target))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
                g.DrawImage(src, new Rectangle(0, 0, size, size));
            }
            return target;
        }

        private static int ClampSize(int v)
        {
            if (v < 16) return DEFAULT_SIZE;
            if (v > 256) return 256;
            return v;
        }
    }
}
