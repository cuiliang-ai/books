
# 第 13 章：MCP 协议 — 开放式工具扩展

> **核心问题**：如何让 Claude Code 的能力不局限于内置工具，而是可以连接任意外部服务？MCP（Model Context Protocol）如何实现这种开放式扩展？

Claude Code 的内置工具覆盖了文件操作、命令执行、代码搜索等核心能力。但现实世界的开发场景远不止这些 — 你可能需要查询数据库、调用 Jira API、操作 Kubernetes、与 IDE 交互。MCP（Model Context Protocol）正是为此设计的开放协议，让 Claude Code 可以连接任意外部工具服务器。

本章将从源码层面解析 Claude Code 的 MCP 客户端实现：连接管理、工具发现、调用执行、传输层、配置源。

---

## 13.1 MCP 架构概览

### 什么是 MCP

MCP（Model Context Protocol）是 Anthropic 开源的协议，定义了 LLM 应用与工具服务器之间的通信标准：

```
┌────────────────────────────────────────────────────────┐
│                    Claude Code                          │
│                                                        │
│  ┌──────────────┐    ┌──────────────┐                  │
│  │ 内置工具       │    │ MCP 客户端    │                  │
│  │ Bash/Read/    │    │              │                  │
│  │ Edit/Grep/...│    │ 管理多个连接   │                  │
│  └──────────────┘    └──────┬───────┘                  │
│                             │                           │
└─────────────────────────────┼───────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
     ┌────────▼──────┐ ┌─────▼──────┐ ┌──────▼──────┐
     │ MCP Server A  │ │ MCP Server B│ │ MCP Server C│
     │ (stdio)       │ │ (HTTP/SSE) │ │ (WebSocket) │
     │               │ │            │ │             │
     │ tools:        │ │ tools:     │ │ tools:      │
     │  - db_query   │ │  - jira    │ │  - k8s      │
     │  - db_write   │ │  - slack   │ │  - deploy   │
     │               │ │            │ │             │
     │ resources:    │ │ prompts:   │ │             │
     │  - schema     │ │  - review  │ │             │
     └──────────────┘ └────────────┘ └─────────────┘
```

### MCP 提供三类能力

| 能力 | 说明 | Claude Code 支持 |
|------|------|----------------|
| **Tools** | 工具调用（函数调用） | ✓ 完整支持 |
| **Resources** | 上下文数据（只读引用） | ✓ ListMcpResourcesTool + ReadMcpResourceTool |
| **Prompts** | 提示模板 | ✓ 作为 slash commands |

### 核心源码文件

```
src/services/mcp/
├── client.ts                    ← MCP 客户端核心（连接、工具注册、调用）
├── types.ts                     ← 类型定义（配置、连接状态）
├── config.ts                    ← 配置管理（多源合并）
├── normalization.ts             ← 名称规范化
├── mcpStringUtils.ts            ← 工具名构建和解析
├── useManageMCPConnections.ts   ← React hook：连接生命周期管理
├── auth.ts                      ← OAuth 认证
├── elicitationHandler.ts        ← 交互式请求处理
├── envExpansion.ts              ← 环境变量展开
├── headersHelper.ts             ← HTTP 头部帮助
├── channelAllowlist.ts          ← 渠道白名单
├── channelPermissions.ts        ← 渠道权限
├── channelNotification.ts       ← 渠道通知
├── claudeai.ts                  ← Claude.ai 集成
├── vscodeSdkMcp.ts              ← VS Code SDK MCP
├── InProcessTransport.ts        ← 进程内传输
├── SdkControlTransport.ts       ← SDK 控制传输
├── utils.ts                     ← 工具函数
└── officialRegistry.ts          ← 官方注册表

src/tools/
├── MCPTool/
│   ├── MCPTool.ts               ← MCP 工具的基础 Tool 定义
│   ├── classifyForCollapse.ts   ← UI 折叠分类
│   └── prompt.ts
├── ListMcpResourcesTool/        ← 列出 MCP 资源
├── ReadMcpResourceTool/         ← 读取 MCP 资源
└── McpAuthTool/                 ← MCP 认证工具
```

---

## 13.2 连接状态管理

### 五种连接状态

```typescript
// src/services/mcp/types.ts
export type MCPServerConnection =
  | ConnectedMCPServer     // 已连接
  | FailedMCPServer        // 连接失败
  | NeedsAuthMCPServer     // 需要认证
  | PendingMCPServer       // 连接中
  | DisabledMCPServer      // 已禁用

export type ConnectedMCPServer = {
  client: Client            // @modelcontextprotocol/sdk Client
  name: string
  type: 'connected'
  capabilities: ServerCapabilities  // 服务器能力
  serverInfo?: { name: string; version: string }
  instructions?: string    // 服务器指令
  config: ScopedMcpServerConfig
  cleanup: () => Promise<void>  // 断开连接清理
}

export type FailedMCPServer = {
  name: string
  type: 'failed'
  config: ScopedMcpServerConfig
  error?: string
}

export type PendingMCPServer = {
  name: string
  type: 'pending'
  config: ScopedMcpServerConfig
  reconnectAttempt?: number
  maxReconnectAttempts?: number
}
```

### 连接状态机

```
              初始化
                │
                ▼
        ┌───────────────┐
        │    pending     │
        │  正在连接中     │
        └───────┬───────┘
                │
        ┌───────┼───────┐
        ▼       ▼       ▼
  ┌──────────┐ ┌──────┐ ┌──────────┐
  │connected │ │failed│ │needs-auth│
  │ 已连接    │ │ 失败  │ │ 需认证    │
  └──────────┘ └──────┘ └──────────┘
       │            │         │
       │            ▼         ▼
       │       重连/放弃    认证后重连
       │
       ▼
  工具/资源/提示 发现
```

---

## 13.3 传输层：多协议支持

### 六种传输类型

```typescript
// src/services/mcp/types.ts
export const TransportSchema = z.enum([
  'stdio',     // 标准输入输出
  'sse',       // Server-Sent Events
  'sse-ide',   // IDE 专用 SSE
  'http',      // Streamable HTTP
  'ws',        // WebSocket
  'sdk',       // SDK 控制传输
])
```

### 配置 Schema

每种传输类型有独立的配置 schema：

```typescript
// stdio 传输
export const McpStdioServerConfigSchema = z.object({
  type: z.literal('stdio').optional(),
  command: z.string().min(1, 'Command cannot be empty'),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
})

// SSE 传输
export const McpSSEServerConfigSchema = z.object({
  type: z.literal('sse'),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  headersHelper: z.string().optional(),
  oauth: McpOAuthConfigSchema().optional(),
})

// Streamable HTTP 传输
export const McpHTTPServerConfigSchema = z.object({
  type: z.literal('http'),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  headersHelper: z.string().optional(),
  oauth: McpOAuthConfigSchema().optional(),
})

// WebSocket 传输
export const McpWebSocketServerConfigSchema = z.object({
  type: z.literal('ws'),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  headersHelper: z.string().optional(),
})

// SDK 控制传输（进程内）
export const McpSdkServerConfigSchema = z.object({
  type: z.literal('sdk'),
  name: z.string(),
})
```

### 连接建立

```typescript
// src/services/mcp/client.ts（简化）
async function connectToMcpServer(
  name: string,
  serverConfig: ScopedMcpServerConfig
): Promise<MCPServerConnection> {
  const timeout = getConnectionTimeoutMs()  // 默认 30000ms

  switch (serverConfig.type) {
    case 'stdio':
      return connectStdio(name, serverConfig, timeout)
    case 'sse':
      return connectSSE(name, serverConfig, timeout)
    case 'http':
      return connectHTTP(name, serverConfig, timeout)
    case 'ws':
      return connectWebSocket(name, serverConfig, timeout)
    case 'sdk':
      return connectSdk(name, serverConfig)
    // ...
  }
}
```

### stdio 传输

```typescript
// 通过子进程的 stdin/stdout 通信
const transport = new StdioClientTransport({
  command: serverConfig.command,
  args: serverConfig.args,
  env: {
    ...subprocessEnv(),      // 继承环境变量
    ...serverConfig.env,     // 服务器特定环境变量
  },
})
```

### HTTP 传输的超时处理

```typescript
// src/services/mcp/client.ts
const MCP_REQUEST_TIMEOUT_MS = 60000  // 单个请求 60秒超时

export function wrapFetchWithTimeout(baseFetch: FetchLike): FetchLike {
  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()

    // GET 请求不设超时 — MCP 中 GET 是长连接 SSE 流
    if (method === 'GET') {
      return baseFetch(url, init)
    }

    // POST 请求设置 60秒超时
    const controller = new AbortController()
    const timer = setTimeout(
      c => c.abort(new DOMException('The operation timed out.', 'TimeoutError')),
      MCP_REQUEST_TIMEOUT_MS,
      controller,
    )
    timer.unref?.()

    try {
      const response = await baseFetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      })
      cleanup()
      return response
    } catch (error) {
      cleanup()
      throw error
    }
  }
}
```

> **设计决策**：使用 `setTimeout` 而非 `AbortSignal.timeout()`。后者的内部 timer 只在 GC 时释放，在 Bun 运行时中每个请求会泄漏约 2.4KB 原生内存长达 60 秒。`setTimeout` + 手动 `clearTimeout` 避免了这个问题。

### Streamable HTTP Accept 头

```typescript
const MCP_STREAMABLE_HTTP_ACCEPT = 'application/json, text/event-stream'

// MCP Streamable HTTP 规范要求客户端在每个 POST 上声明接受 JSON 和 SSE
// 严格的服务器会拒绝没有此头的请求 (HTTP 406)
```

---

## 13.4 工具名称规范化

### 命名规则

MCP 工具的名称遵循 `mcp__<serverName>__<toolName>` 格式：

```typescript
// src/services/mcp/mcpStringUtils.ts
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${getMcpPrefix(serverName)}${normalizeNameForMCP(toolName)}`
}

export function getMcpPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__`
}
```

### 名称规范化

```typescript
// src/services/mcp/normalization.ts
export function normalizeNameForMCP(name: string): string {
  // API 要求: ^[a-zA-Z0-9_-]{1,64}$
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')

  // claude.ai 服务器：压缩连续下划线，去除首尾下划线
  // 防止干扰 __ 分隔符
  if (name.startsWith('claude.ai ')) {
    normalized = normalized.replace(/_+/g, '_').replace(/^_|_$/g, '')
  }
  return normalized
}
```

### 名称解析

```typescript
// src/services/mcp/mcpStringUtils.ts
export function mcpInfoFromString(toolString: string): {
  serverName: string
  toolName: string | undefined
} | null {
  const parts = toolString.split('__')
  const [mcpPart, serverName, ...toolNameParts] = parts
  if (mcpPart !== 'mcp' || !serverName) return null

  // toolName 中可以包含 __（将剩余部分重新 join）
  const toolName = toolNameParts.length > 0
    ? toolNameParts.join('__')
    : undefined
  return { serverName, toolName }
}

// 已知限制：如果 serverName 包含 "__"，解析会错误
// "mcp__my__server__tool" → server="my", tool="server__tool"
// 而非 server="my__server", tool="tool"
```

### 权限检查中的名称

```typescript
export function getToolNameForPermissionCheck(tool: {
  name: string
  mcpInfo?: { serverName: string; toolName: string }
}): string {
  // MCP 工具使用完整的 mcp__server__tool 名称
  // 防止内置工具的 deny 规则（如 "Write"）
  // 错误匹配到同名的 MCP 工具
  return tool.mcpInfo
    ? buildMcpToolName(tool.mcpInfo.serverName, tool.mcpInfo.toolName)
    : tool.name
}
```

---

## 13.5 MCP 工具注册

### MCPTool 基础定义

```typescript
// src/tools/MCPTool/MCPTool.ts
export const MCPTool = buildTool({
  isMcp: true,
  name: 'mcp',  // 被 client.ts 覆盖
  maxResultSizeChars: 100_000,

  // 所有方法都会在 client.ts 中被覆盖
  async call() { return { data: '' } },
  async description() { return DESCRIPTION },
  async prompt() { return PROMPT },
  userFacingName: () => 'mcp',

  async checkPermissions(): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: 'MCPTool requires permission.',
    }
  },
})
```

### 工具实例化

`client.ts` 中的 `fetchToolsForClient` 为每个 MCP 工具创建一个 `Tool` 实例：

```typescript
// client.ts — fetchToolsForClient（概念性）
export async function fetchToolsForClient(
  server: ConnectedMCPServer
): Promise<Tool[]> {
  const result = await server.client.listTools()

  return result.tools.map(mcpTool => {
    const toolName = buildMcpToolName(server.name, mcpTool.name)

    return {
      ...MCPTool,
      name: toolName,
      mcpInfo: { serverName: server.name, toolName: mcpTool.name },
      inputJSONSchema: mcpTool.inputSchema,

      async description() {
        // 截断到 MAX_MCP_DESCRIPTION_LENGTH
        return mcpTool.description?.slice(0, MAX_MCP_DESCRIPTION_LENGTH)
      },

      async call(args, context) {
        // 调用实际的 MCP 服务器
        return callMcpTool(server, mcpTool.name, args, context)
      },

      // 延迟加载和常驻加载标记
      shouldDefer: !mcpTool._meta?.['anthropic/alwaysLoad'],
      alwaysLoad: mcpTool._meta?.['anthropic/alwaysLoad'],
    }
  })
}
```

### 工具描述限制

```typescript
const MAX_MCP_DESCRIPTION_LENGTH = 2048
```

> **设计决策**：OpenAPI 生成的 MCP 服务器经常将 15-60KB 的端点文档放入 `tool.description`。2048 字符的上限截断了长尾而不丢失意图。

### 默认超时

```typescript
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 100_000_000  // ~27.8 小时
```

MCP 工具调用默认"无限"超时 — 因为外部服务的响应时间不可预测。

---

## 13.6 配置源：多层合并

### 七种配置源

```typescript
// src/services/mcp/types.ts
export const ConfigScopeSchema = z.enum([
  'local',       // .mcp.json（项目本地）
  'user',        // ~/.claude/settings.json
  'project',     // .claude/settings.json
  'dynamic',     // 动态添加
  'enterprise',  // 企业管理配置
  'claudeai',    // Claude.ai 提供
  'managed',     // 托管配置
])
```

### ScopedMcpServerConfig

每个服务器配置都带有其来源信息：

```typescript
export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope
  pluginSource?: string  // 如果来自插件
}
```

### 配置合并

`config.ts` 中的 `getAllMcpConfigs()` 合并所有配置源：

```typescript
// src/services/mcp/config.ts（概念性）
export async function getAllMcpConfigs(): Promise<
  Record<string, ScopedMcpServerConfig>
> {
  // 1. 项目 .mcp.json
  const localConfigs = await readMcpJsonConfig()

  // 2. 用户 ~/.claude/settings.json 中的 mcpServers
  const userConfigs = getSettingsForSource('user')?.mcpServers

  // 3. 项目 .claude/settings.json 中的 mcpServers
  const projectConfigs = getSettingsForSource('project')?.mcpServers

  // 4. 企业管理的 MCP 配置
  const enterpriseConfigs = await getEnterpriseMcpConfig()

  // 5. Claude.ai 提供的配置
  const claudeaiConfigs = await fetchClaudeAIMcpConfigsIfEligible()

  // 6. 插件提供的 MCP 服务器
  const pluginConfigs = getPluginMcpServers()

  // 合并：后面的覆盖前面的
  return {
    ...addScopeToServers(localConfigs, 'local'),
    ...addScopeToServers(userConfigs, 'user'),
    ...addScopeToServers(projectConfigs, 'project'),
    ...addScopeToServers(enterpriseConfigs, 'enterprise'),
    ...addScopeToServers(claudeaiConfigs, 'claudeai'),
    ...addScopeToServers(pluginConfigs, 'dynamic'),
  }
}
```

### .mcp.json 配置文件

项目级别的 MCP 配置使用 `.mcp.json`：

```typescript
export const McpJsonConfigSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema()),
})
```

示例 `.mcp.json`：
```json
{
  "mcpServers": {
    "database": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
    },
    "github": {
      "type": "http",
      "url": "https://mcp.github.com",
      "oauth": {
        "clientId": "..."
      }
    }
  }
}
```

### 环境变量展开

配置中的环境变量会被展开：

```typescript
// src/services/mcp/envExpansion.ts
export function expandEnvVarsInString(str: string): string
// ${VAR_NAME} → 实际值
```

---

## 13.7 OAuth 认证

### OAuth 支持

MCP 服务器可以配置 OAuth 认证：

```typescript
const McpOAuthConfigSchema = z.object({
  clientId: z.string().optional(),
  callbackPort: z.number().int().positive().optional(),
  authServerMetadataUrl: z.string().url()
    .startsWith('https://')
    .optional(),
  xaa: z.boolean().optional(),  // Cross-App Access
})
```

### 认证流程

```typescript
// src/services/mcp/auth.ts
export class ClaudeAuthProvider {
  // OAuth 2.0 认证提供者
  // 处理 token 获取、刷新、存储
}

// 401 检测和 step-up 认证
export function wrapFetchWithStepUpDetection(fetch: FetchLike): FetchLike
```

### 认证缓存

```typescript
const MCP_AUTH_CACHE_TTL_MS = 15 * 60 * 1000  // 15 分钟

// needs-auth 状态缓存到磁盘
// 防止每次重连都触发认证流程
function getMcpAuthCachePath(): string {
  return join(getClaudeConfigHomeDir(), 'mcp-needs-auth-cache.json')
}
```

### Claude.ai 代理认证

```typescript
export function createClaudeAiProxyFetch(innerFetch: FetchLike): FetchLike {
  return async (url, init) => {
    // 1. 获取 OAuth token
    await checkAndRefreshOAuthTokenIfNeeded()
    const tokens = getClaudeAIOAuthTokens()

    // 2. 附加 Authorization header
    headers.set('Authorization', `Bearer ${tokens.accessToken}`)

    // 3. 发送请求
    const response = await innerFetch(url, { ...init, headers })

    // 4. 401 重试：刷新 token 后重试一次
    if (response.status === 401) {
      const tokenChanged = await handleOAuth401Error(sentToken)
      if (tokenChanged) {
        return (await doRequest()).response
      }
    }
    return response
  }
}
```

---

## 13.8 Session 管理

### Session 过期检测

```typescript
export function isMcpSessionExpiredError(error: Error): boolean {
  // HTTP 404 + JSON-RPC code -32001 = session expired
  const httpStatus = 'code' in error ? error.code : undefined
  if (httpStatus !== 404) return false
  return (
    error.message.includes('"code":-32001') ||
    error.message.includes('"code": -32001')
  )
}
```

### 错误类型

```typescript
// 工具调用错误（isError: true 的结果）
export class McpToolCallError extends TelemetrySafeError {
  constructor(message, telemetryMessage, mcpMeta?) {
    // 携带 _meta 用于 SDK 消费者
  }
}

// 认证错误
export class McpAuthError extends Error {
  serverName: string
}

// Session 过期
class McpSessionExpiredError extends Error {
  // 调用者应重新获取连接并重试
}
```

---

## 13.9 MCP Resources 和 Prompts

### ListMcpResourcesTool

```typescript
// src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts
// 列出所有连接的 MCP 服务器提供的资源
```

### ReadMcpResourceTool

```typescript
// src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts
// 读取特定 MCP 资源的内容
```

### Prompts as Slash Commands

MCP Prompts 被注册为 Claude Code 的 slash commands，通过 `fetchCommandsForClient` 实现。

---

## 13.10 连接生命周期管理

### useManageMCPConnections Hook

```typescript
// src/services/mcp/useManageMCPConnections.ts
// React hook，管理 MCP 连接的完整生命周期

import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
```

### 动态更新

MCP 服务器可以通过通知机制动态更新其工具列表：

```
MCP Server                        Claude Code
    │                                 │
    │  tools/list_changed ──────────→ │
    │                                 │ 重新获取工具列表
    │  ←─────────── tools/list ────── │
    │                                 │ 更新 AppState.mcp.tools
    │                                 │
```

### 重连策略

```typescript
export type PendingMCPServer = {
  name: string
  type: 'pending'
  config: ScopedMcpServerConfig
  reconnectAttempt?: number       // 当前重连次数
  maxReconnectAttempts?: number   // 最大重连次数
}
```

---

## 13.11 工具集成到工具池

### assembleToolPool 中的 MCP 工具

```typescript
// src/tools.ts
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // 内置工具 → 排序 → MCP 工具 → 排序 → 去重
  // 内置工具优先（同名冲突时）
  return uniqBy(
    [...builtInTools].sort(byName)
      .concat(allowedMcpTools.sort(byName)),
    'name',
  )
}
```

### Deny 规则过滤

用户可以通过 deny 规则禁用整个 MCP 服务器的工具：

```typescript
// 匹配规则："mcp__server" 禁用该服务器所有工具
export function filterToolsByDenyRules(tools, permissionContext) {
  return tools.filter(tool => !getDenyRuleForTool(permissionContext, tool))
}
```

### UI 折叠分类

```typescript
// src/tools/MCPTool/classifyForCollapse.ts
export function classifyMcpToolForCollapse(toolName: string): {
  isSearch: boolean
  isRead: boolean
}
```

---

## 13.12 Elicitation 处理

### 交互式 URL 认证

MCP 规范支持 "elicitation" — 工具调用时服务器可以请求用户交互（如 OAuth 授权）：

```typescript
// src/services/mcp/elicitationHandler.ts
export async function runElicitationHooks(
  serverName: string,
  params: ElicitRequestURLParams,
  signal: AbortSignal
): Promise<ElicitResult>
```

---

## 章末速查表

| 概念 | 定义位置 | 说明 |
|------|---------|------|
| `MCPTool` | `tools/MCPTool/MCPTool.ts` | MCP 工具基础定义 |
| `MCPServerConnection` | `services/mcp/types.ts` | 服务器连接类型联合 |
| `ConnectedMCPServer` | `services/mcp/types.ts` | 已连接服务器 |
| `McpServerConfig` | `services/mcp/types.ts` | 服务器配置联合类型 |
| `ScopedMcpServerConfig` | `services/mcp/types.ts` | 带作用域的配置 |
| `ConfigScope` | `services/mcp/types.ts` | 配置来源作用域 |
| `buildMcpToolName()` | `services/mcp/mcpStringUtils.ts` | 构建完整工具名 |
| `mcpInfoFromString()` | `services/mcp/mcpStringUtils.ts` | 解析工具名 |
| `normalizeNameForMCP()` | `services/mcp/normalization.ts` | 名称规范化 |
| `getAllMcpConfigs()` | `services/mcp/config.ts` | 合并所有配置源 |
| `fetchToolsForClient()` | `services/mcp/client.ts` | 获取服务器工具列表 |
| `wrapFetchWithTimeout()` | `services/mcp/client.ts` | 请求超时包装 |
| `ClaudeAuthProvider` | `services/mcp/auth.ts` | OAuth 认证提供者 |
| `ListMcpResourcesTool` | `tools/ListMcpResourcesTool/` | 列出 MCP 资源 |
| `ReadMcpResourceTool` | `tools/ReadMcpResourceTool/` | 读取 MCP 资源 |
| `McpAuthTool` | `tools/McpAuthTool/` | MCP 认证工具 |
| `MAX_MCP_DESCRIPTION_LENGTH` | `services/mcp/client.ts` | 描述长度上限 (2048) |
| `DEFAULT_MCP_TOOL_TIMEOUT_MS` | `services/mcp/client.ts` | 工具调用超时 (~27.8h) |
| `MCP_REQUEST_TIMEOUT_MS` | `services/mcp/client.ts` | 请求超时 (60s) |
| `MCP_AUTH_CACHE_TTL_MS` | `services/mcp/client.ts` | 认证缓存 TTL (15min) |
| `assembleToolPool()` | `tools.ts` | 合并内置 + MCP 工具 |
| `filterToolsByDenyRules()` | `tools.ts` | 权限过滤 MCP 工具 |
