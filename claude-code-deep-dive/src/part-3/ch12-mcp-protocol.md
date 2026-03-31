
# 第 12 章：MCP 协议 — 开放式工具扩展

> **核心问题**：一个 Coding Agent 如何在保持内置工具安全可控的同时，允许用户和第三方无限扩展工具能力，且不牺牲安全性、可靠性和用户体验？

内置工具（Read、Write、Bash 等）覆盖了文件操作和命令执行，但现实世界的开发场景远不止此 — 你可能需要查询 Jira 任务、操作数据库、调用内部 API、连接代码分析服务。如果每种需求都要在 Claude Code 内部添加工具，这个系统将变得臃肿不堪。

Model Context Protocol（MCP）是 Anthropic 提出的开放标准，让 LLM 应用通过标准化的客户端-服务器协议与外部工具通信。Claude Code 内嵌了一个**完整的 MCP 客户端实现**，支持 6 种配置来源、7 种传输方式、完整的协议特性集（Tools / Prompts / Resources / Elicitation），以及多层安全控制。本章将深入解剖这套系统的每一个关键环节。

---

## 12.1 概述：MCP 在 Claude Code 中的角色

### MCP 是什么

MCP（Model Context Protocol）解决的核心问题是：**工具扩展的标准化**。在 MCP 之前，每个 AI 应用都需要自己实现工具集成 — 不同的发现机制、不同的调用协议、不同的安全模型。MCP 定义了一套统一的客户端-服务器协议，让任何 MCP 服务器都能被任何 MCP 客户端使用，就像 HTTP 让任何浏览器都能访问任何网站一样。

### CC 中的 MCP 全景

Claude Code 的 MCP 实现覆盖了协议的完整能力：

| 维度 | 支持范围 |
|------|----------|
| 配置来源 | 6 种：Enterprise / Local / Project / User / Dynamic / claude.ai |
| 传输层 | 7 种：stdio / SSE / Streamable HTTP / WebSocket / SSE-IDE / WS-IDE / claudeai-proxy |
| 协议特性 | Tools / Prompts / Resources / Elicitation（Form + URL）|
| 安全控制 | 企业策略 / 项目审批 / 环境变量白名单 / Unicode 清理 |

> **注**：CC 客户端**未声明** Sampling 能力（capabilities 中无 sampling 字段）。SDK 层面协议完整，但 CC 选择不暴露该能力。服务器如果声明 `params.tools && !caps?.sampling?.tools`，会收到错误。

### 架构全景图

```
┌─────────────────────────────────────────────────────────────────┐
│                    Claude Code Agent (Agentic Loop)              │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ 内置工具      │  │ MCP 工具     │  │ Prompt / Resource      │ │
│  │ Read,Write...│  │ mcp__srv__fn │  │ /mcp__srv__promptName  │ │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬───────────┘ │
│         │                 │                        │             │
│         │    ┌────────────┴────────────────────────┘             │
│         │    │                                                   │
│         │    ▼                                                   │
│         │  ┌──────────────────────────────────────┐              │
│         │  │     MCP Manager (12_computer_use.js)  │              │
│         │  │  配置合并 VzH() (mergeAllConfigs)     │              │
│         │  │  连接管理 kC()  (createConnection)    │              │
│         │  │  批量连接 GkH() (connectAllServers)   │              │
│         │  └──────────────┬───────────────────────┘              │
│         │                 │                                      │
└─────────┼─────────────────┼──────────────────────────────────────┘
          │                 │
          │    ┌────────────┴────────────────┐
          │    │    MCP Client EV_ (McpClient)│
          │    │  extends _FH (ProtocolBase)  │
          │    │  JSON-RPC 2.0 协议           │
          │    └────────────┬────────────────┘
          │                 │
          │    ┌────────────┴────────────────────────────────────┐
          │    │            Transport Layer                       │
          │    │  ┌───────┐ ┌───────┐ ┌───────┐ ┌─────────────┐ │
          │    │  │ stdio │ │  SSE  │ │ HTTP  │ │  WebSocket  │ │
          │    │  │ sp6   │ │ nV_   │ │ rV_   │ │    fS_      │ │
          │    │  └───┬───┘ └───┬───┘ └───┬───┘ └──────┬──────┘ │
          │    └──────┼─────────┼─────────┼────────────┼────────┘
          │           │         │         │            │
          │           ▼         ▼         ▼            ▼
          │      ┌─────────────────────────────────────────┐
          │      │           MCP Server (外部进程/服务)      │
          │      └─────────────────────────────────────────┘
          │
     直接执行
```

### 与内置工具的对比

MCP 工具通过命名前缀与内置工具区分：

| 特性 | 内置工具 | MCP 工具 |
|------|---------|----------|
| 命名 | `Read`、`Write`、`Bash` | `mcp__<server>__<tool>` |
| 执行 | 进程内直接调用 | JSON-RPC 远程调用 |
| 权限 | 基于工具类型预设 | 默认 `passthrough`（每次需用户确认）|
| 发现 | 编译时固定 | 运行时 `tools/list` 动态获取 |
| 并发 | 工具级标记 | 由 `annotations.readOnlyHint` 决定 |

```
Agent 工具选择
    │
    ├── 无前缀 "Read" ────────→ 内置工具直接执行
    │
    └── "mcp__" 前缀 ─────────→ 解析 server + tool
         │                       │
         ▼                       ▼
     FLH() 获取连接         权限检查 (passthrough)
         │                       │
         ▼                       │
     kD1()+jh7() ←───────────────┘
         │
         ▼
     Transport.send(JSON-RPC)
         │
         ▼
     MCP Server 执行并返回
```

**小结**：MCP 在 Claude Code 中扮演"开放式工具平台"的角色。通过标准化的协议和多层抽象，它让外部工具能够以与内置工具几乎一致的方式被 Agent 发现和调用，同时保持安全可控。

---

## 12.2 配置系统 — 6 层配置来源

MCP 服务器的配置决定了 Agent 能连接哪些外部工具。Claude Code 设计了一套 6 层优先级系统，让企业管理员、个人用户、项目配置各得其所，同时确保企业策略不可被绕过。

### 6 种配置来源与优先级

```
优先级从高到低：

┌─────────────────────────────────────────────────────┐
│ 1. Enterprise  — 企业策略配置                        │
│    最高优先级，管理员控制，不可被用户覆盖              │
├─────────────────────────────────────────────────────┤
│ 2. Local       — 本地配置（不进版本控制）             │
│    .claude/local-settings.json                      │
├─────────────────────────────────────────────────────┤
│ 3. Project     — 项目级配置（.mcp.json，进版本控制）  │
│    需通过审批流程 WS_() (getApprovalStatus)          │
├─────────────────────────────────────────────────────┤
│ 4. User        — 用户全局配置                        │
│    ~/.claude/settings.json                          │
├─────────────────────────────────────────────────────┤
│ 5. Dynamic     — 运行时动态添加                      │
│    Agent 运行过程中通过 API 添加                     │
├─────────────────────────────────────────────────────┤
│ 6. claude.ai   — 远程服务器                          │
│    通过 OAuth 从 claude.ai 拉取                     │
│    hzH() (fetchClaudeAiServers)                     │
└─────────────────────────────────────────────────────┘
```

### 核心合并逻辑 VzH() (mergeAllConfigs)

合并过程遵循"高优先级覆盖低优先级 + 企业策略过滤"的原则：

```javascript
// 核心合并逻辑（简化）
async function VzH(dynamicServers, claudeaiPromise) {
    // 1. 读取各层配置
    let enterprise = pY("enterprise");  // 企业配置
    let user = pY("user");              // 用户配置
    let project = pY("project");        // 项目配置
    let local = pY("local");            // 本地配置

    // 2. 企业独占模式 — 如果启用，直接返回企业配置
    if (KqH()) {  // isEnterpriseExclusive
        return { servers: filteredEnterprise, errors: [] };
    }

    // 3. 项目级配置需要审批
    let approvedProject = {};
    for (let [name, config] of Object.entries(project)) {
        if (WS_(name) === "approved") {  // getApprovalStatus
            approvedProject[name] = config;
        }
    }

    // 4. 按优先级合并（低优先级在前，高优先级在后覆盖）
    let merged = { ...user, ...approvedProject, ...local, ...dynamic, ...claudeai };

    // 5. 企业策略过滤（deny/allow 名单）
    let finalMerged = {};
    for (let [name, config] of Object.entries(merged)) {
        if (!EG(name) && eLH(name, config)) {  // isDisabled / isAllowed
            finalMerged[name] = config;
        }
    }

    return { servers: finalMerged, errors };
}
```

> **设计决策**：企业独占模式 `KqH()` (isEnterpriseExclusive) 是一个"核武器级"开关。一旦启用，所有非企业来源的配置直接被丢弃，连合并都不会发生。这确保了在高安全环境中，管理员对工具的完全控制权。

### .mcp.json 格式与 Schema

每种传输类型有独立的 Zod Schema 定义：

```javascript
// 基本格式
{
    "mcpServers": {
        "my-server": {
            "type": "stdio",        // 传输类型
            "command": "npx",       // 启动命令
            "args": ["-y", "@my/mcp-server"],  // 命令参数
            "env": {                // 环境变量
                "API_KEY": "${MY_API_KEY}"
            }
        }
    }
}
```

8 种传输类型的 Schema 定义：

| Schema 变量 | 传输类型 | 关键字段 |
|-------------|---------|---------|
| `G96` | stdio | command, args, env |
| `xz$` | SSE | url, headers |
| `Bz$` | HTTP (Streamable) | url, headers |
| `gz$` | WebSocket | url, headers |
| `mz$` | SSE-IDE | url, headers |
| `pz$` | WS-IDE | url, headers |
| `dz$` | SDK | - |
| `cz$` | claudeai-proxy | id, uuid |

### 目录层次遍历

Project 级别配置支持从当前目录向上遍历到根目录，每一层的 `.mcp.json` 都会被读取，**深层目录的配置覆盖浅层**：

```
/home/user/project/packages/frontend/.mcp.json  ← 最高优先级
/home/user/project/packages/.mcp.json
/home/user/project/.mcp.json                    ← 最低优先级（Project 层内）
```

这个设计让 monorepo 中的子项目可以定义自己的 MCP 服务器，同时继承根项目的配置。

### 环境变量展开 QA1() (expandEnvVars)

配置中的 `${VAR_NAME}` 语法会被展开为实际环境变量值：

```javascript
// QA1() 调用 aLH() 进行实际替换
// 输入: { "API_KEY": "${MY_SECRET}" }
// 如果 MY_SECRET="sk-123"，输出: { "API_KEY": "sk-123" }
// 如果变量不存在，产生 warning（不是错误）
```

### Windows npx 兼容性

在 Windows 上，`npx` 命令需要通过 `cmd /c` 包装才能正确执行：

```
原始: npx -y @my/mcp-server
Windows 实际执行: cmd /c npx -y @my/mcp-server
```

CC 在创建 stdio 传输时自动检测和处理这个兼容性问题。

### claude.ai 远程服务器 hzH() (fetchClaudeAiServers)

Claude.ai 上配置的 MCP 服务器可以通过 OAuth 认证拉取到本地使用：

```
hzH() 流程:
1. 检查 OAuth token 是否可用
2. GET /v1/mcp_servers (scope: "user:mcp_servers")
3. 返回服务器列表 → 转换为 claudeai-proxy 类型配置
4. 这些服务器通过 Anthropic 代理中转通信
```

**小结**：6 层配置系统的精妙之处在于平衡了"灵活"与"可控"。用户可以在多个层次自由配置，但企业策略始终拥有最终否决权。Project 级别引入审批机制，防止恶意 `.mcp.json` 文件被项目成员意外信任。

---

## 12.3 传输层实现 — 7 种连接方式

传输层是 MCP 客户端与服务器之间的通信基础设施。Claude Code 实现了 7 种传输方式，通过统一的 Transport 接口抽象，让上层代码无需关心底层使用的是本地进程管道还是远程 HTTP 连接。

所有传输都实现统一接口：

```typescript
// Transport 统一接口
interface Transport {
    onmessage: (msg: JSONRPCMessage) => void;  // 接收消息回调
    onerror: (error: Error) => void;           // 错误回调
    onclose: () => void;                       // 关闭回调
    start(): Promise<void>;                    // 启动连接
    close(): Promise<void>;                    // 关闭连接
    send(message: JSONRPCMessage): Promise<void>;  // 发送消息
    sessionId?: string;                        // 会话 ID（HTTP 传输）
}
```

### stdio 传输 sp6 (StdioTransport)

stdio 是最常用的传输方式，用于连接本地 MCP 服务器进程。通过 stdin/stdout 管道进行双向通信。

**消息帧格式**：

```
发送方: JSON.stringify(message) + "\n"    ← 以换行符分隔
接收方: SFH (ReadBuffer) 逐行解析 JSON

┌──────────────────────────────────┐
│ {"jsonrpc":"2.0","method":"..."}  │  ← 一个完整的 JSON 对象
│ \n                                │  ← 换行符作为消息分隔
│ {"jsonrpc":"2.0","id":1,...}      │  ← 下一条消息
│ \n                                │
└──────────────────────────────────┘
```

`SFH` (ReadBuffer) 负责缓冲和解析：读取 stdout 数据流 → 按 `\n` 分割 → `JSON.parse` 每一行 → 通过 `Lu.parse` 验证 JSON-RPC Schema → 触发 `onmessage` 回调。`P0_` 负责序列化：`JSON.stringify(message) + "\n"` → 写入 stdin。

**进程生命周期**：

```
spawn 阶段:
  child_process.spawn(command, args, {
      stdio: ["pipe", "pipe", "inherit"],  // stdin=pipe, stdout=pipe, stderr=继承
      shell: false,                        // 不使用 shell（安全）
      env: filteredEnv                     // 白名单过滤后的环境变量
  })

运行阶段:
  父进程 stdin  ──write──→  子进程 stdin   (发送 JSON-RPC 请求)
  父进程 stdout ←──read───  子进程 stdout  (接收 JSON-RPC 响应)
  父进程 stderr ←──inherit─ 子进程 stderr  (错误日志直接输出)

关闭阶段 (优雅关闭):
  1. stdin.end()           ← 关闭写入端，通知子进程不再有输入
  2. 等待 2s               ← 给子进程清理时间
  3. SIGTERM               ← 请求子进程优雅退出
  4. 等待 2s               ← 再给一次机会
  5. SIGKILL               ← 强制杀死（最后手段）
```

> **设计决策**：`shell: false` 是关键的安全选择。如果 `shell: true`，用户配置中的 command 可能被注入恶意 shell 命令。`shell: false` 确保 command 被直接执行，不经过 shell 解释。

**环境变量白名单过滤**：

为了防止敏感环境变量泄露给 MCP 服务器，stdio 传输对传递的环境变量进行白名单过滤：

| 平台 | 白名单变量 |
|------|-----------|
| Windows | APPDATA, LOCALAPPDATA, PATH, TEMP, TMP, USERPROFILE, HOMEDRIVE, HOMEPATH, ... |
| Unix | HOME, PATH, SHELL, USER, LANG, LC_ALL, TERM, TMPDIR, XDG_*, ... |

加上 `.mcp.json` 中显式声明的 `env` 字段变量。未在白名单中的变量**不会**被传递给子进程。

### SSE 传输 nV_ (SseTransport)

SSE（Server-Sent Events）传输用于连接远程 MCP 服务器，采用"GET 长连接 + POST 发送"的双通道模式：

```
客户端                                  服务器
  │                                       │
  │─── GET /sse ──────────────────────→   │  建立 SSE 长连接
  │                                       │
  │←── event: endpoint ───────────────    │  服务器告知 POST 地址
  │    data: /messages?session_id=abc     │
  │                                       │
  │←── event: message ────────────────    │  推送 JSON-RPC 消息
  │    data: {"jsonrpc":"2.0",...}         │  （通过 SSE 长连接）
  │                                       │
  │─── POST /messages?session_id=abc ──→  │  发送 JSON-RPC 请求
  │    body: {"jsonrpc":"2.0",...}         │  （通过独立 HTTP 请求）
  │                                       │
  │←── event: message ────────────────    │  响应也通过 SSE 推送
  │    data: {"jsonrpc":"2.0","id":1,...}  │
  │                                       │
```

**endpoint 事件**是 SSE 传输的关键握手步骤：服务器通过 SSE 长连接推送一个 `endpoint` 事件，告知客户端应该向哪个 URL 发送 POST 请求。客户端会验证这个 URL 的 origin 与 SSE 连接的 origin 是否一致（**origin 安全检查**），防止服务器将客户端重定向到恶意地址。

**OAuth 认证**：当 POST 请求返回 401 时，触发 OAuth 认证流程。认证成功后重试请求。请求头携带：

```
Authorization: Bearer <token>
mcp-protocol-version: <version>
```

### Streamable HTTP 传输 rV_ (StreamableHttpTransport)

Streamable HTTP 是 MCP 协议的现代传输方式，比 SSE 更灵活。所有通信通过 POST 请求完成，响应可以是 JSON 也可以是 SSE 流：

```
客户端                                      服务器
  │                                           │
  │─── POST /mcp ─────────────────────────→   │
  │    Content-Type: application/json          │
  │    Accept: application/json, text/event-stream
  │    mcp-session-id: <session_id>            │
  │    body: {"jsonrpc":"2.0","method":"..."}  │
  │                                           │
  │←── 三种响应之一:                            │
  │                                           │
  │    A. 202 Accepted                         │  ← 异步处理，稍后推送
  │    B. Content-Type: application/json       │  ← 直接 JSON 响应
  │    C. Content-Type: text/event-stream      │  ← SSE 流式响应
  │                                           │
```

**Session ID 管理**：

```
首次请求: 不带 mcp-session-id
首次响应: 服务器在 header 中返回 mcp-session-id
后续请求: 客户端在 header 中携带 mcp-session-id
```

Session ID 实现了有状态的通信：服务器可以据此关联同一客户端的多次请求。

**Resumption Token 与自动重连**：

Streamable HTTP 支持 SSE 流中断后恢复。每个 SSE 事件可以携带一个 `id`（resumption token），断线重连时客户端通过 `Last-Event-ID` header 告知服务器从哪里继续。

```javascript
// 指数退避重连策略
let delay = initialDelay;
for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
        await reconnect(lastEventId);
        break;  // 成功则退出
    } catch (e) {
        delay = Math.min(delay * 2, maxDelay);
        // 服务器可通过 retry 字段覆盖延迟时间
        await sleep(delay);
    }
}
```

**认证处理**：401 触发 OAuth 认证；403 + `insufficient_scope` 触发 upscoping（请求更高权限）。

### WebSocket 传输 fS_ (WebSocketTransport)

WebSocket 提供全双工的长连接通信，适用于需要服务器主动推送的场景：

```javascript
// 双运行时支持
if (typeof Bun !== "undefined") {
    // Bun 运行时: 使用原生 WebSocket API
    ws = new WebSocket(url);
} else {
    // Node.js 运行时: 使用 ws 库
    const { WebSocket } = require("ws");
    ws = new WebSocket(url, { agent: getProxy(), ...tlsOptions });
}

// 消息处理
ws.onmessage = (event) => {
    let message = JSON.parse(event.data);
    Lu.parse(message);  // JSON-RPC Schema 验证
    this.onmessage(message);
};
```

WebSocket 传输支持：
- **代理**：通过 `getProxy()` 自动检测和使用 HTTP/HTTPS 代理
- **自定义 TLS**：支持自签名证书等非标准 TLS 配置

### claudeai Proxy 传输

基于 Streamable HTTP 传输 `rV_`，通过 Anthropic 代理中转与 claude.ai 上配置的 MCP 服务器通信：

```
URL 构造:
  MCP_PROXY_URL + MCP_PROXY_PATH.replace("{server_id}", id)

通信路径:
  CC Client → Anthropic Proxy → claude.ai MCP Server
```

这让用户在 claude.ai 上配置的 MCP 服务器可以在 Claude Code 中无缝使用。

### 传输选择逻辑 kC() (createConnection)

`kC()` (createConnection) 根据配置中的 `type` 字段路由到对应的传输实现：

```javascript
// 传输类型路由（简化）
function selectTransport(type) {
    switch (type) {
        case "sse":            return nV_;   // SseTransport
        case "sse-ide":        return nV_;   // 复用 SSE（IDE 集成）
        case "ws":             return fS_;   // WebSocketTransport
        case "ws-ide":         return fS_;   // 复用 WebSocket（IDE 集成）
        case "http":           return rV_;   // StreamableHttpTransport
        case "claudeai-proxy": return rV_;   // 复用 HTTP（代理中转）
        case "stdio":          return sp6;   // StdioTransport
        default:               return sp6;   // 默认 stdio
    }
}
```

> **设计决策**：7 种传输方式中，实际的传输类只有 4 个（sp6、nV_、rV_、fS_），其他 3 种通过参数化复用已有实现。SSE-IDE 和 WS-IDE 复用 SSE 和 WebSocket 的实现，只是配置上下文不同；claudeai-proxy 复用 Streamable HTTP，只是 URL 指向代理。这种"少量实现 + 多种配置"的策略最大化了代码复用。

**小结**：传输层通过统一的 Transport 接口，将 7 种物理连接方式抽象为一致的消息收发语义。上层的 MCP Client 不需要知道消息是通过本地管道、HTTP 请求还是 WebSocket 传递的 — 它只看到 `send()` 和 `onmessage`。这个抽象层是支撑 MCP 灵活性的关键基石。

---

## 12.4 MCP 客户端 — EV_ (McpClient)

MCP Client 是协议的核心实现，负责与 MCP Server 建立连接、握手协商、能力发现、方法调用。它将底层传输的原始消息收发转化为结构化的 RPC 调用语义。

### 类结构

```javascript
// EV_ (McpClient) 继承自 _FH (ProtocolBase)
class EV_ extends _FH {
    // 客户端标识
    _clientInfo = {
        name: "claude-code",
        version: "2.1.86"
    };

    // 客户端声明的能力
    _capabilities = {
        roots: {},                   // 支持 roots（工作目录声明）
        elicitation: {
            form: {},                // 支持表单式交互请求
            url: {}                  // 支持 URL 式交互请求
        }
        // 注意: 没有 sampling — CC 不支持服务器发起的 LLM 调用
    };

    // 服务器信息（initialize 后填充）
    _serverCapabilities = null;
    _serverVersion = null;
    _instructions = null;
}
```

`_FH` (ProtocolBase) 基类提供了 JSON-RPC 2.0 的底层实现：请求/响应的 ID 匹配、通知分发、超时管理等。`EV_` 在此基础上添加 MCP 协议特定的握手和能力管理。

### Initialize 握手流程

连接建立后的第一件事是 Initialize 握手 — 这是一个严格的 8 步流程：

```
客户端 EV_                                服务器
  │                                         │
  │  1. connect(transport)                  │
  │     └→ super.connect() 绑定传输        │
  │                                         │
  │  2. 检查 transport.sessionId            │
  │     └→ 有值则跳过握手（已建立会话）     │
  │                                         │
  │  3. ──── initialize request ────────→   │
  │     {                                   │
  │       method: "initialize",             │
  │       params: {                         │
  │         protocolVersion: M_H,           │  ← 协议版本
  │         capabilities: {...},            │  ← 客户端能力
  │         clientInfo: {name,version}      │  ← 客户端标识
  │       }                                 │
  │     }                                   │
  │                                         │
  │  4. ←── initialize response ─────────   │
  │     {                                   │
  │       protocolVersion: "...",            │  ← 服务器选择的版本
  │       capabilities: {...},              │  ← 服务器能力
  │       serverInfo: {name,version},       │  ← 服务器标识
  │       instructions: "..."               │  ← 可选的使用说明
  │     }                                   │
  │                                         │
  │  5. 版本检查                             │
  │     if (!SUPPORTED_VERSIONS.includes(   │
  │         response.protocolVersion))       │
  │       throw Error("Unsupported")        │
  │                                         │
  │  6. 保存服务器能力和信息                  │
  │     this._serverCapabilities = ...      │
  │     this._serverVersion = ...           │
  │     this._instructions = ...            │
  │                                         │
  │  7. 设置协议版本                         │
  │     transport.setProtocolVersion(...)    │
  │                                         │
  │  8. ──── notifications/initialized ──→  │  ← 通知（非请求）
  │     "我已准备好，可以开始工作了"          │
  │                                         │
  │  9. 设置 listChanged 处理器             │
  │     _setupListChangedHandlers()         │
  │                                         │
```

> **设计决策**：第 8 步使用**通知**而非请求来告知服务器客户端已就绪。这是有意的 — 通知不需要响应，减少了一次往返。此时握手已经完成，客户端不需要从服务器获取更多信息。

### 服务器能力 Schema

Initialize 响应中的 `capabilities` 字段声明了服务器支持的功能：

```javascript
// ServerCapabilities 结构
{
    experimental: { ... },        // 实验性功能
    logging: { ... },             // 日志能力
    completions: { ... },         // 自动补全
    prompts: {
        listChanged: true         // 支持 prompts/list_changed 通知
    },
    resources: {
        subscribe: true,          // 支持资源订阅
        listChanged: true         // 支持 resources/list_changed 通知
    },
    tools: {
        listChanged: true         // 支持 tools/list_changed 通知
    },
    tasks: {
        list: true,               // 支持任务列表
        cancel: true,             // 支持任务取消
        requests: true            // 支持任务请求
    }
}
```

### JSON-RPC 2.0 协议

MCP 基于 JSON-RPC 2.0 定义了三种消息类型：

| 类型 | 特征 | 示例 |
|------|------|------|
| **请求** | 有 `id` + `method` | `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}` |
| **响应** | 有 `id` + `result`/`error` | `{"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}` |
| **通知** | 有 `method`，无 `id` | `{"jsonrpc":"2.0","method":"notifications/initialized"}` |

请求需要响应，通知不需要。基类 `_FH` 通过 `id` 将请求与响应配对，通过 `method` 路由通知到注册的处理器。

### 方法能力检查 assertCapabilityForMethod()

在发送请求前，客户端会检查服务器是否声明了对应的能力：

```javascript
// 方法到能力的映射
assertCapabilityForMethod(method) {
    switch (method) {
        case "prompts/get":
        case "prompts/list":
            assert(this._serverCapabilities.prompts);
            break;
        case "resources/read":
        case "resources/list":
        case "resources/subscribe":
            assert(this._serverCapabilities.resources);
            break;
        case "tools/call":
        case "tools/list":
            assert(this._serverCapabilities.tools);
            break;
    }
}
```

如果服务器未声明某项能力，客户端在调用相关方法前就会抛出错误，避免发送注定失败的请求。

### 连接超时 ME_() (getTimeout)

连接建立有严格的超时控制：

```javascript
// ME_() 实现超时保护
async function ME_(connectPromise, timeoutMs) {
    return Promise.race([
        connectPromise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Connection timeout")), timeoutMs)
        )
    ]);
}
```

### listChanged 自动刷新 _setupListChangedHandlers()

如果服务器在能力中声明了 `listChanged: true`，客户端会注册通知处理器，在工具/资源/提示列表变化时自动刷新缓存：

```javascript
_setupListChangedHandlers(config) {
    if (this._serverCapabilities?.tools?.listChanged) {
        // 监听 tools 变化通知
        this.on("notifications/tools/list_changed", () => {
            // 清除工具缓存，下次获取时自动重新拉取
            config.clearToolsCache();
        });
    }
    // resources/list_changed, prompts/list_changed 类似处理
}
```

**小结**：MCP Client 的核心职责是将底层传输的原始字节流转化为类型安全的 RPC 调用。Initialize 握手确保双方能力协商一致，assertCapabilityForMethod 提前拦截不支持的调用，listChanged 处理器实现了工具列表的实时同步。这些机制共同构建了一个可靠的客户端-服务器通信框架。

---

## 12.5 工具集成 — 从发现到调用的完整链路

工具是 MCP 最核心的特性。本节从工具发现、命名、属性映射、三层调用架构到结果处理，完整解析一个 MCP 工具从"被发现"到"被执行"的全过程。

### 工具发现 uy() (getTools)

`uy()` (getTools) 向 MCP Server 发送 `tools/list` 请求，获取服务器提供的所有工具定义：

```javascript
// uy() 工具发现流程（简化）
async function uy(serverName, client) {
    // 1. 发送 tools/list 请求
    let response = await client.request({ method: "tools/list" });

    // 2. Unicode 清理 — 防止注入攻击
    let tools = e8H(response.tools);  // sanitizeUnicode: 递归清理所有字符串

    // 3. 映射为 CC 内部工具定义
    return tools.map(tool => ({
        name: EuH(serverName, tool.name),  // buildToolName: mcp__server__tool
        description: tool.description,
        inputSchema: tool.inputSchema,
        // ... 属性映射
    }));
}
```

`e8H` (sanitizeUnicode) 对工具定义中的所有字符串递归执行 Unicode 清理（详见 12.8 安全机制），防止恶意服务器通过工具名或描述注入不可见字符。

### 工具命名

MCP 工具使用三段式命名：`mcp__<server>__<tool>`

```javascript
// EuH() (buildToolName): 构建工具名
function EuH(serverName, toolName) {
    return `mcp__${Mf(serverName)}__${Mf(toolName)}`;
}

// Mf() (normalizeName): 规范化名称
//   非 [a-zA-Z0-9_-] 的字符 → 下划线
function Mf(name) {
    return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// QR() (parseToolName): 反向解析
//   "mcp__my_server__search" → { server: "my_server", tool: "search" }
function QR(fullName) {
    let parts = fullName.split("__");
    // parts[0] = "mcp", parts[1] = server, parts[2..] = tool
    return { server: parts[1], tool: parts.slice(2).join("__") };
}
```

> **设计决策**：使用双下划线 `__` 作为分隔符，而非单下划线 `_` 或 `/`，是为了与工具名中可能出现的单下划线和路径分隔符区分。`mcp__` 前缀让 Agent 能在工具选择阶段就区分内置工具和外部 MCP 工具，走不同的执行路径。

### 工具属性映射

MCP 工具的 annotations 和 _meta 字段被映射到 CC 内部的工具属性：

```
MCP annotations                    CC 工具属性
─────────────────────────────────────────────────────
readOnlyHint: true          →    isConcurrencySafe: true
                                  isReadOnly: true
destructiveHint: true       →    isDestructive: true
openWorldHint: true         →    isOpenWorld: true

MCP _meta                        CC 工具属性
─────────────────────────────────────────────────────
_meta.searchHint: "..."     →    搜索优化提示
_meta.alwaysLoad: true      →    工具定义始终发送给 LLM
                                  （即使未在当前上下文使用）
```

### 工具调用三层架构

MCP 工具的调用经过精心设计的三层架构，每层负责不同的关注点：

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: call() — 入口层                                    │
│  职责: Session expired 自动重试（最多 1 次）                  │
│                                                             │
│  try {                                                      │
│      return await kD1(args);     // 调用 Layer 2             │
│  } catch (e) {                                              │
│      if (e instanceof McpSessionExpiredError) {             │
│          await reconnect();      // 重建连接                 │
│          return await kD1(args); // 重试一次                 │
│      }                                                      │
│  }                                                          │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: kD1() (callWithElicitation) — Elicitation 处理层   │
│  职责: URL Elicitation 重试（最多 3 次）                      │
│                                                             │
│  for (let attempt = 0; attempt < 3; attempt++) {            │
│      let result = await jh7(args);   // 调用 Layer 3         │
│      if (result.error?.code === -32042) {                   │
│          // URL Elicitation: 服务器要求用户在浏览器中操作     │
│          await handleUrlElicitation(result);                 │
│          continue;  // 重试                                  │
│      }                                                      │
│      return result;                                         │
│  }                                                          │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: jh7() (callToolCore) — 实际调用层                   │
│  职责: JSON-RPC 调用 + 超时控制 + 进度日志                    │
│                                                             │
│  - client.callTool(name, args)    // JSON-RPC: tools/call   │
│  - zD1() 超时控制                 // 配置的超时时间           │
│  - 30 秒间隔日志                  // 长时间运行时输出进度     │
│  - 错误检查:                                                │
│      result.isError → McpToolCallError                      │
│      401 → McpAuthError                                     │
│      -32001/404 → McpSessionExpiredError                    │
└─────────────────────────────────────────────────────────────┘
```

> **设计决策**：三层架构的分层逻辑是"谁负责什么级别的重试"。Session expired 是连接级问题，在最外层处理并重建连接；URL Elicitation 是交互级问题，在中间层处理并等待用户操作；超时和实际调用是 RPC 级问题，在最内层处理。这种分层使每层的逻辑保持简单清晰。

### 工具结果处理 LD1() (processToolResult)

MCP 工具返回的结果支持多种内容类型：

```javascript
// LD1() 处理 MCP 工具返回的 content 数组
function LD1(result) {
    return result.content.map(item => {
        switch (item.type) {
            case "text":
                return { type: "text", text: item.text };

            case "image":
                // base64 编码的图片 → vision content block
                return { type: "image", source: { data: item.data, mediaType: item.mimeType } };

            case "resource":
                // 嵌入的资源内容
                if (item.resource.text) return { type: "text", text: item.resource.text };
                if (item.resource.blob) return { type: "image", ... };
                break;
        }
    });
}
```

### 工具权限 checkPermissions

MCP 工具的默认权限策略是 **passthrough** — 每次调用都需要用户确认：

```javascript
// MCP 工具权限检查
checkPermissions(toolName, input) {
    return { behavior: "passthrough" };
    // passthrough = 需要用户明确批准
    // 与内置工具不同，MCP 工具没有预设的"允许"或"拒绝"
}
```

这是 MCP 工具与内置工具的关键安全差异：内置工具（如 Read）可以根据路径规则自动放行，但 MCP 工具的行为由外部服务器决定，CC 无法预知其安全性，因此默认要求用户逐次确认。

### 工具搜索/只读分类 oL7() (classifyTool)

CC 内部维护了一个硬编码的分类表，将已知的 MCP 工具按行为分类：

```javascript
// oL7() (classifyTool) — 硬编码分类
const SEARCH_TOOLS = new Set([
    // 200+ 工具名
    "code_search", "search_files", "search_code",
    "web_search", "brave_search", "grep", ...
]);

const READ_TOOLS = new Set([
    // 500+ 工具名
    "read_file", "get_content", "list_files",
    "get_issue", "get_pr", "view_page", ...
]);

function oL7(toolName) {
    if (SEARCH_TOOLS.has(toolName)) return "search";
    if (READ_TOOLS.has(toolName)) return "read";
    return "unknown";
}
```

这个分类用于辅助 Agent 的工具选择决策 — 搜索类工具和只读类工具可以并行执行，而未知分类的工具默认串行。

### Resource 工具自动注入

当 MCP Server 声明了 `resources` 能力时，CC 自动为该服务器注入两个额外的工具：

```
服务器声明 capabilities.resources
    │
    ├── 注入 Hr/VrH (ListMcpResourcesTool)
    │   名称: mcp__<server>__mcp_list_resources
    │   功能: 列出服务器提供的所有资源
    │   权限: { behavior: "allow" }  ← 自动允许，无需确认
    │
    └── 注入 $r (ReadMcpResourceTool)
        名称: mcp__<server>__mcp_read_resource
        功能: 读取指定 URI 的资源内容
        权限: { behavior: "allow" }  ← 自动允许，无需确认
```

> **设计决策**：Resource 工具的权限是 `allow` 而非 `passthrough`，因为资源读取本质上是只读操作，且资源 URI 已经由服务器声明在列表中。用户在审批 MCP 服务器时已经隐式同意了对其资源的访问。

**小结**：工具集成链路从发现（tools/list）到命名（mcp__server__tool）到调用（三层架构）到结果处理（多内容类型），构成了一个完整的生命周期。三层调用架构是核心设计亮点 — 通过分层处理不同级别的异常（session / elicitation / RPC），让每层的逻辑保持单一职责。

---

## 12.6 Prompts 与 Resources 集成

MCP 协议不仅提供工具扩展，还支持 Prompts（预定义的提示模板）和 Resources（结构化数据资源）。这两个特性让 MCP 服务器能够向 Agent 提供更丰富的上下文。

### Prompt 发现 gzH() (getPrompts)

```javascript
// gzH() (getPrompts) — 获取服务器提供的 prompt 列表
async function gzH(serverName, client) {
    let response = await client.request({ method: "prompts/list" });

    return response.prompts.map(prompt => ({
        name: `mcp__${serverName}__${prompt.name}`,  // 命名规范与工具一致
        type: "prompt",
        source: "mcp",
        description: prompt.description,
        arguments: prompt.arguments  // 参数定义
    }));
}
```

### Prompt 作为 Skill 注入

Prompt 在 CC 中被注入为 **Skill**，用户通过斜杠命令 `/mcp__server__promptName` 调用：

```
用户输入: /mcp__github__create_pr_description

CC 处理流程:
  1. 解析 Skill 名称 → server: "github", prompt: "create_pr_description"
  2. prompts/get 请求获取 prompt 内容
  3. QR7() (buildArgMap) 构建参数映射
  4. 将 prompt 内容注入当前对话上下文
  5. Agent 基于 prompt 内容生成响应
```

### Prompt 参数传递 QR7() (buildArgMap)

```javascript
// QR7() (buildArgMap) — 将位置参数映射到命名参数
function QR7(prompt, positionalArgs) {
    let argMap = {};
    if (prompt.arguments) {
        prompt.arguments.forEach((argDef, index) => {
            if (positionalArgs[index] !== undefined) {
                argMap[argDef.name] = positionalArgs[index];
            }
        });
    }
    return argMap;
}
```

### Resource 发现 _r() (getResources)

```javascript
// _r() (getResources) — 获取服务器的资源列表
async function _r(serverName, client) {
    let response = await client.request({ method: "resources/list" });

    return response.resources.map(resource => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
        annotations: resource.annotations,
        server: serverName
    }));
}
```

### Resource 读取 — ReadMcpResourceTool ($r)

ReadMcpResourceTool 根据资源的内容类型采用不同的处理策略：

```
resources/read 响应
    │
    ├── text 类型 (resource.text 存在)
    │   └→ 直接返回文本内容给 Agent
    │
    └── blob 类型 (resource.blob 存在)
        └→ base64 解码 → 保存到磁盘临时文件
           └→ 返回文件路径给 Agent
```

```javascript
// ReadMcpResourceTool 核心逻辑（简化）
async function readResource(uri, serverName, client) {
    let response = await client.request({
        method: "resources/read",
        params: { uri }
    });

    for (let content of response.contents) {
        if (content.text) {
            // 文本资源: 直接返回
            return { type: "text", text: content.text };
        }
        if (content.blob) {
            // 二进制资源: 保存到磁盘
            let buffer = Buffer.from(content.blob, "base64");
            let filePath = saveToDisk(buffer, uri);
            return { type: "text", text: `Resource saved to: ${filePath}` };
        }
    }
}
```

### Resource 列表 — ListMcpResourcesTool (Hr/VrH)

ListMcpResourcesTool 列出所有或指定服务器的可用资源：

```javascript
// 调用方式
// 无参数: 列出所有 MCP 服务器的资源
// 指定 server: 列出该服务器的资源

// 权限: { behavior: "allow" } — 列出资源不需要用户确认
```

### 资源订阅

当服务器支持 `resources.listChanged` 时，CC 注册通知处理器自动刷新资源缓存：

```
服务器资源变化 → notifications/resources/list_changed → 清除 _r() 缓存
                                                        ↓
                                                   下次访问时重新 resources/list
```

这个机制与 tools 的 listChanged 完全一致，都是"通知清缓存 + 延迟重获取"的模式。

**小结**：Prompts 和 Resources 扩展了 MCP 的能力范围。Prompts 让服务器能定义可复用的操作模板（如"创建 PR 描述"），以 Skill 形式融入 CC 的交互模型。Resources 让服务器能暴露结构化数据（如数据库记录、API 文档），Agent 可以按需读取。两者与 Tools 一起，构成了 MCP 的三大协议特性。

---

## 12.7 服务器生命周期管理

MCP 服务器不是"配置一次就永远可用"的静态资源。服务器进程可能崩溃、网络可能中断、会话可能过期。本节解析 CC 如何管理服务器的完整生命周期：从连接建立、错误检测、自动重连到优雅关闭。

### 连接建立 kC() (createConnection)

`kC()` (createConnection) 是建立单个 MCP Server 连接的核心函数，完整流程有 8 步：

```
kC() (createConnection) 完整流程:

  1. 创建传输实例
     └→ 根据 config.type 选择 sp6/nV_/rV_/fS_

  2. 创建 MCP Client 实例
     └→ new EV_({ name: "claude-code", version: "2.1.86" })

  3. 注册 ListRoots 处理器
     └→ 响应服务器的 roots/list 请求
     └→ 返回当前工作目录列表

  4. 注册 Elicitation 处理器
     └→ ZL7() (registerElicitationHandler)
     └→ 处理服务器的交互请求（表单/URL）

  5. connect with timeout
     └→ ME_() 超时控制
     └→ client.connect(transport) → Initialize 握手

  6. 设置 listChanged 处理器
     └→ _setupListChangedHandlers()
     └→ 监听工具/资源/提示变化通知

  7. 注册 onerror 处理器
     └→ 记录错误，更新连续错误计数
     └→ 连续 3 次错误 → 关闭连接（熔断）

  8. 注册 onclose 处理器
     └→ 清除 kC/uy/_r/gzH 的 memoize 缓存
     └→ 允许下次调用时自动重连

  返回: { client, transport, serverName }
```

### 批量连接 GkH() (connectAllServers)

启动时，CC 需要连接所有配置的 MCP 服务器。`GkH()` (connectAllServers) 管理这个批量连接过程：

```javascript
// GkH() (connectAllServers) — 简化逻辑
async function GkH(servers) {
    // 1. 分优先级: 远程服务器先连接（通常更慢），本地后连接
    let remote = servers.filter(s => isRemote(s));
    let local = servers.filter(s => !isRemote(s));

    // 2. 并发连接所有服务器
    let connections = await Promise.allSettled([
        ...remote.map(s => kC(s)),   // 远程先发起
        ...local.map(s => kC(s))     // 本地紧跟
    ]);

    // 3. 对成功连接的服务器，获取工具/资源/提示
    for (let conn of connections.filter(c => c.status === "fulfilled")) {
        let tools = await uy(conn.value);      // getTools
        let prompts = await gzH(conn.value);   // getPrompts
        let resources = await _r(conn.value);  // getResources

        // 4. 如果服务器声明了 resources 能力，注入 Resource 工具
        if (conn.value.client._serverCapabilities?.resources) {
            tools.push(Hr);   // ListMcpResourcesTool
            tools.push($r);   // ReadMcpResourceTool
        }
    }
}
```

> **设计决策**：远程服务器优先发起连接是一个简单但有效的优化。远程连接通常需要 DNS 解析、TCP 握手、TLS 协商，延迟远高于本地 stdio spawn。先发起远程连接，让网络延迟与本地 spawn 并行，可以显著缩短总启动时间。

### 断开检测与错误分类

CC 将传输层错误分为**终端错误**和**可恢复错误**两类：

```javascript
// 7 种终端错误 — 表明连接已不可用
const TERMINAL_ERRORS = [
    "ECONNRESET",     // 连接被重置
    "ETIMEDOUT",      // 连接超时
    "ECONNREFUSED",   // 连接被拒绝
    "EPIPE",          // 管道断裂（进程退出）
    "EHOSTUNREACH",   // 主机不可达
    "ESRCH",          // 进程不存在
    "spawn"           // 进程启动失败
];

// 终端错误 → 清除缓存 → 下次调用时自动重连
// 非终端错误 → 记录日志 → 继续使用当前连接
```

### 连续错误熔断

为了防止一个持续失败的服务器浪费资源，CC 实现了简单的熔断机制：

```
连续错误计数:
  错误 1 → 计数 = 1，记录日志
  错误 2 → 计数 = 2，记录日志
  错误 3 → 计数 = 3，触发熔断！
            └→ 关闭连接
            └→ 标记服务器为不可用
            └→ 清除所有缓存
```

熔断阈值是 **3 次连续错误**。成功的调用会重置计数器。

### Session Expired 自动重连

对于 HTTP 和 claudeai-proxy 传输，会话过期是一种特殊的可恢复错误：

```
工具调用 → jh7() 返回 -32001/404 错误
    │
    ▼
抛出 McpSessionExpiredError
    │
    ▼
call() 入口层捕获
    │
    ├── 关闭当前传输 (closeTransport)
    ├── 清除 kC() 缓存 → 下次调用创建新连接
    └── 重试一次 → kD1() → jh7()
         └→ 新的 Initialize 握手 → 新 Session ID
```

### 服务器重启 jr() (restartServer)

用户可以手动触发服务器重启（比如服务器代码更新后）：

```javascript
// jr() (restartServer) — 完整重启流程
async function jr(serverName) {
    // 1. 清除所有 memoize 缓存
    clearCache(kC, serverName);   // 连接缓存
    clearCache(uy, serverName);   // 工具缓存
    clearCache(_r, serverName);   // 资源缓存
    clearCache(gzH, serverName);  // Prompt 缓存

    // 2. 断开现有连接
    await IG(serverName);  // disconnect

    // 3. 重新建立连接
    await kC(serverName);  // createConnection

    // 4. 重新获取工具列表
    await uy(serverName);  // getTools
}
```

### 连接断开与清理 IG() (disconnect)

```javascript
// IG() (disconnect) — 清理连接
async function IG(serverName) {
    let connection = getConnection(serverName);
    if (!connection) return;

    // 1. 执行清理回调
    connection.cleanup();

    // 2. 清除 memoize 缓存
    clearCache(kC, serverName);
    clearCache(uy, serverName);
    clearCache(_r, serverName);
    clearCache(gzH, serverName);

    // 3. 关闭传输
    await connection.transport.close();
}
```

### stdio 优雅关闭

stdio 传输的关闭需要特殊处理，因为涉及子进程的生命周期：

```
┌───────────────────────────────────────────────────────────┐
│  stdio 优雅关闭时序                                        │
│                                                           │
│  1. 发送 SIGINT                                           │
│     └→ 通知子进程"请准备退出"                              │
│                                                           │
│  2. 每 50ms 轮询子进程状态                                  │
│     └→ 检查 process.exitCode !== null                     │
│     └→ 如果已退出 → 完成                                  │
│                                                           │
│  3. 500ms 后仍未退出 → 发送 SIGTERM                        │
│     └→ 强烈请求退出                                       │
│                                                           │
│  4. 再等 500ms → 发送 SIGKILL                              │
│     └→ 强制杀死（不可忽略）                                │
│                                                           │
│  总超时: ~1000ms                                           │
└───────────────────────────────────────────────────────────┘
```

### onclose 缓存清除

当传输层检测到连接关闭时，`onclose` 回调会清除该服务器的所有 memoize 缓存：

```javascript
transport.onclose = () => {
    // 清除缓存 → 允许下次调用时自动重连
    clearMemoizeCache(kC, serverName);    // 连接缓存: $6 memoize
    clearMemoizeCache(uy, serverName);    // 工具缓存: XM memoized TTL
    clearMemoizeCache(_r, serverName);    // 资源缓存
    clearMemoizeCache(gzH, serverName);   // Prompt 缓存
};
```

这个机制实现了**透明的自动重连**：缓存清除后，下次工具调用会触发 `kC()` 重新创建连接，上层代码完全不知道中间发生了断线重连。

**小结**：服务器生命周期管理的核心思想是"缓存 + 自动恢复"。正常情况下，连接通过 `$6` memoize 缓存复用，避免重复建立；异常情况下，onclose 清除缓存，下次调用自动重建。连续错误熔断防止无限重试，Session expired 实现透明重连。这套机制让上层代码几乎不需要关心连接状态。

---

## 12.8 安全机制

MCP 开放了工具扩展能力，但开放性带来安全风险：恶意 MCP 服务器可能窃取数据、注入不可见字符、执行危险操作。CC 构建了多层安全防线来应对这些威胁。

### 企业策略: allowlist/denylist

企业管理员可以通过 allowlist（白名单）和 denylist（黑名单）控制哪些 MCP 服务器可以被使用：

```javascript
// dL7() (isDenied) — 检查是否在黑名单中
function dL7(name, config, deniedList) {
    return deniedList.some(pattern =>
        matchByName(name, pattern) ||     // 按名称匹配
        matchByCommand(config, pattern) || // 按命令匹配
        matchByUrl(config, pattern)        // 按 URL 匹配
    );
    // 支持通配符: "github*" 匹配 "github-issues", "github-prs"
}

// eLH() (isAllowed) — 综合判断是否允许
function eLH(name, config) {
    // 1. deny 优先 — 黑名单中的服务器一定被拒绝
    if (dL7(name, config, denyList)) return false;

    // 2. 无 allowlist — 默认全部允许
    if (!allowList) return true;

    // 3. 空 allowlist — 全部拒绝（"只允许列表中的，但列表为空"）
    if (allowList.length === 0) return false;

    // 4. 匹配 allowlist — 在列表中才允许
    return allowList.some(pattern => matchAny(name, config, pattern));
}
```

> **设计决策**：Deny 优先于 Allow 是安全领域的标准做法。即使管理员不小心在 allowlist 中添加了一个危险服务器，只要它同时在 denylist 中，就仍然会被拒绝。这遵循了"拒绝优先"的安全原则。

### 企业独占模式 KqH() (isEnterpriseExclusive)

最严格的企业控制 — 启用后，**只有**企业配置中的服务器可以使用：

```
KqH() = true 时的合并逻辑:

  Enterprise 配置: [server-a, server-b]     ← 只有这些可用
  User 配置:      [server-c]                ← 丢弃
  Project 配置:   [server-d]                ← 丢弃
  Dynamic 配置:   [server-e]                ← 丢弃
  claude.ai:      [server-f]                ← 丢弃

  最终结果: [server-a, server-b]
```

### 项目级审批 WS_() (getApprovalStatus)

Project 级别的 `.mcp.json` 可能由任何项目成员提交，存在被恶意利用的风险。CC 为此引入了审批机制：

```javascript
// WS_() (getApprovalStatus) — 判断项目级 MCP 服务器的审批状态
function WS_(serverName) {
    let normalized = Mf(serverName);  // 规范化名称

    // 1. 黑名单检查
    if (isInBlacklist(normalized)) return "rejected";

    // 2. 白名单检查（用户已明确批准）
    if (isInWhitelist(normalized)) return "approved";

    // 3. 自动审批条件（Claude Max/Pro 订阅用户）
    if (isAutoApproveEligible()) return "approved";

    // 4. 其他情况: 等待用户确认
    return "pending";
}
```

`pending` 状态的服务器不会被连接，直到用户在 UI 中明确批准。

### 服务器名称保留

某些名称被 CC 内部保留，外部 MCP 服务器不可使用：

```javascript
// 保留名称
const RESERVED_NAMES = [
    NzH,    // "Chrome MCP" — 浏览器控制
    // Computer Use — 屏幕操作
];

// 如果外部服务器使用保留名称 → 拒绝连接
```

### 服务器禁用控制 EG() (isDisabled)

```javascript
// EG() (isDisabled) — 检查服务器是否被禁用
function EG(name) {
    // 内置 MCP 服务器: 需要在 enabledMcpServers 中
    if (isBuiltin(name)) {
        return !enabledMcpServers.includes(name);
    }
    // 其他服务器: 在 disabledMcpServers 中则禁用
    return disabledMcpServers.includes(name);
}
```

### 环境变量安全

MCP 服务器进程的环境变量经过严格控制：

```
安全措施:
  1. 白名单传递 — 只传递安全的系统变量 + 显式声明的变量
  2. 不存在变量 warning — ${UNDEFINED_VAR} 产生警告，不静默忽略
  3. OAuth token 脱敏 — 日志中显示为 [REDACTED]
```

### Unicode 安全 kB6() (sanitizeUnicodeString)

恶意 MCP 服务器可能在工具名、描述或返回值中嵌入不可见的 Unicode 字符（零宽字符、双向文本控制符等），用于欺骗 LLM 或用户。CC 对所有来自 MCP 的字符串执行多轮清理：

```javascript
// kB6() (sanitizeUnicodeString) — Unicode 清理流程
function kB6(input) {
    let result = input;

    // 1. 多轮 NFKC 标准化
    //    将兼容字符转换为规范形式（如全角→半角）
    result = result.normalize("NFKC");

    // 2. 移除 Unicode 分类中的不可见/控制字符
    //    Cf (Format): 零宽字符、双向控制符
    //    Co (Private Use): 私用区字符
    //    Cn (Unassigned): 未分配码点

    // 3. 移除特定危险字符
    //    零宽空格 (U+200B)
    //    零宽连接符 (U+200C, U+200D)
    //    BOM (U+FEFF)
    //    双向文本控制符 (U+200E-U+200F, U+202A-U+202E)
    //    私用区字符 (U+E000-U+F8FF)

    return result;
}

// e8H() (sanitizeUnicode) — 递归清理对象中的所有字符串
function e8H(obj) {
    if (typeof obj === "string") return kB6(obj);
    if (Array.isArray(obj)) return obj.map(e8H);
    if (typeof obj === "object") {
        let result = {};
        for (let [key, value] of Object.entries(obj)) {
            result[kB6(key)] = e8H(value);  // key 和 value 都清理
        }
        return result;
    }
    return obj;
}
```

> **设计决策**：Unicode 清理同时作用于 key 和 value。攻击者可能在 JSON key 中嵌入零宽字符，使 `{"to\u200Bol": "..."}` 看起来像 `{"tool": "..."}`，但实际上是不同的 key。同时清理 key 和 value 堵住了这个攻击向量。

### MCP 官方注册表 XIq() (fetchOfficialRegistry)

CC 从 Anthropic 维护的官方注册表获取已认证的 MCP 服务器列表：

```
XIq() (fetchOfficialRegistry):
  URL: api.anthropic.com/mcp-registry/v0/servers
  用途: WIq() 判断服务器是否为官方认证
  影响: 官方服务器在遥测中记录更详细的信息
```

**小结**：MCP 安全是一个四层防护体系 — 企业策略控制"谁可以用"，项目审批控制"哪些项目配置可信"，环境变量白名单控制"泄露什么信息"，Unicode 清理控制"传输的内容是否安全"。每一层都在不同的攻击面上提供保护。

---

## 12.9 Elicitation — 交互式请求

有些 MCP 操作需要用户参与 — 比如 OAuth 授权需要在浏览器中完成，或者操作前需要用户填写一些参数。Elicitation 机制让 MCP 服务器能够在工具调用过程中向用户发起交互请求。

### 两种模式

| 模式 | 触发方式 | 用户交互 | 典型场景 |
|------|---------|---------|---------|
| **Form** | 服务器发送 JSON Schema 表单 | 用户在 CLI/UI 中填写字段 | 配置参数、确认信息 |
| **URL** | 工具调用返回 error code -32042 | 用户在浏览器中完成操作 | OAuth 授权、第三方登录 |

### Elicitation 请求处理 ZL7() (registerElicitationHandler)

```javascript
// ZL7() — 在 kC() 中注册 elicitation 处理器
function ZL7(client, serverName) {
    // 注册 Form Elicitation 处理器
    client.setRequestHandler("elicitation/create", async (params) => {
        // 1. hooks 前处理
        await drH(params);  // 前置 hook — 可以修改或拒绝请求

        // 2. 向用户展示表单
        let response = await showElicitationUI({
            message: params.message,
            schema: params.schema    // JSON Schema 定义表单字段
        });

        // 3. hooks 后处理
        await crH(response);  // 后置 hook

        // 4. 返回用户操作结果
        return response;  // { action: "accept"|"reject"|"decline", data: {...} }
    });

    // 注册 Elicitation 完成通知处理器
    client.setNotificationHandler("notifications/elicitation/complete", (params) => {
        // 服务器通知 elicitation 已在其端完成
    });
}
```

### Form Elicitation 流程

```
MCP Server                     CC Client                    用户
    │                             │                           │
    │── elicitation/create ──→    │                           │
    │   { message: "请输入...",    │                           │
    │     schema: { type: "object",│                          │
    │       properties: {          │                          │
    │         apiKey: {type:"string"}} │                      │
    │     }                        │                          │
    │   }                          │                          │
    │                              │── 显示表单 ─────────→     │
    │                              │                          │
    │                              │←─ 用户填写 ──────────     │
    │                              │   { apiKey: "sk-..." }   │
    │                              │                          │
    │←── response ─────────────    │                          │
    │   { action: "accept",        │                          │
    │     data: { apiKey: "sk-..." }│                         │
    │   }                          │                          │
    │                              │                          │
```

### URL Elicitation 重试机制

URL Elicitation 的触发方式不同于 Form — 它通过工具调用的**错误码**触发：

```
工具调用 → jh7() → 服务器返回 error code -32042
    │
    ▼
kD1() (callWithElicitation) 检测到 -32042
    │
    ├── 提取 URL 和提示信息
    ├── 打开用户浏览器访问 URL
    ├── 等待用户在浏览器中完成操作
    │   （如 OAuth 授权、支付确认等）
    │
    ├── 重试工具调用（最多 3 次）
    │   └→ 服务器检查用户是否已完成操作
    │       ├── 已完成 → 返回正常结果
    │       └── 未完成 → 再次返回 -32042
    │
    └── 3 次后仍未完成 → 返回最终错误
```

### 用户操作结果

Elicitation 支持三种用户响应：

| 操作 | 含义 | 场景 |
|------|------|------|
| `accept` | 用户完成并提交 | 填写表单后确认 |
| `reject` | 用户明确拒绝 | 不想提供信息 |
| `decline` | 用户选择跳过 | 暂时不处理 |

### hooks 集成

Elicitation 请求经过 hooks 管道，允许自动化处理：

```
drH (前处理 hook):
  - 可以自动填充表单字段
  - 可以拒绝特定的 elicitation 请求
  - 用于 CI/CD 场景中的自动化

crH (后处理 hook):
  - 可以记录用户的 elicitation 响应
  - 可以修改响应数据
```

**小结**：Elicitation 是 MCP 协议中"服务器向客户端发起请求"的反向通信机制。Form 模式适用于简单的数据收集，URL 模式适用于需要浏览器交互的复杂场景（如 OAuth）。-32042 错误码 + 最多 3 次重试的设计，让 URL Elicitation 可以优雅地处理异步的浏览器操作。

---

## 12.10 设计启示：标准化工具协议的工程智慧

MCP 在 Claude Code 中的实现展示了多个值得借鉴的工程设计模式。

### 1. 传输层抽象 — 统一接口支撑多种连接

7 种传输方式、4 个实际实现类、1 个统一 Transport 接口。上层代码（MCP Client、工具调用、连接管理）**完全不知道**底层使用的是 stdio 管道还是 WebSocket。这种抽象的价值在于：新增传输方式只需实现 `start/close/send/onmessage` 四个方法，无需修改任何上层代码。

### 2. 连接缓存与自动重连 — $6 memoize + onclose 清缓存

```
正常路径:
  调用 kC() → 命中 $6 memoize 缓存 → 直接返回已有连接 → 零延迟

异常路径:
  连接断开 → onclose 清除 $6 缓存 → 下次调用 kC() → 缓存未命中
  → 重新创建连接 → 透明重连完成
```

这个模式的巧妙之处在于**没有显式的重连逻辑** — 只有"缓存存在则复用，不存在则创建"的简单语义，重连是缓存失效的自然结果。

### 3. 延迟加载 — XM memoized with TTL + listChanged 通知

工具列表通过 `XM` memoized（带 TTL=20s）实现延迟加载：首次调用时从服务器获取，之后 20 秒内直接返回缓存。当服务器推送 `listChanged` 通知时，主动清除缓存触发下次重新获取。

```
                     TTL 未过期
                    ┌──────────┐
                    │          │
     首次调用 ───→  缓存       ├──→ 直接返回（快速）
                    │          │
                    └──────────┘
                         │ TTL 过期 或 listChanged
                         ▼
                    重新 tools/list
```

这比定时轮询高效（无需周期性请求），比纯事件驱动可靠（TTL 兜底处理通知丢失）。

### 4. 安全多层防护 — 企业/项目/环境/Unicode 四层

| 层 | 保护目标 | 机制 |
|----|---------|------|
| 企业 | 控制可用服务器 | allowlist/denylist + 独占模式 |
| 项目 | 防止恶意 .mcp.json | 审批流程 + 自动审批条件 |
| 环境 | 防止信息泄露 | 环境变量白名单 + token 脱敏 |
| Unicode | 防止字符注入 | NFKC + 控制字符/零宽清除 |

每层独立工作，互不依赖。即使某一层被绕过，其他层仍然提供保护。

### 5. 工具命名规范 — mcp__server__tool 实现统一调度

三段式命名（`mcp__<server>__<tool>`）看似简单，却解决了三个关键问题：

1. **前缀路由**：Agent 的 `if (name.startsWith("mcp__"))` 就能区分内置/外部工具
2. **名称唯一性**：不同服务器的同名工具不会冲突（`mcp__github__search` vs `mcp__jira__search`）
3. **反向解析**：从完整名称可以还原出 server 和 tool，用于路由到正确的连接

### 6. Elicitation 双模式 — Form + URL 覆盖不同场景

Form 模式适用于结构化数据收集（API Key、配置参数），URL 模式适用于需要浏览器的复杂交互（OAuth、第三方授权）。两种模式共用 hooks 管道，支持自动化和定制化。

### 7. 三层调用架构 — 关注点分离的典范

```
call()  → Session 级重试（连接问题）
kD1()   → Elicitation 级重试（交互问题）
jh7()   → RPC 级执行（调用问题）
```

每层只处理一种类型的异常，职责单一，逻辑清晰。增加新的重试逻辑只需在对应层添加，不影响其他层。

---

## 速查表

### 关键常量

| 常量 | 值 | 含义 |
|------|-----|------|
| 协议版本 M_H | (当前支持的版本列表) | Initialize 握手时声明 |
| 连续错误熔断阈值 | 3 次 | 连续 3 次错误后关闭连接 |
| URL Elicitation 最大重试 | 3 次 | -32042 错误最多重试 3 次 |
| Session expired 重试 | 1 次 | call() 入口层最多重试 1 次 |
| 工具缓存 TTL (XM) | 20 秒 | memoized with TTL 的过期时间 |
| stdio 关闭 SIGINT 后等待 | 50ms 轮询 | 检查子进程是否退出 |
| stdio 关闭 SIGTERM 后等待 | 500ms | 给进程退出的时间 |
| stdio spawn 配置 | shell: false | 不使用 shell（安全） |
| 进度日志间隔 (jh7) | 30 秒 | 长时间运行的工具调用输出进度 |
| clientInfo.name | "claude-code" | MCP 客户端标识 |
| clientInfo.version | "2.1.86" | 当前版本 |
| 搜索工具硬编码数量 | 200+ | oL7() SEARCH_TOOLS Set |
| 只读工具硬编码数量 | 500+ | oL7() READ_TOOLS Set |

### 关键函数索引

| 混淆名 | 推测英文名 | 文件:行号 | 功能 |
|--------|-----------|----------|------|
| `VzH()` | mergeAllConfigs | 12_computer_use.js | 6 层配置合并主逻辑 |
| `KqH()` | isEnterpriseExclusive | 12_computer_use.js | 判断企业独占模式 |
| `pY()` | getConfigByScope | 12_computer_use.js | 读取指定层级的配置 |
| `WS_()` | getApprovalStatus | 12_computer_use.js | 项目级 MCP 服务器审批状态 |
| `QA1()` | expandEnvVars | 12_computer_use.js | 配置中 ${VAR} 环境变量展开 |
| `aLH()` | replaceEnvVar | 12_computer_use.js | 单个环境变量替换 |
| `hzH()` | fetchClaudeAiServers | 12_computer_use.js | 从 claude.ai 拉取远程 MCP 服务器 |
| `sp6` | StdioTransport | 11_api_streaming.js:~27259 | stdio 传输实现 |
| `SFH` | ReadBuffer | 11_api_streaming.js | stdio 消息帧解析（JSON + \n） |
| `P0_` | serializeMessage | 11_api_streaming.js | 消息序列化 (JSON.stringify + \n) |
| `nV_` | SseTransport | 11_api_streaming.js:~27050 | SSE 传输实现 |
| `rV_` | StreamableHttpTransport | 11_api_streaming.js:~27378 | Streamable HTTP 传输实现 |
| `fS_` | WebSocketTransport | 12_computer_use.js:~70 | WebSocket 传输实现 |
| `kC()` | createConnection | 12_computer_use.js:~11034 | 建立单个 MCP Server 连接（8 步） |
| `GkH()` | connectAllServers | 12_computer_use.js:~10404 | 批量并发连接所有服务器 |
| `IG()` | disconnect | 12_computer_use.js:~10325 | 断开连接并清理缓存 |
| `jr()` | restartServer | 12_computer_use.js:~10364 | 重启 MCP 服务器 |
| `EV_` | McpClient | 11_api_streaming.js:~25760 | MCP 客户端主类 |
| `_FH` | ProtocolBase | 11_api_streaming.js | JSON-RPC 2.0 协议基类 |
| `ME_()` | getTimeout | 11_api_streaming.js | 连接超时控制 (Promise.race) |
| `DR6` | InitializeResponseSchema | 11_api_streaming.js | Initialize 响应的 Zod Schema |
| `Lu` | JsonRpcMessageSchema | 11_api_streaming.js | JSON-RPC 消息验证 Schema |
| `uy()` | getTools | 12_computer_use.js:~11480 | 工具发现 (tools/list) |
| `e8H()` | sanitizeUnicode | 12_computer_use.js | 递归 Unicode 清理（对象级） |
| `EuH()` | buildToolName | 12_computer_use.js | 构建 mcp__server__tool 名称 |
| `Mf()` | normalizeName | 12_computer_use.js | 名称规范化 [^a-zA-Z0-9_-]→_ |
| `QR()` | parseToolName | 12_computer_use.js | 反向解析工具名 → server + tool |
| `kD1()` | callWithElicitation | 12_computer_use.js | 工具调用 Layer 2: Elicitation 处理 |
| `jh7()` | callToolCore | 12_computer_use.js | 工具调用 Layer 3: 实际 RPC 调用 |
| `zD1()` | callTimeout | 12_computer_use.js | 工具调用超时控制 |
| `LD1()` | processToolResult | 12_computer_use.js | 工具结果内容类型处理 |
| `oL7()` | classifyTool | 12_computer_use.js | 工具搜索/只读分类（硬编码表） |
| `gzH()` | getPrompts | 12_computer_use.js:~11648 | Prompt 发现 (prompts/list) |
| `QR7()` | buildArgMap | 12_computer_use.js | Prompt 参数位置→命名映射 |
| `_r()` | getResources | 12_computer_use.js:~11633 | Resource 发现 (resources/list) |
| `Hr`/`VrH` | ListMcpResourcesTool | 12_computer_use.js | 列出 MCP 资源的自动注入工具 |
| `$r` | ReadMcpResourceTool | 12_computer_use.js | 读取 MCP 资源的自动注入工具 |
| `ZL7()` | registerElicitationHandler | 12_computer_use.js:~279 | 注册 Elicitation 处理器 |
| `dL7()` | isDenied | 12_computer_use.js | 企业黑名单检查 |
| `eLH()` | isAllowed | 12_computer_use.js | 企业白名单检查（deny 优先） |
| `EG()` | isDisabled | 12_computer_use.js | 服务器禁用状态检查 |
| `kB6()` | sanitizeUnicodeString | 12_computer_use.js | 单字符串 Unicode 清理 |
| `XIq()` | fetchOfficialRegistry | 12_computer_use.js | 获取 MCP 官方注册表 |
| `WIq()` | isOfficialServer | 12_computer_use.js | 判断是否为官方认证服务器 |
| `FLH()` | getOrCreateConnection | 12_computer_use.js | 获取或创建服务器连接 |
| `$6` | memoize | (utility) | 函数级缓存（连接复用） |
| `XM` | memoizedWithTTL | (utility) | 带 TTL 的函数级缓存 |

### 配置来源优先级表

| 优先级 | 来源 | 配置文件位置 | 是否需要审批 | 特殊行为 |
|--------|------|-------------|-------------|---------|
| 1 (最高) | Enterprise | 管理员分发 | 否 | 可启用独占模式 |
| 2 | Local | .claude/local-settings.json | 否 | 不进版本控制 |
| 3 | Project | .mcp.json (目录遍历) | 是 (WS_) | 深层覆盖浅层 |
| 4 | User | ~/.claude/settings.json | 否 | 全局配置 |
| 5 | Dynamic | 运行时 API | 否 | 临时生效 |
| 6 (最低) | claude.ai | OAuth + v1/mcp_servers | 否 | 通过代理中转 |

### 传输类型对比表

| 传输类型 | 实现类 | Schema | 连接方式 | Session | 适用场景 |
|---------|--------|--------|---------|---------|---------|
| stdio | sp6 | G96 | 进程管道 | 否 | 本地工具 |
| SSE | nV_ | xz$ | GET 长连接 + POST | 否 | 远程服务（旧版） |
| HTTP | rV_ | Bz$ | POST (JSON/SSE) | 是 | 远程服务（推荐） |
| WebSocket | fS_ | gz$ | 全双工 WS | 否 | 实时推送 |
| SSE-IDE | nV_ | mz$ | 同 SSE | 否 | IDE 集成 |
| WS-IDE | fS_ | pz$ | 同 WebSocket | 否 | IDE 集成 |
| claudeai-proxy | rV_ | cz$ | HTTP via 代理 | 是 | claude.ai 服务器 |

### JSON-RPC 消息类型

| 类型 | 有 id | 有 method | 有 result/error | 方向 |
|------|-------|----------|----------------|------|
| 请求 | 是 | 是 | 否 | 双向 |
| 响应 | 是 | 否 | 是 | 双向 |
| 通知 | 否 | 是 | 否 | 双向 |
