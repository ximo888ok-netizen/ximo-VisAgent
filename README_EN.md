# ximo-VisAgent

> An AI agent that operates the Windows desktop to complete office tasks — like a person sitting next to you: looking at the screen, moving the mouse, typing on the keyboard, and delivering results.

English | [中文](./README.md)

---

## Overview

ximo-VisAgent is a **Windows desktop AI agent** built on Electron + ReAct loop architecture. It enables a large language model (LLM) to operate a computer the way a human would:

- **See** screenshots → locate target elements
- **Act** with the mouse → click, drag, scroll
- **Type** on the keyboard → enter text, press shortcuts
- **Deliver** results → save files, submit forms, send messages

A built-in four-level safety classifier (L0-L3) and human-in-the-loop approval state machine ensure that sensitive operations are never executed without explicit permission.

---

## Key Features

### Agent Core (agent-core)

- **ReAct Main Loop**: Thought → Action → Observation → repeat until task completion
- **Task Planner**: Decomposes natural-language goals into 1-5 executable steps
- **Short-term Memory**: 5-step sliding window summary + LLM compression fallback, controlling token consumption
- **Efficiency Guard**: Screen change detection (pHash) to skip redundant screenshots and save tokens
- **Visual Grounding**: Leverages multimodal LLM grounding capabilities for "look at image, report coordinates" — a fallback when the UIA tree cannot find the target
- **On-demand Tool Loading**: Core tool set + optional tool catalog; the Agent can expand capabilities via `request_tools`
- **Batch Execution**: Deterministic sequential actions merged into a single batch (click input field → type → Ctrl+S in one go)

### Perception Layer (perception)

- **Screenshot Capture**: Based on Electron `desktopCapturer`, physical pixel coordinate system
- **Foreground Window Detection**: Retrieves the active window title and class name
- **Environment Context**: Screen resolution, DPI scale, visible window list
- **Image Change Detection**: 64-bit perceptual hash to avoid false triggers from minor changes (e.g., cursor blink)

### Control Layer (control-kit)

- **Mouse Operations**: Click, double-click, right-click, drag, hold, drag-hold, scroll
- **Keyboard Operations**: Text input (including CJK), keyboard shortcut combinations
- **UIA Tree Query**: Reads the Windows UI Automation accessibility tree for element-ID-based precise targeting (`ui_locate` / `ui_click`)
- **OCR Recognition**: Screen text recognition as a supplementary targeting method
- **Click Verification**: Pre/post-click screenshot comparison to verify operation effectiveness
- **Click Guard**: Same-position rapid-click circuit breaker + UIA hit suggestions + fallback candidates
- **File / Office Operations**: File read/write, Excel cell read/write
- **Window Management**: Activate specific windows, list visible windows
- **Clipboard Operations**: Read/set clipboard content

### Safety Layer (safety)

Four-level operation classification and approval mechanism:

| Level | Description | Examples | Default Behavior |
|-------|-------------|----------|-----------------|
| **L0** | Read-only, no side effects | Screenshot, OCR, file read | Auto-execute |
| **L1** | Input injection, low risk | Mouse click, keyboard input, open app | Auto-execute |
| **L2** | Write to disk / outbound send | Write file, Excel write, send message, submit form | Requires approval |
| **L3** | High-risk operations | System settings, PowerShell, banking websites | Blocked by default |

**Approval Mode Settings**:
- `manual` (default): L2+ always prompts for approval
- `auto`: Auto-approve L2; L3 still prompts
- `autonomous`: Auto-approve all (requires explicit risk confirmation)

**Built-in Safety Rules**:
- Block access to PowerShell / CMD / Terminal
- Block access to System Settings / Control Panel
- Block access to banking websites
- Force approval for IM messaging (WeChat / WeCom / DingTalk / Feishu)

**Approval State Machine**: PENDING → APPROVED / REJECTED / EDITED / TIMEOUT, with timeout suspension support.

### Desktop Application (apps/desktop)

#### Island UI

A persistent desktop UI inspired by macOS Dynamic Island — a floating interactive panel with the following tabs:

| Panel | Function |
|-------|----------|
| **Task** | Task input, real-time step stream, approval cards, run controls |
| **Settings** | LLM configuration, safety rules, general/appearance/memory/workspace settings |
| **Audit** | Full operation audit log, statistics panel |
| **History** | Historical task replay (step replayer) |
| **SOP** | Standard Operating Procedure template management |
| **Schedule** | Cron-based scheduled task management |
| **Employee** | Position role definitions, fact cards, onboarding reports |
| **Evolution** | Prompt version management, world model, meta-layer (Constitutional Gate) |
| **Mission** | Mission / subtask / artifact management |
| **Log** | Runtime log panel |

#### Aura Presence Indicator

A breathing glow effect at the screen edge indicating the Agent is running. Intensity is adjustable (off / subtle / full).

#### Splash Screen

A splash window showing startup progress (restoring tools → perception service → waking the Island).

### Experience Layer & Learning

- **Attribution Records**: Task execution trace attribution — records success/failure causes
- **Skill World**: Environment facts, recovery rules, prompt version management
- **Prompt Evolution**: A/B testing of prompt versions; supports registration after Constitutional Gate (Meta Gate) approval
- **Custom Tools**: Users can author script tools that are registered to the Agent after Constitutional Gate approval

### SOP Templates

Save task execution traces as reusable Standard Operating Procedure (SOP) templates with variable placeholder filling.

### Scheduled Task Scheduler

5-field cron scheduler with JSON persistence; triggers task execution automatically at scheduled times.

### WeChat Bot Integration

WeChat Bot integration based on the iLink protocol, supporting:
- Triggering tasks from WeChat messages
- Automatic notifications on task completion
- Pushing approval requests to WeChat

### UIA Sidecar (Native Component)

A C# Windows UIA element tree JSON-RPC service (stdin/stdout NDJSON protocol):
- Reads the system accessibility tree, providing control names, types, and positions
- Per-Monitor V2 DPI awareness — aligned 1:1 with Electron screenshot coordinates
- Automatically enables the screen reader flag so Chromium-based apps expose the full UIA tree

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Framework | Electron 44 + electron-vite + electron-builder |
| Frontend | React 19 + TypeScript 5 + TailwindCSS 4 + Zustand 5 |
| Backend | Node.js 20+ (Electron main process) |
| Native Component | C# (.NET Framework 4.8) — UIA Sidecar |
| Native FFI | koffi (Win32 API calls) |
| Database | better-sqlite3 (SQLite) |
| Package Manager | pnpm 11 (Workspace) |
| Build | Turbo (Monorepo) + tsup (package builds) |
| Testing | Vitest + Node.js test runner |
| LLM | OpenAI-compatible protocol (DeepSeek / Qwen / GLM / Kimi) |

---

## Project Structure

```
ximo-VisAgent/
├── apps/
│   └── desktop/                    # Electron desktop app
│       ├── src/
│       │   ├── main/                # Main process (orchestration layer)
│       │   │   ├── index.ts         # Entry point
│       │   │   ├── bootstrap.ts     # Startup sequence
│       │   │   ├── orchestrator.ts  # Task orchestrator
│       │   │   ├── ipc-registry.ts  # IPC handler registration
│       │   │   ├── audit-store.ts   # SQLite audit storage
│       │   │   ├── config-store.ts  # Config persistence
│       │   │   ├── experience-store.ts  # Experience layer storage
│       │   │   ├── scheduler.ts      # Cron task scheduler
│       │   │   ├── wechat-bot.ts     # WeChat Bot
│       │   │   ├── stores/           # Domain store splits
│       │   │   ├── mission-db/      # Mission subsystem database
│       │   │   └── ...
│       │   ├── preload/             # Electron preload scripts
│       │   ├── renderer/            # Renderer process (UI)
│       │   │   └── src/
│       │   │       ├── island/      # Island UI
│       │   │       │   ├── components/
│       │   │       │   │   ├── Island/    # Core island components
│       │   │       │   │   └── Panel/     # Feature panels
│       │   │       │   ├── store/         # Zustand state management
│       │   │       │   └── styles/
│       │   │       └── aura/        # Aura presence indicator UI
│       │   └── shared/             # Shared types (main + renderer)
│       └── resources/
├── packages/
│   ├── agent-core/                 # Agent core (ReAct loop)
│   │   └── src/
│   │       ├── agent/              # Main loop, planner, memory, grounding
│   │       ├── tools/              # Tool schemas and registry
│   │       └── prompts/           # System prompts
│   ├── control-kit/                # Device control layer
│   │   └── src/
│   │       ├── executor.ts         # Tool executor
│   │       ├── win32.ts            # Mouse operations (FFI)
│   │       ├── win32-keyboard.ts   # Keyboard operations (FFI)
│   │       ├── uia-client.ts       # UIA client
│   │       └── ...
│   ├── perception/                 # Perception layer (screenshot, env context)
│   ├── safety/                     # Safety layer (classifier, approval engine)
│   ├── llm-providers/              # LLM provider adapters
│   │   └── src/
│   │       ├── openai-compat.ts    # OpenAI-compatible protocol
│   │       ├── provider-presets.ts # Provider presets
│   │       ├── vision.ts           # Image message encoding
│   │       └── web-search.ts       # Web search
│   └── shared-types/               # Shared type definitions
├── native/
│   └── uia-sidecar-cs/             # C# UIA Sidecar native component
├── e2e/                            # End-to-end tests
├── scripts/                        # Utility scripts
├── turbo.json                      # Turbo build config
└── package.json                    # Monorepo root config
```

---

## Supported LLM Providers

| Provider | Description |
|----------|-------------|
| **Qwen (Alibaba)** | Recommended default; GUI grounding-trained model, flash-tier pricing |
| **DeepSeek** | Supports thinking mode and grounding |
| **GLM (Zhipu)** | Multimodal vision model |
| **Kimi (Moonshot)** | Long-context multimodal model |
| **Custom** | Any OpenAI-compatible endpoint |

Supports configuring separate text LLM and vision LLM, or using a single multimodal model for both.

---

## Getting Started

### Prerequisites

- **Node.js** >= 20
- **pnpm** >= 11
- **Windows 10/11** (x64)
- **.NET Framework 4.8** (UIA Sidecar build dependency — included with Windows)

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd ximo-VisAgent

# Install dependencies (includes automatic UIA Sidecar compilation)
pnpm install
```

### Development

```bash
# Build all packages (required on first run)
pnpm build:packages

# Start the desktop app in dev mode
pnpm dev:desktop
```

### Building

```bash
# Build everything
pnpm build

# Build only the desktop app
pnpm build:desktop

# Package as a Windows installer (NSIS)
pnpm package:win
```

### Testing

```bash
# Full verification (lint + budget + typecheck + test + build)
pnpm verify

# Unit tests only
pnpm test

# Device integration tests (requires a real Windows environment)
pnpm test:device

# Self-test mode (validates experience/meta-layer contracts against real SQLite in Electron)
pnpm selftest

# End-to-end tests (real desktop tasks with human-in-the-loop approval)
pnpm e2e
```

---

## How It Works

### ReAct Loop

```
User Goal
    ↓
[Planner] → Decompose into subtask list
    ↓
┌───────────────────────────────────────────┐
│  [Main Loop]                               │
│  1. Screenshot → perception snapshot       │
│  2. Build context (screenshot + history)   │
│  3. LLM inference → Thought + Action       │
│  4. Safety classification → approval (if needed) │
│  5. Execute tool call                      │
│  6. Record result → back to step 1         │
└───────────────────────────────────────────┘
    ↓
Task complete → task_done
```

### Targeting Fallback Chain

```
UIA Tree Query (ui_locate / ui_click)
    ↓ target not found
Visual Grounding (Grounding API)
    ↓ low confidence
Close-up Inspection (look_close)
    ↓ still uncertain
Manual reading (model reads coordinates directly from screenshot grid)
```

### Coordinate System

All coordinates use the **physical pixel coordinate system**:
- Electron `desktopCapturer` screenshot = physical pixels
- UIA Sidecar Per-Monitor V2 = physical pixels
- Screenshot grid lines assist the model in precise reading (±5px)

---

## Engineering Quality

### Command Reference

| Command | Description |
|---------|-------------|
| `pnpm verify` | lint + budget + typecheck + test + build |
| `pnpm lint` | ESLint (line limits, cross-layer imports, dead code, hook order) |
| `pnpm budget` | Legacy exemption budget (only decreases, never increases) |
| `pnpm test` | Package core + main process pure logic unit tests |
| `pnpm selftest` | Validate experience/meta-layer contracts against real SQLite in Electron |
| `pnpm e2e [id]` | Real desktop end-to-end tasks (with human-in-the-loop approval) |

### E2E Benchmark Tasks

| ID | Task | Verification |
|----|------|-------------|
| A | Open Notepad, type Chinese text, save to desktop | Desktop file exists with correct content |
| B | Open Calculator, compute 128×64, write result to file | Desktop file content = 8192 |
| D | Create Excel with columns, sum, save as new file | New file C1 = 110 |
| E | Read result file and send via IM (requires approval) | IM message sent after approval |

---

## License

This project is open-sourced under the [MIT License](./LICENSE). Copyright © 2026 ximo-VisAgent
