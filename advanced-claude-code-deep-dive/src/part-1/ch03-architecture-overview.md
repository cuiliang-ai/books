
# 第 3 章：架构总览

> **核心问题**：一个由 500+ TypeScript 文件、40+ 工具、90+ 命令、多层安全防线组成的 Coding Agent，整体架构是什么样的？在深入每一个子系统之前，我们需要一张完整的地图。

一座城市如果没有地图，你只能在街巷中摸索。Claude Code 的代码库也是如此 — 数百个 TypeScript 文件分布在 10+ 个顶层目录中，包含 Agentic Loop、工具系统、权限引擎、流式 API 客户端、多智能体协作、终端 UI 等十多个子系统。如果直接跳入某个模块的细节，很容易迷失在函数调用链中。

本章是整本书的"地图"。我们将从最高层的系统全景开始，逐层拆解 Claude Code 的架构分层、六大核心子系统、一个请求的完整数据流、源码目录的依赖关系，最后预览贯穿全系统的设计哲学。读完本章后，你将拥有一个清晰的导航框架 — 无论后续深入哪一章，都能准确定位"我在看什么、它属于哪一层、它和其他部分如何协作"。

---

## 3.1 系统全景图：七层架构

Claude Code 的整体架构可以从上到下分为七个层次。每一层解决一类特定的问题，层与层之间通过明确的接口交互：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                     USER LAYER  [用户层]                            │   │
│   │                                                                     │   │
│   │   Terminal UI (Ink/React)    CLI Arguments    REPL / One-shot       │   │
│   │   components/App.tsx         main.tsx          replLauncher.tsx     │   │
│   │   ├─ 80+ React Components   ├─ --print       ├─ Interactive Mode   │   │
│   │   ├─ 6+ Themes              ├─ --dangerously  ├─ Conversation      │   │
│   │   ├─ Keybinding Engine      │   -skip-perms   │   History          │   │
│   │   └─ Streaming Markdown     └─ --model        └─ Session Resume    │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                       │                                     │
│                                       ▼                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                   COMMAND LAYER  [命令层]                           │   │
│   │                                                                     │   │
│   │   commands.ts ── 90+ Slash Commands                                │   │
│   │   ├─ /commit, /review, /compact, /config, /mcp ...                │   │
│   │   ├─ skills/ ── Skill System (YAML-defined AI workflows)          │   │
│   │   └─ MCP Prompts (server-provided prompts)                        │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                       │                                     │
│                                       ▼                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                     CORE LAYER  [核心层]                            │   │
│   │                                                                     │   │
│   │   query.ts ── Agentic Loop       queryContext.ts     compact/      │   │
│   │   ├─ query() async generator     ├─ System Prompt    ├─ L1 Replace │   │
│   │   ├─ queryLoop() while(true)     ├─ CLAUDE.md inject ├─ L2 Micro  │   │
│   │   ├─ streaming tool dispatch     ├─ cache partition  ├─ L3 Auto   │   │
│   │   └─ multi-layer recovery        └─ dynamic assembly│   Compact   │   │
│   │                                                      └─ snip/     │   │
│   │   QueryEngine.ts ── SDK Entry                          collapse    │   │
│   │   └─ submitMessage() for headless/SDK usage                        │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                       │                                     │
│                                       ▼                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                   CAPABILITY LAYER  [能力层]                        │   │
│   │                                                                     │   │
│   │   tools.ts ── Tool Registry                                        │   │
│   │   getAllBaseTools() → 40+ built-in tools                           │   │
│   │                                                                     │   │
│   │   tools/BashTool/         tools/FileReadTool/   tools/GlobTool/   │   │
│   │   tools/FileEditTool/     tools/FileWriteTool/  tools/GrepTool/   │   │
│   │   tools/AgentTool/        tools/WebFetchTool/   tools/MCPTool/    │   │
│   │   tools/SkillTool/        tools/WebSearchTool/  tools/...         │   │
│   │                                                                     │   │
│   │   services/mcp/ ── MCP Protocol                                    │   │
│   │   ├─ config.ts (multi-source config)                               │   │
│   │   ├─ client.ts (connection management)                             │   │
│   │   └─ Tools / Prompts / Resources                                   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                       │                                     │
│                                       ▼                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                   SECURITY LAYER  [安全层]                          │   │
│   │                                                                     │   │
│   │   utils/permissions/        utils/sandbox/       utils/hooks/      │   │
│   │   ├─ permissions.ts         ├─ sandbox-adapter   ├─ hookHelpers    │   │
│   │   ├─ permissionSetup.ts     │   .ts              ├─ postSampling   │   │
│   │   ├─ PermissionMode.ts      ├─ macOS Seatbelt   │   Hooks.ts      │   │
│   │   └─ deny-first rules       ├─ Linux Landlock   └─ 5 lifecycle    │   │
│   │                              └─ Docker isolation     events        │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                       │                                     │
│                                       ▼                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                 COLLABORATION LAYER  [协作层]                       │   │
│   │                                                                     │   │
│   │   tools/AgentTool/                                                 │   │
│   │   ├─ runAgent.ts ── Sub-Agent (independent context)                │   │
│   │   ├─ forkSubagent.ts ── Fork (inherited context, shared cache)    │   │
│   │   └─ TeamCreateTool/ ── Team (independent process, messaging)     │   │
│   │                                                                     │   │
│   │   coordinator/ ── Coordinator Mode (multi-worker)                  │   │
│   │   bridge/ ── Remote Bridge (Claude Desktop integration)            │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                       │                                     │
│                                       ▼                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                 COMMUNICATION LAYER  [通信层]                       │   │
│   │                                                                     │   │
│   │   services/api/claude.ts ── API Client (Multi-Provider)            │   │
│   │   ├─ First-Party (Anthropic)                                       │   │
│   │   ├─ AWS Bedrock (SigV4)                                           │   │
│   │   ├─ Google Vertex (GoogleAuth)                                    │   │
│   │   └─ Retry + Backoff + Rate Limit (withRetry.ts)                  │   │
│   │                                                                     │   │
│   │   SSE Streaming ── services/api/client.ts                          │   │
│   │   └─ @anthropic-ai/sdk → Stream → AsyncIterator → content blocks  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

> **设计决策**：七层架构中，核心层（`query.ts` 的 Agentic Loop + System Prompt + Context Management）是整个系统的"心脏"，但它本身不直接与外界交互 — 向上通过命令层和用户层接收输入，向下通过能力层操作真实世界，旁边通过安全层约束行为。这种"核心无副作用、边界做脏活"的设计，使得 Agentic Loop 可以保持简洁的流式状态机模型，而不被 I/O、安全检查等关注点污染。

理解这张全景图的关键在于：**每一层只关心自己的职责**。用户层不知道 API 用的是 Anthropic 还是 Bedrock，能力层不关心安全规则是 deny 还是 allow，通信层不在乎消息会显示在终端还是管道输出。这种职责分离是 Claude Code 在 200K+ 行 TypeScript 代码规模下保持可维护性的基础。

---

## 3.2 六大核心子系统概述

全景图中的七层可以进一步归纳为六个核心子系统。每个子系统在后续章节中都有专门的深度分析，这里只做"导游式"介绍。

### 3.2.1 Agentic Loop — Agent 的心跳

**解决的问题**：如何让一个 LLM 从"一问一答"进化为"自主执行多步任务直至完成"？

**源码位置**：`src/query.ts`（核心循环）、`src/QueryEngine.ts`（SDK 入口）

Agentic Loop 是 Claude Code 最核心的子系统。它本质上是一个**流式 async generator 状态机**，驱动着"调用 API → 解析响应 → 执行工具 → 回注结果 → 继续"的循环。

三个关键入口函数构成了 Loop 的执行链：

```
QueryEngine.submitMessage()  — SDK/Headless 入口
  └→ query()                 — 外层包装（命令生命周期管理）
      └→ queryLoop()         — 真正的循环体：while (true)
```

让我们看看 `queryLoop()` 的真实结构。它是一个 ~1500 行的 `while (true)` 循环，每一轮执行以下阶段：

```typescript
// src/query.ts — queryLoop() 的核心结构（简化）
async function* queryLoop(params, consumedCommandUuids) {
  let state: State = { messages, toolUseContext, turnCount: 1, ... }

  while (true) {
    // Phase 1: Context Preprocessing
    messagesForQuery = await applyToolResultBudget(messagesForQuery, ...)
    messagesForQuery = snipModule.snipCompactIfNeeded(messagesForQuery)
    messagesForQuery = await deps.microcompact(messagesForQuery, ...)
    const { compactionResult } = await deps.autocompact(messagesForQuery, ...)

    // Phase 2: API Streaming Call
    for await (const message of deps.callModel({ messages, systemPrompt, tools, ... })) {
      yield message  // 流式输出到 UI
      if (message.type === 'assistant') {
        // 收集 tool_use blocks
        toolUseBlocks.push(...msgToolUseBlocks)
        needsFollowUp = true
      }
    }

    // Phase 3: Termination Check
    if (!needsFollowUp) {
      // 模型没有调用工具 → 任务可能完成
      // 处理 prompt-too-long 恢复、max_output_tokens 恢复、stop hooks
      return { reason: 'completed' }
    }

    // Phase 4: Tool Execution
    for await (const update of runTools(toolUseBlocks, ...)) {
      yield update.message  // 工具结果流式输出
    }

    // Phase 5: Result Injection → Continue
    state = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      turnCount: nextTurnCount,
      transition: { reason: 'next_turn' },
    }
    // → 回到 while (true) 顶部
  }
}
```

Agentic Loop 的设计精髓在于两点：

1. **流式管道** — 通过 `async function*` 和 `yield`，API 的流式输出、工具执行结果都是逐条推送给调用方的，无需等待整个循环完成
2. **状态机式 continue** — 循环的每个"继续"点（`state = next; continue`）都是一个明确的状态转换，有 7 种不同的继续原因（`next_turn`, `reactive_compact_retry`, `max_output_tokens_recovery`, `stop_hook_blocking`, `collapse_drain_retry`, `max_output_tokens_escalate`, `token_budget_continuation`）

> 详细分析见第 4 章

### 3.2.2 工具系统 — Agent 的执行臂

**解决的问题**：LLM 只能生成文本，如何让它"动手"操作文件、执行命令、搜索代码？

**源码位置**：`src/Tool.ts`（接口定义）、`src/tools.ts`（注册表）、`src/tools/`（40+ 实现）

工具系统的核心是 `getAllBaseTools()` 函数，它返回所有内置工具的列表：

```typescript
// src/tools.ts — 工具注册表（简化）
export function getAllBaseTools(): Tools {
  return [
    AgentTool,          // 子 Agent 委派
    TaskOutputTool,     // 任务输出
    BashTool,           // Shell 命令执行
    GlobTool,           // 文件路径搜索
    GrepTool,           // 内容搜索（ripgrep）
    FileReadTool,       // 文件读取
    FileEditTool,       // 文件编辑（diff-based）
    FileWriteTool,      // 文件写入
    NotebookEditTool,   // Jupyter Notebook
    WebFetchTool,       // URL 抓取
    WebSearchTool,      // 网络搜索
    TodoWriteTool,      // 任务管理
    SkillTool,          // Skill 调用
    AskUserQuestionTool,// 向用户提问
    EnterPlanModeTool,  // 进入计划模式
    ExitPlanModeV2Tool, // 退出计划模式
    // ... 更多工具（条件加载）
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    ...(isAgentSwarmsEnabled() ? [getTeamCreateTool(), getTeamDeleteTool()] : []),
    ...(WorkflowTool ? [WorkflowTool] : []),
    ListMcpResourcesTool,
    ReadMcpResourceTool,
  ]
}
```

每个工具遵循统一的 `Tool` 接口（定义在 `src/Tool.ts`），核心属性包括：

| 属性 | 类型 | 用途 |
|------|------|------|
| `name` | string | 工具名称（API 注册用） |
| `description` | string | 工具描述（给 LLM 看） |
| `inputSchema` | zod schema | 输入参数的运行时校验 |
| `isConcurrencySafe()` | function | 是否可以并行执行 |
| `isEnabled()` | function | 是否在当前环境启用 |
| `call()` | async function | 执行入口 |

工具调用的调度由 `src/services/tools/toolOrchestration.ts` 中的 `runTools()` 负责。一个关键设计是**并发安全分区**：

```typescript
// src/services/tools/toolOrchestration.ts — 工具并发调度
function partitionToolCalls(toolUseMessages, toolUseContext): Batch[] {
  // 将工具调用分区：
  // - 连续的只读工具 → 一个批次，并行执行
  // - 非只读工具 → 单独一个批次，串行执行
}

export async function* runTools(...) {
  for (const { isConcurrencySafe, blocks } of partitionToolCalls(...)) {
    if (isConcurrencySafe) {
      yield* runToolsConcurrently(blocks, ...)   // GlobTool + GrepTool → 并行
    } else {
      yield* runToolsSerially(blocks, ...)       // FileEditTool → 串行
    }
  }
}
```

> **设计决策**：工具并发分区的粒度是**批次**而非**工具**。当模型在一次响应中调用了 `[Glob, Grep, Grep, Edit, Read, Read]`，分区结果是 `[{并行: [Glob, Grep, Grep]}, {串行: [Edit]}, {并行: [Read, Read]}]`。这比全部串行快 2-3 倍，同时保证了写操作的顺序语义。

> 详细分析见第 9-13 章

### 3.2.3 安全体系 — Agent 的行为围栏

**解决的问题**：一个拥有 Bash 执行权限的 Agent，如何做到"该做的自动做，不该做的绝不做"？

**源码位置**：`src/utils/permissions/`、`src/utils/sandbox/`、`src/utils/hooks/`

Claude Code 的安全体系由三道防线组成，形成**纵深防御**：

```
第一道防线：权限系统 (utils/permissions/)
  ├─ PermissionMode.ts: 5 种权限模式 (default/plan/acceptEdits/auto/bypass)
  ├─ permissions.ts: deny-first 规则引擎
  └─ permissionSetup.ts: 运行时权限初始化

第二道防线：沙箱 (utils/sandbox/)
  ├─ sandbox-adapter.ts: 平台适配（SandboxManager）
  ├─ macOS: Seatbelt (sandbox-exec)
  └─ Linux: Landlock + Seccomp

第三道防线：Hooks (utils/hooks/)
  ├─ hookHelpers.ts: Hook 执行引擎
  ├─ postSamplingHooks.ts: 采样后 Hook
  └─ 5 个生命周期事件: SessionStart/PreToolUse/PostToolUse/Notification/Stop
```

从源码看，权限检查的入口是 `ToolPermissionContext`（定义在 `src/Tool.ts`）：

```typescript
// src/Tool.ts — 权限上下文贯穿整个 ToolUseContext
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode                    // 当前权限模式
  alwaysAllowRules: ToolPermissionRulesBySource  // 始终允许规则
  alwaysDenyRules: ToolPermissionRulesBySource   // 始终拒绝规则
  alwaysAskRules: ToolPermissionRulesBySource    // 始终询问规则
  isBypassPermissionsModeAvailable: boolean
  shouldAvoidPermissionPrompts?: boolean  // 后台 Agent 不弹对话框
}>
```

三道防线各司其职：权限系统做"逻辑检查"（这条命令是否在白名单中），沙箱做"物理隔离"（即使命令绕过检查也无法越界），Hooks 做"可编程增强"（执行前格式化检查、执行后日志审计）。

> 详细分析见第 14-16 章

### 3.2.4 多智能体协作 — Agent 的分身术

**解决的问题**：当任务复杂到单个 Agent 效率低下时，如何将工作分解给多个协作单元？

**源码位置**：`src/tools/AgentTool/`

Claude Code 提供了三层递进的协作模式：

| 模式 | 源文件 | 上下文 | 通信 | 适用场景 |
|------|--------|--------|------|---------|
| **Sub-Agent** | `runAgent.ts` | 独立 | 单向（结果返回） | "帮我查这个函数" |
| **Fork** | `forkSubagent.ts` | 继承父 Agent | 共享 Prompt Cache | "并行重构 5 个文件" |
| **Team** | `TeamCreateTool/` | 独立进程 | 双向消息 | "多人协作" |

`AgentTool` 内部还维护了一组**内置 Agent 定义**（`tools/AgentTool/built-in/`）：

```
built-in/
├── generalPurposeAgent.ts   # 通用子 Agent
├── exploreAgent.ts          # 代码探索 Agent
├── planAgent.ts             # 规划 Agent
├── verificationAgent.ts     # 验证 Agent
└── claudeCodeGuideAgent.ts  # 指南 Agent
```

> 详细分析见第 16 章

### 3.2.5 上下文管理 — Agent 的有限记忆

**解决的问题**：在有限的 Context Window（200K tokens）内，如何在长时间会话中保持对任务的完整理解？

**源码位置**：`src/services/compact/`

Claude Code 用多层递进策略应对上下文窗口限制，从源码中可以识别出至少 **5 个层级**：

```
src/services/compact/
├── autoCompact.ts ·········· L3: 全局摘要压缩（消耗完整 API 调用）
├── microCompact.ts ·········· L2: 局部压缩（利用 cache_edits）
├── apiMicrocompact.ts ······· L2b: API 级微压缩
├── compact.ts ··············· 压缩核心逻辑（buildPostCompactMessages）
├── grouping.ts ·············· 消息分组策略
├── prompt.ts ················ 压缩 prompt 模板
└── sessionMemoryCompact.ts ·· 会话记忆压缩

src/services/compact/snipCompact.ts ·· 历史裁剪 [feature: HISTORY_SNIP]
src/services/contextCollapse/ ········ 上下文折叠 [feature: CONTEXT_COLLAPSE]
src/utils/toolResultStorage.ts ······· L1: Content Replacement（原地截断）
```

从 `query.ts` 的代码可以清楚看到这些层级的执行顺序：

```typescript
// src/query.ts — 上下文压缩管线（每轮循环开始时执行）
// L1: Tool result budget (原地替换过长结果)
messagesForQuery = await applyToolResultBudget(messagesForQuery, ...)

// L1.5: History snip (裁剪旧历史) [feature: HISTORY_SNIP]
const snipResult = snipModule.snipCompactIfNeeded(messagesForQuery)

// L2: Microcompact (局部压缩单条消息)
const microcompactResult = await deps.microcompact(messagesForQuery, ...)

// L2.5: Context collapse (折叠上下文) [feature: CONTEXT_COLLAPSE]
const collapseResult = await contextCollapse.applyCollapsesIfNeeded(...)

// L3: Auto-compact (全局摘要，消耗 API 调用)
const { compactionResult } = await deps.autocompact(messagesForQuery, ...)
```

> **设计决策**：五层策略体现了"渐进式降级" — 轻量方案能解决的不用重量方案，能局部处理的不做全局处理。`applyToolResultBudget` 是零成本的字符串截断；`microcompact` 是低成本的单消息压缩；`autoCompact` 是高成本的全局摘要但保证信息完整性。只有前几层都无法将上下文控制在窗口内时，才触发更昂贵的层级。

> 详细分析见第 7 章

### 3.2.6 Terminal UI — Agent 的交互界面

**解决的问题**：如何在传统终端中提供流式 Markdown 渲染、彩色 diff、动画、主题切换？

**源码位置**：`src/components/`

Claude Code 使用 **Ink（React for CLI）** 作为 UI 框架。顶层组件树的结构如下：

```typescript
// src/components/App.tsx — 顶层 Provider 链
export function App({ getFpsMetrics, stats, initialState, children }) {
  return (
    <FpsMetricsProvider getFpsMetrics={getFpsMetrics}>
      <StatsProvider store={stats}>
        <AppStateProvider initialState={initialState} onChangeAppState={onChangeAppState}>
          {children}
        </AppStateProvider>
      </StatsProvider>
    </FpsMetricsProvider>
  )
}
```

`App` → `StatsProvider` → `AppStateProvider` → `REPL` 的 Provider 链为整个 UI 树提供了 FPS 指标、统计数据和应用状态。`REPL` 组件是交互式会话的核心 — 它管理消息列表、输入框、权限对话框和流式渲染。

`components/` 目录包含 80+ React 组件：

```
components/
├── App.tsx ··················· 应用顶层
├── REPL.tsx ·················· 交互式循环核心
├── MessageList.tsx ··········· 消息列表
├── InputPrompt.tsx ··········· 输入提示
├── PermissionDialog.tsx ······ 权限对话框
├── CompactSummary.tsx ········ 压缩摘要
├── AutoUpdater.tsx ··········· 自动更新
├── BridgeDialog.tsx ·········· 桥接对话框
├── Spinner.tsx ··············· 加载动画
└── ... (70+ more)
```

> 详细分析见第 18 章

---

## 3.3 数据流：一个请求的完整旅程

理解架构不仅要知道"有哪些模块"，更要知道"数据如何流动"。让我们跟踪一个典型请求 — 用户输入 `帮我把 UserService 重构为单例模式` — 从键盘按下到最终响应的完整路径。

```
用户键入: "帮我把 UserService 重构为单例模式" [Enter]

[1] INPUT CAPTURE ── components/REPL.tsx
    │
    │  ├─ InputPrompt 组件捕获输入
    │  ├─ 检查 "/" 前缀 → 非 slash command → 普通消息
    │  └─ 调用 processUserInput()
    │
    ▼
[2] AGENT ENTRY ── QueryEngine.ts / query.ts
    │
    │  QueryEngine.submitMessage(prompt)
    │  ├─ fetchSystemPromptParts() → 构建 System Prompt
    │  │     ├─ 默认系统提示
    │  │     ├─ CLAUDE.md 注入
    │  │     ├─ 工具描述
    │  │     └─ 动态上下文（git status, 项目信息）
    │  ├─ processUserInput() → 处理用户输入
    │  └─ query() → 进入 Agentic Loop
    │
    ▼
[3] CONTEXT PREPROCESSING ── query.ts Phase 1
    │
    │  queryLoop() 每轮循环开始时执行：
    │  ├─ applyToolResultBudget(): 截断过长的工具结果
    │  ├─ snipCompactIfNeeded(): 裁剪旧历史 (如果启用)
    │  ├─ deps.microcompact(): 局部压缩
    │  ├─ contextCollapse.applyCollapsesIfNeeded(): 折叠 (如果启用)
    │  └─ deps.autocompact(): 全局摘要 (如果超过阈值)
    │
    ▼
[4] API CALL ── query.ts Phase 2 + services/api/claude.ts
    │
    │  deps.callModel({
    │    messages: prependUserContext(messagesForQuery, userContext),
    │    systemPrompt: fullSystemPrompt,
    │    tools: toolUseContext.options.tools,
    │    // ...
    │  })
    │  │
    │  └→ @anthropic-ai/sdk → SSE Stream
    │       │
    │       ▼
    │  for await (const message of stream) {
    │    yield message  // 流式推送到 UI
    │  }
    │
    ▼
[5] STREAM PARSING & UI RENDERING (并行)
    │
    │  每个 content block 通过 yield 推送:
    │
    │  ┌─ text block ──────┐    ┌─ tool_use block ──────────────┐
    │  │ "我来帮你重构..."  │    │ name: "Grep"                  │
    │  │       │            │    │ input: {pattern:"UserService"}│
    │  │       ▼            │    │       │                       │
    │  │  REPL.tsx:         │    │       ▼                       │
    │  │  流式 Markdown     │    │  toolUseBlocks.push(block)   │
    │  │  渲染 + 语法高亮   │    │  needsFollowUp = true        │
    │  └───────────────────┘    └───────────────────────────────┘
    │
    ▼
[6] TOOL EXECUTION ── services/tools/toolOrchestration.ts
    │
    │  runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)
    │  │
    │  ├─ partitionToolCalls(): 分区（只读 → 并行，写入 → 串行）
    │  │
    │  ├─ 对每个工具调用:
    │  │   ├─ canUseTool(): 权限检查 (utils/permissions/)
    │  │   │   ├─ 规则匹配: Grep → 只读 → 自动允许
    │  │   │   └─ (若需要确认 → UI 弹出权限对话框)
    │  │   ├─ PreToolUse Hooks: 执行前拦截
    │  │   ├─ tool.call(): 实际执行
    │  │   ├─ PostToolUse Hooks: 执行后拦截
    │  │   └─ 构建 tool_result
    │  │
    │  └─ yield { message: toolResult, newContext }
    │
    ▼
[7] RESULT INJECTION & CONTINUE ── query.ts Phase 5
    │
    │  state = {
    │    messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
    │    turnCount: nextTurnCount,
    │    transition: { reason: 'next_turn' },
    │  }
    │  // → continue (回到 while(true) 顶部)
    │
    │  ... (Agent 可能执行 5-20 轮: Grep → Read → Edit → Bash → ...)
    │
    ▼
[8] TERMINATION ── query.ts Phase 3
    │
    │  if (!needsFollowUp) {
    │    // 模型响应不含 tool_use → 任务完成
    │    yield* handleStopHooks(...)  // Stop Hook 检查
    │    return { reason: 'completed' }
    │  }
    │
    ▼
[9] OUTPUT ── components/REPL.tsx
    │
    │  ├─ 渲染最终回答 (Markdown → 语法高亮 → ANSI)
    │  ├─ 显示 Token 使用量 + 成本
    │  ├─ recordTranscript() → 持久化会话
    │  └─ 等待用户下一次输入 → 回到 [1]
```

这个流程揭示了几个重要的架构特征：

1. **流式贯穿**：从 SSE 字节流到 UI 渲染，所有中间环节都通过 `async function*` 和 `yield` 实现流式传递。text block 实时渲染，tool_use block 完成即执行。

2. **安全检查内嵌**：权限检查（`canUseTool`）和 Hooks 拦截不是独立的"安全网关"，而是嵌入在 `runToolUse()` 内部，每次工具调用都经过。

3. **上下文是活的**：每轮循环开始前都会执行压缩管线（L1 → L2 → L3），上下文在持续演化，不是静态累积。

4. **终止是模型决定的**：Agent 不是"执行完预定步骤就停止"，而是模型自行判断"任务完成了" — 表现为响应中不包含 `tool_use` block。除非被 `maxTurns`、资源限制或 Stop Hook 强制终止。

5. **多层恢复**：`queryLoop()` 中有 7 种不同的 `continue` 路径，分别处理 prompt-too-long、max_output_tokens、stop hook blocking 等异常场景。

---

## 3.4 源码目录的依赖关系

理解源码目录之间的依赖关系，能帮助你在阅读代码时建立上下文 — 知道一个文件来自哪个目录、它可能引用哪些其他目录的文件。

### 目录依赖图

```
                    ┌───────────────┐
                    │  main.tsx     │
                    │  (CLI entry)  │
                    └───────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
      ┌───────────┐  ┌───────────┐  ┌───────────┐
      │entrypoints│  │ commands/ │  │components/│
      │cli, init  │  │ 90+ cmds │  │ React UI  │
      │mcp        │  │          │  │ 80+ comps │
      └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
            │               │               │
            └───────────────┼───────────────┘
                            ▼
            ┌───────────────────────────────┐
            │         CORE LAYER            │
            │  query.ts  QueryEngine.ts     │
            │  Tool.ts   tools.ts           │
            └────────┬──────────────────────┘
                     │
       ┌─────────────┼─────────────┬──────────────┐
       ▼             ▼             ▼              ▼
  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌──────────┐
  │ tools/  │  │services/ │  │ utils/  │  │  state/  │
  │ 40+     │  │ api/     │  │permissions│  │AppState │
  │ tools   │  │ mcp/     │  │ sandbox/│  │ store   │
  │         │  │ compact/ │  │ hooks/  │  │selectors│
  └─────────┘  │ analytics│  │ model/  │  └──────────┘
               │ oauth/   │  │ config  │
               └──────────┘  └─────────┘
                     │
                     ▼
            ┌───────────────────┐
            │  External APIs    │
            │  @anthropic-ai/sdk│
            │  @mcp/sdk         │
            │  child_process    │
            │  (git, rg, etc.)  │
            └───────────────────┘
```

### 核心依赖规则

1. **tools/ 不互相依赖** — 每个工具是独立的，只通过 `Tool.ts` 的接口与系统交互
2. **services/ 不依赖 components/** — 服务层是 UI 无关的
3. **utils/ 是底层** — 被几乎所有其他目录引用
4. **query.ts 是枢纽** — 它引用 tools.ts、services/、utils/，但不直接引用 components/
5. **state/ 是双向的** — `AppState` 被 components/ 读取，被 utils/ 写入

### 阅读策略建议

基于这张依赖图，推荐三种阅读路径：

**路径 A：自顶向下（理解用户体验）**
```
main.tsx → components/REPL.tsx → query.ts → tools.ts → tools/BashTool/
```

**路径 B：自底向上（理解实现机制）**
```
services/api/claude.ts → query.ts → Tool.ts → tools/ → components/
```

**路径 C：按兴趣跳读（推荐）**
```
先读 query.ts (理解心跳) → 然后跳到你最感兴趣的子系统
例如: 安全 → utils/permissions/ → utils/sandbox/
      工具 → tools/BashTool/ → tools/AgentTool/
      命令 → commands.ts → commands/commit.ts
```

---

## 3.5 数据结构枢纽：贯穿系统的关键类型

在深入各子系统之前，了解几个贯穿全系统的核心数据结构会让后续阅读更顺畅。

### Messages — 对话的基本单元

整个系统围绕 `messages` 数组运转。它是 Anthropic Messages API 的核心数据结构，也是 `queryLoop()` 的状态载体。类型定义在 `src/types/message.ts`：

```typescript
// 核心消息类型（简化）
type Message =
  | UserMessage        // 用户输入 + 工具结果
  | AssistantMessage   // 模型响应（text + tool_use blocks）
  | SystemMessage      // 系统消息（compact boundary, api error, ...）
  | AttachmentMessage  // 附件（memory, edited_text_file, queued_command, ...）
  | ProgressMessage    // 进度通知
```

`messages` 数组在 `queryLoop()` 中持续增长和压缩 — 每轮循环追加新的 assistant + tool_result 消息，同时通过压缩管线控制总长度。

### ToolUseContext — 工具执行的完整上下文

`ToolUseContext`（定义在 `src/Tool.ts`）是传递给每个工具调用的"大上下文对象"。它包含了工具执行所需的一切：

```typescript
// src/Tool.ts — ToolUseContext（关键字段）
export type ToolUseContext = {
  options: {
    tools: Tools                    // 可用工具列表
    commands: Command[]             // 可用命令列表
    mainLoopModel: string           // 当前模型
    thinkingConfig: ThinkingConfig  // 思考模式配置
    mcpClients: MCPServerConnection[] // MCP 连接
    isNonInteractiveSession: boolean  // 是否非交互
    agentDefinitions: AgentDefinitionsResult  // Agent 定义
  }
  abortController: AbortController  // 中断控制
  readFileState: FileStateCache     // 文件读取缓存
  getAppState(): AppState           // 应用状态访问
  setAppState(f): void              // 应用状态修改
  messages?: Message[]              // 当前消息历史
  agentId?: AgentId                 // 子 Agent ID（主线程为 undefined）
  queryTracking?: QueryChainTracking // 查询链追踪
  // ... 更多字段
}
```

### QueryParams — 查询循环的参数

`QueryParams`（定义在 `src/query.ts`）是传递给 `query()` 的参数包：

```typescript
// src/query.ts
export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn           // 权限检查回调
  toolUseContext: ToolUseContext
  fallbackModel?: string             // 降级模型
  querySource: QuerySource           // 来源标识
  maxTurns?: number                  // 最大轮次
  taskBudget?: { total: number }     // Token 预算
}
```

这三个数据结构 — `Message`（状态）、`ToolUseContext`（上下文）、`QueryParams`（参数） — 是串联六大子系统的"血管"。在后续章节中，你会反复遇到它们。

---

## 3.6 设计哲学预览

在深入每个子系统的实现之前，值得先了解贯穿整个 Claude Code 的几个核心设计原则。这些原则不是抽象的教条 — 你会在后续每一章中看到它们的具体体现。

### 安全第一 (Security First)

**一句话**：任何功能设计都从"如果被滥用会怎样"开始思考。

从源码看，安全不是"后加的" — 它内嵌在 `Tool` 接口中（`isConcurrencySafe`、`needsPermission`），嵌入在 `queryLoop()` 的工具执行管线中（`canUseTool` 在每次调用前执行），嵌入在 BashTool 的实现中（`bashSecurity.ts`、`shouldUseSandbox.ts`）。

### 渐进式信任 (Progressive Trust)

**一句话**：默认不信任，通过用户交互逐步建立信任。

`ToolPermissionContext` 的 `mode` 字段有 5 个层级（`default` → `plan` → `acceptEdits` → `auto` → `bypass`），每个层级赋予 Agent 更多自主权。`alwaysAllowRules` 和 `alwaysDenyRules` 支持按工具和命令粒度的细粒度控制。

### 流式处理 (Streaming First)

**一句话**：永远不等待"全部完成" — 有一部分数据就处理一部分。

`query()` 和 `queryLoop()` 都是 `async function*`。`callModel()` 返回 `AsyncGenerator`。`runTools()` 返回 `AsyncGenerator`。整个从 API 到 UI 的管线是一个 `yield` 驱动的流式管道。

### 编译期消除 (Compile-Time Elimination)

**一句话**：不在运行时判断，在编译时消除。

`feature()` 不是运行时 `if`，而是编译时被替换为 `true`/`false` 的常量。`process.env.USER_TYPE` 在外部构建中被替换为 `"external"` 字符串。这确保了内部功能的代码在外部二进制文件中**完全不存在**。

### 优雅降级 (Graceful Degradation)

**一句话**：任何一个环节失败，都不应该让整个系统崩溃。

`queryLoop()` 中有 7 种不同的 `continue` 路径：

| 继续原因 | 触发条件 | 恢复策略 |
|---------|---------|---------|
| `next_turn` | 正常的工具结果回注 | 继续循环 |
| `reactive_compact_retry` | prompt-too-long | 触发紧凑压缩后重试 |
| `collapse_drain_retry` | prompt-too-long | 排空折叠队列后重试 |
| `max_output_tokens_recovery` | 输出截断 | 注入恢复提示后重试 |
| `max_output_tokens_escalate` | 输出截断 | 提升 max_tokens 重试 |
| `stop_hook_blocking` | Stop Hook 阻止 | 将 Hook 错误注入后重试 |
| `token_budget_continuation` | Token 预算未用完 | 注入继续提示 |

---

## 小结

本章从六个维度建立了 Claude Code 的全局认知：

| 维度 | 你了解到了什么 |
|------|-------------|
| **系统分层** | 七层架构（用户 → 命令 → 核心 → 能力 → 安全 → 协作 → 通信） |
| **六大子系统** | Agentic Loop (query.ts)、工具系统 (tools/)、安全体系 (permissions/sandbox/hooks)、多智能体 (AgentTool/)、上下文管理 (compact/)、Terminal UI (components/) |
| **数据流** | 一个请求从键盘输入到终端输出的 9 步完整路径 |
| **目录依赖** | core (query.ts, Tool.ts) → tools/ → services/ → utils/ 的依赖层次 |
| **核心数据结构** | Message、ToolUseContext、QueryParams 三个贯穿全系统的枢纽类型 |
| **设计哲学** | 安全第一、渐进式信任、流式处理、编译期消除、优雅降级 |

你现在拥有了一张完整的地图。从下一章开始，我们将沿着这张地图深入每一个子系统。第 4 章将首先打开 Claude Code 最核心的模块 — `query.ts` 的 Agentic Loop，拆解这颗"心脏"的每一个零件。

> **给急性子读者的建议**：如果你已经等不及想看代码了，直接打开 `src/query.ts`。它的 `queryLoop()` 函数（~1500 行）是整个系统的核心 — 理解了它，就理解了 Claude Code 70% 的行为。

---

## 速查表

### 关键文件索引

| 文件 | 路径 | 职责 | 对应章节 |
|------|------|------|---------|
| main.tsx | `src/main.tsx` | CLI 入口，启动序列 | 第 2 章 |
| query.ts | `src/query.ts` | Agentic Loop 核心 | 第 4 章 |
| QueryEngine.ts | `src/QueryEngine.ts` | SDK 查询引擎 | 第 4 章 |
| Tool.ts | `src/Tool.ts` | 工具接口 + ToolUseContext | 第 8 章 |
| tools.ts | `src/tools.ts` | 工具注册表 | 第 8 章 |
| commands.ts | `src/commands.ts` | 命令注册表 | 第 17 章 |
| claude.ts | `src/services/api/claude.ts` | API 调用核心 | 第 5 章 |
| autoCompact.ts | `src/services/compact/autoCompact.ts` | 自动压缩 | 第 7 章 |
| toolOrchestration.ts | `src/services/tools/toolOrchestration.ts` | 工具调度 | 第 8 章 |
| permissions.ts | `src/utils/permissions/permissions.ts` | 权限引擎 | 第 13 章 |
| sandbox-adapter.ts | `src/utils/sandbox/sandbox-adapter.ts` | 沙箱适配 | 第 14 章 |
| App.tsx | `src/components/App.tsx` | React 顶层 | 第 18 章 |

### 关键函数索引

| 函数 | 文件 | 职责 |
|------|------|------|
| `query()` | query.ts | Agentic Loop 外层包装 |
| `queryLoop()` | query.ts | Agentic Loop 核心循环（while true） |
| `submitMessage()` | QueryEngine.ts | SDK 提交消息入口 |
| `getAllBaseTools()` | tools.ts | 获取所有内置工具 |
| `getTools()` | tools.ts | 获取过滤后的工具列表 |
| `runTools()` | toolOrchestration.ts | 工具并发调度 |
| `partitionToolCalls()` | toolOrchestration.ts | 工具调用并发分区 |
| `applyToolResultBudget()` | toolResultStorage.ts | L1 工具结果截断 |
| `fetchSystemPromptParts()` | queryContext.ts | 系统提示构建 |
| `buildPostCompactMessages()` | compact.ts | 压缩后消息重建 |

### 目录功能速查

| 目录 | 文件数 | 功能 |
|------|--------|------|
| `src/tools/` | 40+ 子目录 | 工具实现 |
| `src/commands/` | 90+ 子目录 | Slash 命令 |
| `src/components/` | 80+ 文件 | React UI 组件 |
| `src/services/api/` | 15+ 文件 | API 客户端 |
| `src/services/mcp/` | 20+ 文件 | MCP 协议 |
| `src/services/compact/` | 10+ 文件 | 上下文压缩 |
| `src/utils/permissions/` | 10+ 文件 | 权限引擎 |
| `src/utils/sandbox/` | 5+ 文件 | 沙箱系统 |
| `src/utils/hooks/` | 5+ 文件 | Hooks 系统 |
| `src/state/` | 5 文件 | 应用状态管理 |
| `src/bridge/` | 20+ 文件 | 远程桥接 |
| `src/skills/` | 5+ 文件 | Skill 系统 |
