
# 第 1 章：什么是 Claude Code

> **核心问题**：Claude Code 到底是什么？它和 Copilot、Cursor 这些 AI 编程工具有什么本质区别？为什么从原始 TypeScript 源码出发理解它，比反编译分析更有价值？

打开终端，输入 `claude`，你进入的不是一个编辑器插件，不是一个代码补全引擎，而是一个**自主运行的 Agent 系统**。它能读代码、改文件、跑测试、修 bug、甚至协调多个子 Agent 并行工作 — 全程只需要你用自然语言描述目标。

这是一个本质性的差异。大多数 AI 编程工具是"人驱动、AI 辅助"的 — 你在编辑器里写代码，AI 在旁边给建议。而 Claude Code 是"人指挥、Agent 执行"的 — 你说目标，Agent 自己规划路径、调用工具、循环迭代直到完成。

本章将建立对 Claude Code 的全景认知：它是什么，不是什么，能做什么，以及本书将如何剖析它。

---

## 1.1 Claude Code 是什么

### 一句话定义

**Claude Code 是一个运行在终端中的 Agentic 编程系统。**

拆解这句话的每个关键词：

| 关键词 | 含义 |
|--------|------|
| **终端** | 不依赖任何 IDE，在命令行中运行，通过 stdin/stdout 与用户交互 |
| **Agentic** | 不是单次问答，而是自主循环 — 思考、行动、观察、再思考，直到任务完成 |
| **编程系统** | 不只是"聊天"，而是具备完整的文件操作、命令执行、版本控制、安全管控等能力的系统 |

### 不是什么

理解 Claude Code，首先要清楚它**不是什么**：

- **不是 IDE 插件** — 它不嵌入 VS Code 或 JetBrains，它本身就是交互界面
- **不是代码补全** — 它不在你打字时给出续写建议，它独立地读、写、执行代码
- **不是聊天机器人** — 它不只是回答问题，它会主动采取行动来完成任务
- **不是代码生成器** — 它不是输入需求输出代码片段，它在真实项目中做真实的修改

### 运行时全景

当你执行 `claude` 命令时，发生了什么？让我们从源码的真实入口开始追踪：

```
Terminal                                Claude Code Process
┌──────────────────┐                   ┌─────────────────────────────────────┐
│  $ claude        │                   │  main.tsx                           │
│                  │  user input        │  ┌─────────────┐                    │
│  > Refactor      │ ──────────────────▶│  │ query()     │  Agentic Loop     │
│    UserService   │                   │  │  query.ts    │  (async generator) │
│                  │                   │  └──────┬──────┘                    │
│                  │                   │         │                            │
│                  │                   │  ┌──────▼──────┐                    │
│  Searching...    │ ◀────────────────  │  │ Tool System │  40+ built-in     │
│                  │  streaming output  │  │  tools.ts   │  + MCP extensions │
│  Reading file... │ ◀────────────────  │  └──────┬──────┘                    │
│                  │                   │         │                            │
│  Editing file... │ ◀────────────────  │  ┌──────▼──────┐                    │
│                  │                   │  │ Permission  │  sandbox guard     │
│  Running tests.. │ ◀────────────────  │  │ + Sandbox   │                    │
│                  │                   │  └─────────────┘                    │
│  Done            │ ◀────────────────  │                                     │
└──────────────────┘                   └─────────────────────────────────────┘
                                               │
                                        ┌──────▼──────┐
                                        │ Anthropic   │
                                        │ API Server  │
                                        │ (Claude)    │
                                        └─────────────┘
```

整个过程中，Claude Code 自主完成了：搜索代码 → 读取文件 → 理解结构 → 编辑代码 → 运行测试 → 确认结果。这个"**自主循环直到完成**"的能力，就是 Agentic 的核心含义。

从源码角度看，这个循环的核心是 `src/query.ts` 中的 `query()` 函数 — 一个 `async function*`（异步生成器），通过 `while (true)` 驱动 Agent 不断"调用 API → 解析响应 → 执行工具 → 回注结果"，直到模型认为任务完成：

```typescript
// src/query.ts — Agentic Loop 的真实入口
export async function* query(params: QueryParams): AsyncGenerator<...> {
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  return terminal
}

async function* queryLoop(params: QueryParams, ...): AsyncGenerator<...> {
  // ...
  while (true) {
    // Phase 1: Context preprocessing (compact, snip, microcompact)
    // Phase 2: API call (streaming)
    // Phase 3: Tool execution
    // Phase 4: Result injection → continue loop
    // Phase 5: Termination check
  }
}
```

> **设计决策**：Claude Code 选择终端而非 IDE 插件作为载体，这不是技术限制，而是架构选择。终端环境意味着：(1) 不依赖任何特定 IDE，开发者可以用任何编辑器；(2) 天然支持远程 SSH 和容器环境；(3) 可以被脚本调用，融入 CI/CD 流水线（`claude -p "fix all tests"`）。这个决策让 Claude Code 成为一个**通用的编程 Agent 平台**，而不是某个编辑器的附属品。

---

## 1.2 与其他 AI 编程工具的区别

市面上的 AI 编程工具可以按交互模式分为三种类型：

### 三种交互模式

```
Completion-based              IDE-embedded                 Terminal Agent
(GitHub Copilot)             (Cursor, Windsurf)           (Claude Code)

┌────────────────┐           ┌────────────────┐           ┌────────────────┐
│   IDE Editor   │           │   IDE Editor   │           │   Terminal     │
│                │           │                │           │                │
│  def foo():    │           │  [Chat Panel]  │           │  > "Refactor   │
│    ret█        │           │  "Rewrite this │           │     module"    │
│       ↑        │           │   function"    │           │                │
│   AI: "urn x"  │           │       ↓        │           │  Agent runs    │
│                │           │  AI gen diff   │           │  autonomously  │
│  Human writes  │           │  Human review  │           │  read→edit→    │
│  AI completes  │           │  & apply       │           │  test→fix→done │
│                │           │                │           │                │
│  Human drives  │           │  Human drives  │           │  Human states  │
│  AI assists    │           │  AI edits      │           │  Agent does    │
└────────────────┘           └────────────────┘           └────────────────┘
```

### 详细对比

| 维度 | GitHub Copilot | Cursor / Windsurf | Claude Code |
|------|---------------|-------------------|-------------|
| **交互模式** | 行内补全 + Chat | IDE 内对话 + Diff 预览 | 终端自然语言对话 |
| **载体** | IDE 插件 | 定制 IDE (VSCode fork) | 独立 CLI 程序 |
| **运行时** | Node.js (plugin) | Electron + Node.js | **Bun** (JavaScriptCore) |
| **Agent 能力** | 弱（单次补全为主） | 中（可多步操作） | 强（完整 Agentic Loop） |
| **工具调用** | 有限 | 文件编辑 + 终端 | 40+ 内置工具 + MCP 扩展 |
| **自主性** | 低 — 每步需人确认 | 中 — 可连续操作 | 高 — 自主循环至完成 |
| **安全模型** | IDE 权限 | IDE 权限 | 独立沙箱 + 权限分级 |
| **多 Agent** | 否 | 否 | Sub-Agent / Fork / Team |
| **环境依赖** | 特定 IDE | Cursor IDE | 任意终端 |
| **CI/CD 集成** | 间接 | 不支持 | 原生支持 (`claude -p`) |
| **MCP 扩展** | 部分 | 部分 | 完整协议支持 |
| **SDK** | 否 | 否 | 完整 SDK (`QueryEngine`) |

### 本质区别：控制权的转移

这三种模式的核心差异不在技术细节，而在**控制权的分配**：

- **Copilot**：人写代码，AI 猜你要写什么 — 控制权完全在人
- **Cursor**：人说要改什么，AI 提供 diff，人审核后应用 — 控制权大部分在人
- **Claude Code**：人说目标，Agent 自主规划路径和执行 — 控制权大部分在 Agent

控制权转移带来的挑战是**信任**。你把更多自主权交给 Agent，就需要更强的安全机制来保证它不会搞砸。这就是为什么 Claude Code 的源码中有一个完整的安全体系 — `src/utils/permissions/`（权限引擎）、`src/utils/sandbox/`（沙箱适配器）、`src/utils/hooks/`（生命周期拦截） — 这些在补全式工具中根本不需要。

从源码看，安全不是"加上去的" — 它内嵌在 Tool 定义的接口中：

```typescript
// src/Tool.ts — 每个工具的权限声明是接口的一部分
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode          // 'default' | 'plan' | 'auto' | 'bypass'
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  // ...
}>
```

---

## 1.3 核心能力概览

Claude Code 是一个复杂的系统。在深入源码之前，先建立一个能力全景图。以下每个能力都对应源码中的真实模块：

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Code                              │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ Agentic Loop     │  │ System Prompt│  │ Context Mgmt    │  │
│  │  query.ts        │  │  queryContext│  │  compact/       │  │
│  │  QueryEngine.ts  │  │  .ts         │  │  autoCompact.ts │  │
│  └──────┬───────────┘  └──────────────┘  └─────────────────┘  │
│         │                                                       │
│  ┌──────▼──────────────────────────────────────────────────┐   │
│  │              Tool System (tools.ts + tools/)            │   │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌───────┐ │   │
│  │  │BashTool│ │FileRead│ │FileEdit│ │GlobTool│ │  MCP  │ │   │
│  │  │        │ │Tool    │ │Tool    │ │GrepTool│ │  Tool │ │   │
│  │  └────────┘ └────────┘ └────────┘ └────────┘ └───────┘ │   │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────────────────┐│   │
│  │  │WebFetch│ │  Agent │ │WebSrch │ │  + 30 more tools   ││   │
│  │  │Tool    │ │  Tool  │ │Tool    │ │                    ││   │
│  │  └────────┘ └────────┘ └────────┘ └────────────────────┘│   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Permission   │  │   Sandbox    │  │  Multi-Agent         │  │
│  │ permissions/ │  │  sandbox/    │  │  AgentTool/          │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Hooks        │  │ Commands +   │  │  Terminal UI         │  │
│  │ hooks/       │  │ Skills       │  │  components/ (Ink)   │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 逐一概览

| 能力 | 源码位置 | 一句话描述 |
|------|---------|-----------|
| **Agentic Loop** | `query.ts`, `QueryEngine.ts` | 持续"思考→行动→观察"循环，是 Agent 的心跳 |
| **API Client** | `services/api/claude.ts`, `client.ts` | 流式 SSE 通信引擎，支持多 Provider |
| **System Prompt** | `utils/queryContext.ts` | 动态组装的行为指令，根据项目和工具自适应 |
| **Context 管理** | `services/compact/` | 多级压缩策略管理 200K 上下文窗口 |
| **工具系统** | `tools.ts`, `Tool.ts`, `tools/` | 40+ 内置工具的统一注册、调度和执行框架 |
| **Bash 工具** | `tools/BashTool/` | 在沙箱中执行任意 shell 命令 |
| **File I/O** | `tools/FileReadTool/`, `FileEditTool/`, `FileWriteTool/` | 精确的文件读写、编辑操作 |
| **搜索工具** | `tools/GlobTool/`, `GrepTool/` | 文件路径搜索与内容搜索 |
| **MCP 协议** | `services/mcp/` | 通过标准协议扩展工具能力 |
| **权限系统** | `utils/permissions/` | 五层级联配置 + deny-first 规则引擎 |
| **安全沙箱** | `utils/sandbox/` | macOS Seatbelt / Linux 隔离 |
| **Hooks 系统** | `utils/hooks/` | 工具执行前后的生命周期拦截点 |
| **多智能体** | `tools/AgentTool/` | Sub-Agent / Fork / Team 三层协作 |
| **Slash 命令** | `commands/`, `commands.ts` | 90+ 命令 (commit, review, plan...) |
| **Skill 系统** | `skills/` | YAML 定义的 AI 工作流 |
| **Terminal UI** | `components/` | 基于 Ink (React) 的终端渲染引擎 |

这些能力不是孤立的，它们构成了一个紧密耦合的系统。`query()` 驱动工具调用，工具调用受权限系统管控，权限系统由配置层级决定，沙箱为工具执行提供安全边界，Hooks 在每个环节提供拦截点。

---

## 1.4 使用场景

### 适合什么任务

Claude Code 的 Agentic 特性使它特别擅长**需要多步骤、跨文件、需要理解上下文**的任务：

**大型重构**
```
> "把整个项目的错误处理从 callback 改为 async/await"
  Agent 会：搜索所有 callback 用法 → 逐文件改写 → 更新调用方 → 运行测试 → 修复失败
```

**Bug 诊断与修复**
```
> "用户反馈登录后偶尔白屏，帮我排查"
  Agent 会：读错误日志 → 搜索相关代码 → 分析可能原因 → 添加修复 → 编写测试用例
```

**代码库探索**
```
> "这个项目的认证流程是怎么实现的？"
  Agent 会：搜索认证相关文件 → 阅读核心模块 → 追踪调用链 → 输出结构化分析
```

**自动化流程**（非交互模式）
```bash
# 用 -p 参数实现管道式自动化
claude -p "读取 API spec，生成对应的 TypeScript 类型定义和测试"
```

**SDK 集成**
```typescript
// 使用 QueryEngine 嵌入到自己的应用中
import { QueryEngine } from './QueryEngine.js'
const engine = new QueryEngine({ cwd, tools, commands, ... })
for await (const msg of engine.submitMessage("Fix the bug")) {
  console.log(msg)
}
```

### 不适合什么任务

| 场景 | 原因 |
|------|------|
| **实时代码补全** | Claude Code 不嵌入编辑器，不提供打字时的补全建议 |
| **UI/视觉调试** | 纯终端环境，无法直接预览前端界面（但支持 Computer Use） |
| **需要即时反馈的小修改** | 如果只是改个变量名，直接在编辑器里改更快 |
| **超大代码库的全局分析** | 200K 上下文窗口是硬限制，极大代码库需要分治策略 |

> **设计决策**：Claude Code 不试图取代 IDE。它的定位是**高自主性的编程 Agent** — 处理那些人类开发者觉得繁琐、重复、需要大量上下文的任务。从源码可以看到，Anthropic 在 Agentic Loop（`query.ts` 1700+ 行）和工具系统（`tools/` 目录 40+ 工具）上的投入远超 UI 渲染（`components/`），这正是这个定位的体现。

---

## 1.5 本书的分析方法

### 为什么分析原始源码

本书的前作基于反编译的混淆 JavaScript 进行分析 — 所有函数名被替换为无意义的短标识符（如 `av()`、`xi1()`），需要靠字符串常量和调用上下文推测语义。这种方法虽然能还原架构轮廓，但有固有局限：

| 维度 | 反编译分析 | 原始源码分析 |
|------|----------|------------|
| **函数命名** | 猜测：`av()` → "agentExecute" | 真实：`query()`, `queryLoop()` |
| **文件结构** | 一个 503K 行文件，手工拆分 | 真实目录结构，数百个 `.ts` 文件 |
| **注释** | 全部丢失 | 保留原始注释和 JSDoc |
| **类型信息** | 丢失 | 完整的 TypeScript 类型定义 |
| **设计意图** | 只能推测 | 注释直接说明（如 "The rules of thinking are lengthy..."） |
| **模块边界** | 模糊 | 清晰的 `import`/`export` |

举一个具体的例子。在反编译版本中，Agentic Loop 的核心被标记为 `xi1()` (mainLoop)。在原始源码中，它是：

```typescript
// src/query.ts — 真实的函数名和详尽的注释
/**
 * The rules of thinking are lengthy and fortuitous. They require plenty
 * of thinking of most long duration and deep meditation for a wizard to
 * wrap one's noggin around.
 *
 * The rules follow:
 * 1. A message that contains a thinking or redacted_thinking block must
 *    be part of a query whose max_thinking_length > 0
 * 2. A thinking block may not be the last message in a block
 * 3. Thinking blocks must be preserved for the duration of an assistant
 *    trajectory
 *
 * Heed these rules well, young wizard. For they are the rules of thinking,
 * and the rules of thinking are the rules of the universe.
 */
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3
```

这段注释在反编译版本中完全不可见。它不仅说明了技术规则，还透露了 Anthropic 工程师的幽默感和团队文化。

### 源码规模

从源码目录的统计来看，Claude Code 的规模远超一般的 CLI 工具：

| 指标 | 数值 |
|------|------|
| TypeScript/TSX 文件数 | 500+ |
| 工具实现目录 | 40+ (tools/) |
| Slash 命令目录 | 90+ (commands/) |
| 服务模块 | 30+ (services/) |
| 工具函数 | 100+ (utils/) |
| React 组件 | 80+ (components/) |

### 关键入口文件

理解 Claude Code 的最佳起点是这五个文件：

| 文件 | 职责 | 为什么重要 |
|------|------|-----------|
| `main.tsx` | CLI 入口 | 整个程序的起点，Commander.js 参数解析，启动序列 |
| `query.ts` | Agentic Loop | Agent 的心跳 — `query()` → `queryLoop()` 循环 |
| `QueryEngine.ts` | 查询引擎 | SDK/headless 模式的入口，`submitMessage()` 方法 |
| `Tool.ts` | 工具接口 | `ToolUseContext` 类型定义 — 贯穿全系统的上下文 |
| `tools.ts` | 工具注册 | `getAllBaseTools()` — 40+ 工具的注册表 |

---

## 1.6 从源码看 Claude Code 的技术栈

通过 `main.tsx` 的 import 声明，我们可以精确识别 Claude Code 的技术栈：

```typescript
// src/main.tsx — 前 200 行的 import 揭示了完整技术栈
import { feature } from 'bun:bundle'                    // Bun 运行时 + 编译期 feature flags
import { Command as CommanderCommand } from '@commander-js/extra-typings'  // CLI 框架
import chalk from 'chalk'                                 // 终端颜色
import React from 'react'                                 // UI 框架基础
// ... (Ink 用于终端渲染，在 components/ 中)
import { getOauthConfig } from './constants/oauth.js'    // OAuth 认证
import { init } from './entrypoints/init.js'             // 初始化入口
import { launchRepl } from './replLauncher.js'           // REPL 启动器
import { initializeGrowthBook } from './services/analytics/growthbook.js'  // Feature flags (运行时)
import { SandboxManager } from './utils/sandbox/sandbox-adapter.js'        // 沙箱管理
```

### 技术栈总结

```
┌─────────────────────────────────────────────────────────┐
│                    Claude Code 技术栈                     │
├─────────────────────────────────────────────────────────┤
│  Runtime    │ Bun (JavaScriptCore) — 非 Node.js         │
│  Language   │ TypeScript (严格模式)                       │
│  CLI        │ Commander.js (@commander-js/extra-typings)  │
│  UI         │ Ink (React for CLI) + React 19             │
│  API        │ @anthropic-ai/sdk (Anthropic TS SDK)       │
│  MCP        │ @modelcontextprotocol/sdk                   │
│  Build      │ bun build --compile + bun:bundle feature()  │
│  Analytics  │ GrowthBook (feature flags) + Statsig        │
│  Auth       │ OAuth 2.0 + API Key                         │
│  Sandbox    │ macOS Seatbelt / Linux Landlock              │
│  Search     │ ripgrep (rg)                                 │
│  VCS        │ git (child_process)                          │
└─────────────────────────────────────────────────────────┘
```

> **设计决策**：Claude Code 选择 **Bun** 而非 Node.js 作为运行时，这是一个重要的技术选择。Bun 的 `bun build --compile` 能将 TypeScript 源码 + 运行时打包为**独立二进制文件**，消除了对用户系统 Node.js 版本的依赖。同时，Bun 的 `bun:bundle` 提供了编译期 feature flags（`feature('FLAG_NAME')`），实现了优雅的 dead code elimination — 外部构建可以在编译时剥离内部功能，而无需运行时分支判断。

---

## 小结

本章建立了对 Claude Code 的基本认知：

1. **它是什么** — 运行在终端的 Agentic 编程系统，核心循环在 `query.ts` 的 `query()` 函数中
2. **它不是什么** — 不是 IDE 插件、不是代码补全、不是聊天机器人
3. **与同类的区别** — 从"AI 辅助人写代码"进化到"人指挥 Agent 做任务"，核心差异是控制权的转移
4. **能力全景** — 40+ 工具、90+ 命令、多智能体协作，分布在 500+ TypeScript 文件中
5. **使用场景** — 擅长多步骤、跨文件、需要上下文的任务；不适合即时补全和 UI 交互
6. **分析方法** — 基于原始 TypeScript 源码，使用真实文件名和函数名，无需猜测
7. **技术栈** — Bun 运行时、TypeScript、Ink/React、Commander.js、bun:bundle feature flags

从下一章开始，我们将深入 Claude Code 的内部 — 首先是安装与打包（第 2 章），然后是架构总览（第 3 章），接着进入核心架构的逐层拆解。

---

## 速查表

### 关键文件索引

| 文件 | 路径 | 职责 |
|------|------|------|
| main.tsx | `src/main.tsx` | CLI 主入口，启动序列 |
| query.ts | `src/query.ts` | Agentic Loop 核心 |
| QueryEngine.ts | `src/QueryEngine.ts` | SDK/headless 查询引擎 |
| Tool.ts | `src/Tool.ts` | 工具接口 + ToolUseContext |
| tools.ts | `src/tools.ts` | 工具注册表 |
| commands.ts | `src/commands.ts` | 命令注册表 |
| App.tsx | `src/components/App.tsx` | React 应用顶层组件 |

### 关键函数索引

| 函数 | 文件 | 职责 |
|------|------|------|
| `query()` | query.ts | Agentic Loop 入口 |
| `queryLoop()` | query.ts | 循环体 (while true) |
| `submitMessage()` | QueryEngine.ts | SDK 提交消息入口 |
| `ask()` | QueryEngine.ts | 一次性查询便捷函数 |
| `getAllBaseTools()` | tools.ts | 获取所有内置工具 |
| `getTools()` | tools.ts | 获取过滤后的工具列表 |
| `getCommands()` | commands.ts | 获取所有 Slash 命令 |
