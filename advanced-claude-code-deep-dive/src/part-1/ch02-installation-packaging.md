
# 第 2 章：安装与打包 — 从 TypeScript 源码到独立二进制

> **核心问题**：Claude Code 是如何从数百个 TypeScript 源文件，变成一个无需 Node.js 即可运行的独立二进制文件的？`bun:bundle` 的 `feature()` 机制如何实现编译期的条件编译？入口文件 `main.tsx` 在启动时做了什么？

Claude Code 的安装体验极其简单 — 一条命令即可。但"简单的安装"背后，是一套精心设计的构建系统 — Bun 运行时打包、`feature()` 编译期条件编译、native 模块跨平台编译、500+ 源文件合并。理解这些，是阅读本书后续章节的前提：你需要知道"我们分析的对象是如何构建的"。

---

## 2.1 安装方式

### 独立二进制安装（当前推荐）

Claude Code 已从 npm 包分发迁移到**独立二进制文件**分发：

```bash
# macOS / Linux
curl -fsSL https://claude.ai/install.sh | bash

# macOS (Homebrew)
brew install claude-code

# Windows
winget install claude-code
```

安装后，系统 PATH 中会多出一个 `claude` 命令。这是一个独立的二进制文件，内嵌了 Bun 运行时（JavaScriptCore 引擎），**不需要系统安装 Node.js**。

### 环境要求

| 要求 | 说明 |
|------|------|
| 操作系统 | macOS / Linux / Windows |
| 网络 | 运行时需要访问 API 服务 |
| Node.js | **不再需要**（Bun 运行时已内嵌） |
| Git | 推荐（版本控制集成） |

> **设计决策**：从 npm 包迁移到独立二进制，是一个重要的工程决策。npm 方式要求用户系统有 Node.js 18+，版本冲突是常见的用户支持问题。`bun build --compile` 将 TypeScript 源码 + Bun 运行时编译为单一可执行文件，彻底消除了运行时依赖。代价是二进制文件更大（100MB+），但对于开发者工具而言，这是可以接受的。

### 历史：npm 安装方式（已弃用）

早期版本通过 npm 分发：

```bash
# 已弃用
npm install -g @anthropic-ai/claude-code
```

这种方式将所有代码打包为一个 ~12MB 的 `main.mjs` 文件（esbuild 生成），通过 Node.js 运行。本书前作基于这个版本进行反编译分析。

---

## 2.2 项目源码结构

Claude Code 的 TypeScript 源码组织为清晰的模块化结构。以下是从 `src/` 目录提取的真实结构：

```
src/
│
├── main.tsx ·················· CLI 主入口（Commander.js 解析 + 启动序列）
├── query.ts ·················· Agentic Loop 核心循环
├── QueryEngine.ts ············ SDK/Headless 查询引擎
├── Tool.ts ··················· 工具接口定义 + ToolUseContext
├── tools.ts ·················· 工具注册表（getAllBaseTools）
├── commands.ts ··············· Slash 命令注册表（90+ 命令）
├── Task.ts ··················· 后台任务抽象
├── replLauncher.tsx ·········· REPL 启动器
│
├── entrypoints/ ·············· 入口点
│   ├── cli.tsx ···············   CLI 入口
│   ├── init.ts ···············   初始化逻辑
│   ├── mcp.ts ················   MCP Server 模式入口
│   └── agentSdkTypes.ts ·····   SDK 类型定义
│
├── components/ ··············· React/Ink UI 组件（80+）
│   ├── App.tsx ···············   应用顶层
│   ├── REPL.tsx ··············   交互式循环
│   ├── MessageList.tsx ·······   消息列表
│   ├── InputPrompt.tsx ·······   输入提示
│   └── ...
│
├── tools/ ···················· 工具实现（40+ 工具）
│   ├── BashTool/ ·············   Bash 执行（含沙箱集成）
│   │   ├── BashTool.tsx
│   │   ├── bashSecurity.ts
│   │   ├── shouldUseSandbox.ts
│   │   └── prompt.ts
│   ├── FileReadTool/ ········    文件读取
│   ├── FileEditTool/ ········    文件编辑
│   ├── FileWriteTool/ ·······    文件写入
│   ├── GlobTool/ ·············   路径搜索
│   ├── GrepTool/ ·············   内容搜索
│   ├── AgentTool/ ············   子 Agent（含 Fork/Team）
│   │   ├── AgentTool.tsx
│   │   ├── runAgent.ts
│   │   ├── forkSubagent.ts
│   │   └── built-in/         #   内置 Agent 定义
│   ├── WebFetchTool/ ········    URL 抓取
│   ├── WebSearchTool/ ·······    网络搜索
│   ├── MCPTool/ ··············   MCP 工具桥接
│   ├── SkillTool/ ············   Skill 调用
│   └── ... (30+ more)
│
├── services/ ················· 服务层
│   ├── api/ ··················   API 客户端
│   │   ├── claude.ts ·········     核心 API 调用逻辑
│   │   ├── client.ts ·········     HTTP 客户端
│   │   ├── withRetry.ts ······     重试与退避
│   │   ├── errors.ts ·········     错误分类
│   │   └── logging.ts ········     Usage 追踪
│   ├── mcp/ ··················   MCP 协议
│   │   ├── client.ts ·········     MCP 客户端管理
│   │   ├── config.ts ·········     MCP 服务器配置
│   │   └── types.ts ··········     MCP 类型定义
│   ├── compact/ ··············   上下文压缩
│   │   ├── autoCompact.ts ····     自动压缩
│   │   ├── microCompact.ts ···     微压缩
│   │   └── compact.ts ········     压缩核心逻辑
│   ├── analytics/ ············   遥测分析
│   ├── oauth/ ················   OAuth 认证
│   └── lsp/ ··················   LSP 集成
│
├── utils/ ···················· 工具函数
│   ├── permissions/ ··········   权限引擎
│   │   ├── permissions.ts ····     权限检查核心
│   │   ├── permissionSetup.ts     权限初始化
│   │   └── PermissionMode.ts ·    权限模式定义
│   ├── sandbox/ ··············   沙箱系统
│   │   └── sandbox-adapter.ts     平台适配器
│   ├── hooks/ ················   Hooks 系统
│   │   ├── hookHelpers.ts ····     Hook 执行
│   │   └── postSamplingHooks.ts   采样后 Hook
│   ├── model/ ················   模型选择
│   ├── settings/ ·············   设置系统
│   └── ...
│
├── state/ ···················· 应用状态管理
│   ├── AppState.tsx ··········   状态 Provider
│   ├── AppStateStore.ts ······   状态存储
│   ├── store.ts ··············   响应式 Store
│   └── selectors.ts ··········   状态选择器
│
├── commands/ ················· Slash 命令实现（90+ 目录）
│   ├── commit.ts ·············   /commit
│   ├── compact/ ··············   /compact
│   ├── config/ ···············   /config
│   ├── review/ ···············   /review
│   ├── mcp/ ··················   /mcp
│   ├── plugin/ ···············   /plugin
│   └── ... (80+ more)
│
├── skills/ ··················· Skill 系统
│   ├── loadSkillsDir.ts ······   Skill 加载器
│   ├── bundledSkills.ts ······   内置 Skills
│   └── bundled/ ··············   内置 Skill 定义
│
├── bridge/ ··················· 远程桥接（Claude Desktop）
│   ├── bridgeMain.ts ·········   桥接主逻辑
│   ├── replBridge.ts ·········   REPL 桥接
│   └── ...
│
├── coordinator/ ·············· 协调器模式（多 Worker）
│
├── buddy/ ···················· Companion 系统
│
└── constants/ ················ 常量定义
    ├── tools.ts ··············   工具相关常量
    ├── oauth.js ··············   OAuth 配置
    └── ...
```

### 规模统计

从目录结构可以估算项目规模：

| 维度 | 数量 |
|------|------|
| `.ts` 文件 | ~400 |
| `.tsx` 文件 | ~120 |
| 工具目录 (`tools/`) | 40+ |
| 命令目录 (`commands/`) | 90+ |
| 服务模块 (`services/`) | 30+ |
| UI 组件 (`components/`) | 80+ |
| 总代码行数（估计） | 150K-200K 行 TypeScript |

> **设计决策**：源码采用**按功能聚合**的目录组织方式 — 每个工具（如 BashTool）有独立目录，包含实现、UI、权限、prompt 等相关文件。这与 React 社区推荐的 "colocation" 原则一致：相关文件放在一起，而非按技术类型（所有 .tsx 放一起）分组。

---

## 2.3 Bun 运行时与 `bun:bundle` 编译

### 从 Node.js 到 Bun

Claude Code 的运行时已从 Node.js 迁移到 **Bun**。Bun 是一个用 Zig 编写的 JavaScript 运行时，基于 JavaScriptCore（Safari 的 JS 引擎）。关键特性：

| Bun 特性 | Claude Code 如何利用 |
|----------|-------------------|
| `bun build --compile` | TypeScript → 独立二进制，无需 Node.js |
| `bun:bundle` `feature()` | 编译期条件编译，dead code elimination |
| 原生 TypeScript 支持 | 无需 tsc 编译步骤 |
| 快速启动 | 比 Node.js 更快的进程启动 |
| Node.js 兼容 | 大部分 Node.js API 可直接使用 |

### `feature()` — 编译期条件编译

Claude Code 源码中最显著的特征之一是 `import { feature } from 'bun:bundle'`。这是 Bun 提供的**编译期 feature flag** 机制：

```typescript
// src/query.ts — feature() 的典型用法
import { feature } from 'bun:bundle'

const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('./services/compact/reactiveCompact.js') as typeof import(...))
  : null

const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? (require('./services/contextCollapse/index.js') as typeof import(...))
  : null
```

**工作原理**：

```
                    编译时                              运行时
                 ┌──────────┐                        ┌──────────┐
feature('X')     │ Bun 编译器│                        │ 二进制   │
  │              │ 静态求值  │                        │ 文件     │
  ▼              │          │                        │          │
true ──────────▶ │ 保留代码  │ ─────────────────────▶ │ 代码存在 │
false ─────────▶ │ 删除代码  │ ─────────────────────▶ │ 代码不存在│
                 └──────────┘                        └──────────┘
```

在编译时，`feature('FLAG_NAME')` 被替换为字面值 `true` 或 `false`。当为 `false` 时，分支中的代码被 tree-shaking 完全移除 — 包括 `require()` 引入的模块。

### 常见 Feature Flags

从源码中提取的 feature flags 及其用途：

| Feature Flag | 用途 | 备注 |
|-------------|------|------|
| `REACTIVE_COMPACT` | 响应式上下文压缩 | prompt-too-long 恢复 |
| `CONTEXT_COLLAPSE` | 上下文折叠 | 渐进式上下文管理 |
| `HISTORY_SNIP` | 历史裁剪 | 长会话内存优化 |
| `CACHED_MICROCOMPACT` | 缓存微压缩 | 利用 cache_edits |
| `TOKEN_BUDGET` | Token 预算控制 | 自动继续功能 |
| `BG_SESSIONS` | 后台会话 | `claude ps` 任务摘要 |
| `COORDINATOR_MODE` | 协调器模式 | 多 Worker 协作 |
| `KAIROS` | 助手模式 | 实验性功能 |
| `BRIDGE_MODE` | 桥接模式 | Claude Desktop 集成 |
| `VOICE_MODE` | 语音模式 | 语音交互 |
| `CHICAGO_MCP` | Computer Use MCP | 屏幕操作 |
| `PROACTIVE` | 主动模式 | Sleep/唤醒 |
| `EXPERIMENTAL_SKILL_SEARCH` | Skill 搜索 | AI 驱动的 Skill 发现 |
| `FORK_SUBAGENT` | Fork 子 Agent | 廉价并行 |
| `UDS_INBOX` | Unix Domain Socket | 进程间通信 |
| `WORKFLOW_SCRIPTS` | 工作流脚本 | 可编排的任务流 |
| `ULTRAPLAN` | 超级计划 | 高级规划工具 |
| `BUDDY` | 伴侣模式 | 实验性 UI |

> **设计决策**：使用编译期 feature flags 而非运行时 feature flags（如 GrowthBook），有两个关键优势：(1) **性能** — 未启用的功能代码完全不存在于二进制文件中，零运行时开销；(2) **安全** — 内部实验性功能（如 `KAIROS`、`COORDINATOR_MODE`）不会出现在外部发布的二进制文件中，即使通过反编译也找不到。Claude Code 同时使用 GrowthBook 做**运行时**的 A/B 测试和渐进发布，两者互补。

### 内部 vs 外部构建

源码中的 `process.env.USER_TYPE` 区分内部和外部构建：

```typescript
// src/tools.ts — 内部工具条件加载
const REPLTool = process.env.USER_TYPE === 'ant'
  ? require('./tools/REPLTool/REPLTool.js').REPLTool
  : null

// src/main.tsx — 内部检测
if ("external" !== 'ant' && isBeingDebugged()) {
  process.exit(1)  // 外部构建禁止调试器附加
}
```

注意 `"external" !== 'ant'` — 这意味着在外部构建中，`process.env.USER_TYPE` 被编译期替换为字符串 `"external"`。这是另一层条件编译。

---

## 2.4 入口文件分析：main.tsx

`main.tsx` 是 Claude Code 的主入口文件，也是理解整个启动序列的关键。这个文件超过 2000 行，其复杂度反映了一个生产级 CLI 工具需要处理的所有边缘情况。

### 启动序列概览

```
用户输入: $ claude [args]
    │
    ▼
main.tsx 顶层执行
    │
    ├── [1] 性能基准点
    │     profileCheckpoint('main_tsx_entry')
    │
    ├── [2] 并行预加载（在 import 之前！）
    │     ├── startMdmRawRead()    # MDM 设置读取
    │     └── startKeychainPrefetch()  # 钥匙串预读
    │
    ├── [3] 所有 import 执行（~135ms）
    │     profileCheckpoint('main_tsx_imports_loaded')
    │
    ├── [4] 调试检测
    │     isBeingDebugged() → 外部构建禁止调试器
    │
    ├── [5] Commander.js CLI 解析
    │     ├── 注册全局选项（--print, --model, --dangerously-skip-permissions...）
    │     ├── 注册子命令（mcp, config, update, ...）
    │     └── 路由到对应处理函数
    │
    ├── [6] 初始化序列 init()
    │     ├── 加载设置（MDM, managed settings）
    │     ├── 初始化 GrowthBook (feature flags)
    │     ├── 认证检查（API Key / OAuth）
    │     └── 运行迁移 runMigrations()
    │
    ├── [7] 模式路由
    │     ├── --print → 非交互模式（runHeadless）
    │     ├── --resume → 恢复会话
    │     ├── REPL → 交互模式（launchRepl）
    │     └── SDK → QueryEngine 入口
    │
    └── [8] 进入主循环
          └── REPL.tsx → 等待用户输入 → query() → ...
```

### 关键代码片段

**1. 顶层副作用 — 并行预加载**

```typescript
// src/main.tsx 开头 — 这些必须在所有 import 之前执行
import { profileCheckpoint } from './utils/startupProfiler.js'
profileCheckpoint('main_tsx_entry')

import { startMdmRawRead } from './utils/settings/mdm/rawRead.js'
startMdmRawRead()  // 火并行子进程读取 MDM 设置

import { startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js'
startKeychainPrefetch()  // 并行读取 macOS 钥匙串
```

> **设计决策**：这三行代码必须在文件最顶部，在所有其他 `import` 之前。原因是 ES module 的 import 是同步求值的 — `main.tsx` 的 ~200 个 import 需要约 135ms 来执行。通过在第一个 import 之后立即启动 MDM 和钥匙串读取的子进程，这些 I/O 操作可以与后续 135ms 的模块加载**并行**执行，而不是串行等待。这是一个典型的**关键路径优化** — 把最慢的 I/O 提前到最早的时间点。

**2. 迁移系统**

```typescript
// src/main.tsx — 版本迁移
const CURRENT_MIGRATION_VERSION = 11

function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings()
    migrateBypassPermissionsAcceptedToSettings()
    migrateSonnet45ToSonnet46()
    migrateOpusToOpus1m()
    // ... 11 个迁移
    saveGlobalConfig(prev => ({
      ...prev,
      migrationVersion: CURRENT_MIGRATION_VERSION
    }))
  }
}
```

迁移系统确保在版本升级后，用户的配置文件能自动更新。每个迁移函数是幂等的，`migrationVersion` 作为水位线防止重复执行。

**3. 延迟预取**

```typescript
// src/main.tsx — 首次渲染后才执行的预取
export function startDeferredPrefetches(): void {
  if (isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER) ||
      isBareMode()) {
    return  // 性能测量模式和脚本模式跳过
  }

  void initUser()              // 用户信息初始化
  void getUserContext()        // 用户上下文预取
  void getRelevantTips()       // 提示信息
  void countFilesRoundedRg()   // 项目文件计数
  void refreshModelCapabilities()  // 模型能力刷新
  // ...
}
```

> **设计决策**：`startDeferredPrefetches()` 在 REPL 首次渲染**之后**才执行，不阻塞首屏。这些操作（用户信息、文件计数、模型能力）利用"用户正在打字"的时间窗口并行完成，当用户按下回车时结果已经就绪。对于 `--bare` 模式（脚本调用），这些预取全部跳过 — 脚本没有"用户打字"窗口，预取是纯开销。

---

## 2.5 依赖关系

### 核心依赖

从 `main.tsx` 的 import 声明和工具实现中，可以识别出 Claude Code 的核心依赖：

| 依赖 | 用途 | 位置 |
|------|------|------|
| `@anthropic-ai/sdk` | Anthropic API TypeScript SDK | services/api/ |
| `@modelcontextprotocol/sdk` | MCP 协议 SDK | services/mcp/ |
| `@commander-js/extra-typings` | CLI 参数解析 | main.tsx |
| `react` + `ink` | 终端 UI 渲染 | components/ |
| `chalk` | 终端颜色 | 全局 |
| `zod` | 运行时类型验证 | 多处 |
| `lodash-es` | 工具函数 | 多处 |
| `strip-ansi` | ANSI 清理 | 多处 |

### native 模块

```
vendor/
├── image-processor.node      # Rust (napi), 图像处理
├── audio-capture.node         # Rust (napi), 音频捕获
├── computer-use-swift.node    # Swift, macOS 屏幕控制
└── computer-use-input.node    # Rust (napi), 键鼠自动化
```

这些 native 模块服务于 **Computer Use** 功能。对于纯 CLI 编程助手场景，它们不会被加载。

### 外部工具依赖

| 工具 | 对应的 Claude Code 能力 | 调用方式 |
|------|----------------------|---------|
| `rg` (ripgrep) | GrepTool / 内容搜索 | child_process |
| `git` | 版本控制集成 | child_process |
| `sandbox-exec` (macOS) | Seatbelt 沙箱 | child_process |

---

## 2.6 打包方式

### 当前构建：bun build --compile

```
TypeScript 源码 (src/**/*.ts, src/**/*.tsx)
    │
    ▼
bun build --compile
    ├── TypeScript → JavaScript 转换
    ├── 依赖树解析 + 内联
    ├── feature() 静态求值 → dead code elimination
    ├── process.env.USER_TYPE 替换 → 内部/外部分离
    ├── Bun 运行时 (JavaScriptCore) 嵌入
    └── 输出独立二进制
    │
    ▼
独立可执行文件 (~100MB+)
    ├── Bun 运行时（JavaScriptCore 引擎）
    ├── 所有 JS/TS 代码（编译后）
    └── 内联的 npm 依赖
```

### 与旧版 esbuild 打包的对比

| 维度 | 旧版 (esbuild + npm) | 当前 (bun build --compile) |
|------|---------------------|--------------------------|
| 输出格式 | `main.mjs` (~12MB JS) | 独立二进制 (~100MB+) |
| 运行时依赖 | Node.js 18+ | 无（Bun 已嵌入） |
| 条件编译 | 无 | `bun:bundle` feature() |
| 分发方式 | npm install | curl / brew / winget |
| 启动速度 | Node.js 模块解析 | Bun 直接执行 |
| Tree-shaking | esbuild 静态分析 | feature() 编译期消除 |

---

## 2.7 运行时架构预览

当用户在终端输入 `claude` 并按下回车，从 `main.tsx` 到 `query.ts` 的完整启动路径：

```
$ claude
    │
    ▼
main.tsx
    │
    ├── [并行] MDM 读取 + 钥匙串预取
    ├── [同步] ~200 个 import 执行 (~135ms)
    ├── Commander.js 解析 process.argv
    │
    ├─── 子命令路由 ─────────────────────────────────────────┐
    │    │                                                    │
    │    ├── `claude mcp`  → MCP 管理                         │
    │    ├── `claude config` → 配置管理                       │
    │    ├── `claude -p "..."` → 非交互模式                   │
    │    │      └── QueryEngine.submitMessage()               │
    │    │             └── query() ← Agentic Loop             │
    │    │                                                    │
    │    └── `claude` (无参数) → 交互模式                     │
    │           │                                             │
    │           ▼                                             │
    │    init() ─ 初始化序列                                  │
    │    ├── 加载全局设置                                     │
    │    ├── 初始化 GrowthBook                                │
    │    ├── 认证检查                                         │
    │    ├── 运行迁移                                         │
    │    └── 信任对话框                                       │
    │           │                                             │
    │           ▼                                             │
    │    launchRepl() ─ 启动交互式 REPL                       │
    │    ├── Ink.render(<App>) ─ 初始化终端 UI                │
    │    ├── REPL.tsx ─ 渲染输入框                            │
    │    ├── startDeferredPrefetches() ─ 后台预取             │
    │    └── 等待用户输入                                     │
    │           │                                             │
    │           ▼                                             │
    │    用户输入 "Refactor UserService"                      │
    │    ├── processUserInput() ─ 处理输入                    │
    │    ├── 构建 System Prompt                               │
    │    └── query() ─ 进入 Agentic Loop                     │
    │           │                                             │
    │           ▼                                             │
    │    queryLoop() ─ while (true) 循环                     │
    │    ├── Phase 1: 上下文压缩 (compact/snip/micro)         │
    │    ├── Phase 2: API 流式调用 (callModel)                │
    │    ├── Phase 3: 终止判断 / 恢复                         │
    │    ├── Phase 4: 工具执行 (runTools)                     │
    │    └── Phase 5: 结果回注 → 下一轮                      │
    └─────────────────────────────────────────────────────────┘
```

---

## 小结

本章从"用户安装 Claude Code"的视角出发，逐层揭示了项目的构建与打包机制：

| 层次 | 关键发现 |
|------|---------|
| **安装方式** | 独立二进制（Bun 内嵌），不再需要 Node.js |
| **源码结构** | 500+ TypeScript 文件，按功能聚合（tools/, services/, commands/, components/） |
| **编译机制** | `bun:bundle` 的 `feature()` 实现编译期条件编译，20+ feature flags |
| **内外分离** | `feature()` + `process.env.USER_TYPE` 双重门控，内部功能在外部构建中完全消除 |
| **入口文件** | `main.tsx` — 并行预加载、CLI 解析、初始化、REPL 启动 |
| **启动优化** | MDM/钥匙串并行预取、延迟预取、profileCheckpoint 性能追踪 |

理解了"源码如何组织、如何构建"，我们就可以在下一章建立 Claude Code 的架构全景图 — 从七层架构到一个请求的完整数据流。

---

## 速查表

### 关键文件索引

| 文件 | 路径 | 职责 |
|------|------|------|
| main.tsx | `src/main.tsx` | CLI 主入口，启动序列 |
| cli.tsx | `src/entrypoints/cli.tsx` | CLI 入口点 |
| init.ts | `src/entrypoints/init.ts` | 初始化逻辑 |
| replLauncher.tsx | `src/replLauncher.tsx` | REPL 启动器 |
| App.tsx | `src/components/App.tsx` | React 应用顶层 |

### 关键函数索引

| 函数 | 文件 | 职责 |
|------|------|------|
| `profileCheckpoint()` | utils/startupProfiler.ts | 启动性能基准 |
| `startMdmRawRead()` | utils/settings/mdm/rawRead.ts | MDM 设置并行预读 |
| `startKeychainPrefetch()` | utils/secureStorage/keychainPrefetch.ts | 钥匙串并行预读 |
| `runMigrations()` | main.tsx | 配置版本迁移 |
| `startDeferredPrefetches()` | main.tsx | 首渲染后延迟预取 |
| `launchRepl()` | replLauncher.tsx | 启动交互式 REPL |
| `init()` | entrypoints/init.ts | 初始化序列 |
| `feature()` | bun:bundle | 编译期条件编译 |

### Feature Flags 速查

| Flag | 功能 | 内部/外部 |
|------|------|----------|
| `REACTIVE_COMPACT` | 响应式压缩 | 待确认 |
| `CONTEXT_COLLAPSE` | 上下文折叠 | 待确认 |
| `HISTORY_SNIP` | 历史裁剪 | 待确认 |
| `COORDINATOR_MODE` | 多 Worker 协调 | 内部 |
| `KAIROS` | 助手模式 | 内部 |
| `BRIDGE_MODE` | 桥接模式 | 待确认 |
| `CHICAGO_MCP` | Computer Use | 内部 |
| `TOKEN_BUDGET` | Token 预算 | 待确认 |
