# 第四章 Agentic Loop：Agent 的心跳

> **核心问题**：一个 AI Agent 如何在"思考→行动→观察"的循环中持续运转，直到任务完成？Claude Code 用了一个 1730 行的 `while(true)` 状态机来回答这个问题。

---

## 4.1 从 ChatBot 到 Agent：循环的本质

传统 ChatBot 是一问一答的。用户说一句，模型回一句，对话结束。但 Agent 不一样——Agent 会自主决定下一步做什么，执行工具，观察结果，再决定下一步。这个循环一直持续到任务完成。

Claude Code 的核心循环定义在 `src/query.ts`，全文 1730 行。这个文件是整个系统的心脏。如果你只能读一个文件来理解 Claude Code，那就是这个。

```
┌─────────────────────────────────────────────────────────┐
│                    queryLoop()                          │
│                                                         │
│   while (true) {                                        │
│     ┌─────────────────────────┐                         │
│     │ Phase 1: Context 压缩   │  snip → MC → collapse   │
│     │         → autocompact   │  → autocompact          │
│     ├─────────────────────────┤                         │
│     │ Phase 2: API 调用       │  callModel() streaming  │
│     │   (含 streaming 工具执行) │  + tool_use inline     │
│     ├─────────────────────────┤                         │
│     │ Phase 3: 终止判断       │  no tool_use? → exit    │
│     │   (含错误恢复)          │  PTL? → compact retry   │
│     │                         │  max_output? → recover  │
│     ├─────────────────────────┤                         │
│     │ Phase 4: 剩余工具执行   │  getRemainingResults()  │
│     ├─────────────────────────┤                         │
│     │ Phase 5: Attachments    │  memory, skills, queue  │
│     ├─────────────────────────┤                         │
│     │ Phase 6: 状态组装       │  state = { ... }        │
│     │         → continue      │  transition: next_turn  │
│     └─────────────────────────┘                         │
│   }                                                     │
└─────────────────────────────────────────────────────────┘
```

## 4.2 两层架构：query() 和 queryLoop()

循环分两层。外层 `query()` 是一个薄包装，负责命令生命周期通知；内层 `queryLoop()` 是真正的状态机。

```typescript
// src/query.ts:219-239
export async function* query(
  params: QueryParams,
): AsyncGenerator<StreamEvent | Message | TombstoneMessage | ToolUseSummaryMessage, Terminal> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

注意返回类型：`AsyncGenerator<..., Terminal>`。这是 TypeScript 的 async generator，它既能通过 `yield` 逐条发出流式事件（assistant 消息、tool 结果、progress 更新），又能通过 `return` 返回一个终止原因。`Terminal` 类型定义了所有可能的退出路径。

> **设计决策**：为什么用 `async function*`（async generator）而不是回调或 Promise？因为 agentic loop 的输出天然是一个流——模型一边生成文字一边触发工具，工具执行产生中间结果，这些都需要实时推送给上层。Generator 的 pull-based 模型让调用者可以背压控制消费速度，避免缓冲区膨胀。而 `yield*` 的委托语义让多层 generator 组合（query → queryLoop → handleStopHooks）变得像函数调用一样自然。

## 4.3 State：不可变状态替换

`queryLoop` 的核心数据结构是 `State`：

```typescript
// src/query.ts:204-217
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined
}
```

每一个字段都有明确职责：

| 字段 | 用途 |
|------|------|
| `messages` | 当前对话历史（含 compact 后的压缩版本） |
| `toolUseContext` | 工具执行环境（权限、abort 控制器、应用状态） |
| `maxOutputTokensRecoveryCount` | max_output_tokens 恢复重试计数器 |
| `hasAttemptedReactiveCompact` | 是否已尝试 reactive compact（防螺旋） |
| `turnCount` | 当前 turn 序号 |
| `transition` | 上一次迭代为什么 `continue`（调试/测试用） |
| `pendingToolUseSummary` | 异步生成的 tool use 摘要（Haiku 并行生成） |
| `stopHookActive` | stop hook 是否正在活跃 |

> **设计决策**：为什么用状态对象整体替换（`state = { ... }`）而不是逐个字段修改？源码注释说得很清楚：*"Continue sites write `state = { ... }` instead of 9 separate assignments."* 整体替换有三个好处：(1) 不会忘记更新某个字段，(2) 每个 continue 站点的意图一目了然，(3) TypeScript 的类型系统会强制要求所有字段都被赋值。

状态初始化发生在循环开始前：

```typescript
// src/query.ts:268-279
let state: State = {
  messages: params.messages,
  toolUseContext: params.toolUseContext,
  maxOutputTokensOverride: params.maxOutputTokensOverride,
  autoCompactTracking: undefined,
  stopHookActive: undefined,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  turnCount: 1,
  pendingToolUseSummary: undefined,
  transition: undefined,
}
```

循环体开头，用解构赋值提取当前迭代需要的值：

```typescript
// src/query.ts:311-322
let { toolUseContext } = state
const {
  messages,
  autoCompactTracking,
  maxOutputTokensRecoveryCount,
  hasAttemptedReactiveCompact,
  maxOutputTokensOverride,
  pendingToolUseSummary,
  stopHookActive,
  turnCount,
} = state
```

注意 `toolUseContext` 用 `let` 而不是 `const`——它是唯一一个在迭代内部会被重新赋值的字段，因为工具执行可能修改上下文（`contextModifiers`）。

## 4.4 Phase 1：Context 压缩管线

每次 API 调用前，对话历史要经过一条四级压缩管线。这是 Claude Code 能支持无限长对话的关键。

```
原始 messages
    │
    ├─ applyToolResultBudget()      // Content Replacement: 大结果截断
    │
    ├─ snipCompactIfNeeded()        // Snip: 按时间删除老消息段
    │
    ├─ deps.microcompact()          // MicroCompact: 清除旧工具输出
    │
    ├─ contextCollapse.apply...()   // Context Collapse: 分段压缩
    │
    └─ deps.autocompact()           // AutoCompact: 全对话摘要
        │
        └─ messagesForQuery         // 准备好的消息发给 API
```

Content Replacement 排第一，因为它操作的是 tool_use_id，不依赖其他压缩的结果：

```typescript
// src/query.ts:379-394
messagesForQuery = await applyToolResultBudget(
  messagesForQuery,
  toolUseContext.contentReplacementState,
  persistReplacements ? records =>
    void recordContentReplacement(records, toolUseContext.agentId)
      .catch(logError)
  : undefined,
  new Set(
    toolUseContext.options.tools
      .filter(t => !Number.isFinite(t.maxResultSizeChars))
      .map(t => t.name),
  ),
)
```

MicroCompact 在 Snip 之后运行：

```typescript
// src/query.ts:414-419
const microcompactResult = await deps.microcompact(
  messagesForQuery,
  toolUseContext,
  querySource,
)
messagesForQuery = microcompactResult.messages
```

AutoCompact 排最后，因为它是最昂贵的操作（需要调用模型生成摘要）：

```typescript
// src/query.ts:454-467
const { compactionResult, consecutiveFailures } = await deps.autocompact(
  messagesForQuery,
  toolUseContext,
  { systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages: messagesForQuery },
  querySource,
  tracking,
  snipTokensFreed,
)
```

> **设计决策**：为什么压缩管线里 Context Collapse 排在 AutoCompact 前面？源码注释（`src/query.ts:430-432`）解释得很清楚：*"Runs BEFORE autocompact so that if collapse gets us under the autocompact threshold, autocompact is a no-op and we keep granular context instead of a single summary."* —— 优先保留细粒度上下文，只有当 collapse 不够用时才做全对话摘要。

## 4.5 Phase 2：API 调用与 Streaming 工具执行

压缩完成后，消息被发送给模型。这里有一个精妙的设计——工具执行和模型 streaming 是交织在一起的：

```typescript
// src/query.ts:659-863
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  // ...options
})) {
  // 处理每个 streaming event...

  if (message.type === 'assistant') {
    assistantMessages.push(message)

    // 提取 tool_use blocks
    const msgToolUseBlocks = message.message.content.filter(
      content => content.type === 'tool_use',
    ) as ToolUseBlock[]

    if (msgToolUseBlocks.length > 0) {
      toolUseBlocks.push(...msgToolUseBlocks)
      needsFollowUp = true
    }

    // 在 streaming 过程中就开始执行工具！
    if (streamingToolExecutor && !toolUseContext.abortController.signal.aborted) {
      for (const toolBlock of msgToolUseBlocks) {
        streamingToolExecutor.addTool(toolBlock, message)
      }
    }
  }

  // 同时收割已完成的工具结果
  if (streamingToolExecutor && !toolUseContext.abortController.signal.aborted) {
    for (const result of streamingToolExecutor.getCompletedResults()) {
      if (result.message) {
        yield result.message
        toolResults.push(/* ... */)
      }
    }
  }
}
```

这段代码展示了 Claude Code 的一个关键优化：**模型还在 streaming 输出后续 token 的时候，前面已经完成的 tool_use block 就开始执行了**。比如模型先输出一个 `Read("file_a.ts")` 再输出一个 `Read("file_b.ts")`，在 `file_b.ts` 的 tool_use 还在 streaming 的时候，`file_a.ts` 的读取可能已经完成了。

## 4.6 StreamingToolExecutor：读写锁并发模型

`StreamingToolExecutor`（`src/services/tools/StreamingToolExecutor.ts`）是实现上述交织执行的核心组件。它实现了一个类似读写锁的并发控制模型。

```
                ┌─────────────────────────────────┐
                │     StreamingToolExecutor        │
                │                                  │
                │  tools: TrackedTool[]            │
                │    ┌──────┬──────┬──────┐       │
                │    │Read A│Read B│Edit C│       │
                │    │queued│exec  │queued│       │
                │    └──────┴──────┴──────┘       │
                │                                  │
                │  Rules:                          │
                │  - concurrent-safe 可以并行      │
                │  - non-concurrent 必须独占       │
                │  - 结果按接收顺序 yield          │
                └─────────────────────────────────┘
```

每个工具声明自己是否 "concurrency safe"：

```typescript
// src/services/tools/StreamingToolExecutor.ts:104-120
const parsedInput = toolDefinition.inputSchema.safeParse(block.input)
const isConcurrencySafe = parsedInput?.success
  ? (() => {
      try {
        return Boolean(toolDefinition.isConcurrencySafe(parsedInput.data))
      } catch {
        return false
      }
    })()
  : false
```

并发检查逻辑就一个函数：

```typescript
// src/services/tools/StreamingToolExecutor.ts:129-135
private canExecuteTool(isConcurrencySafe: boolean): boolean {
  const executingTools = this.tools.filter(t => t.status === 'executing')
  return (
    executingTools.length === 0 ||
    (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
  )
}
```

翻译成人话：
- 如果没有工具在执行 → 可以执行
- 如果有工具在执行，且新工具和所有执行中的工具都是 concurrent-safe → 可以并行
- 否则 → 排队等待

这就是经典的**读写锁**语义。Read、Grep、Glob 这些只读工具是 "readers"（concurrent-safe），可以同时跑多个。FileEdit、Bash 这些写工具是 "writers"（non-concurrent），必须独占执行。

### Sibling Error Cascade

当一个 Bash 工具出错时，它的兄弟工具也会被取消：

```typescript
// src/services/tools/StreamingToolExecutor.ts:358-363
if (tool.block.name === BASH_TOOL_NAME) {
  this.hasErrored = true
  this.erroredToolDescription = this.getToolDescription(tool)
  this.siblingAbortController.abort('sibling_error')
}
```

但只有 Bash 错误会触发 cascade。Read、WebFetch 等工具的错误不会——因为它们是独立的，一个文件读取失败不应该影响另一个。

> **设计决策**：为什么只有 Bash 错误取消兄弟？源码注释解释：*"Bash commands often have implicit dependency chains (e.g. mkdir fails → subsequent commands pointless). Read/WebFetch/etc are independent — one failure shouldn't nuke the rest."*

### 结果顺序保证

虽然工具可以并行执行，但结果严格按接收顺序 yield：

```typescript
// src/services/tools/StreamingToolExecutor.ts:417-439
*getCompletedResults(): Generator<MessageUpdate, void> {
  for (const tool of this.tools) {
    // Progress messages 立即 yield
    while (tool.pendingProgress.length > 0) {
      const progressMessage = tool.pendingProgress.shift()!
      yield { message: progressMessage, newContext: this.toolUseContext }
    }

    if (tool.status === 'yielded') continue

    if (tool.status === 'completed' && tool.results) {
      tool.status = 'yielded'
      for (const message of tool.results) {
        yield { message, newContext: this.toolUseContext }
      }
      markToolUseAsComplete(this.toolUseContext, tool.id)
    } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
      break  // 非并发工具还在执行，停止遍历
    }
  }
}
```

关键的 `break` 语句：如果遇到一个还在执行的非并发工具，停止遍历——即使后面的工具已经完成了。这保证了写操作的结果不会乱序。

## 4.7 Phase 3：终止判断与错误恢复

当模型响应完成且没有 tool_use 时（`needsFollowUp === false`），循环进入终止判断阶段。这里有多条恢复路径：

### 3.1 Prompt Too Long 恢复

```
prompt_too_long (413)
    │
    ├─ Context Collapse drain → 成功 → continue (collapse_drain_retry)
    │                          └─ 失败 ↓
    ├─ Reactive Compact       → 成功 → continue (reactive_compact_retry)
    │                          └─ 失败 → yield error, return
    └─ 都没开启 → yield error, return
```

代码实现了一个三级降级链：

```typescript
// src/query.ts:1085-1117 — 先尝试 collapse drain
if (feature('CONTEXT_COLLAPSE') && contextCollapse
    && state.transition?.reason !== 'collapse_drain_retry') {
  const drained = contextCollapse.recoverFromOverflow(messagesForQuery, querySource)
  if (drained.committed > 0) {
    state = { /* ... */ transition: { reason: 'collapse_drain_retry' } }
    continue
  }
}

// src/query.ts:1119-1166 — 再尝试 reactive compact
if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
  const compacted = await reactiveCompact.tryReactiveCompact({
    hasAttempted: hasAttemptedReactiveCompact,
    // ...
  })
  if (compacted) {
    state = { /* ... */ transition: { reason: 'reactive_compact_retry' } }
    continue
  }
}
```

### 3.2 Max Output Tokens 恢复

```
max_output_tokens
    │
    ├─ maxOutputTokensOverride === undefined?
    │   └─ 是 → 升级到 ESCALATED_MAX_TOKENS (64k), continue
    │
    ├─ recoveryCount < 3?
    │   └─ 是 → 注入 recovery message, continue
    │
    └─ 都用完了 → yield error
```

Recovery message 的措辞经过精心设计：

```typescript
// src/query.ts:1224-1229
const recoveryMessage = createUserMessage({
  content:
    `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
    `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
  isMeta: true,
})
```

这条消息告诉模型：不要道歉，不要重复之前说过的内容，直接从中断的地方继续。

### 3.3 Withheld Message 模式

一个关键设计是**错误消息扣留**（withheld messages）。在 streaming 过程中，如果收到 prompt_too_long 或 max_output_tokens 错误，不立即 yield 给调用者——而是先看恢复机制能否处理：

```typescript
// src/query.ts:799-825
let withheld = false
if (feature('CONTEXT_COLLAPSE')) {
  if (contextCollapse?.isWithheldPromptTooLong(message, isPromptTooLongMessage, querySource)) {
    withheld = true
  }
}
if (reactiveCompact?.isWithheldPromptTooLong(message)) {
  withheld = true
}
if (isWithheldMaxOutputTokens(message)) {
  withheld = true
}
if (!withheld) {
  yield yieldMessage
}
```

> **设计决策**：为什么要 withhold？源码注释（`src/query.ts:166-178`）解释：*"Yielding early leaks an intermediate error to SDK callers (e.g. cowork/desktop) that terminate the session on any `error` field — the recovery loop keeps running but nobody is listening."* 如果提前 yield 错误消息，SDK 调用者（比如桌面应用）会认为会话失败并终止，但恢复循环还在后台运行——这是经典的观察者-被观察者脱节问题。

## 4.8 Phase 4-5：工具结果收割与附件注入

API streaming 结束后，剩余的工具执行结果通过 `getRemainingResults()` 收割：

```typescript
// src/query.ts:1380-1408
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

for await (const update of toolUpdates) {
  if (update.message) {
    yield update.message
    // ...
  }
  if (update.newContext) {
    updatedToolUseContext = { ...update.newContext, queryTracking }
  }
}
```

注意这里有个 fallback：如果 `streamingToolExecutor` 为 null（feature gate 关闭），就退回到 `runTools()`——一个同步顺序执行的老路径。

工具执行完毕后，附件（attachments）被注入到消息流中：

```typescript
// src/query.ts:1580-1590
for await (const attachment of getAttachmentMessages(
  null, updatedToolUseContext, null, queuedCommandsSnapshot,
  [...messagesForQuery, ...assistantMessages, ...toolResults],
  querySource,
)) {
  yield attachment
  toolResults.push(attachment)
}
```

附件包括：
- **Memory prefetch**：预取的相关记忆文件
- **Skill discovery**：自动发现的相关技能
- **Queued commands**：用户在工具执行期间输入的新命令
- **File change notifications**：文件变更通知

## 4.9 Phase 6：状态组装与 Continue

循环的最后一步是组装下一次迭代的状态：

```typescript
// src/query.ts:1715-1727
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  pendingToolUseSummary: nextPendingToolUseSummary,
  maxOutputTokensOverride: undefined,
  stopHookActive,
  transition: { reason: 'next_turn' },
}
state = next
```

注意每个 `continue` 站点设置不同的 `transition.reason`。整个文件中有 7 个不同的 continue 路径：

| Transition Reason | 触发条件 | 说明 |
|-------------------|----------|------|
| `next_turn` | 正常 tool_use → tool_result | 标准 agentic 循环迭代 |
| `max_output_tokens_recovery` | 输出被截断 | 注入 recovery message 重试 |
| `max_output_tokens_escalate` | 首次 8k 上限碰壁 | 升级到 64k 重试 |
| `reactive_compact_retry` | prompt_too_long 后压缩成功 | 压缩后重试 |
| `collapse_drain_retry` | context collapse 回收空间 | drain 后重试 |
| `stop_hook_blocking` | stop hook 返回错误 | 把错误反馈给模型 |
| `token_budget_continuation` | token budget 未耗尽 | 自动继续工作 |

## 4.10 Fallback Model 机制

当高负载导致 API 返回 529 错误超过阈值时，`withRetry` 抛出 `FallbackTriggeredError`，循环捕获它并切换模型：

```typescript
// src/query.ts:894-951
} catch (innerError) {
  if (innerError instanceof FallbackTriggeredError && fallbackModel) {
    currentModel = fallbackModel
    attemptWithFallback = true

    // 清理失败请求的所有状态
    yield* yieldMissingToolResultBlocks(assistantMessages, 'Model fallback triggered')
    assistantMessages.length = 0
    toolResults.length = 0
    toolUseBlocks.length = 0
    needsFollowUp = false

    // 重建 streaming tool executor
    if (streamingToolExecutor) {
      streamingToolExecutor.discard()
      streamingToolExecutor = new StreamingToolExecutor(
        toolUseContext.options.tools, canUseTool, toolUseContext,
      )
    }

    // 更新 context 里的 model
    toolUseContext.options.mainLoopModel = fallbackModel

    // Thinking signatures 与 model 绑定，切换后要清除
    if (process.env.USER_TYPE === 'ant') {
      messagesForQuery = stripSignatureBlocks(messagesForQuery)
    }

    yield createSystemMessage(
      `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand...`,
      'warning',
    )
    continue  // 重试 API 调用
  }
  throw innerError
}
```

Fallback 过程中有一个细节：`streamingToolExecutor.discard()` 会丢弃之前失败请求中已经在执行的工具。这防止了旧的 tool_result（带有旧的 tool_use_id）泄露到重试的响应中。

## 4.11 Abort 处理：优雅退出

用户按 Ctrl+C 或 Escape 时，`abortController.signal.aborted` 变为 `true`。循环有两个地方检查 abort：

**Streaming 结束后（`src/query.ts:1015-1052`）**：

```typescript
if (toolUseContext.abortController.signal.aborted) {
  if (streamingToolExecutor) {
    // 消费剩余结果——executor 会为未完成的工具生成 synthetic tool_result
    for await (const update of streamingToolExecutor.getRemainingResults()) {
      if (update.message) yield update.message
    }
  } else {
    yield* yieldMissingToolResultBlocks(assistantMessages, 'Interrupted by user')
  }

  // submit-interrupt 不需要中断消息（排队的用户消息提供了足够上下文）
  if (toolUseContext.abortController.signal.reason !== 'interrupt') {
    yield createUserInterruptionMessage({ toolUse: false })
  }
  return { reason: 'aborted_streaming' }
}
```

**工具执行结束后（`src/query.ts:1485-1516`）**：

```typescript
if (toolUseContext.abortController.signal.aborted) {
  if (toolUseContext.abortController.signal.reason !== 'interrupt') {
    yield createUserInterruptionMessage({ toolUse: true })
  }
  return { reason: 'aborted_tools' }
}
```

两种 abort 的区别在于 `toolUse: true/false` 参数——它告诉 UI 中断发生在工具执行期间还是 streaming 期间。

## 4.12 依赖注入：QueryDeps

循环的所有外部依赖通过 `QueryDeps` 注入：

```typescript
// src/query/deps.ts
export type QueryDeps = {
  callModel: typeof queryModelWithStreaming
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded
  uuid: () => string
}

export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
```

测试时可以替换任何依赖：

```typescript
const deps = params.deps ?? productionDeps()
```

> **设计决策**：为什么不用 class + interface 做依赖注入？因为 `queryLoop` 是一个函数，不是类。把四个函数打包成一个 plain object 比创建 class hierarchy 更简单。`productionDeps()` 就是一个 factory function，测试代码可以 `{ ...productionDeps(), callModel: mockCallModel }` 来替换单个依赖。这种方式避免了 class mock 的复杂性（`jest.mock()` 的各种陷阱），同时保持了类型安全。

## 4.13 QueryEngine：会话级生命周期

`QueryEngine`（`src/QueryEngine.ts`）在 `query()` 之上管理完整的会话生命周期：

```
QueryEngine
├── submitMessage()    // 提交一条用户消息，返回 async generator
├── ask()             // 一次性便捷方法
├── messages          // 对话历史
├── abortController   // 会话级 abort
├── sessionPersist    // 会话持久化
└── usageTracking     // token 用量跟踪
```

`submitMessage()` 是 SDK 和 UI 调用的入口。它负责：

1. 组装 system prompt（调用 `fetchSystemPromptParts()`）
2. 创建 `ToolUseContext`
3. 调用 `query()` 并转发所有 yield 的事件
4. 更新 `this.messages` 保存对话历史
5. 调用 `sessionPersist` 持久化会话

`ask()` 是简化版，用于一次性查询（比如 compact 时的摘要生成）：

```typescript
async ask(question: string): Promise<string> {
  const gen = this.submitMessage(question)
  let result = ''
  for await (const event of gen) {
    if (event.type === 'assistant') {
      // 收集文本内容
    }
  }
  return result
}
```

## 4.14 Stop Hooks：决定何时真正停止

当模型没有输出 tool_use 时，并不意味着循环一定结束。Stop hooks（`src/query/stopHooks.ts`）提供了一个插入点：

```typescript
// src/query.ts:1267-1306
const stopHookResult = yield* handleStopHooks(
  messagesForQuery, assistantMessages,
  systemPrompt, userContext, systemContext,
  toolUseContext, querySource, stopHookActive,
)

if (stopHookResult.preventContinuation) {
  return { reason: 'stop_hook_prevented' }
}

if (stopHookResult.blockingErrors.length > 0) {
  state = {
    messages: [...messagesForQuery, ...assistantMessages, ...stopHookResult.blockingErrors],
    // ...
    transition: { reason: 'stop_hook_blocking' },
  }
  continue  // 把 hook 错误反馈给模型
}
```

Stop hooks 运行的内容包括：
- **Memory extraction**：自动提取对话中的重要信息保存到记忆
- **Prompt suggestion**：生成后续提示建议
- **Auto-dream**：后台记忆整理
- **Teammate hooks**：TaskCompleted、TeammateIdle 通知

Stop hooks 是**后台运行**的（`void` 调用），不阻塞循环。只有 `blockingErrors` 会导致循环继续。

## 4.15 MaxTurns 安全阀

作为最后的安全网，循环有一个 `maxTurns` 检查：

```typescript
// src/query.ts:1705-1712
if (maxTurns && nextTurnCount > maxTurns) {
  yield createAttachmentMessage({
    type: 'max_turns_reached',
    maxTurns,
    turnCount: nextTurnCount,
  })
  return { reason: 'max_turns', turnCount: nextTurnCount }
}
```

这个检查在工具执行和附件注入之后，状态组装之前。它确保即使模型陷入无限循环，也会在有限步骤后停止。

## 4.16 Feature Flags：条件编译

循环中大量使用 `feature()` 来做条件编译：

```typescript
import { feature } from 'bun:bundle'

const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('./services/compact/reactiveCompact.js') as ...)
  : null

const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? (require('./services/contextCollapse/index.js') as ...)
  : null
```

`feature()` 是 Bun bundler 的编译时常量。在外部构建（3P builds）中，这些条件会被编译器常量折叠为 `false`，相关代码和 `require()` 会被 dead code elimination 完全移除。这意味着外部用户的 Claude Code 二进制文件更小，不包含内部实验性功能的代码。

## 4.17 完整生命周期图

```
用户输入 "Fix the bug in auth.ts"
    │
    ▼
QueryEngine.submitMessage()
    │
    ├─ fetchSystemPromptParts()     // 并行获取 system prompt + contexts
    │   ├─ getSystemPrompt()
    │   ├─ getUserContext()
    │   └─ getSystemContext()
    │
    ├─ 创建 ToolUseContext
    │
    └─ query() → queryLoop()
        │
        ▼
    while (true) {
        │
        ├─ [压缩管线]
        │   ├─ applyToolResultBudget()
        │   ├─ snipCompactIfNeeded()
        │   ├─ microcompactMessages()
        │   ├─ applyCollapsesIfNeeded()
        │   └─ autoCompactIfNeeded()
        │
        ├─ [API 调用 + Streaming]
        │   ├─ callModel() → for await (message of stream)
        │   │   ├─ yield assistant text
        │   │   ├─ tool_use block → StreamingToolExecutor.addTool()
        │   │   └─ getCompletedResults() → yield tool results
        │   │
        │   └─ catch FallbackTriggeredError → 切换模型重试
        │
        ├─ [终止判断]
        │   ├─ no tool_use? → stop hooks → return
        │   ├─ prompt_too_long? → collapse drain / reactive compact
        │   └─ max_output_tokens? → escalate / recovery message
        │
        ├─ [剩余工具结果]
        │   └─ getRemainingResults() → yield remaining
        │
        ├─ [附件注入]
        │   ├─ getAttachmentMessages()
        │   ├─ memory prefetch consume
        │   └─ skill discovery consume
        │
        ├─ [maxTurns 检查]
        │
        └─ state = { ..., transition: { reason: 'next_turn' } }
    }
```

## 4.18 本章速查表

| 概念 | 文件位置 | 关键函数/类型 |
|------|----------|---------------|
| Agentic Loop 入口 | `src/query.ts:219` | `query()` |
| 主状态机 | `src/query.ts:241` | `queryLoop()` |
| 循环状态类型 | `src/query.ts:204` | `State` |
| 查询参数 | `src/query.ts:181` | `QueryParams` |
| Streaming 工具执行器 | `src/services/tools/StreamingToolExecutor.ts:40` | `StreamingToolExecutor` |
| 并发安全检查 | `src/services/tools/StreamingToolExecutor.ts:129` | `canExecuteTool()` |
| 工具执行入口 | `src/services/tools/StreamingToolExecutor.ts:76` | `addTool()` |
| 结果收割（非阻塞） | `src/services/tools/StreamingToolExecutor.ts:412` | `getCompletedResults()` |
| 结果收割（阻塞） | `src/services/tools/StreamingToolExecutor.ts:453` | `getRemainingResults()` |
| 依赖注入 | `src/query/deps.ts:7` | `QueryDeps` |
| 生产依赖 | `src/query/deps.ts:14` | `productionDeps()` |
| 会话级管理 | `src/QueryEngine.ts` | `QueryEngine` |
| Stop Hooks | `src/query/stopHooks.ts` | `handleStopHooks()` |
| Max output tokens 限制 | `src/query.ts:164` | `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3` |
| Feature flags | `bun:bundle` | `feature('REACTIVE_COMPACT')` 等 |
| 工具执行 fallback | `src/services/tools/toolOrchestration.ts` | `runTools()` |
