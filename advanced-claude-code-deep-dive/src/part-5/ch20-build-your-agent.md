
# 第 20 章：构建你的 Agent — 从源码模式到实践指南

> **核心问题**：如果你想从零构建一个 Coding Agent，应该采用什么架构？Claude Code 的源码中隐藏了哪些可复用的设计模式？哪些决策是普适的，哪些是 Claude Code 特有的？

上一章提炼了 Claude Code 的设计哲学，本章将这些哲学转化为**可落地的架构指南**。我们将沿着"最小可行 Agent → 完整工具系统 → 上下文管理 → 安全模型"的路线，逐步构建一个生产级 Coding Agent，每一步都引用 Claude Code 源码中的具体实现作为范例。

---

## 20.1 最小可行 Agentic Loop

### Step 1：最简循环 — 5 行核心

一个 Agentic Loop 的本质是：

```
while (model 要求使用工具) {
    执行工具
    把结果喂回模型
}
```

Claude Code 的 `query.ts` 实现了这个核心逻辑，但包裹了数千行的优化和容错。如果你从零开始，最小可行版本可以这么写：

```typescript
// 最小可行 Agentic Loop（基于 Claude Code 模式简化）
async function* agentLoop(messages: Message[], tools: Tool[]) {
  while (true) {
    // Phase 1: 调用模型
    const response = await callModel(messages, tools)

    // Phase 2: 检查是否有工具调用
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use')
    if (toolUseBlocks.length === 0) {
      yield response  // 没有工具调用，返回最终响应
      return
    }

    // Phase 3: 执行工具
    messages.push({ role: 'assistant', content: response.content })
    for (const block of toolUseBlocks) {
      const result = await executeTool(block.name, block.input)
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: block.id, content: result }]
      })
    }
    // Phase 4: 继续循环
  }
}
```

> **设计决策**：注意返回类型是 `async function*`（async generator）而不是普通 async function。这是从 Claude Code 学到的第一个模式 — **用 generator 实现流式输出**。每次循环迭代可以 `yield` 中间状态给 UI 层，而不用等整个循环结束。Claude Code 的 `query()` 函数（query.ts:219）正是这样做的。

### Step 2：加入状态管理

Claude Code 的循环不是无状态的 — 它有一个显式的 `State` 对象：

```typescript
// 学习 Claude Code 的 State 模式
type AgentState = {
  messages: Message[]
  turnCount: number
  maxTurns: number
  transition?: { reason: string }  // 为什么继续了上一轮
}

async function* agentLoop(initialState: AgentState, tools: Tool[]) {
  let state = initialState

  while (true) {
    const { messages, turnCount, maxTurns } = state

    // 安全阀：防止无限循环
    if (turnCount > maxTurns) {
      return { reason: 'max_turns_exceeded' }
    }

    const response = await callModel(messages, tools)
    const toolUseBlocks = getToolUseBlocks(response)

    if (toolUseBlocks.length === 0) {
      yield response
      return { reason: 'end_turn' }
    }

    const toolResults = await executeTools(toolUseBlocks)

    // 构造下一轮状态
    state = {
      messages: [...messages, response, ...toolResults],
      turnCount: turnCount + 1,
      maxTurns,
      transition: { reason: 'tool_use' },
    }
  }
}
```

Claude Code 的 `maxTurns` 检查（query.ts 中的 `turnCount` 对比）是一个**必须有的安全阀** — 没有它，一个糟糕的 prompt 可能导致 Agent 无限循环，消耗大量 API 费用。

### Step 3：加入容错

从 Claude Code 学到的最重要教训之一：**每个 tool_use 必须有对应的 tool_result**。

```typescript
// 学习 Claude Code 的 yieldMissingToolResultBlocks 模式
function createErrorResults(
  assistantMessage: AssistantMessage,
  errorMessage: string,
): UserMessage[] {
  return assistantMessage.content
    .filter(block => block.type === 'tool_use')
    .map(block => ({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: block.id,
        content: errorMessage,
        is_error: true,
      }],
    }))
}

// 在 try/catch 中使用
try {
  const toolResults = await executeTools(toolUseBlocks)
  // ...
} catch (error) {
  // 确保即使出错，也为每个 tool_use 生成 tool_result
  const errorResults = createErrorResults(response, error.message)
  messages.push(response, ...errorResults)
}
```

> **设计决策**：Claude Code 的 `yieldMissingToolResultBlocks`（query.ts:123）在**每一个错误出口**都会被调用 — 模型错误、用户中断、streaming fallback、所有异常路径。这不是巧合，而是 Anthropic Messages API 的硬性要求：如果 assistant message 包含 tool_use 但下一条 user message 没有对应的 tool_result，API 会返回 400 错误。破坏这个协议会导致整个对话无法继续。

---

## 20.2 工具系统设计

### 统一的工具接口

Claude Code 的工具接口设计是整个系统中最值得借鉴的模式之一。核心思想：**每个工具都是一个实现了统一接口的对象**。

```typescript
// 学习 Claude Code Tool 接口的核心部分（Tool.ts:362）
type Tool<Input, Output> = {
  // 身份
  name: string
  description(input): string

  // Schema — 双层设计
  inputSchema: ZodSchema<Input>      // 暴露给 API 的外部 Schema
  // 可选：internalInputSchema      // 内部使用的扩展 Schema

  // 安全属性
  isConcurrencySafe(input): boolean  // 是否可并行
  isReadOnly(input): boolean         // 是否只读
  isEnabled(): boolean               // 是否可用

  // 执行
  call(args, context): Promise<ToolResult<Output>>

  // 可选验证
  validateInput?(input, context): Promise<ValidationResult>
}
```

关键设计选择的对比：

| 设计选择 | Claude Code 做法 | 简单做法 | 为什么 CC 更好 |
|:---------|:-----------------|:---------|:-------------|
| Schema | Zod 运行时验证 | JSON Schema | 类型安全 + 运行时验证一体化 |
| 安全属性 | 函数（接受输入） | 静态布尔值 | 同工具不同输入有不同安全级别 |
| 描述 | 函数（可动态） | 静态字符串 | 可根据环境调整提示 |
| 结果 | `ToolResult<T>` 包装 | 原始字符串 | 可携带附加消息和上下文修改器 |

`ToolResult` 的设计特别值得注意：

```typescript
// Tool.ts:321 — ToolResult 不只是数据
export type ToolResult<T> = {
  data: T                     // 主数据
  newMessages?: Message[]     // 附加消息（如 memory 注入）
  contextModifier?: (ctx) => ToolUseContext  // 修改后续上下文
  mcpMeta?: { ... }          // MCP 协议元数据
}
```

`contextModifier` 允许工具在执行后修改后续工具的运行上下文 — 比如 `cd` 后修改工作目录、`git checkout` 后刷新文件缓存。这比"工具只返回字符串"的简单设计强大得多。

### 工具注册与发现

```typescript
// tools.ts:193 — 所有工具的注册点
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    BashTool,
    GlobTool, GrepTool,
    FileReadTool, FileEditTool, FileWriteTool,
    NotebookEditTool,
    WebFetchTool, WebSearchTool,
    // ... 条件工具
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    ...(SleepTool ? [SleepTool] : []),
    ...(cronTools),
  ]
}
```

推荐的工具注册模式：

```typescript
// 你的 Agent 的工具注册
function getTools(config: AgentConfig): Tool[] {
  const baseTools = [ReadTool, EditTool, BashTool, GrepTool]

  const conditionalTools = [
    config.enableWebSearch && WebSearchTool,
    config.enableGit && GitTool,
    config.enableNotebook && NotebookTool,
  ].filter(Boolean)

  return [...baseTools, ...conditionalTools]
}
```

### 工具并发控制

Claude Code 的 `StreamingToolExecutor`（services/tools/StreamingToolExecutor.ts）实现了精密的并发控制：

```typescript
// StreamingToolExecutor.ts:40 — 并发执行器
export class StreamingToolExecutor {
  private tools: TrackedTool[] = []

  // 核心并发规则
  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executingTools = this.tools.filter(t => t.status === 'executing')
    return (
      executingTools.length === 0 ||
      (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
    )
  }
}
```

并发规则用文字描述：

```
并发安全矩阵：

                     新工具
                     并发安全    非并发安全
正在执行的工具  ┌──────────┬──────────┐
  无            │  ✅ 执行  │  ✅ 执行  │
  并发安全       │  ✅ 并行  │  ⏸️ 排队  │
  非并发安全     │  ⏸️ 排队  │  ⏸️ 排队  │
                └──────────┴──────────┘

例：
- Read + Read + Grep → 全部并行（都是只读，并发安全）
- Read + Edit         → Edit 排队（Edit 非并发安全）
- Edit + Read         → Read 排队（已有非并发安全工具在执行）
```

如果你构建自己的 Agent，这个并发规则是**必须实现的** — 没有它，并行的文件读取和写入可能导致数据损坏。

---

## 20.3 上下文管理策略

### 三级上下文压缩

Claude Code 不是等到 token 限制时才处理上下文 — 它有一个**三级主动压缩**体系：

```
上下文管理三级体系：

Level 1: Snip Compact (最轻量)
  ┌────────────────────────────────────┐
  │  裁剪早期对话中的大型工具输出        │
  │  保留对话结构，只缩短内容            │
  │  query.ts:401-410                  │
  └────────────────────────────────────┘
              │ 不够 ↓

Level 2: Microcompact (中等)
  ┌────────────────────────────────────┐
  │  压缩工具结果中的重复/冗余内容      │
  │  保留对话完整性                     │
  │  query.ts:414-426                  │
  └────────────────────────────────────┘
              │ 不够 ↓

Level 3: AutoCompact (最激进)
  ┌────────────────────────────────────┐
  │  调用模型总结整个对话历史            │
  │  用简短摘要替代完整历史              │
  │  query.ts:454-468                  │
  └────────────────────────────────────┘
```

从 `query.ts` 的执行顺序可以看到，这三级按从轻到重的顺序执行：

```typescript
// query.ts:401 — Level 1: Snip
if (feature('HISTORY_SNIP')) {
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
}

// query.ts:414 — Level 2: Microcompact
const microcompactResult = await deps.microcompact(
  messagesForQuery, toolUseContext, querySource,
)
messagesForQuery = microcompactResult.messages

// query.ts:454 — Level 3: AutoCompact
const { compactionResult } = await deps.autocompact(
  messagesForQuery, toolUseContext,
  { systemPrompt, userContext, systemContext, ... },
  querySource, tracking, snipTokensFreed,
)
```

还有第四道防线 — **响应式压缩**，在 API 返回 prompt-too-long 错误时触发：

```typescript
// query.ts:1086-1099 — 响应式恢复
if (isWithheld413) {
  // 尝试 1: Context Collapse drain
  if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
    const drained = contextCollapse.recoverFromOverflow(...)
    if (drained.committed > 0) { /* 重试 */ }
  }
  // 尝试 2: Reactive Compact
  if (reactiveCompact && !hasAttemptedReactiveCompact) { /* ... */ }
}
```

### 你的 Agent 需要什么级别的上下文管理？

```
决策树：

你的 Agent 会有超过 5 轮对话吗？
├── 否 → 不需要压缩
└── 是 → 你的模型上下文窗口 > 128k tokens?
    ├── 是 → Level 1 (Snip) 即可
    └── 否 → 是否允许丢失早期信息？
        ├── 是 → Level 1 + 2 (Snip + Microcompact)
        └── 否 → 需要 Level 3 (AutoCompact 摘要)
```

最简可行的上下文管理：

```typescript
// 最简上下文压缩：截断到最近 N 轮
function truncateContext(messages: Message[], maxTokens: number): Message[] {
  let totalTokens = 0
  const result: Message[] = []

  // 从后往前遍历，保留最近的消息
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(messages[i])
    if (totalTokens + tokens > maxTokens) break
    result.unshift(messages[i])
    totalTokens += tokens
  }

  return result
}
```

> **设计决策**：Claude Code 的 `taskBudgetRemaining` 跟踪（query.ts:291）揭示了一个微妙的问题 — 压缩后，模型看到的对话历史变短了，但之前消耗的 token 不应该被"忘记"。Claude Code 通过在压缩时快照 `finalContextTokensFromLastResponse`，然后把已消耗量传给 API 的 `task_budget.remaining`，确保了预算跟踪跨越压缩边界的一致性。如果你的 Agent 有 token 预算，**必须在压缩时记录已消耗量**。

---

## 20.4 安全模型设计

### 分层安全架构

Claude Code 的安全模型不是单点检查，而是**分层纵深防御**：

```
安全防线：

Layer 1: 工具级别
  ├── isEnabled()         → 工具是否可用
  ├── validateInput()     → 输入是否合法
  └── isReadOnly()        → 读写分类

Layer 2: 权限级别
  ├── alwaysDenyRules     → 黑名单（如 rm -rf /）
  ├── alwaysAllowRules    → 白名单（如 ls, cat）
  └── canUseTool()        → 交互式确认

Layer 3: 分类器级别 (feature gated)
  ├── BASH_CLASSIFIER     → Bash 命令安全分类
  └── TRANSCRIPT_CLASSIFIER → 对话轨迹安全分析

Layer 4: 沙箱级别
  └── SandboxManager      → 文件系统隔离
```

最小可行的安全模型：

```typescript
// 你的 Agent 的安全模型
type SecurityPolicy = {
  // Layer 1: 永远拒绝的模式
  denyPatterns: RegExp[]
  // Layer 2: 永远允许的模式
  allowPatterns: RegExp[]
  // Layer 3: 需要确认的操作类型
  requireConfirmation: Set<'write' | 'execute' | 'network' | 'delete'>
}

async function checkPermission(
  tool: Tool,
  input: unknown,
  policy: SecurityPolicy,
): Promise<'allow' | 'deny' | 'ask'> {
  // Layer 1: 黑名单优先
  const inputStr = JSON.stringify(input)
  if (policy.denyPatterns.some(p => p.test(inputStr))) {
    return 'deny'
  }

  // Layer 2: 白名单
  if (policy.allowPatterns.some(p => p.test(inputStr))) {
    return 'allow'
  }

  // Layer 3: 基于操作类型
  if (tool.isReadOnly(input)) return 'allow'
  if (policy.requireConfirmation.has('write')) return 'ask'

  return 'allow'
}
```

### canUseTool 的签名学习

Claude Code 的 `canUseTool` 不是简单的布尔函数 — 它返回一个包含行为指令的结构：

```typescript
// hooks/useCanUseTool.ts 的模式
type PermissionResult = {
  behavior: 'allow' | 'deny' | 'ask'
  message?: string        // 为什么拒绝
  updatedInput?: unknown  // 修改后的输入（如路径重写）
}
```

`updatedInput` 是一个精妙的设计 — 权限系统不仅可以拒绝操作，还可以**修改操作**。比如将相对路径转换为绝对路径、将危险命令替换为安全版本。

---

## 20.5 架构蓝图：你的 Agent 的推荐结构

综合以上所有模式，推荐以下项目结构：

```
my-coding-agent/
├── src/
│   ├── core/
│   │   ├── agentLoop.ts        # Agentic Loop (学习 query.ts)
│   │   ├── state.ts            # State 类型定义
│   │   └── deps.ts             # 依赖注入 (学习 query/deps.ts)
│   ├── tools/
│   │   ├── Tool.ts             # 工具接口 (学习 Tool.ts)
│   │   ├── registry.ts         # 工具注册 (学习 tools.ts)
│   │   ├── executor.ts         # 并发执行 (学习 StreamingToolExecutor.ts)
│   │   ├── BashTool.ts
│   │   ├── ReadTool.ts
│   │   ├── EditTool.ts
│   │   └── GrepTool.ts
│   ├── context/
│   │   ├── tokenCounter.ts     # Token 估算
│   │   ├── compactor.ts        # 上下文压缩
│   │   └── messageBuilder.ts   # 消息构建
│   ├── security/
│   │   ├── permission.ts       # 权限检查
│   │   ├── policy.ts           # 安全策略
│   │   └── sandbox.ts          # 沙箱 (可选)
│   ├── api/
│   │   ├── client.ts           # API 客户端
│   │   └── streaming.ts        # SSE 流式处理
│   └── ui/
│       ├── terminal.ts         # 终端 UI
│       └── progress.ts         # 进度显示
├── tests/
│   ├── core/
│   │   └── agentLoop.test.ts   # 注入 fake deps 测试
│   └── tools/
│       └── executor.test.ts
└── package.json
```

### 最小可行版本的实现顺序

```
Phase 1 (MVP, ~3 天):
  agentLoop.ts + BashTool + ReadTool
  → 能读文件、执行命令、循环到完成

Phase 2 (可用, ~1 周):
  + EditTool + GrepTool + 基础权限
  → 能修改代码、搜索、有安全保障

Phase 3 (生产, ~2 周):
  + 上下文压缩 + 流式 UI + 并发执行
  → 能处理长对话、实时反馈、效率优化

Phase 4 (高级, ~1 月):
  + SubAgent + MCP 集成 + 高级安全
  → 多 Agent 协作、可扩展能力
```

---

## 20.6 实践建议清单

从 Claude Code 源码中学到的 10 条实践建议：

| # | 建议 | Claude Code 中的体现 | 优先级 |
|---|------|---------------------|--------|
| 1 | **tool_use 和 tool_result 必须配对** | `yieldMissingToolResultBlocks()` | 🔴 必须 |
| 2 | **设 maxTurns 安全阀** | `State.turnCount` + `maxTurns` 检查 | 🔴 必须 |
| 3 | **读操作并行、写操作串行** | `StreamingToolExecutor.canExecuteTool()` | 🟡 强烈推荐 |
| 4 | **用 async generator 流式输出** | `query()` 返回 `AsyncGenerator` | 🟡 强烈推荐 |
| 5 | **集中状态管理** | `State` 类型 + `while(true)` | 🟡 强烈推荐 |
| 6 | **依赖注入方便测试** | `QueryDeps` + `productionDeps()` | 🟢 推荐 |
| 7 | **输入验证用 Zod** | `tool.inputSchema.safeParse()` | 🟢 推荐 |
| 8 | **权限返回行为指令而非布尔值** | `PermissionResult.behavior` | 🟢 推荐 |
| 9 | **环境配置入口快照化** | `buildQueryConfig()` | 🟢 推荐 |
| 10 | **编译时 feature flag** | `feature('X')` + dead code elimination | ⚪ 大型项目 |

> **设计决策**：建议 1 和 2 是**硬性要求**，没有它们你的 Agent 会崩溃或烧钱。建议 3-5 是显著提升用户体验的关键。建议 6-10 在项目规模增长后会越来越重要。Claude Code 从第一天就实现了所有 10 条，这是它能从原型快速发展到生产系统的关键。

---

## 20.7 小结

构建一个 Coding Agent 的核心挑战不是 LLM 调用 — 那只是一个 HTTP 请求。真正的挑战在于：

1. **循环引擎**：让 Agent 持续行动直到任务完成，同时防止无限循环
2. **工具系统**：统一的接口、安全的并发、可靠的错误处理
3. **上下文管理**：在有限的 token 窗口中保持最重要的信息
4. **安全模型**：在 Agent 自主性和用户安全之间取得平衡

Claude Code 的源码为每一个挑战都提供了生产级的解决方案。你不需要复制它的每一行代码 — 但理解它的设计模式，会让你少走很多弯路。

下一章我们将深入这些模式在实现中遇到的**关键挑战**，以及 Claude Code 团队是如何解决它们的。
