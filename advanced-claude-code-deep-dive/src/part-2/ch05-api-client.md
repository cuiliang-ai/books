# 第五章 API Client：流式通信引擎

> **核心问题**：Claude Code 如何与 Anthropic API 通信？如何支持多个云平台？如何在网络不稳定时优雅重试？如何在高负载时自动降级？

---

## 5.1 多 Provider 架构

Claude Code 不只是对接一个 API 端点。它同时支持四种 API Provider：

```
┌──────────────────────────────────────────────┐
│              getAnthropicClient()             │
│          src/services/api/client.ts           │
│                                               │
│  ┌───────────┐ ┌──────────┐ ┌──────────────┐│
│  │FirstParty │ │ Bedrock  │ │   Vertex     ││
│  │(Anthropic)│ │(AWS)     │ │(Google Cloud)││
│  └─────┬─────┘ └────┬─────┘ └──────┬───────┘│
│        │            │              │         │
│  ┌─────┴────────────┴──────────────┴───────┐ │
│  │        Anthropic SDK (统一接口)          │ │
│  └─────────────────────────────────────────┘ │
│                                               │
│  ┌──────────────┐                            │
│  │  Foundry     │  (Azure, 独立路径)          │
│  │  (Microsoft) │                            │
│  └──────────────┘                            │
└──────────────────────────────────────────────┘
```

`getAnthropicClient()`（`src/services/api/client.ts`）是一个工厂函数，根据 `getAPIProvider()` 返回的 provider 类型创建对应的客户端。

### FirstParty（Anthropic 直连）

最简单的情况——直连 Anthropic API：

```typescript
// src/services/api/client.ts
case 'firstparty': {
  return new Anthropic({
    apiKey: apiKey,
    authToken: authToken,  // OAuth token
    baseURL: baseURL,
    fetch: buildFetch(options),
  })
}
```

`apiKey` 和 `authToken` 互斥：`apiKey` 是传统 API key，`authToken` 是 OAuth 认证的 access token。

### Bedrock（AWS）

AWS Bedrock 路径更复杂，因为需要 AWS SigV4 签名：

```typescript
// src/services/api/client.ts
case 'bedrock': {
  return new AnthropicBedrock({
    awsRegion: process.env.ANTHROPIC_BEDROCK_REGION || 'us-east-1',
    awsAccessKey: process.env.AWS_ACCESS_KEY_ID,
    awsSecretKey: process.env.AWS_SECRET_ACCESS_KEY,
    awsSessionToken: process.env.AWS_SESSION_TOKEN,
    fetch: buildFetch(options),
  })
}
```

Bedrock 支持通过 bearer token 进行跨账户访问，也支持区域覆盖——比如 `us-west-2` 的模型可能比 `us-east-1` 有更高的配额。

### Vertex（Google Cloud）

Vertex 路径有一个独特的防御机制：

```typescript
// src/services/api/client.ts
case 'vertex': {
  // 避免 Google metadata server timeout
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ||
    await getProjectIdWithTimeout(5000)

  return new AnthropicVertex({
    projectId,
    region: process.env.ANTHROPIC_VERTEX_REGION || 'us-east5',
    fetch: buildFetch(options),
  })
}
```

当运行在非 GCP 环境时，`GoogleAuth` 会尝试访问 GCE metadata server 获取 project ID，这个请求会超时（默认 5 秒），导致 Claude Code 启动缓慢。代码通过显式的 `getProjectIdWithTimeout()` 和环境变量 fallback 来规避这个问题。

### Foundry（Microsoft Azure）

Foundry 路径使用 Azure AD token provider：

```typescript
// src/services/api/client.ts
case 'foundry': {
  return new AnthropicFoundry({
    baseURL: process.env.ANTHROPIC_FOUNDRY_BASE_URL,
    tokenProvider: async () => {
      // Azure AD authentication
      const token = await getAzureADToken()
      return token.accessToken
    },
    fetch: buildFetch(options),
  })
}
```

> **设计决策**：为什么不用一个通用的 HTTP client + 适配器模式？因为 Anthropic SDK 已经为每个 provider 提供了专用客户端类（`Anthropic`、`AnthropicBedrock`、`AnthropicVertex`、`AnthropicFoundry`），它们内部处理了签名、token 刷新、模型 ID 映射等差异。Claude Code 只需要在入口选择正确的客户端即可。

## 5.2 buildFetch()：请求追踪

所有 provider 都通过 `buildFetch()` 注入一个自定义的 fetch 函数：

```typescript
// src/services/api/client.ts
function buildFetch(options?: ClientOptions): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())

    // 注入自定义 headers
    const customHeaders = parseCustomHeaders()
    for (const [key, value] of customHeaders) {
      headers.set(key, value)
    }

    return fetch(input, { ...init, headers })
  }
}
```

`CLIENT_REQUEST_ID_HEADER`（`x-client-request-id`）是每个请求的唯一标识符。当出现问题需要联系 Anthropic 支持时，这个 ID 可以用来精确定位具体的 API 请求。

自定义 headers 通过 `ANTHROPIC_CUSTOM_HEADERS` 环境变量注入，格式为 `key1:value1,key2:value2`。这在企业代理网关场景下很有用。

## 5.3 queryModelWithStreaming()：Streaming 核心

`queryModelWithStreaming()`（`src/services/api/claude.ts`）是所有 API 调用的汇聚点。它是一个 `async function*`，yield streaming 事件：

```
queryModelWithStreaming()
    │
    ├─ 构建请求参数
    │   ├─ buildSystemPromptBlocks()    // system prompt 分 cache scope
    │   ├─ getExtraBodyParams()         // 额外参数（betas, effort 等）
    │   ├─ configureEffortParams()      // thinking effort 控制
    │   ├─ configureTaskBudgetParams()  // API-side token budget
    │   └─ normalizeMessagesForAPI()    // 消息格式标准化
    │
    ├─ withRetry() 包装
    │   └─ withStreamingVCR() / withVCR() 包装（测试录制/回放）
    │       └─ client.beta.messages.stream()
    │
    └─ 处理 streaming events
        ├─ content_block_start     → yield assistant message
        ├─ content_block_delta     → update message
        ├─ content_block_stop      → finalize block
        ├─ message_stop            → yield final message
        └─ error                   → yield error message
```

### System Prompt 的 Cache 分层

System prompt 被分成两层 cache scope：

```typescript
// src/services/api/claude.ts
function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  cacheScope: CacheScope,
): BetaTextBlockParam[] {
  const { prefix, suffix } = splitSysPromptPrefix(systemPrompt)

  const blocks: BetaTextBlockParam[] = []

  if (prefix.length > 0) {
    blocks.push({
      type: 'text',
      text: prefix.join('\n\n'),
      cache_control: { type: 'ephemeral', scope: 'global' },
    })
  }

  if (suffix.length > 0) {
    blocks.push({
      type: 'text',
      text: suffix.join('\n\n'),
      cache_control: { type: 'ephemeral', scope: cacheScope },
    })
  }

  return blocks
}
```

`splitSysPromptPrefix()`（`src/utils/api.ts`）在 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记处拆分 system prompt。标记之前的内容（身份、规则、工具说明等）使用 `scope: 'global'` 缓存——这些内容对所有用户都一样，可以跨组织复用缓存。标记之后的内容（环境信息、MCP 指令、语言偏好等）使用 `scope: 'org'` 或 `scope: 'user'` 缓存。

```
System Prompt 结构：
┌─────────────────────────────────┐
│ Static prefix (global cache)    │
│  - Identity/intro               │
│  - System rules                 │
│  - Doing tasks                  │
│  - Actions section              │
│  - Using tools                  │
│  - Tone and style               │
│  - Output efficiency            │
├── DYNAMIC_BOUNDARY ─────────────┤
│ Dynamic suffix (org/user cache) │
│  - Session-specific guidance    │
│  - Memory                       │
│  - Environment info             │
│  - Language preference          │
│  - MCP instructions             │
│  - Scratchpad config            │
└─────────────────────────────────┘
```

> **设计决策**：为什么要做这种 cache 分层？Anthropic 的 prompt caching 按前缀匹配——如果两个请求的 system prompt 前缀完全相同，后端可以复用 KV cache，避免重新计算 attention。全局缓存意味着不同用户的请求也能共享缓存。但动态部分（比如环境信息、MCP 指令）因人而异，不能全局缓存。`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 就是这个分界线。PR #24490 和 #24171 修复的就是动态内容意外出现在静态前缀中导致 cache miss 的 bug。

### Extra Body Params

`getExtraBodyParams()`（`src/services/api/claude.ts:272-299`）处理通过 `CLAUDE_CODE_EXTRA_BODY` 环境变量传入的额外请求参数：

```typescript
export function getExtraBodyParams(betaHeaders?: string[]): JsonObject {
  const extraBodyStr = process.env.CLAUDE_CODE_EXTRA_BODY
  let result: JsonObject = {}

  if (extraBodyStr) {
    try {
      const parsed = safeParseJSON(extraBodyStr)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 浅拷贝——safeParseJSON 有 LRU 缓存，直接修改会污染缓存
        result = { ...(parsed as JsonObject) }
      }
    } catch (error) {
      logForDebugging(`Error parsing CLAUDE_CODE_EXTRA_BODY: ...`, { level: 'error' })
    }
  }
  // ...合并 beta headers
  return result
}
```

注意浅拷贝的注释：`safeParseJSON` 有 LRU 缓存，对同一个字符串会返回同一个对象引用。如果直接修改 `result`，会污染缓存导致后续调用得到错误的值。

### Effort 控制

`configureEffortParams()` 控制模型的 "thinking effort"：

```typescript
// src/services/api/claude.ts
function configureEffortParams(params: {
  thinkingConfig: ThinkingConfig | undefined
  effortValue: EffortValue | undefined
  model: string
}): { thinking?: object; effort?: object } {
  const resolvedEffort = resolveAppliedEffort(params.effortValue)

  if (modelSupportsAdaptiveThinking(params.model)) {
    return {
      thinking: {
        type: 'enabled',
        budget_tokens: getMaxThinkingTokensForModel(params.model),
      },
    }
  }

  if (modelSupportsEffort(params.model) && resolvedEffort) {
    return {
      effort: { type: resolvedEffort },
    }
  }

  return {}
}
```

Effort 值有三个级别：`low`、`medium`、`high`。低 effort 用于简单查询（少 thinking），高 effort 用于复杂推理任务（多 thinking）。

### 1 小时 Cache TTL

对于符合条件的用户，prompt cache 可以保持 1 小时（默认是 5 分钟）：

```typescript
// src/services/api/claude.ts
function getCacheControl(): { type: string; ttl?: number } | undefined {
  if (getPromptCache1hEligible()) {
    return {
      type: 'ephemeral',
      ttl: CACHE_TTL_1HOUR_MS,  // 3600000
    }
  }
  return { type: 'ephemeral' }
}
```

`getPromptCache1hEligible()` 检查用户是否在白名单中（通过 feature flag 控制）。1 小时 cache 对长时间编码会话特别有价值——系统 prompt 占用大量 tokens（通常 3000-5000），缓存 1 小时意味着这些 tokens 只需计算一次。

## 5.4 withRetry()：指数退避重试

`withRetry()`（`src/services/api/withRetry.ts`，823 行）是 Claude Code 的网络弹性层。它包装 API 调用，处理各种瞬态错误。

### 基本重试策略

```
DEFAULT_MAX_RETRIES = 10
BASE_DELAY_MS = 500

delay = min(500 * 2^(attempt-1), 32000) + random(0, delay * 0.25)

尝试 1: 500ms  + jitter
尝试 2: 1000ms + jitter
尝试 3: 2000ms + jitter
尝试 4: 4000ms + jitter
尝试 5: 8000ms + jitter
尝试 6: 16000ms + jitter
尝试 7-10: 32000ms + jitter (capped)
```

指数退避 + 25% jitter 是经典策略。Jitter 防止多个客户端同时重试造成惊群效应（thundering herd）。

### shouldRetry()：哪些错误该重试

```typescript
// src/services/api/withRetry.ts
function shouldRetry(error: unknown): boolean {
  if (error instanceof APIError) {
    // 检查服务器的 x-should-retry header
    if (error.headers?.['x-should-retry'] === 'true') return true
    if (error.headers?.['x-should-retry'] === 'false') return false

    // 按状态码判断
    switch (error.status) {
      case 408: return true  // Request Timeout
      case 409: return true  // Conflict
      case 429: return true  // Rate Limited
      case 529: return true  // Overloaded
      default:
        return error.status >= 500  // 所有 5xx
    }
  }

  // 连接错误（网络断开、DNS 解析失败等）
  if (isConnectionError(error)) return true

  return false
}
```

`x-should-retry` header 是 Anthropic API 的特殊设计——服务器可以明确告诉客户端是否应该重试。这比仅靠状态码判断更精确。比如 429 Rate Limited 时，如果服务器知道配额很快会恢复，就返回 `x-should-retry: true`；如果是硬性限制，就返回 `false`。

### 529 错误与 Fallback 机制

529 Overloaded 有特殊处理：

```typescript
// src/services/api/withRetry.ts
const MAX_529_RETRIES = 3

// 只有这些 querySource 会在 529 时重试
const FOREGROUND_529_RETRY_SOURCES = new Set([
  'repl_main_thread',
  'sdk',
  'repl_main_thread_cowork',
])
```

如果连续 3 次 529 错误，`withRetry` 不再重试，而是抛出 `FallbackTriggeredError`：

```typescript
// src/services/api/withRetry.ts
if (is529Error(error) && retryContext.consecutive529Count >= MAX_529_RETRIES) {
  throw new FallbackTriggeredError(
    originalModel,
    fallbackModel,
    `Exceeded max 529 retries (${MAX_529_RETRIES})`,
  )
}
```

这个错误被 `queryLoop`（`src/query.ts:894`）捕获，触发模型切换（比如从 Opus 降级到 Sonnet）。

### Retry 期间的用户通知

`withRetry` 本身也是一个 async generator，在等待重试时 yield 系统消息：

```typescript
// src/services/api/withRetry.ts
async function* withRetry<T>(
  fn: () => AsyncGenerator<T>,
  // ...
): AsyncGenerator<T | SystemAPIErrorMessage> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      yield* fn()
      return
    } catch (error) {
      if (!shouldRetry(error)) throw new CannotRetryError(error)

      // Yield 系统消息通知用户
      yield createSystemAPIErrorMessage({
        content: `API error: ${error.message}. Retrying in ${delay}ms...`,
        retryAttempt: attempt + 1,
        maxRetries,
      })

      await sleep(delay)
      delay = calculateNextDelay(delay)
    }
  }
}
```

这些消息会被 UI 渲染为状态通知，让用户知道正在重试，而不是以为系统挂了。

### Persistent Retry Mode

无人值守模式（`CLAUDE_CODE_UNATTENDED_RETRY`）有更激进的重试策略：

```
最大退避: 5 分钟（而不是 32 秒）
重置上限: 6 小时
心跳间隔: 30 秒（定期 yield "still retrying" 消息）
```

这种模式用于 CI/CD 管线或长时间运行的后台任务。如果 API 宕机 1 小时，普通模式早就放弃了，但 persistent 模式会一直等到 API 恢复。

### Fast Mode Fallback

Fast mode 有自己的 fallback 逻辑：

```
短重试 (<20s): 保持 cache，直接重试
长重试 (>=20s): 进入冷却期（最少 10 分钟）
```

短重试时保持 prompt cache 是因为 cache 的 TTL 是 5 分钟——20 秒以内重试还能命中 cache。超过 20 秒就不值得保持了，进入冷却期让其他请求有机会通过。

### Prompt Too Long 的动态调整

`withRetry` 还能处理 prompt_too_long 错误中的 `max_tokens` 信息：

```typescript
// src/services/api/withRetry.ts
function parseMaxTokensContextOverflowError(error: APIError): number | null {
  // 从错误消息中提取 API 建议的 max_tokens 值
  const match = error.message.match(
    /max_tokens.*?(\d+)/
  )
  return match ? parseInt(match[1]) : null
}
```

如果 API 返回 "max_tokens is too high for the given context, please use max_tokens <= 12345"，`withRetry` 会提取 12345 并传给下一次请求。这比盲目减少 max_tokens 更精确。

## 5.5 VCR：录制与回放

`withStreamingVCR()` 和 `withVCR()`（`src/services/vcr.ts`）提供了 API 交互的录制/回放功能：

```
录制模式：
  API request → 真实 API → response
                    └──→ 保存到磁盘 (.vcr 文件)

回放模式：
  API request → 读取 .vcr 文件 → 模拟 response
```

VCR 主要用于：
1. **测试**：录制一次真实 API 交互，后续测试回放，不消耗 API 配额
2. **调试**：重现特定的 API 行为（比如某个导致 bug 的响应）
3. **开发**：在没有 API 访问的环境下开发（比如飞机上）

`withStreamingVCR` 处理 streaming 响应（多个 event），`withVCR` 处理非 streaming 响应（单个 response）。

## 5.6 消息格式化

在发送给 API 之前，消息需要经过标准化处理：

### prependUserContext()

```typescript
// src/utils/api.ts
function prependUserContext(
  messages: Message[],
  userContext: { [k: string]: string },
): Message[] {
  // 把 CLAUDE.md 内容、日期等作为 system-reminder 注入第一条 user message
  const firstUserMessageIndex = messages.findIndex(m => m.type === 'user')
  if (firstUserMessageIndex === -1) return messages

  const contextBlocks = Object.entries(userContext).map(([key, value]) => ({
    type: 'text',
    text: `<system-reminder>\n# ${key}\n${value}\n</system-reminder>`,
  }))

  // 注入到第一条 user message 的内容开头
  // ...
}
```

User context（CLAUDE.md 文件内容、当前日期等）被包装在 `<system-reminder>` 标签中注入第一条 user message。这利用了 prompt caching 的特性——user context 在整个对话中不变，注入第一条消息后它就成为了可缓存前缀的一部分。

### appendSystemContext()

```typescript
// src/utils/api.ts
function appendSystemContext(
  systemPrompt: SystemPrompt,
  systemContext: { [k: string]: string },
): string[] {
  // 把 git status 等信息追加到 system prompt 末尾
}
```

System context（git branch、最近 commits 等）被追加到 system prompt 末尾。因为它在 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 之后，不会影响全局 cache。

### normalizeMessagesForAPI()

```typescript
// src/utils/messages.ts
function normalizeMessagesForAPI(
  messages: Message[],
  tools: Tools,
): (UserMessage | AssistantMessage)[] {
  // 1. 过滤掉 progress、attachment、system 等非 API 消息类型
  // 2. 确保 tool_result 与 tool_use 正确配对
  // 3. 剥离内部字段（uuid、metadata 等）
  // 4. 处理图片、文档等多模态内容
}
```

## 5.7 Beta Headers

Claude Code 使用大量 beta headers 来启用实验性功能：

```typescript
// src/constants/betas.ts
export const EFFORT_BETA_HEADER = 'output-128k-2025-02-19'
export const AFK_MODE_BETA_HEADER = 'afk-mode-2025-05-14'
export const CONTEXT_MANAGEMENT_BETA_HEADER = 'context-management-2025-06-01'
export const FAST_MODE_BETA_HEADER = 'fast-mode-2025-04-01'
export const STRUCTURED_OUTPUTS_BETA_HEADER = 'structured-output-2025-05-14'
export const TASK_BUDGETS_BETA_HEADER = 'task-budgets-2026-03-13'
export const PROMPT_CACHING_SCOPE_BETA_HEADER = 'prompt-caching-scope-2025-07-20'
```

这些 headers 通过 `getMergedBetas()` 合并后传给 API。某些 beta headers 是 "latched"（锁存的）——一旦在某次请求中使用，后续请求都必须继续使用，否则 API 会报错。`setAfkModeHeaderLatched()` 等函数管理这些锁存状态。

## 5.8 API Metadata

每个请求携带元数据用于分析和调试：

```typescript
// src/services/api/claude.ts
function getAPIMetadata(): object {
  return {
    device_id: getOrCreateUserID(),
    account_uuid: getOauthAccountInfo()?.uuid,
    session_id: getSessionId(),
    // ...
  }
}
```

`device_id` 是安装时生成的持久化 ID。`session_id` 是每次启动 Claude Code 时生成的。这些用于跨请求关联分析和 A/B 测试。

## 5.9 Cost Tracking

每个 API 响应的 usage 信息被用来计算成本：

```typescript
// src/services/api/claude.ts
if (usage) {
  const cost = calculateUSDCost(model, usage)
  addToTotalSessionCost(cost)
}
```

`calculateUSDCost()`（`src/utils/modelCost.ts`）包含每个模型的定价信息。会话结束时（或用户运行 `/cost`）可以看到总花费。

## 5.10 Streaming Event 处理

API 返回的 streaming events 被转换为 Claude Code 的内部消息类型：

```typescript
// src/services/api/claude.ts (简化版)
for await (const event of stream) {
  switch (event.type) {
    case 'content_block_start':
      // 创建新的 content block（text/tool_use/thinking）
      break
    case 'content_block_delta':
      // 追加增量内容
      if (event.delta.type === 'text_delta') {
        currentBlock.text += event.delta.text
      } else if (event.delta.type === 'input_json_delta') {
        currentBlock.partial_json += event.delta.partial_json
      }
      break
    case 'content_block_stop':
      // Finalize block — 解析 tool_use JSON
      break
    case 'message_delta':
      // 更新 stop_reason、usage
      break
    case 'message_stop':
      // Yield 最终的 assistant message
      yield createAssistantMessage(/* ... */)
      break
  }
}
```

每当一个完整的 tool_use block 被 finalize（`content_block_stop`），它就可以被 `StreamingToolExecutor` 立即执行——不需要等待整个 message 完成。

## 5.11 错误分类

API 错误被精确分类：

| 错误类型 | HTTP Status | 处理方式 |
|----------|-------------|----------|
| Rate Limited | 429 | 重试，respecting `retry-after` header |
| Overloaded | 529 | 重试 3 次后 fallback |
| Server Error | 5xx | 重试 |
| Prompt Too Long | 400 (specific) | 触发 reactive compact |
| Max Tokens | 200 (specific) | 触发 recovery loop |
| Auth Error | 401/403 | 不重试，提示用户 |
| Not Found | 404 | 不重试（模型不存在） |
| Connection Error | N/A | 重试 |
| Timeout | 408 | 重试 |

```typescript
// src/services/api/errors.ts
export const API_ERROR_MESSAGE_PREFIX = 'API Error'
export const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Your conversation is too long...'
export const CUSTOM_OFF_SWITCH_MESSAGE = 'Claude Code has been disabled...'
```

`CannotRetryError` 包装不可重试的错误，让上层知道重试机制已经放弃：

```typescript
// src/services/api/withRetry.ts
export class CannotRetryError extends Error {
  constructor(public readonly cause: unknown) {
    super(`Cannot retry: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}
```

## 5.12 Prompt Cache Break Detection

`checkResponseForCacheBreak()`（`src/services/api/promptCacheBreakDetection.ts`）监控 cache hit 率：

```typescript
// 当 cache_read_input_tokens 突然降为 0 时，说明 cache 被打破
function checkResponseForCacheBreak(usage: BetaUsage): void {
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheCreation = usage.cache_creation_input_tokens ?? 0

  if (cacheRead === 0 && cacheCreation > 0 && previousCacheRead > 0) {
    // Cache break detected!
    recordPromptState('cache_break', {
      previousCacheRead,
      currentCacheCreation: cacheCreation,
    })
  }
  previousCacheRead = cacheRead
}
```

Cache break 意味着用户突然从缓存命中变成了完全重新计算——成本可能暴增 10 倍。这个检测帮助识别是哪个变更导致了 cache break（通常是 system prompt 中的动态内容变化）。

## 5.13 请求流程完整链路

```
用户消息
    │
    ▼
QueryEngine.submitMessage()
    │
    ├─ 组装 system prompt + contexts
    │
    ▼
queryLoop()
    │
    ├─ prependUserContext()          // CLAUDE.md → 第一条 user message
    ├─ appendSystemContext()         // git status → system prompt 末尾
    │
    ▼
deps.callModel() = queryModelWithStreaming()
    │
    ├─ buildSystemPromptBlocks()    // 分 global/org cache scope
    ├─ getExtraBodyParams()         // 合并 betas + env vars
    ├─ configureEffortParams()      // thinking effort
    ├─ configureTaskBudgetParams()  // task budget
    ├─ normalizeMessagesForAPI()    // 过滤/标准化消息
    │
    ▼
withRetry()                         // 重试包装
    │
    ├─ shouldRetry()?
    │   ├─ 429 → 等待 + 重试
    │   ├─ 529 → 重试 3 次后 FallbackTriggeredError
    │   ├─ 5xx → 重试
    │   └─ 其他 → CannotRetryError
    │
    ▼
withStreamingVCR()                  // VCR 录制/回放
    │
    ▼
client.beta.messages.stream()      // Anthropic SDK
    │
    ├─ content_block_start
    ├─ content_block_delta ──→ yield StreamEvent
    ├─ content_block_stop  ──→ tool_use 完整 → addTool()
    ├─ message_delta
    └─ message_stop ──→ yield AssistantMessage
```

## 5.14 本章速查表

| 概念 | 文件位置 | 关键函数/类型 |
|------|----------|---------------|
| API Client 工厂 | `src/services/api/client.ts` | `getAnthropicClient()` |
| 请求追踪 | `src/services/api/client.ts` | `buildFetch()` |
| Streaming API 调用 | `src/services/api/claude.ts` | `queryModelWithStreaming()` |
| System prompt 分层 | `src/services/api/claude.ts` | `buildSystemPromptBlocks()` |
| Extra body 参数 | `src/services/api/claude.ts:272` | `getExtraBodyParams()` |
| Effort 控制 | `src/services/api/claude.ts` | `configureEffortParams()` |
| Task budget | `src/services/api/claude.ts` | `configureTaskBudgetParams()` |
| Cache control | `src/services/api/claude.ts` | `getCacheControl()` |
| API metadata | `src/services/api/claude.ts` | `getAPIMetadata()` |
| 重试逻辑 | `src/services/api/withRetry.ts` | `withRetry()` |
| 重试判断 | `src/services/api/withRetry.ts` | `shouldRetry()` |
| 最大重试次数 | `src/services/api/withRetry.ts` | `DEFAULT_MAX_RETRIES = 10` |
| 基础退避延迟 | `src/services/api/withRetry.ts` | `BASE_DELAY_MS = 500` |
| 529 重试上限 | `src/services/api/withRetry.ts` | `MAX_529_RETRIES = 3` |
| Fallback 触发 | `src/services/api/withRetry.ts` | `FallbackTriggeredError` |
| 不可重试错误 | `src/services/api/withRetry.ts` | `CannotRetryError` |
| VCR 录制/回放 | `src/services/vcr.ts` | `withStreamingVCR()`, `withVCR()` |
| 消息标准化 | `src/utils/messages.ts` | `normalizeMessagesForAPI()` |
| User context 注入 | `src/utils/api.ts` | `prependUserContext()` |
| System context 注入 | `src/utils/api.ts` | `appendSystemContext()` |
| System prompt 拆分 | `src/utils/api.ts` | `splitSysPromptPrefix()` |
| Cache break 检测 | `src/services/api/promptCacheBreakDetection.ts` | `checkResponseForCacheBreak()` |
| Beta headers | `src/constants/betas.ts` | 各 `*_BETA_HEADER` 常量 |
| 成本计算 | `src/utils/modelCost.ts` | `calculateUSDCost()` |
| Provider 检测 | `src/utils/model/providers.ts` | `getAPIProvider()` |
