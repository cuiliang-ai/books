# 第七章 Context Management：有限记忆的艺术

> **核心问题**：当对话历史超过模型的 context window 时怎么办？Claude Code 用了一套五级压缩体系——从最轻量的结果截断到最重量级的全对话摘要——让 Agent 在理论上拥有无限长的对话记忆。

---

## 7.1 为什么需要 Context Management

Claude 模型有 200K token 的 context window。听起来很大，但在 agentic coding 场景下，token 消耗速度惊人：

- 一个 system prompt：3000-5000 tokens
- 一次文件读取（1000 行代码）：~4000 tokens
- 一次 grep 搜索结果：~2000 tokens
- 模型的一次回复（含 thinking）：5000-20000 tokens
- 一次 shell 命令输出：500-5000 tokens

一个典型的 bug 修复任务可能涉及 5-10 次文件读取、3-5 次搜索、2-3 次编辑、几次测试运行。这很容易累积到 100K tokens 以上。如果用户接着说"再帮我修另一个 bug"，context 就快满了。

Claude Code 的解决方案是一套渐进式压缩管线，在 `queryLoop()` 的每次迭代开头运行：

```
轻量级 ←─────────────────────────────→ 重量级
   │                                      │
   ▼                                      ▼
Content      Snip      Micro     Context   Auto
Replacement  Compact   Compact   Collapse  Compact
   │           │         │         │         │
   │           │         │         │         └─ 全对话摘要（调用模型）
   │           │         │         └─ 分段压缩
   │           │         └─ 清除旧工具输出
   │           └─ 按时间删除老消息段
   └─ 截断大结果
```

## 7.2 Content Replacement：第一道防线

Content Replacement（`src/utils/toolResultStorage.ts:applyToolResultBudget()`）在所有其他压缩之前运行。它的工作很简单：把超大的工具结果截断到合理大小。

```typescript
// src/query.ts:379-394
messagesForQuery = await applyToolResultBudget(
  messagesForQuery,
  toolUseContext.contentReplacementState,
  persistReplacements ? records =>
    void recordContentReplacement(records, toolUseContext.agentId).catch(logError)
  : undefined,
  new Set(
    toolUseContext.options.tools
      .filter(t => !Number.isFinite(t.maxResultSizeChars))
      .map(t => t.name),
  ),
)
```

每个工具可以定义 `maxResultSizeChars`——结果超过这个长度就会被截断。最后一个参数是"豁免集合"——没有定义大小限制的工具不会被截断。

Content Replacement 之所以排第一，有两个原因：

1. **它不依赖其他压缩的结果** —— 只看每条消息自身的大小
2. **它操作的是 tool_use_id，与 cached microcompact 兼容** —— cached MC 通过 tool_use_id 工作，content replacement 只修改内容不删除消息，两者互不干扰

被替换的内容可以持久化到磁盘（通过 `recordContentReplacement()`），这样在会话恢复（`/resume`）时可以读回来。

## 7.3 Snip Compact：按时间删除

Snip Compact（`src/services/compact/snipCompact.ts`）是一个基于时间的压缩策略。它删除对话历史中的老消息段，只保留最近的交互。

```typescript
// src/query.ts:401-410
if (feature('HISTORY_SNIP')) {
  queryCheckpoint('query_snip_start')
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
  if (snipResult.boundaryMessage) {
    yield snipResult.boundaryMessage
  }
  queryCheckpoint('query_snip_end')
}
```

Snip 返回三个值：
- `messages`：删除后的消息数组
- `tokensFreed`：释放的 token 数量
- `boundaryMessage`：分界标记消息（告诉模型有些历史被删除了）

`tokensFreed` 会被传递给后续的 autocompact，让它的阈值检查反映 snip 已经释放的空间。这避免了一个 bug：`tokenCountWithEstimation()` 读取的是上一次 API 响应的 usage，而 snip 是在客户端做的——如果不传递 `tokensFreed`，autocompact 会看到过时的 token 计数，可能在不必要时触发昂贵的全对话摘要。

## 7.4 MicroCompact：清除旧工具输出

MicroCompact（`src/services/compact/microCompact.ts`，531 行）是最巧妙的压缩策略。它的核心思想是：**旧的工具输出可以被安全删除，因为模型已经"看过"了它们并做出了反应**。

```
可压缩的工具（COMPACTABLE_TOOLS）：
  FileRead, Shell, Grep, Glob, WebSearch,
  WebFetch, FileEdit, FileWrite
```

比如模型在第 3 轮读取了 `auth.ts` 的内容（2000 tokens），在第 4 轮根据内容做了编辑，在第 8 轮已经远远离开了这段代码。这时第 3 轮的 `FileRead` 结果就可以被清除——模型已经用过它了，保留在 context 中只是占空间。

### 两种 MicroCompact 策略

```typescript
// src/services/compact/microCompact.ts
export async function microcompactMessages(
  messages: Message[],
  toolUseContext: ToolUseContext,
  querySource: QuerySource,
): Promise<MicrocompactResult> {
  // 策略 1：Time-based MC
  const timeBasedResult = await tryTimeBasedMC(messages, toolUseContext)
  if (timeBasedResult) return timeBasedResult

  // 策略 2：Cached MC（Cache Editing API）
  const cachedResult = await tryCachedMC(messages, toolUseContext)
  if (cachedResult) return cachedResult

  return { messages, compactionInfo: null }
}
```

#### Time-Based MicroCompact

基于时间间隔的 MC 比较简单——如果上次 assistant 响应距今超过某个阈值（比如对话已经沉默了一段时间后恢复），就清除老的工具结果：

```typescript
// src/services/compact/microCompact.ts
const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'
```

被清除的工具结果内容被替换为 `'[Old tool result content cleared]'`。这个标记文字很重要——模型看到它就知道这里曾经有工具输出，但已经被清除了，不会以为是 bug。

#### Cached MicroCompact

Cached MC 使用 Anthropic 的 **Cache Editing API**——它可以让服务器端删除缓存前缀中的特定 content blocks，而不使整个缓存失效。这是一个关键优化：

```
传统做法：
  修改消息内容 → 整个缓存失效 → 重新计算所有 attention

Cached MC 做法：
  通过 cache_edit 指令删除 block → 缓存保持有效 → 只重新计算删除部分

                     省掉了重新计算已缓存前缀的成本
```

```typescript
// src/services/compact/microCompact.ts
function collectCompactableToolIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (block.type === 'tool_use' && COMPACTABLE_TOOLS.has(block.name)) {
        ids.push(block.id)
      }
    }
  }
  return ids
}
```

`collectCompactableToolIds()` 遍历消息历史，找出所有可压缩工具的 tool_use_id。这些 ID 被传给 cache editing API，让服务器删除对应的 tool_result 内容。

> **设计决策**：为什么 cached MC 在 time-based MC 之后而不是相反？因为 time-based MC 是客户端操作（修改消息内容），cached MC 是服务端操作（通过 API header 指示服务器删除）。如果 time-based MC 已经处理了，就不需要再用 cached MC 了。先做客户端操作更安全——如果 cache editing API 出问题，不影响基本功能。

### Pin 机制

Cached MC 有一个 "pin" 机制，用来保护某些 tool result 不被删除：

```typescript
// src/services/compact/microCompact.ts
export function pinCacheEdits(toolIds: string[]): void {
  // 标记这些 tool_use_id 的结果为"不可删除"
}

export function getPinnedCacheEdits(): Set<string> {
  return pinnedToolIds
}
```

当模型正在使用某个工具的结果时（比如正在根据 FileRead 的输出写代码），这个结果应该被 pin 住，防止 MC 在它还有用的时候删除它。

## 7.5 Context Collapse：分段压缩

Context Collapse（`src/services/contextCollapse/index.ts`）是介于 MicroCompact 和 AutoCompact 之间的中间层。它不是压缩整个对话，而是**分段**压缩——每次只压缩一部分老消息，保留最近的上下文。

```typescript
// src/query.ts:440-447
if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
  const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
    messagesForQuery,
    toolUseContext,
    querySource,
  )
  messagesForQuery = collapseResult.messages
}
```

Context Collapse 的核心理念是**读时投影**（read-time projection）：

```
原始消息历史（完整保留在内存中）：
  [M1] [M2] [M3] [M4] [M5] [M6] [M7] [M8] [M9] [M10]

Collapse store（记录哪些消息段被压缩了）：
  Collapse #1: M1-M4 → "User asked about auth module, found bug in line 42"
  Collapse #2: M5-M7 → "Fixed bug, ran tests, all passed"

投影视图（发给 API 的）：
  [Summary_1] [Summary_2] [M8] [M9] [M10]
```

源码注释（`src/query.ts:433-439`）解释了这个设计：*"Nothing is yielded — the collapsed view is a read-time projection over the REPL's full history. Summary messages live in the collapse store, not the REPL array."* 原始消息永远保留，只是在发给 API 之前被投影为压缩版本。

Context Collapse 排在 AutoCompact 之前，理由是（`src/query.ts:430-432`）：*"Runs BEFORE autocompact so that if collapse gets us under the autocompact threshold, autocompact is a no-op and we keep granular context instead of a single summary."* 如果 collapse 足以把 token 数降到阈值以下，就不需要做更激进的全对话摘要了。

### Overflow Recovery

当 API 返回 prompt_too_long 错误时，Context Collapse 可以作为第一道恢复手段：

```typescript
// src/query.ts:1090-1117
if (feature('CONTEXT_COLLAPSE') && contextCollapse
    && state.transition?.reason !== 'collapse_drain_retry') {
  const drained = contextCollapse.recoverFromOverflow(messagesForQuery, querySource)
  if (drained.committed > 0) {
    state = { /* ... */ transition: { reason: 'collapse_drain_retry' } }
    continue
  }
}
```

`recoverFromOverflow()` 会把所有已暂存但未提交的 collapse 立即提交，释放更多空间。`state.transition?.reason !== 'collapse_drain_retry'` 防止无限循环——如果 drain 一次后还是 prompt_too_long，就不再尝试。

## 7.6 AutoCompact：全对话摘要

AutoCompact（`src/services/compact/autoCompact.ts`，352 行）是最后的防线——当所有轻量级压缩都不够时，它调用模型生成对话摘要。

### 阈值计算

```typescript
// src/services/compact/autoCompact.ts
export function getEffectiveContextWindowSize(model: string): number {
  const contextWindow = getModelContextWindow(model)
  const maxOutput = getModelMaxOutputTokens(model)
  return contextWindow - Math.min(maxOutput, 20000)
}

const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000

export function getAutoCompactThreshold(model: string): number {
  return getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS
}
```

以 200K context window 的模型为例：

```
Context Window:  200,000 tokens
Max Output:       20,000 tokens
Effective Window: 180,000 tokens (200K - 20K)

Auto Compact Threshold: 167,000 tokens (180K - 13K buffer)
Warning Threshold:      160,000 tokens (180K - 20K buffer)
Blocking Limit:         177,000 tokens (180K - 3K buffer)
```

```
   0                    160K      167K     177K    180K    200K
   ├─────────────────────┼────────┼────────┼───────┤────────┤
   │    Normal Operation │Warning │ Auto   │Block  │Max Out │
   │                     │        │Compact │       │        │
```

### Token Warning State

```typescript
// src/services/compact/autoCompact.ts
export function calculateTokenWarningState(
  tokenCount: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const effectiveWindow = getEffectiveContextWindowSize(model)
  const percentLeft = Math.round(((effectiveWindow - tokenCount) / effectiveWindow) * 100)

  return {
    percentLeft,
    isAboveWarningThreshold: tokenCount >= effectiveWindow - WARNING_THRESHOLD_BUFFER_TOKENS,
    isAboveErrorThreshold: tokenCount >= effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS,
    isAboveAutoCompactThreshold: tokenCount >= getAutoCompactThreshold(model),
    isAtBlockingLimit: tokenCount >= effectiveWindow - MANUAL_COMPACT_BUFFER_TOKENS,
  }
}
```

这个函数返回一个多级状态对象。UI 用它来显示 context 使用百分比和颜色指示器。`isAtBlockingLimit` 为 `true` 时，系统会阻止 API 调用并提示用户手动 `/compact`。

### 断路器：防止压缩风暴

```typescript
// src/services/compact/autoCompact.ts
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource: QuerySource,
  tracking: AutoCompactTrackingState | undefined,
  snipTokensFreed: number,
): Promise<{
  compactionResult: CompactionResult | undefined
  consecutiveFailures: number | undefined
}> {
  // 检查是否启用
  if (!isAutoCompactEnabled()) return noCompaction
  if (!shouldAutoCompact(querySource)) return noCompaction

  // Token 计数
  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(toolUseContext.options.mainLoopModel)
  if (tokenCount < threshold) return noCompaction

  // 断路器检查
  const failures = tracking?.consecutiveFailures ?? 0
  if (failures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    logEvent('tengu_autocompact_circuit_breaker_tripped')
    return noCompaction
  }

  // 执行压缩
  try {
    const result = await compactConversation(messages, cacheSafeParams, toolUseContext)
    return { compactionResult: result, consecutiveFailures: 0 }
  } catch (error) {
    return { compactionResult: undefined, consecutiveFailures: failures + 1 }
  }
}
```

断路器在连续 3 次压缩失败后停止重试。这防止了一个场景：压缩请求本身消耗 token，如果反复失败，可能会让 context 更快溢出。

### shouldAutoCompact()：防止递归

```typescript
// src/services/compact/autoCompact.ts
export function shouldAutoCompact(querySource: QuerySource): boolean {
  // 防止压缩递归：compact 源的查询不能触发 autocompact
  if (querySource === 'compact' || querySource === 'session_memory') {
    return false
  }
  // reactive-only mode 下不主动压缩
  if (isReactiveCompactOnly()) return false
  // context-collapse mode 下不主动压缩
  if (isContextCollapseEnabled()) return false

  return true
}
```

最关键的是 `querySource === 'compact'` 检查。压缩过程本身需要调用模型来生成摘要，这个调用也会经过 `queryLoop`——如果不排除，就会触发无限递归：compress → queryLoop → should compress? → compress → …

## 7.7 compactConversation()：摘要生成

`compactConversation()`（`src/services/compact/compact.ts`，1706 行）是执行全对话摘要的核心函数。

### 整体流程

```
compactConversation()
    │
    ├─ Pre-compact hooks
    │   └─ 通知 hooks 即将压缩
    │
    ├─ streamCompactSummary()
    │   ├─ 优先：forked agent（共享 cache prefix）
    │   └─ 降级：直接 streaming
    │
    ├─ buildPostCompactMessages()
    │   ├─ Boundary marker
    │   ├─ Summary messages
    │   ├─ Messages to keep（protected tail）
    │   ├─ Post-compact file attachments
    │   ├─ Post-compact skill attachments
    │   └─ Hook results
    │
    └─ Post-compact file restoration
```

### streamCompactSummary()

```typescript
// src/services/compact/compact.ts
async function streamCompactSummary(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
): Promise<CompactSummary> {
  // 优先使用 forked agent——它能共享主对话的 cache prefix
  try {
    return await streamCompactSummaryWithFork(messages, cacheSafeParams)
  } catch {
    // 降级到直接 streaming
    return await streamCompactSummaryDirect(messages)
  }
}
```

使用 forked agent 做摘要有一个缓存优势：fork 继承了主对话的 system prompt 和消息前缀，可以复用已有的 KV cache。如果直接创建新请求，整个 prompt 要重新计算。

### buildPostCompactMessages()

```typescript
// src/services/compact/compact.ts
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    // 1. Boundary marker
    createCompactBoundaryMessage(),
    // 2. Summary messages
    ...result.summaryMessages,
    // 3. Messages to keep (protected tail)
    ...result.messagesToKeep,
    // 4. Post-compact file attachments
    ...result.attachments,
    // 5. Hook results
    ...result.hookResults,
  ]
}
```

Post-compact 消息结构是精心设计的：

```
┌─────────────────────────────┐
│ Compact Boundary Marker     │  ← 标记压缩点
├─────────────────────────────┤
│ Summary: "User was working  │  ← 模型生成的摘要
│ on auth bug in line 42..."  │
├─────────────────────────────┤
│ Protected tail messages     │  ← 保留最近 N 条消息
├─────────────────────────────┤
│ File attachments (max 5)    │  ← 重要文件内容快照
│ - auth.ts (first 5K tokens) │
│ - test.ts (first 5K tokens) │
├─────────────────────────────┤
│ Skill attachments           │  ← 相关技能上下文
├─────────────────────────────┤
│ Hook results                │  ← hook 产生的额外上下文
└─────────────────────────────┘
```

### Post-Compact File Attachments

压缩后，最近操作过的文件内容会被重新附加：

```typescript
// src/services/compact/compact.ts
// 最多 5 个文件
const MAX_POST_COMPACT_FILES = 5
// 每个文件最多 5K tokens
const MAX_TOKENS_PER_FILE = 5_000
// 总计最多 50K tokens
const MAX_TOTAL_TOKENS = 50_000
```

这些参数确保了文件附件不会让压缩后的 context 重新膨胀。选择哪些文件附加是基于最近的编辑历史——模型最近编辑或读取的文件更可能在后续工作中需要。

> **设计决策**：为什么要在压缩后重新附加文件内容？因为摘要是文字描述（"User edited auth.ts to fix the null check on line 42"），但如果模型需要继续修改同一个文件，光有描述不够——它需要看到实际的代码。文件附件弥补了这个信息差距。但有上限（5 个文件、50K tokens），防止"重新附加"变成"重新创建整个 context"。

### Protected Tail

不是所有消息都被压缩。最近的消息保留原样（"protected tail"）：

```typescript
// src/services/compact/compact.ts
function getMessagesToKeep(messages: Message[]): Message[] {
  // 保留最后一个完整的 assistant turn 及其 tool results
  // 这确保了压缩后模型的工作记忆不会断裂
}
```

Protected tail 跳过文件附件以避免重复——如果某个文件已经在 protected tail 的消息中了，就不需要再作为 post-compact attachment 附加。

### Image Stripping

压缩前，图片被替换为标记：

```typescript
// src/services/compact/compact.ts
function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map(msg => {
    // 把 image blocks 替换为 { type: 'text', text: '[image]' }
  })
}
```

图片不能被送入压缩模型（占用过多 token 且对摘要无用）。`[image]` 标记让模型知道这里曾经有图片，但具体内容已经丢失了。

## 7.8 Reactive Compact：紧急恢复

Reactive Compact（`src/services/compact/reactiveCompact.ts`）不是主动压缩——它只在 API 返回 `prompt_too_long` 错误时触发：

```typescript
// src/query.ts:1119-1166
if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
  const compacted = await reactiveCompact.tryReactiveCompact({
    hasAttempted: hasAttemptedReactiveCompact,
    querySource,
    aborted: toolUseContext.abortController.signal.aborted,
    messages: messagesForQuery,
    cacheSafeParams: {
      systemPrompt, userContext, systemContext,
      toolUseContext, forkContextMessages: messagesForQuery,
    },
  })

  if (compacted) {
    state = { /* ... */ hasAttemptedReactiveCompact: true,
              transition: { reason: 'reactive_compact_retry' } }
    continue
  }

  // 恢复失败 → 表面化错误
  yield lastMessage
  return { reason: 'prompt_too_long' }
}
```

`hasAttemptedReactiveCompact` 标记防止无限循环：如果 reactive compact 一次不够，不会再尝试第二次。这个标记在正常的 `next_turn` transition 时重置为 `false`——下一个正常 turn 允许再次触发 reactive compact。

Reactive compact 也处理 media size errors（图片/PDF 太大）。策略是删除大图片后重试——如果删除后仍然超过限制，就表面化错误。

## 7.9 Manual Compact：用户触发

用户可以通过 `/compact` 命令手动触发压缩。手动压缩使用更小的 buffer（`MANUAL_COMPACT_BUFFER_TOKENS = 3,000`），比自动压缩（13,000）更激进：

```
自动压缩在 167K 触发（留 13K buffer）
手动压缩可以在更低阈值触发（留 3K buffer）
```

这个差异存在是因为自动压缩需要更大的安全余量——它可能在模型正在生成长回复时触发，需要足够空间完成当前回复。手动压缩是用户主动触发的，他们期望尽可能多地释放空间。

### Partial Compact

除了全对话压缩，还有 partial compact：

```typescript
// src/services/compact/compact.ts
export async function partialCompactConversation(
  messages: Message[],
  direction: 'from' | 'up_to',
  messageIndex: number,
  // ...
): Promise<CompactionResult> {
  // 'from': 压缩从 messageIndex 开始到最新的消息
  // 'up_to': 压缩从最早到 messageIndex 的消息
}
```

Partial compact 让用户可以选择性地压缩对话的一部分，比如"压缩前半段但保留最近的工作"。

## 7.10 PTL Retry：Prompt Too Long 的降级策略

当 prompt_too_long 错误发生且所有压缩都失败时，还有一个最后的手段——PTL retry：

```typescript
// src/services/compact/compact.ts
function truncateHeadForPTLRetry(
  messages: Message[],
  maxRetries: number,
): { messages: Message[]; retryCount: number } {
  // 删除最老的 API-round groups（一轮 assistant + tool_result）
  // 最多重试 3 次
}
```

PTL retry 通过删除最老的完整交互轮次来减少 token 数。它最多重试 3 次，每次删除最老的一组消息。这比全对话压缩更粗暴但更快——不需要调用模型生成摘要。

## 7.11 Token 计数与估算

`tokenCountWithEstimation()`（`src/utils/tokens.ts`）是压缩决策的基础。它的挑战是：精确的 token 计数需要运行 tokenizer（耗时），但压缩决策需要快速做出。

```typescript
// src/utils/tokens.ts
export function tokenCountWithEstimation(messages: Message[]): number {
  // 使用上次 API 响应的 input_tokens 作为基准
  const lastUsage = getLastAPIResponseUsage(messages)
  if (lastUsage) {
    return lastUsage.input_tokens +
           (lastUsage.cache_creation_input_tokens ?? 0) +
           (lastUsage.cache_read_input_tokens ?? 0)
  }
  // 回退到估算
  return estimateTokenCount(messages)
}
```

它优先使用上次 API 响应中的 `input_tokens`——这是服务器返回的精确值。只有在没有历史 usage 数据时才使用估算。

`finalContextTokensFromLastResponse()` 提取更精确的值，用于 task_budget 计算：

```typescript
// src/utils/tokens.ts
export function finalContextTokensFromLastResponse(
  messages: Message[],
): number {
  // 找最后一条 assistant message 的 usage
  // iterations[-1] 是权威的最终窗口大小
}
```

## 7.12 isAutoCompactEnabled()：尊重用户配置

```typescript
// src/services/compact/autoCompact.ts
export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) return false
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) return false
  // 检查用户配置
  return true
}
```

用户可以通过环境变量完全禁用压缩（`DISABLE_COMPACT`）或只禁用自动压缩（`DISABLE_AUTO_COMPACT`）。禁用自动压缩时，用户仍然可以手动 `/compact`。

## 7.13 压缩管线的协调

五级压缩不是互相独立的——它们有精心设计的协调关系：

```
┌──────────────────────────────────────────────────┐
│ Coordination Rules:                               │
│                                                    │
│ 1. Content Replacement 先于 MC                    │
│    (MC 靠 tool_use_id 工作,                       │
│     CR 不删除消息，两者互不干扰)                    │
│                                                    │
│ 2. Snip 先于 MC                                   │
│    (两者不互斥，可以都运行)                         │
│                                                    │
│ 3. MC 先于 Collapse                               │
│    (MC 减少的 token 让 Collapse 更少地运行)         │
│                                                    │
│ 4. Collapse 先于 AutoCompact                      │
│    (如果 Collapse 够了，不需要做昂贵的全摘要)       │
│                                                    │
│ 5. snipTokensFreed 传给 AutoCompact               │
│    (避免用过时 usage 做决策)                        │
│                                                    │
│ 6. compactConversation 不能在 compact/             │
│    session_memory querySource 中触发                │
│    (防止递归)                                      │
│                                                    │
│ 7. Reactive Compact 只在 PTL 错误时触发            │
│    (不主动运行，只做紧急恢复)                       │
│                                                    │
│ 8. hasAttemptedReactiveCompact 在                  │
│    next_turn 时重置                                │
│    (每个正常 turn 允许一次 reactive compact)        │
└──────────────────────────────────────────────────┘
```

## 7.14 Compact 后的状态管理

压缩完成后，`queryLoop` 的状态更新有几个关键点：

```typescript
// src/query.ts:521-543
tracking = {
  compacted: true,
  turnId: deps.uuid(),
  turnCounter: 0,
  consecutiveFailures: 0,
}

const postCompactMessages = buildPostCompactMessages(compactionResult)

for (const message of postCompactMessages) {
  yield message
}

messagesForQuery = postCompactMessages
```

1. **tracking 重置** —— 新的 `turnId`、`turnCounter` 归零
2. **yield 所有 post-compact 消息** —— 调用者（QueryEngine）保存到 `this.messages`
3. **messagesForQuery 替换** —— 后续的 API 调用使用压缩后的消息

`yield` post-compact 消息是关键——它通知上层（QueryEngine、SDK、UI）对话被压缩了。QueryEngine 会用这些消息替换掉旧的对话历史。

## 7.15 Session Memory Compaction

在 autoCompact 触发前，系统优先尝试 session memory compaction：

```typescript
// src/services/compact/autoCompact.ts
async function autoCompactIfNeeded(...) {
  // ...
  // 优先尝试 session memory compaction
  const memoryResult = await trySessionMemoryCompaction(messages, toolUseContext)
  if (memoryResult) return { compactionResult: memoryResult, consecutiveFailures: 0 }

  // 回退到 compactConversation
  return await compactConversation(...)
}
```

Session memory compaction 比全对话摘要更轻量——它只把重要信息提取到持久化记忆中，然后删除被提取的消息，而不是生成完整摘要。

## 7.16 完整压缩决策树

```
queryLoop() 每次迭代开头
    │
    ├─ applyToolResultBudget()
    │   └─ 截断超大工具结果
    │
    ├─ snipCompactIfNeeded()
    │   └─ 删除老消息段 → snipTokensFreed
    │
    ├─ microcompactMessages()
    │   ├─ time-based MC → 清除旧 tool results
    │   └─ cached MC → 通过 cache editing 删除
    │
    ├─ applyCollapsesIfNeeded()
    │   └─ 投影已提交的 collapse
    │
    └─ autoCompactIfNeeded()
        ├─ isAutoCompactEnabled()? → No → 跳过
        ├─ shouldAutoCompact()? → No → 跳过
        ├─ tokenCount < threshold? → 跳过
        ├─ consecutiveFailures >= 3? → 断路器跳过
        ├─ trySessionMemoryCompaction() → 成功? → 返回
        └─ compactConversation() → 成功? → 返回

API 调用后错误恢复：
    │
    ├─ prompt_too_long?
    │   ├─ Context Collapse drain → 成功 → continue
    │   ├─ Reactive Compact → 成功 → continue
    │   └─ 都失败 → yield error, exit
    │
    └─ max_output_tokens?
        ├─ Escalate to 64K → continue
        ├─ Recovery message (max 3 次) → continue
        └─ 都用完 → yield error
```

## 7.17 本章速查表

| 概念 | 文件位置 | 关键函数/类型 |
|------|----------|---------------|
| Content Replacement | `src/utils/toolResultStorage.ts` | `applyToolResultBudget()` |
| Snip Compact | `src/services/compact/snipCompact.ts` | `snipCompactIfNeeded()` |
| MicroCompact 入口 | `src/services/compact/microCompact.ts` | `microcompactMessages()` |
| 可压缩工具集 | `src/services/compact/microCompact.ts` | `COMPACTABLE_TOOLS` |
| 清除标记 | `src/services/compact/microCompact.ts` | `TIME_BASED_MC_CLEARED_MESSAGE` |
| 可压缩 ID 收集 | `src/services/compact/microCompact.ts` | `collectCompactableToolIds()` |
| Cache edit pin | `src/services/compact/microCompact.ts` | `pinCacheEdits()` |
| Context Collapse | `src/services/contextCollapse/index.ts` | `applyCollapsesIfNeeded()` |
| Collapse 溢出恢复 | `src/services/contextCollapse/index.ts` | `recoverFromOverflow()` |
| AutoCompact 入口 | `src/services/compact/autoCompact.ts` | `autoCompactIfNeeded()` |
| 有效窗口大小 | `src/services/compact/autoCompact.ts` | `getEffectiveContextWindowSize()` |
| AutoCompact 阈值 | `src/services/compact/autoCompact.ts` | `getAutoCompactThreshold()` |
| AutoCompact buffer | `src/services/compact/autoCompact.ts` | `AUTOCOMPACT_BUFFER_TOKENS = 13,000` |
| 手动 compact buffer | `src/services/compact/autoCompact.ts` | `MANUAL_COMPACT_BUFFER_TOKENS = 3,000` |
| 警告阈值 buffer | `src/services/compact/autoCompact.ts` | `WARNING_THRESHOLD_BUFFER_TOKENS = 20,000` |
| 断路器限制 | `src/services/compact/autoCompact.ts` | `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` |
| Token 警告状态 | `src/services/compact/autoCompact.ts` | `calculateTokenWarningState()` |
| 启用检查 | `src/services/compact/autoCompact.ts` | `isAutoCompactEnabled()` |
| 递归防护 | `src/services/compact/autoCompact.ts` | `shouldAutoCompact()` |
| 全对话摘要 | `src/services/compact/compact.ts` | `compactConversation()` |
| 摘要流式生成 | `src/services/compact/compact.ts` | `streamCompactSummary()` |
| Post-compact 消息 | `src/services/compact/compact.ts` | `buildPostCompactMessages()` |
| 图片剥离 | `src/services/compact/compact.ts` | `stripImagesFromMessages()` |
| Partial compact | `src/services/compact/compact.ts` | `partialCompactConversation()` |
| PTL retry | `src/services/compact/compact.ts` | `truncateHeadForPTLRetry()` |
| Post-compact 文件限制 | `src/services/compact/compact.ts` | `MAX_POST_COMPACT_FILES = 5` |
| 每文件 token 限制 | `src/services/compact/compact.ts` | `MAX_TOKENS_PER_FILE = 5,000` |
| 总附件 token 限制 | `src/services/compact/compact.ts` | `MAX_TOTAL_TOKENS = 50,000` |
| Reactive Compact | `src/services/compact/reactiveCompact.ts` | `tryReactiveCompact()` |
| Token 计数 | `src/utils/tokens.ts` | `tokenCountWithEstimation()` |
| 最终 context 大小 | `src/utils/tokens.ts` | `finalContextTokensFromLastResponse()` |
