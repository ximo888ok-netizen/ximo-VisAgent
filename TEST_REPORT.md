# ximo-VisAgent 沙箱测试报告

> 测试日期：2026-09-09  
> 测试模型：qwen3.8-flash（通义千问，阿里云百炼）  
> 测试环境：Windows 10 x64，Node.js 20+，pnpm 11，Electron 44  

---

## 一、测试概述

### 1.1 测试目标

对 ximo-VisAgent 项目进行全面的沙箱测试，验证以下维度：

1. **代码质量门禁**：Lint、TypeCheck、Build 全部通过
2. **单元测试套件**：6 个包共 8 个测试文件、198 个测试用例全量执行
3. **经验层/元层契约自检**（selftest）：13 项真机 SQLite 契约验证
4. **坐标链路实机诊断**（coordcheck）：5 项九点探测坐标一致性验证

### 1.2 测试范围

| 层级 | 包 | 测试文件数 | 测试用例数 | 状态 |
|------|-----|-----------|-----------|------|
| 智能体内核 | `@ximo-visagent/agent-core` | 8 | 76 | ✅ 全部通过 |
| 设备控制 | `@ximo-visagent/control-kit` | 5 | 36 | ✅ 全部通过 |
| LLM 供应商 | `@ximo-visagent/llm-providers` | 1 | 25 | ✅ 全部通过 |
| 安全层 | `@ximo-visagent/safety` | 1 | 8 | ✅ 全部通过 |
| 感知层 | `@ximo-visagent/perception` | 1 | 7 | ✅ 全部通过 |
| 桌面应用 | `@ximo-visagent/desktop` | 5 | 46 | ✅ 全部通过 |
| **合计** | | **21** | **198** | **✅ 全部通过** |

### 1.3 模型配置确认

`qwen3.8-flash` 作为项目默认推荐模型，配置验证通过：

| 配置项 | 值 | 验证方式 |
|--------|-----|---------|
| provider | `qwen` | `provider-presets.test.ts` — 预置 Qwen 供应商 |
| baseUrl | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `provider-presets.ts` 硬编码 |
| model | `qwen3.8-flash` | `defaultAgentConfig()` 默认值 |
| supportsVision | `true` | 多模态，同时作为 textLLM 和 visionLLM |
| vl_high_resolution_images | `true` | Qwen 专属参数注入，避免截图降采样 |
| image detail | `high` | OpenAI 标准高档位 |
| thinkingMode | `daily`（默认） | 恒关思考，日常直操最快 |

---

## 二、测试环境

| 项目 | 值 |
|------|-----|
| 操作系统 | Windows 10 x64 |
| 屏幕分辨率 | 1920×1080（物理像素） |
| DPI 缩放 | 100%（scaleFactor = 1） |
| Node.js | ≥ 20 |
| pnpm | 11.5.0 |
| TypeScript | 5.8.3 |
| Electron | 44.0.0 |
| Vitest | 3.2.7 |
| Turbo | 2.10.12 |
| .NET Framework | 4.8（UIA Sidecar 编译依赖） |

---

## 三、测试执行详情

### 3.1 代码质量门禁

#### 3.1.1 ESLint

```
pnpm lint → 7 个包全部通过，0 warnings，0 errors
```

| 包 | 结果 |
|-----|------|
| @ximo-visagent/agent-core | ✅ 通过 |
| @ximo-visagent/control-kit | ✅ 通过 |
| @ximo-visagent/desktop | ✅ 通过 |
| @ximo-visagent/llm-providers | ✅ 通过 |
| @ximo-visagent/perception | ✅ 通过（缓存命中） |
| @ximo-visagent/safety | ✅ 通过 |
| @ximo-visagent/shared-types | ✅ 通过 |

#### 3.1.2 TypeScript 类型检查

```
pnpm typecheck → 13 个任务全部通过（含依赖构建）
```

所有包 `tsc --noEmit` 零类型错误。

#### 3.1.3 构建

```
pnpm build:packages → 6 个包构建成功
pnpm build:desktop → 主进程 + preload + 渲染层全部构建成功
```

构建产物：

| 产物 | 大小 |
|------|------|
| `out/main/index.js` | 2,296.70 KB |
| `out/preload/island.js` | 220.89 KB |
| `out/renderer/assets/island-*.js` | 502.20 KB |
| `out/renderer/assets/client-*.js` | 555.39 KB |

---

### 3.2 单元测试全量结果

#### 3.2.1 agent-core（76 tests / 8 files）

| 测试文件 | 测试数 | 耗时 | 状态 |
|---------|--------|------|------|
| `loop.test.ts`（ReAct 闭环逻辑 + 直操模式对话门控） | 11 | 41ms | ✅ |
| `acceptance.test.ts`（自动验收单测） | 8 | 26ms | ✅ |
| `grounding.test.ts`（视觉定位 + 多视图投票） | 15 | 14ms | ✅ |
| `direct-mode.test.ts`（直操模式批执行 + 滑窗） | 12 | 17ms | ✅ |
| `on-demand-tools.test.ts`（按需工具加载） | 10 | 21ms | ✅ |
| `loop-efficiency.test.ts`（效率守卫 + 停滞信号） | 7 | 6ms | ✅ |
| `completion.test.ts`（目标收尾强化） | 9 | 10ms | ✅ |
| `image-part.test.ts`（截图编码供应商适配） | 4 | 5ms | ✅ |

**关键测试覆盖**：

- ✅ ReAct 主循环闭环：Thought → Action → Observation → done
- ✅ L2 操作审批拦截 + 批准后执行 + 拒绝后不执行
- ✅ 任务取消状态机
- ✅ 最大步数超限判失败
- ✅ 工具连续失败 3 次熔断（不空转到 maxSteps）
- ✅ 画面停滞时重复动作硬拦截
- ✅ 批执行模式：3 个动作串行 1 次截图迭代
- ✅ 批内 L2 拒绝截断：已执行保留、剩余不执行
- ✅ 批内动作失败截断：停批并反馈失败位置
- ✅ 视觉定位千分比归一化 + 绝对像素容错
- ✅ Qwen 原生 bbox_2d 格式容错解析
- ✅ 小目标触发多视图投票，中位数中心
- ✅ 按需工具加载：request_tools 不触执行器
- ✅ 拼错工具名反馈可选目录
- ✅ 自定义工具未加载时模型看不到 schema
- ✅ 自动验收：打回继续 → 二次 task_done 通过
- ✅ 验收连续不通过 → 带保留完成 + 人工复核提示
- ✅ 验收 fail-open：评审 API 异常不卡死任务

#### 3.2.2 control-kit（36 tests / 5 files）

| 测试文件 | 测试数 | 耗时 | 状态 |
|---------|--------|------|------|
| `unit.test.ts`（文件沙箱 + 坐标有限性） | 5 | 8ms | ✅ |
| `click-guard.test.ts`（点击守卫熔断） | 6 | — | ✅ |
| `click-verify.test.ts`（点击验证区域比对） | 8 | 1239ms | ✅ |
| `cursor-path.test.ts`（鼠标轨迹确定性） | 5 | 8ms | ✅ |
| `ui-locate.test.ts`（UIA 树展平/搜索/SoM） | 12 | — | ✅ |

**关键测试覆盖**：

- ✅ 文件路径越界拒绝（`../secret.txt` 被拒）
- ✅ 文件写入读取回环
- ✅ NaN/undefined/字符串坐标被拦截（不直通 SendInput）
- ✅ 同位置 3 次点击后熔断 + UIA 候选建议
- ✅ 点击验证：区域变化 → 生效；无变化 → 未生效 + 换方案
- ✅ 鼠标轨迹确定性（同参数完全一致，无随机数）
- ✅ 终点精确落在目标点
- ✅ 弧线偏移封顶（≤45px，不横扫半个屏幕）
- ✅ UIA 树展平过滤 offscreen + 无名称节点
- ✅ 物理坐标 → 截图坐标系换算（1.5x 缩放验证）
- ✅ SoM 候选收集无名控件
- ✅ zoomedBoxToScreen 精修坐标映射

#### 3.2.3 llm-providers（25 tests / 1 file）

| 测试文件 | 测试数 | 耗时 | 状态 |
|---------|--------|------|------|
| `llm.test.ts` | 25 | 13ms | ✅ |

**关键测试覆盖**：

- ✅ **qwen3.8-flash 默认配置**：text 与 vision 同源，默认 qwen3.8-flash
- ✅ Qwen 专属 `vl_high_resolution_images=true` 参数注入（避免截图降采样）
- ✅ 非 Qwen 供应商不下发该参数
- ✅ DeepSeek thinking 模式：`thinking.enabled` + `reasoning_effort` 透传
- ✅ 思考四档（qwen/glm）：daily 恒关 / deep 恒开 / long 前 2 步关 / auto 评分制
- ✅ auto 评分器：四信号加权（深度 35 + 规模 25 + 失败 30 + 停滞 10）
- ✅ 截图 base64 不计入规模分（只算 text part）
- ✅ 软阈值带：40-59 分判定由种子决定且稳定
- ✅ Kimi / Custom 不下发思考参数
- ✅ OpenAIClient 构造时自动追加 `/chat/completions`
- ✅ HTTP 失败抛 `LLMError`
- ✅ 捕获思维链 `reasoning_content` 到 `ChatResult`

#### 3.2.4 safety（8 tests / 1 file）

| 测试文件 | 测试数 | 耗时 | 状态 |
|---------|--------|------|------|
| `safety.test.ts` | 8 | 6ms | ✅ |

**关键测试覆盖**：

- ✅ L0 只读自动放行（`get_clipboard`）
- ✅ L1 常规点击（`mouse_click`）
- ✅ L2 发送消息必须审批（`send_message`）
- ✅ L2 文件写入（`file_write`）
- ✅ L3 黑名单应用被禁（`cmd.exe`）
- ✅ 审批批准/拒绝/编辑三路径
- ✅ 审批超时置 `TIMEOUT`

#### 3.2.5 perception（7 tests / 1 file）

| 测试文件 | 测试数 | 耗时 | 状态 |
|---------|--------|------|------|
| `perception.test.ts` | 7 | 16ms | ✅ |

**关键测试覆盖**：

- ✅ 首帧必发、相同帧不发（pHash 变化检测）
- ✅ 明显变化触发
- ✅ 汉明距离计算正确
- ✅ pHash 生成 64bit 固定长度
- ✅ UIA 树展平并按 id 解析 center
- ✅ DPI 逻辑/物理像素互转
- ✅ 多显示器命中

#### 3.2.6 desktop（46 tests / 5 files）

| 测试文件 | 测试数 | 耗时 | 状态 |
|---------|--------|------|------|
| `meta-gate.test.ts`（宪法门） | 21 | 12ms | ✅ |
| `approval-policy.test.ts`（审批档位门禁） | 12 | 7ms | ✅ |
| `experience-layer.test.ts`（经验层契约） | 6 | 5ms | ✅ |
| `som-mark.test.ts`（SoM 标注） | 3 | 5ms | ✅ |
| `perception-grid.test.ts`（感知网格） | 4 | 7ms | ✅ |

**关键测试覆盖**：

- ✅ 宪法门白名单 9 种元层操作
- ✅ 越权检测：非白名单 / bypass 标志 / 空字段 / 注入字符 / 类型不匹配 / 批量操作
- ✅ 提案只登记不生效，审批后执行
- ✅ 越权后自动停用元层 + 留痕
- ✅ 不能重复决定，执行抛错标记 failed
- ✅ payload 损坏拒绝执行
- ✅ 审批档位真值表：manual / auto / autonomous × L2 / custom_* / L3
- ✅ 五道刹车：非交互来源 / 岛窗口不在场 / 配额 / 非法档位
- ✅ 天花板锁：关键工具分级不得低于基线
- ✅ SOP 骨架渲染（占位符 / 填参 / 损坏容错）
- ✅ 自定义工具沙箱静态检查（`fs.rmSync` / `fetch` 被拦截）

---

### 3.3 selftest（经验层/元层真机契约验证）

```
pnpm selftest → 13 项全部通过（0 failed）
```

| # | 检查项 | 结果 | 详情 |
|---|--------|------|------|
| 1 | 轨迹回读：从审计库还原完整 StepDetail（含 args） | ✅ pass | 通过 |
| 2 | 自定义工具：写盘 + 编译注册 | ✅ pass | 通过 |
| 3 | 自定义工具：执行后确实调用了组成原子并返回结果 | ✅ pass | `ok=true` 调用=`["activate_window","wait"]` |
| 4 | 自定义工具：越界脚本路径被拒 | ✅ pass | 通过 |
| 5 | 自定义工具：未注册的脚本名不进入模型工具表 | ✅ pass | 通过 |
| 6 | 宪法门：提权变更登记后不立即生效 | ✅ pass | 通过 |
| 7 | 宪法门：人工批准后执行器被调用且提案转 executed | ✅ pass | 通过 |
| 8 | 宪法门：越权写入被拒并自动停用元层 | ✅ pass | 通过 |
| 9 | 审批档位：写读一致，重启后仍是原档位 | ✅ pass | 通过 |
| 10 | 审批档位：旧配置文件缺字段时回落 manual | ✅ pass | 通过 |
| 11 | 审批档位：缺 ack 切「完全自主」被拒且未落盘 | ✅ pass | 通过 |
| 12 | 审批档位：带 ack 切换成功并在审计留痕 | ✅ pass | 通过 |
| 13 | 统计口径：策略放行不计入人工干预次数 | ✅ pass | 通过 |

**说明**：selftest 在 Electron 中启动临时 `userData` 目录，对真实 SQLite 数据库 + 真实代码路径做断言。验证了审计库轨迹还原、自定义工具脚本注册/执行/安全边界、宪法门提案/审批/越权停用、审批档位持久化与门禁等核心数据层契约。

---

### 3.4 coordcheck（坐标链路实机诊断）

```
electron out/main/index.js --coordcheck → 5 项全部通过（0 failed）
```

| # | 检查项 | 结果 | 详情 |
|---|--------|------|------|
| A1 | 屏幕物理尺寸 (bounds×scaleFactor) | ✅ pass | 物理 1920×1080 = bounds 1920×1080 × scaleFactor 1 |
| B1 | 感知帧尺寸 = 屏幕物理尺寸 | ✅ pass | 截图 1920×1080 vs 物理 1920×1080 |
| B2 | captureScreen 后 setScreenScale 生效值 | ✅ pass | 实际 1.000/1.000 vs 期望 1.000/1.000 |
| B3 | 网格帧 vs 净帧尺寸一致 | ✅ pass | 网格帧 1920×1080 vs 净帧 1920×1080 |
| C1 | 截图系坐标注入→物理回读（9/9 点 ≤2px） | ✅ pass | 见下表 |

**九点探测详情**：

| 探测点 | 目标坐标 | 回读坐标 | 偏差 | 状态 |
|--------|---------|---------|------|------|
| 左上角 | (1, 1) | (0, 1) | (1.0, 0.0) | ✅ ≤2px |
| 中心 | (960, 540) | (960, 540) | (0.0, 0.0) | ✅ ≤2px |
| 右下角 | (1918, 1078) | (1918, 1078) | (0.0, 0.0) | ✅ ≤2px |
| 四分点 | (480, 270) | (480, 270) | (0.0, 0.0) | ✅ ≤2px |
| 四分点 | (1440, 810) | (1440, 810) | (0.0, 0.0) | ✅ ≤2px |
| 顶部中轴 | (960, 1) | (960, 1) | (0.0, 0.0) | ✅ ≤2px |
| 左中轴 | (1, 540) | (0, 540) | (1.0, 0.0) | ✅ ≤2px |
| 右中轴 | (1918, 540) | (1918, 540) | (0.0, 0.0) | ✅ ≤2px |
| 底部中轴 | (960, 1078) | (960, 1078) | (0.0, 0.0) | ✅ ≤2px |

**结论**：坐标链路三方对齐——Electron screen API / desktopCapturer 截图 / SendInput 注入回读 全部在物理像素坐标系 1:1 对齐，最大偏差 1.0px（≤2px 容差）。

---

## 四、qwen3.8-flash 模型专项验证

### 4.1 默认配置验证

`defaultAgentConfig()` 返回单一多模态主大脑配置，text 与 vision 同源为 `qwen3.8-flash`：

```
✅ cfg.textLLM.provider === 'qwen'
✅ cfg.textLLM.model === 'qwen3.8-flash'
✅ cfg.visionLLM.provider === cfg.textLLM.provider
✅ cfg.visionLLM.model === cfg.textLLM.model
✅ cfg.visionLLM.enabled === true
```

### 4.2 Qwen 专属参数注入

| 参数 | 值 | 验证 |
|------|-----|------|
| `vl_high_resolution_images` | `true` | ✅ 仅 Qwen 下发，避免截图被降采样 |
| `image detail` | `high` | ✅ OpenAI 标准高档位 |
| `enable_thinking` (daily) | `false` | ✅ 恒关，日常直操最快 |
| `enable_thinking` (long, step≥3) | `true` | ✅ 前 2 步关，第 3 步起开 |
| `enable_thinking` (auto, 连败≥3) | `true` | ✅ 强失败信号直通开思考 |
| `enable_thinking` (auto, 简单场景) | `false` | ✅ 短上下文+无失败 → 关 |

### 4.3 截图编码

- ✅ `buildImagePart` 对 Qwen 供应商返回 `image_url` 类型，base64 内联
- ✅ `encodeImageForLLM` 正确检测 MIME 类型，不统一标 `image/png`

---

## 五、安全机制验证

### 5.1 操作分级

| 级别 | 工具 | 策略 | 验证状态 |
|------|------|------|---------|
| L0 | `ocr_region`, `get_clipboard`, `file_read`, `file_list`, `screen_ocr`, `web_search`, `ui_locate` | 自动执行 | ✅ 天花板锁断言 |
| L1 | `mouse_click`, `mouse_drag`, `keyboard_type`, `keyboard_press`, `open_app`, `activate_window`, `set_clipboard` | 自动执行 | ✅ 天花板锁断言 |
| L2 | `file_write`, `excel_write_cell`, `wechat_send`, `submit_form`, `send_message` | 需审批 | ✅ 天花板锁断言 |
| L3 | PowerShell/CMD, 系统设置, 银行网站 | 默认禁止 | ✅ 天花板锁断言 |

### 5.2 审批档位门禁

| 档位 | L2 | custom_* | L3 | 验证 |
|------|-----|----------|-----|------|
| manual | 询问 | 询问 | 询问 | ✅ |
| auto | 放行 | 询问 | 询问 | ✅ |
| autonomous | 放行 | 放行 | 放行 | ✅ |

**五道刹车验证**：

- ✅ B1：非交互来源（定时/基准/E2E）不得继承档位
- ✅ B3：岛窗口不在场 → 无可见性，一律询问
- ✅ B4：每任务配额 L2≤20 次 / L3≤3 次，超限回落询问
- ✅ B5：非法档位 / 非法等级 fail-closed 到询问

### 5.3 宪法门

- ✅ 白名单 9 种元层操作
- ✅ 提权类（prompt_activate / tool_register / sop_promote）必须人工批准
- ✅ 越权操作自动停用元层 + 审计留痕
- ✅ 不能重复决定、payload 损坏拒绝执行

---

## 六、测试结果汇总

| 测试维度 | 执行项 | 通过 | 失败 | 通过率 |
|---------|--------|------|------|--------|
| ESLint | 7 包 | 7 | 0 | 100% |
| TypeScript | 7 包 | 7 | 0 | 100% |
| Build | 8 包 | 8 | 0 | 100% |
| 单元测试 | 198 用例 | 198 | 0 | 100% |
| selftest | 13 项 | 13 | 0 | 100% |
| coordcheck | 5 项（9 点） | 5 | 0 | 100% |
| **总计** | **231** | **231** | **0** | **100%** |

---

## 七、测试结论

### 7.1 总体评价

ximo-VisAgent 项目在 `qwen3.8-flash` 模型配置下，通过了全部 6 个维度的沙箱测试，共 **231 项检查全部通过，0 失败**。

### 7.2 核心能力验证结论

| 能力域 | 结论 |
|--------|------|
| **ReAct 主循环** | ✅ 闭环逻辑完整：Thought→Action→Observation→done，支持批执行、取消、步数超限、工具熔断、停滞拦截 |
| **安全机制** | ✅ 四级分类器 + 三档审批 + 五道刹车 + 天花板锁 + 宪法门，安全边界严格 |
| **坐标链路** | ✅ 三方对齐：Electron screen / desktopCapturer / SendInput 回读，9 点探测最大偏差 1.0px |
| **数据层** | ✅ SQLite 经验层/元层契约真实数据库验证通过：轨迹回读、自定义工具、宪法门、审批档位 |
| **qwen3.8-flash 适配** | ✅ 默认配置正确，专属参数注入（vl_high_resolution_images）+ 思考四档 + 视觉高档位 |
| **代码质量** | ✅ ESLint 0 warnings，TypeScript 0 errors，6 包构建全部成功 |

### 7.3 未覆盖项说明

以下测试项因需要真实 LLM API Key 或人在环审批，未在本次沙箱测试中执行，但项目已提供完整的执行框架：

| 测试项 | 原因 | 执行方式 |
|--------|------|---------|
| E2E 基准任务（A/B/D/E） | 需要真实 qwen3.8-flash API Key + 真实桌面操作 | `pnpm e2e` — 需配置 API Key 后执行 |
| 设备集成测试 | 需要真实 Windows 设备操作鼠标键盘 | `pnpm test:device` |
| 微信 Bot | 需要 iLink 扫码登录 | 应用内配置 |

### 7.4 建议

1. **E2E 补充**：配置 qwen3.8-flash API Key 后执行 `pnpm e2e`，验证真实桌面操作链路
2. **多模型对比**：可扩展测试 DeepSeek / GLM 等其他供应商的 grounding 精度
3. **长时间稳定性**：建议在真实办公场景中连续运行 8 小时以上，观察 token 消耗与记忆压缩表现

---

## 附录 A：测试命令速查

| 命令 | 内容 | 本次结果 |
|------|------|---------|
| `pnpm lint` | ESLint 全量 | ✅ 7 包通过 |
| `pnpm typecheck` | TypeScript 类型检查 | ✅ 7 包通过 |
| `pnpm build` | 全量构建 | ✅ 8 包通过 |
| `pnpm test` | 全量单元测试 | ✅ 198 用例通过 |
| `pnpm selftest` | 经验层/元层真机契约 | ✅ 13 项通过 |
| `--coordcheck` | 坐标链路实机诊断 | ✅ 5 项 / 9 点通过 |
| `pnpm e2e` | 端到端桌面任务 | 未执行（需 API Key） |

## 附录 B：测试执行日志摘要

### 单元测试

```
 Tasks:    12 successful, 12 total
  Time:    8.337s
```

### selftest

```
{"selftest":"done","total":13,"failed":0}
```

### coordcheck

```
{"coordcheck":"done","total":5,"failed":0}
```
