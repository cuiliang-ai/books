
# 第 20 章：Remote Control — 远程桥接系统

> **核心问题**：如何让 claude.ai 网页端远程控制一个运行在本地机器上的 Claude Code CLI？这个跨网络、跨进程的桥接系统如何处理认证、会话管理、消息路由和安全性？

想象这样一个场景：你正在远程服务器上工作，需要让 Claude 读写本地文件、执行本地命令。网页端的 claude.ai 没有文件系统访问权限，而本地的 Claude Code CLI 又没有网页端的交互界面。Remote Control 要解决的就是这个"跨界"问题 — 将 claude.ai 的 UI 与本地 CLI 的执行能力连接起来。

这不仅仅是一个简单的 WebSocket 代理。它涉及 OAuth 认证链、JWT Token 自动刷新、可信设备注册、工作队列认领、多会话并发管理、v1/v2 双协议切换等一系列复杂的工程决策。本章将从源码层面完整还原这套桥接系统的设计与实现。

---

## 20.1 概述：全景架构

### 使用场景

Remote Control 有三种典型使用模式：

1. **远程桌面开发**：用户在 claude.ai 网页端发起会话，由本地 CLI 执行文件编辑、代码编译等操作
2. **服务器端代理**：`claude remote-control` 作为持久化服务运行在开发服务器上，多个 Web 会话共享一个环境
3. **REPL 桥接**：用户在本地 REPL 中启动 bridge，让当前 REPL 会话同时可从 claude.ai 网页端访问

### 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                      claude.ai (网页端)                             │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────────────────┐ │
│  │ 用户输入  │  │ 会话选择器    │  │  权限审批 UI                  │ │
│  └────┬─────┘  └──────┬───────┘  └──────────────┬────────────────┘ │
│       │               │                          │                  │
└───────┼───────────────┼──────────────────────────┼──────────────────┘
        │               │                          │
        ▼               ▼                          ▼
┌───────────────────────────────────────────────────────────────────┐
│                   Anthropic Cloud (CCR)                            │
│                                                                   │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────────────┐ │
│  │ Environment│  │ Work Queue │  │ Session Ingress              │ │
│  │ Registry   │  │ (Redis)    │  │ (WebSocket/SSE 路由)         │ │
│  └────┬───────┘  └─────┬──────┘  └──────────────┬───────────────┘ │
│       │                │                         │                 │
└───────┼────────────────┼─────────────────────────┼─────────────────┘
        │                │                         │
        ▼                ▼                         ▼
┌───────────────────────────────────────────────────────────────────┐
│              本地 Bridge 进程 (bridgeMain.ts)                      │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────────┐ │
│  │ 环境注册      │  │ 轮询/认领     │  │ 会话子进程管理           │ │
│  │ + 心跳保活    │  │ Work Items   │  │ (sessionRunner.ts)      │ │
│  └──────────────┘  └──────────────┘  └──────────┬──────────────┘ │
│                                                  │                │
│         ┌────────────────────────────────────────┘                │
│         ▼                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ Session #1  │  │ Session #2  │  │ Session #N  │              │
│  │ (子进程)     │  │ (子进程)     │  │ (子进程)     │              │
│  │ claude --   │  │ claude --   │  │ claude --   │              │
│  │ print --    │  │ print --    │  │ print --    │              │
│  │ sdk-url ... │  │ sdk-url ... │  │ sdk-url ... │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│       │                │                 │                        │
│       ▼                ▼                 ▼                        │
│  ┌────────────────────────────────────────────┐                  │
│  │          本地文件系统 / Shell               │                  │
│  └────────────────────────────────────────────┘                  │
└───────────────────────────────────────────────────────────────────┘
```

> **设计决策**：Bridge 进程本身不执行 AI 推理 — 它只是一个"调度员"。每个会话被 spawn 为独立的 `claude --print` 子进程，子进程通过 `--sdk-url` 直接与 Session Ingress 通信。Bridge 只负责认领工作、生成子进程、监控生命周期。这种"管控分离"架构让每个会话都有独立的资源上下文和故障隔离。

---

## 20.2 Bridge 主循环：从注册到轮询

Bridge 的核心是一个"注册 → 轮询 → 认领 → 生成 → 监控 → 清理"的主循环，实现在 `bridgeMain.ts` 的 `runBridgeLoop()` 函数中。

### 环境注册

Bridge 启动后的第一件事是向 Anthropic 云端注册自己：

```typescript
// bridgeApi.ts — 环境注册 API
async registerBridgeEnvironment(config: BridgeConfig): Promise<{
  environment_id: string
  environment_secret: string
}> {
  const response = await withOAuthRetry(
    (token) => axios.post(
      `${deps.baseUrl}/v1/environments/bridge`,
      {
        machine_name: config.machineName,
        directory: config.dir,
        branch: config.branch,
        git_repo_url: config.gitRepoUrl,
        max_sessions: config.maxSessions,
        metadata: { worker_type: config.workerType },
        // 幂等重注册：支持断线恢复
        ...(config.reuseEnvironmentId && {
          environment_id: config.reuseEnvironmentId,
        }),
      },
      { headers: getHeaders(token), timeout: 15_000 }
    ),
    'Registration',
  )
  return response.data
}
```

注册请求携带了丰富的元数据 — 机器名、工作目录、Git 分支、仓库 URL、最大会话数。这些信息让 claude.ai 网页端能在会话选择器中显示友好的环境描述（例如 "MacBook Pro · /projects/my-app · main branch"）。

`reuseEnvironmentId` 字段支持幂等重注册。当用户通过 `--session-id` 恢复一个之前中断的会话时，Bridge 会传入之前的 environment_id，让服务端做"重连"而非"新建"。

### 工作轮询与认领

注册成功后，Bridge 进入轮询循环：

```typescript
// bridgeMain.ts — 主循环核心
while (!loopSignal.aborted) {
  const pollConfig = getPollIntervalConfig()  // 实时读取 GrowthBook 配置

  const work = await api.pollForWork(
    environmentId,
    environmentSecret,
    loopSignal,
    pollConfig.reclaim_older_than_ms,         // 回收超时未确认的工作
  )

  if (!work) {
    // 无工作：根据容量状态选择不同的等待策略
    const atCap = activeSessions.size >= config.maxSessions
    if (atCap) {
      // 满载：心跳模式或慢轮询保活
    } else {
      // 空闲：标准轮询间隔
      await sleep(pollConfig.multisession_poll_interval_ms_not_at_capacity)
    }
    continue
  }

  // 有工作到达：解码密钥 → 确认认领 → 生成会话
  const secret = decodeWorkSecret(work.secret)
  await api.acknowledgeWork(environmentId, work.id, secret.session_ingress_token)
  // ... 生成子进程
}
```

轮询间隔通过 GrowthBook 动态配置，运维团队可以实时调整全球车队的轮询频率。这是一个关键的"操控面"设计：

| 状态 | 轮询间隔 | 目的 |
|------|---------|------|
| 空闲（无会话） | 2秒 | 快速响应新会话请求 |
| 部分占用 | 2秒 | 同上，还有余量 |
| 满载 | 10分钟 | 保活（Redis TTL = 4h），不再需要快速接单 |
| 满载 + 心跳 | 60秒（心跳间隔） | 每个 Work Item 独立心跳续租 |

> **设计决策**：为什么用 HTTP 轮询而非 WebSocket 推送？Bridge 需要在各种网络环境中存活 — 企业代理、NAT 穿透、不稳定的 SSH 隧道。HTTP 轮询具有最强的网络兼容性，每次请求都是独立的，不需要维护长连接状态。WebSocket 是子进程（即每个会话）的通信协议 — 那是在服务端和子进程之间，有稳定的路由保障。

### 工作类型分发

`pollForWork` 返回的工作有两种类型：

```typescript
// types.ts — 工作数据类型
export type WorkData = {
  type: 'session' | 'healthcheck'
  id: string
}
```

```typescript
switch (work.data.type) {
  case 'healthcheck':
    await ackWork()
    logger.logVerbose('Healthcheck received')
    break
  case 'session': {
    const sessionId = work.data.id
    // 1. 已有会话 → 更新 Token（断线恢复场景）
    const existingHandle = activeSessions.get(sessionId)
    if (existingHandle) {
      existingHandle.updateAccessToken(secret.session_ingress_token)
      break
    }
    // 2. 容量检查
    if (activeSessions.size >= config.maxSessions) break
    // 3. 生成新会话
    await ackWork()
    // ... spawn child process
    break
  }
}
```

注意 `existingHandle` 分支 — 当服务端重新分派（re-dispatch）一个已存在的会话时，Bridge 不会重复 spawn，而是将新 Token 注入已有子进程。这是处理 JWT 过期后刷新的关键路径。

---

## 20.3 认证体系：三层安全保障

Bridge 的认证不是简单的"一个 Token 打天下"，而是三层递进的认证链。

### 第一层：OAuth Token

用户通过 `claude auth login` 获得的 OAuth Token 是一切的基础。Bridge 用它来：

1. 注册环境（`POST /v1/environments/bridge`）
2. 注销环境（`DELETE /v1/environments/bridge/{id}`）
3. 停止工作项（`POST .../work/{id}/stop`）
4. 归档会话（`POST /v1/sessions/{id}/archive`）

```typescript
// bridgeConfig.ts — Token 来源优先级
export function getBridgeAccessToken(): string | undefined {
  // 1. 开发者覆盖（仅 ant 用户）
  return getBridgeTokenOverride() ?? getClaudeAIOAuthTokens()?.accessToken
}

export function getBridgeBaseUrl(): string {
  // 1. 开发者覆盖 → 2. 生产 OAuth 配置
  return getBridgeBaseUrlOverride() ?? getOauthConfig().BASE_API_URL
}
```

### 第二层：Session Ingress JWT

每个工作项的 `secret` 字段携带一个 Base64url 编码的 JSON，其中包含 `session_ingress_token` — 一个有时效性的 JWT：

```typescript
// workSecret.ts — 解码工作密钥
export function decodeWorkSecret(secret: string): WorkSecret {
  const json = Buffer.from(secret, 'base64url').toString('utf-8')
  const parsed = jsonParse(json)
  if (!parsed || parsed.version !== 1) {
    throw new Error(`Unsupported work secret version`)
  }
  // 校验必要字段
  if (typeof parsed.session_ingress_token !== 'string' ||
      parsed.session_ingress_token.length === 0) {
    throw new Error('Invalid work secret: missing session_ingress_token')
  }
  return parsed as WorkSecret
}
```

`WorkSecret` 的完整结构揭示了 Bridge 会话的配置能力：

```typescript
export type WorkSecret = {
  version: number
  session_ingress_token: string     // JWT — 子进程用于连接 Session Ingress
  api_base_url: string              // API 端点
  sources: Array<{                  // Git 源信息
    type: string
    git_info?: { type: string; repo: string; ref?: string; token?: string }
  }>
  auth: Array<{ type: string; token: string }>  // 认证凭据
  claude_code_args?: Record<string, string>      // CLI 参数覆盖
  mcp_config?: unknown                           // MCP 配置注入
  environment_variables?: Record<string, string> // 环境变量注入
  use_code_sessions?: boolean                    // v2 协议选择
}
```

### 第三层：可信设备 Token

对于安全等级要求更高的场景（`SecurityTier=ELEVATED`），Bridge 还会发送可信设备 Token：

```typescript
// trustedDevice.ts — 可信设备注册
export async function enrollTrustedDevice(): Promise<void> {
  // 1. 检查 GrowthBook gate
  if (!(await checkGate_CACHED_OR_BLOCKING(TRUSTED_DEVICE_GATE))) return

  // 2. 获取 OAuth Token
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) return

  // 3. POST /auth/trusted_devices 注册设备
  const response = await axios.post(
    `${baseUrl}/api/auth/trusted_devices`,
    { display_name: `Claude Code on ${hostname()} · ${process.platform}` },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )

  // 4. 持久化到系统 Keychain
  const token = response.data?.device_token
  storageData.trustedDeviceToken = token
  secureStorage.update(storageData)
}
```

设备 Token 有 90 天的滚动过期，存储在系统安全存储（macOS Keychain、Windows Credential Store 等）中。注册必须在 `/login` 后 10 分钟内完成（服务端校验 `account_session.created_at`）。

```
认证链路示意：

用户 ──login──▶ OAuth Token (长期, Keychain)
                  │
                  ├──▶ 环境注册 → environment_secret
                  │
                  ├──▶ 可信设备注册 → device_token (90d, Keychain)
                  │
                  └──▶ 轮询 → work.secret
                              │
                              └──▶ 解码 → session_ingress_token (JWT, 短期)
                                          │
                                          └──▶ 子进程用于 WS/SSE 连接
```

### JWT 自动刷新

Session Ingress JWT 有有限的生命周期（通常几小时）。`jwtUtils.ts` 实现了一个主动刷新调度器：

```typescript
// jwtUtils.ts — Token 刷新调度
export function createTokenRefreshScheduler({
  getAccessToken,
  onRefresh,
  label,
  refreshBufferMs = 5 * 60 * 1000,  // 过期前 5 分钟刷新
}): { schedule, cancel, cancelAll } {
  // ...
  function schedule(sessionId: string, token: string): void {
    const expiry = decodeJwtExpiry(token)  // 不验签，只解码 exp 字段
    const delayMs = expiry * 1000 - Date.now() - refreshBufferMs
    if (delayMs <= 0) {
      void doRefresh(sessionId, gen)  // 已过期，立即刷新
      return
    }
    const timer = setTimeout(doRefresh, delayMs, sessionId, gen)
    timers.set(sessionId, timer)
  }

  async function doRefresh(sessionId: string, gen: number): Promise<void> {
    // 检查 generation — 防止过时的定时器执行
    if (generations.get(sessionId) !== gen) return

    const oauthToken = await getAccessToken()
    onRefresh(sessionId, oauthToken)

    // 调度后续刷新（30分钟后），保持长时间会话的 Token 活跃
    const timer = setTimeout(doRefresh, 30 * 60 * 1000, sessionId, gen)
    timers.set(sessionId, timer)
  }
}
```

`generation` 计数器是一个精妙的并发控制机制：每次 `schedule()` 或 `cancel()` 都会 bump generation，如果在 `doRefresh()` 的异步等待期间会话被取消或重新调度，过时的回调会检测到 generation 不匹配并安全退出，避免设置孤立的定时器。

---

## 20.4 会话管理：三种 SpawnMode

Bridge 支持三种会话生成模式，适应不同的工作场景：

```typescript
// types.ts — SpawnMode 定义
export type SpawnMode = 'single-session' | 'worktree' | 'same-dir'
```

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `single-session` | 一个会话，结束后 Bridge 退出 | 临时使用，`/remote-control` 命令 |
| `worktree` | 每个会话创建独立 git worktree | 多人协作，避免文件冲突 |
| `same-dir` | 所有会话共享同一目录 | 独占式多任务（注意文件竞争） |

### 会话子进程生成

每个会话都是一个独立的 `claude` 子进程，通过 `sessionRunner.ts` 的 `createSessionSpawner` 创建：

```typescript
// sessionRunner.ts — 子进程生成核心
spawn(opts: SessionSpawnOpts, dir: string): SessionHandle {
  const args = [
    ...deps.scriptArgs,
    '--print',                    // 非交互模式
    '--sdk-url', opts.sdkUrl,     // Session Ingress 连接地址
    '--session-id', opts.sessionId,
    '--input-format', 'stream-json',   // NDJSON 输入
    '--output-format', 'stream-json',  // NDJSON 输出
    '--replay-user-messages',          // 回放历史消息
  ]

  const env = {
    ...deps.env,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,      // 剥离 Bridge OAuth Token
    CLAUDE_CODE_ENVIRONMENT_KIND: 'bridge',
    CLAUDE_CODE_SESSION_ACCESS_TOKEN: opts.accessToken,  // 会话专用 Token
    ...(deps.sandbox && { CLAUDE_CODE_FORCE_SANDBOX: '1' }),
    // v2 协议变量
    ...(opts.useCcrV2 && {
      CLAUDE_CODE_USE_CCR_V2: '1',
      CLAUDE_CODE_WORKER_EPOCH: String(opts.workerEpoch),
    }),
  }

  const child = spawn(deps.execPath, args, {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],  // stdin/stdout/stderr 全部管道化
    env,
    windowsHide: true,
  })
  // ...
}
```

> **设计决策**：注意 `CLAUDE_CODE_OAUTH_TOKEN: undefined` — 这故意剥离了 Bridge 的 OAuth Token，让子进程只能使用 session ingress token 进行推理。这是一个"最小权限"设计：子进程只需要与 Session Ingress 通信，不需要也不应该拥有管理环境的能力。

### NDJSON 活动流

Bridge 通过解析子进程 stdout 的 NDJSON 流来追踪会话状态：

```typescript
// sessionRunner.ts — 活动提取
function extractActivities(line: string, sessionId: string): SessionActivity[] {
  const msg = jsonParse(line)
  const activities: SessionActivity[] = []

  switch (msg.type) {
    case 'assistant': {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          activities.push({
            type: 'tool_start',
            summary: toolSummary(block.name, block.input),  // "Reading src/foo.ts"
            timestamp: Date.now(),
          })
        }
      }
      break
    }
    case 'result': {
      activities.push({
        type: msg.subtype === 'success' ? 'result' : 'error',
        summary: msg.subtype === 'success' ? 'Session completed' : msg.errors?.[0],
        timestamp: Date.now(),
      })
      break
    }
  }
  return activities
}
```

活动数据被上报到 Bridge 的状态显示（终端 UI），让用户在本地终端看到会话正在做什么 — "Reading package.json"、"Writing src/main.ts"、"Running npm test"。

### 权限请求转发

当子进程遇到需要用户确认的操作时，它会通过 stdout 输出 `control_request`：

```typescript
// sessionRunner.ts — 权限请求检测
if (msg.type === 'control_request') {
  const request = msg.request
  if (request?.subtype === 'can_use_tool' && deps.onPermissionRequest) {
    deps.onPermissionRequest(opts.sessionId, parsed, opts.accessToken)
  }
}
```

Bridge 将这个请求通过 API 转发给 claude.ai 网页端：

```typescript
// bridgeApi.ts — 发送权限响应事件
async sendPermissionResponseEvent(
  sessionId: string,
  event: PermissionResponseEvent,
  sessionToken: string,
): Promise<void> {
  await axios.post(
    `${deps.baseUrl}/v1/sessions/${sessionId}/events`,
    { events: [event] },
    { headers: getHeaders(sessionToken) }
  )
}
```

用户在网页端看到权限弹窗，点击允许/拒绝后，决策回传到 Bridge → 子进程 stdin。

### Token 实时更新

当 JWT 刷新后，Bridge 需要将新 Token 传递给正在运行的子进程。它使用了一个巧妙的 stdin 消息机制：

```typescript
// sessionRunner.ts — 通过 stdin 更新 Token
updateAccessToken(token: string): void {
  handle.accessToken = token
  handle.writeStdin(
    jsonStringify({
      type: 'update_environment_variables',
      variables: { CLAUDE_CODE_SESSION_ACCESS_TOKEN: token },
    }) + '\n',
  )
}
```

子进程的 StructuredIO 层收到 `update_environment_variables` 消息后，直接设置 `process.env`，让下一次 API 调用自动使用新 Token。

---

## 20.5 传输协议：CCR v1 vs v2

Bridge 支持两代传输协议，由服务端通过 `WorkSecret.use_code_sessions` 字段动态选择。

### v1：HybridTransport（WebSocket）

v1 是 Session Ingress 时代的协议：

```
子进程 ◄─── WebSocket ───► Session Ingress (读)
子进程 ──── HTTP POST ───► Session Ingress (写)
```

```typescript
// replBridgeTransport.ts — v1 适配器
export function createV1ReplTransport(hybrid: HybridTransport): ReplBridgeTransport {
  return {
    write: msg => hybrid.write(msg),
    close: () => hybrid.close(),
    getLastSequenceNum: () => 0,  // v1 不使用 SSE 序列号
    reportState: () => {},        // v1 无状态报告
    reportDelivery: () => {},     // v1 无投递确认
    flush: () => Promise.resolve(), // v1 POST 即等待
  }
}
```

SDK URL 的构造反映了部署差异：

```typescript
// workSecret.ts — v1 URL 构造
export function buildSdkUrl(apiBaseUrl: string, sessionId: string): string {
  const isLocalhost = apiBaseUrl.includes('localhost')
  const protocol = isLocalhost ? 'ws' : 'wss'
  const version = isLocalhost ? 'v2' : 'v1'     // localhost 直连, 生产走 Envoy
  const host = apiBaseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return `${protocol}://${host}/${version}/session_ingress/ws/${sessionId}`
}
```

### v2：SSETransport + CCRClient

v2 是 CCR（Claude Code Runtime）的原生协议：

```
子进程 ◄─── SSE Stream ──────── CCR /worker/events/stream (读)
子进程 ──── HTTP POST ─────────► CCR /worker/events        (写)
子进程 ──── HTTP PUT  ─────────► CCR /worker/state         (状态)
子进程 ──── HTTP POST ─────────► CCR /worker/heartbeat     (心跳)
```

```typescript
// replBridgeTransport.ts — v2 适配器
export async function createV2ReplTransport(opts): Promise<ReplBridgeTransport> {
  const epoch = opts.epoch ?? (await registerWorker(opts.sessionUrl, opts.ingressToken))

  // SSE 读取流
  const sse = new SSETransport(sseUrl, {}, opts.sessionId, undefined,
    opts.initialSequenceNum,   // 断线恢复：从上次的序列号继续
    opts.getAuthHeaders)

  // CCR 客户端（写入 + 心跳 + 状态）
  const ccr = new CCRClient(sse, new URL(opts.sessionUrl), {
    getAuthHeaders: opts.getAuthHeaders,
    onEpochMismatch: () => {
      // epoch 冲突 → 关闭并让轮询循环恢复
      ccr.close(); sse.close()
      onCloseCb?.(4090)
      throw new Error('epoch superseded')
    },
  })

  // ACK 优化：同时发送 received + processed
  sse.setOnEvent(event => {
    ccr.reportDelivery(event.event_id, 'received')
    ccr.reportDelivery(event.event_id, 'processed')
  })

  return {
    write: msg => ccr.writeEvent(msg),
    connect() {
      void sse.connect()            // 读流：fire-and-forget
      void ccr.initialize(epoch)    // 写路径：初始化后触发 onConnect
        .then(() => { ccrInitialized = true; onConnectCb?.() })
    },
    // ...
  }
}
```

### v1 vs v2 对比

| 维度 | v1 (HybridTransport) | v2 (SSE + CCRClient) |
|------|---------------------|---------------------|
| 读协议 | WebSocket | SSE (Server-Sent Events) |
| 写协议 | HTTP POST to Session Ingress | HTTP POST to CCR /worker/events |
| 认证 | OAuth Token（或 JWT） | JWT only（验 session_id claim） |
| 心跳 | Bridge 层轮询 | CCRClient 内置心跳 |
| 断线恢复 | 服务端消息游标 | SSE 序列号 (Last-Event-ID) |
| 投递确认 | 无 | received → processed 两阶段 |
| 状态报告 | 无 | PUT /worker/state |
| Worker 注册 | 无 | POST /worker/register → epoch |
| Epoch 冲突处理 | N/A | 409 → 关闭 → 轮询恢复 |

> **设计决策**：v2 的 `epoch` 机制是一个"独占锁"设计。每次 `registerWorker` 产生一个递增的 epoch 值，服务端在每个请求中校验 epoch。当另一个 worker 注册了新 epoch 后，旧 worker 的所有请求都会收到 409，触发优雅退出。这确保了"最多一个活跃 worker"的不变量，避免了两个 Bridge 实例同时处理同一会话的幽灵问题。

---

## 20.6 REPL Bridge：本地会话的远程附体

除了 `claude remote-control` 启动的独立 Bridge 进程，Claude Code 还支持在本地 REPL 会话中启用 Bridge — 让正在运行的 REPL 同时可从 claude.ai 访问。

`replBridge.ts` 实现了这种"本地+远程双写"模式：

```typescript
// replBridge.ts — ReplBridgeHandle 接口
export type ReplBridgeHandle = {
  bridgeSessionId: string
  environmentId: string
  sessionIngressUrl: string
  writeMessages(messages: Message[]): void      // 本地消息 → 远程同步
  writeSdkMessages(messages: SDKMessage[]): void
  sendControlRequest(request: SDKControlRequest): void
  sendControlResponse(response: SDKControlResponse): void
  sendResult(): void
  teardown(): Promise<void>
}
```

REPL Bridge 的生命周期：

```
1. 用户输入 /remote-control 或设置 remoteControlAtStartup=true
2. initReplBridge():
   a. 创建 BridgeApiClient
   b. 注册环境 (POST /v1/environments/bridge)
   c. 创建会话 (POST /v1/sessions)
   d. 开始轮询工作队列
3. 工作到达 → 解码密钥 → 建立传输层
   - v1: HybridTransport → createV1ReplTransport
   - v2: SSETransport + CCRClient → createV2ReplTransport
4. 本地 REPL 的每次输出都通过 writeMessages() 同步到远程
5. 远程用户的输入通过 onInboundMessage 回调注入本地 REPL
6. 用户断开 → teardown() → 注销环境
```

这种模式的关键挑战是**双向消息路由**：本地用户和远程用户同时向同一个 REPL 会话发消息，Bridge 需要正确地将输出同步到远程、将远程输入注入本地。

---

## 20.7 远程会话客户端：Web 端的视角

到目前为止我们讨论的是"本地 CLI 如何做 Bridge"。现在让我们切换到另一侧 — 当 claude.ai 网页端（或另一个本地 CLI 实例）要连接到远程会话时，使用的是 `RemoteSessionManager`。

```typescript
// RemoteSessionManager.ts — 远程会话管理
export class RemoteSessionManager {
  private websocket: SessionsWebSocket | null = null
  private pendingPermissionRequests: Map<string, SDKControlPermissionRequest> = new Map()

  connect(): void {
    const wsCallbacks = {
      onMessage: message => this.handleMessage(message),
      onConnected: () => this.callbacks.onConnected?.(),
      onClose: () => this.callbacks.onDisconnected?.(),
    }
    this.websocket = new SessionsWebSocket(
      this.config.sessionId,
      this.config.orgUuid,
      this.config.getAccessToken,
      wsCallbacks,
    )
    void this.websocket.connect()
  }

  // 发送用户消息（HTTP POST，非 WebSocket）
  async sendMessage(content: RemoteMessageContent): Promise<boolean> {
    return sendEventToRemoteSession(this.config.sessionId, content)
  }

  // 响应权限请求
  respondToPermissionRequest(requestId: string, result: RemotePermissionResponse): void {
    const response: SDKControlResponse = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: result.behavior, ... },
      },
    }
    this.websocket?.sendControlResponse(response)
  }
}
```

### WebSocket 连接管理

`SessionsWebSocket` 封装了 WebSocket 连接的完整生命周期：

```typescript
// SessionsWebSocket.ts — WebSocket 客户端
export class SessionsWebSocket {
  async connect(): Promise<void> {
    const baseUrl = getOauthConfig().BASE_API_URL.replace('https://', 'wss://')
    const url = `${baseUrl}/v1/sessions/ws/${this.sessionId}/subscribe?organization_uuid=${this.orgUuid}`

    // Bun 和 Node.js 用不同的 WebSocket 实现
    if (typeof Bun !== 'undefined') {
      const ws = new globalThis.WebSocket(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        proxy: getWebSocketProxyUrl(url),
      })
      // ... event handlers
    } else {
      const { default: WS } = await import('ws')
      const ws = new WS(url, { headers, agent: getWebSocketProxyAgent(url) })
      // ... event handlers
    }
  }
}
```

WebSocket 的关闭码有精确的语义：

| 关闭码 | 含义 | 处理 |
|--------|------|------|
| 4001 | Session not found | 有限重试（3次） — 可能是 compaction 暂态 |
| 4003 | Unauthorized | 立即停止 — 永久拒绝 |
| 其他 | 临时断开 | 指数退避重连（最多 5 次） |

### 消息适配层

远程收到的 SDKMessage 需要转换为本地 REPL 的 Message 格式：

```typescript
// sdkMessageAdapter.ts — SDK → REPL 消息转换
export function convertSDKMessage(msg: SDKMessage): ConvertedMessage {
  switch (msg.type) {
    case 'assistant':
      return { type: 'message', message: convertAssistantMessage(msg) }
    case 'stream_event':
      return { type: 'stream_event', event: convertStreamEvent(msg) }
    case 'result':
      return msg.subtype !== 'success'
        ? { type: 'message', message: convertResultMessage(msg) }
        : { type: 'ignored' }  // 成功结果不需要额外显示
    case 'user':
      return { type: 'ignored' }  // 用户消息本地已有
    // ...
  }
}
```

### 权限桥接

当远程 CLI 请求执行一个需要确认的操作时，本地客户端需要构造"合成的" AssistantMessage 来渲染权限弹窗：

```typescript
// remotePermissionBridge.ts — 权限桥接
export function createSyntheticAssistantMessage(
  request: SDKControlPermissionRequest,
  requestId: string,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    message: {
      content: [{
        type: 'tool_use',
        id: request.tool_use_id,
        name: request.tool_name,
        input: request.input,
      }],
      // ... 其他字段填充默认值
    },
  }
}

// 为本地不存在的工具创建 stub
export function createToolStub(toolName: string): Tool {
  return {
    name: toolName,
    needsPermissions: () => true,
    renderToolUseMessage: (input) => {
      return Object.entries(input).slice(0, 3)
        .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : jsonStringify(value)}`)
        .join(', ')
    },
    // ... 最小化接口实现
  }
}
```

`createToolStub` 特别有意思 — 远程 CLI 可能加载了本地没有的 MCP 工具。权限桥接器会为未知工具创建一个最小化的 stub，让权限弹窗至少能显示工具名和输入参数，即使本地不知道这个工具的具体定义。

---

## 20.8 Direct Connect：自托管场景

除了通过 Anthropic Cloud 中继的标准模式，Claude Code 还支持 Direct Connect — 本地客户端直接连接到自托管的 Claude Code Server。

```typescript
// createDirectConnectSession.ts — 创建直连会话
export async function createDirectConnectSession({
  serverUrl, authToken, cwd, dangerouslySkipPermissions,
}): Promise<{ config: DirectConnectConfig; workDir?: string }> {
  const resp = await fetch(`${serverUrl}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${authToken}` },
    body: jsonStringify({
      cwd,
      ...(dangerouslySkipPermissions && { dangerously_skip_permissions: true }),
    }),
  })

  const data = connectResponseSchema().safeParse(await resp.json())
  return {
    config: {
      serverUrl,
      sessionId: data.session_id,
      wsUrl: data.ws_url,  // WebSocket URL for real-time streaming
      authToken,
    },
    workDir: data.work_dir,
  }
}
```

```typescript
// directConnectManager.ts — 直连会话管理
export class DirectConnectSessionManager {
  connect(): void {
    this.ws = new WebSocket(this.config.wsUrl, {
      headers: { authorization: `Bearer ${this.config.authToken}` },
    })

    this.ws.addEventListener('message', event => {
      const lines = data.split('\n').filter(l => l.trim())
      for (const line of lines) {
        const parsed = jsonParse(line)
        // 转发 control_request（权限请求）
        if (parsed.type === 'control_request' && parsed.request.subtype === 'can_use_tool') {
          this.callbacks.onPermissionRequest(parsed.request, parsed.request_id)
          continue
        }
        // 转发 SDK 消息（跳过 keep_alive 等内部消息）
        if (parsed.type !== 'control_response' && parsed.type !== 'keep_alive') {
          this.callbacks.onMessage(parsed)
        }
      }
    })
  }

  sendMessage(content: RemoteMessageContent): boolean {
    // 直接通过 WebSocket 发送 SDKUserMessage
    this.ws.send(jsonStringify({
      type: 'user',
      message: { role: 'user', content },
    }))
  }
}
```

Direct Connect 与标准 Bridge 模式的关键区别：

| 维度 | 标准 Bridge 模式 | Direct Connect |
|------|-----------------|----------------|
| 中继 | Anthropic Cloud (CCR) | 直连自托管服务器 |
| 发现 | 环境注册 + 轮询 | 直接 URL 连接 |
| 认证 | OAuth + JWT + Trusted Device | 简单 Bearer Token |
| 会话创建 | 服务端推送 Work | 客户端主动 POST /sessions |
| 消息通道 | SSE/WS 经 Session Ingress | 直接 WebSocket |
| 权限模式 | 必须 | 可选跳过 (`dangerouslySkipPermissions`) |

---

## 20.9 安全设计：纵深防御

Remote Control 的安全设计体现了"纵深防御"（Defense in Depth）的理念。让我们梳理每一层：

### 1. 身份验证

```
claude.ai 用户 ──OAuth──▶ Anthropic Cloud ──JWT──▶ Bridge ──env vars──▶ 子进程
     │                        │
     └── Trusted Device ──────┘
```

- **OAuth Token**：Bridge 到云端的认证，具有完整的账户权限
- **Session Ingress JWT**：短时效，仅用于特定会话的读写
- **Trusted Device Token**：设备绑定，90天滚动过期，存储在系统 Keychain

### 2. 最小权限

```typescript
// 子进程环境变量 — 最小权限原则
const env = {
  CLAUDE_CODE_OAUTH_TOKEN: undefined,           // 剥离管理权限
  CLAUDE_CODE_SESSION_ACCESS_TOKEN: opts.accessToken,  // 仅会话权限
  CLAUDE_CODE_ENVIRONMENT_KIND: 'bridge',       // 标记为 bridge 环境
  ...(deps.sandbox && { CLAUDE_CODE_FORCE_SANDBOX: '1' }),  // 可选沙箱
}
```

### 3. 输入校验

所有来自服务端的 ID 都经过严格校验，防止路径遍历：

```typescript
// bridgeApi.ts — ID 校验
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

export function validateBridgeId(id: string, label: string): string {
  if (!id || !SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${label}: contains unsafe characters`)
  }
  return id
}
```

### 4. 会话隔离

在 `worktree` 模式下，每个会话有独立的文件系统工作区：

```typescript
// bridgeMain.ts — worktree 隔离
if (spawnMode === 'worktree') {
  const wt = await createAgentWorktree(`bridge-${safeFilenameId(sessionId)}`)
  sessionWorktrees.set(sessionId, {
    worktreePath: wt.worktreePath,
    worktreeBranch: wt.worktreeBranch,
    gitRoot: wt.gitRoot,
  })
  sessionDir = wt.worktreePath  // 子进程在隔离的 worktree 中运行
}
```

### 5. 生命周期控制

每个会话有 24 小时超时保护：

```typescript
const DEFAULT_SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000

// 超时看门狗
const timer = setTimeout(onSessionTimeout, timeoutMs, sessionId, timeoutMs, logger, timedOutSessions, handle)
sessionTimers.set(sessionId, timer)
```

### 6. 优雅关闭

Bridge 关闭时按序清理所有资源：

```
1. 停止轮询循环（abort controller）
2. SIGTERM 所有子进程
3. 等待 grace period（30秒）
4. SIGKILL 未退出的子进程
5. stopWork（通知服务端释放工作项）
6. archiveSession（标记会话为归档）
7. deregisterEnvironment（注销环境）
8. 清理 worktree
9. 等待所有 pending cleanup
```

---

## 20.10 设计启示

### 1. 控制面与数据面分离

Bridge 是纯粹的控制面 — 它不处理任何 AI 推理或工具执行，只做"调度"。数据面（AI 推理、工具调用、文件操作）完全由子进程负责。这种分离带来了：
- **故障隔离**：子进程崩溃不影响 Bridge
- **资源独立**：每个会话独立的内存和上下文
- **可观测性**：Bridge 可以从外部监控每个会话，而不被会话内部的复杂性污染

### 2. 降级优雅的多版本协议

v1/v2 的共存设计值得借鉴。服务端通过 `WorkSecret.use_code_sessions` 字段告诉客户端使用哪个协议版本，客户端通过 `ReplBridgeTransport` 接口抹平差异。这使得服务端可以按用户/组织/百分比逐步推进协议升级，而不是一刀切。

### 3. GrowthBook 驱动的运行时调参

轮询间隔、心跳频率、功能开关 — 几乎所有运行时参数都通过 GrowthBook feature flags 动态配置。这不是"配置文件化"，而是"实时运维化"— 运维团队可以在不重启任何客户端的情况下，在几分钟内调整全球数千个 Bridge 实例的行为。

### 4. Generation 计数器模式

`jwtUtils.ts` 中的 generation 计数器是处理异步定时器竞态的优雅模式：

```
schedule(session_A)  → gen=1, timer fires doRefresh(gen=1)
cancel(session_A)    → gen=2, old timer still pending
schedule(session_A)  → gen=3, new timer fires doRefresh(gen=3)
-- old gen=1 timer fires → generations.get(A) === 3 ≠ 1 → skip
```

这比 `clearTimeout` + `setTimeout` 更可靠，因为它能处理异步等待期间的竞态 — `doRefresh` 在 `await getAccessToken()` 期间，会话可能被 cancel 或重新 schedule。

---

## 章末速查表

| 概念 | 文件 | 核心函数/类 |
|------|------|------------|
| Bridge 主循环 | `bridgeMain.ts` | `runBridgeLoop()` |
| API 客户端 | `bridgeApi.ts` | `createBridgeApiClient()` |
| 功能检测 | `bridgeEnabled.ts` | `isBridgeEnabled()`, `getBridgeDisabledReason()` |
| 认证配置 | `bridgeConfig.ts` | `getBridgeAccessToken()`, `getBridgeBaseUrl()` |
| 工作密钥 | `workSecret.ts` | `decodeWorkSecret()`, `buildSdkUrl()`, `registerWorker()` |
| 会话子进程 | `sessionRunner.ts` | `createSessionSpawner()` |
| REPL Bridge | `replBridge.ts` | `ReplBridgeHandle` |
| v1/v2 传输层 | `replBridgeTransport.ts` | `createV1ReplTransport()`, `createV2ReplTransport()` |
| JWT 刷新 | `jwtUtils.ts` | `createTokenRefreshScheduler()` |
| 可信设备 | `trustedDevice.ts` | `enrollTrustedDevice()`, `getTrustedDeviceToken()` |
| 轮询配置 | `pollConfig.ts` | `getPollIntervalConfig()` |
| 远程会话管理 | `RemoteSessionManager.ts` | `RemoteSessionManager` |
| WebSocket 客户端 | `SessionsWebSocket.ts` | `SessionsWebSocket` |
| 消息适配 | `sdkMessageAdapter.ts` | `convertSDKMessage()` |
| 权限桥接 | `remotePermissionBridge.ts` | `createSyntheticAssistantMessage()`, `createToolStub()` |
| 直连管理 | `directConnectManager.ts` | `DirectConnectSessionManager` |
| 直连创建 | `createDirectConnectSession.ts` | `createDirectConnectSession()` |

| 环境变量 | 用途 |
|----------|------|
| `CLAUDE_CODE_SESSION_ACCESS_TOKEN` | 子进程的 Session Ingress JWT |
| `CLAUDE_CODE_ENVIRONMENT_KIND` | 标记 bridge 环境（值: `bridge`） |
| `CLAUDE_CODE_FORCE_SANDBOX` | 强制沙箱模式 |
| `CLAUDE_CODE_USE_CCR_V2` | 启用 CCR v2 协议 |
| `CLAUDE_CODE_WORKER_EPOCH` | v2 Worker epoch |
| `CLAUDE_BRIDGE_OAUTH_TOKEN` | 开发者覆盖 Token（仅 ant） |
| `CLAUDE_BRIDGE_BASE_URL` | 开发者覆盖 URL（仅 ant） |
| `CLAUDE_TRUSTED_DEVICE_TOKEN` | 测试用可信设备 Token |

| 关键常量 | 值 | 含义 |
|----------|-----|------|
| 默认会话超时 | 24h | `DEFAULT_SESSION_TIMEOUT_MS` |
| JWT 刷新缓冲 | 5min | 过期前提前刷新 |
| 后备刷新间隔 | 30min | 长时间会话的周期性刷新 |
| 最大刷新失败 | 3次 | 放弃刷新前的重试次数 |
| 空闲轮询间隔 | 2s | 快速响应新会话 |
| 满载轮询间隔 | 10min | 保活信号 |
| 回收超时 | 5s | 回收未确认的工作项 |
| WS 重连上限 | 5次 | 超过后永久断开 |
| Ping 间隔 | 30s | WebSocket 心跳 |
