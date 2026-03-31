
# 第 5 章：API Client 与流式传输 — Agent 的通信管线

> **核心问题**：一个 Coding Agent 如何在支持 4 种云端 Provider、应对网络抖动和速率限制的同时，让用户实时看到 AI 的输出？

对于一个 Coding Agent 来说，与 LLM 的通信链路就是它的"神经中枢"。如果 HTTP 调用失败，Agent 就瘫痪了；如果流式传输卡顿，用户体验就崩溃了；如果 Token 计量不准，成本就失控了。

Claude Code 为此构建了一套**多 Provider、流式优先、自动重试**的 API 通信层。本章将从 HTTP 客户端构造开始，沿着请求的完整生命周期——路由选择、流式解码、错误重试、Token 计量——逐层拆解这套系统的设计与实现。

---

## 5.1 概述：为什么 API Client 是 Agent 的生命线

API Client 是 Claude Code 与大模型之间的唯一通道。它不是一个简单的 HTTP 封装，而是一套完整的通信基础设施：

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Claude Code 应用层                          │
│    主查询 (av)  │  副查询 (Ev)  │  内存提取  │  自动紧凑           │
└────────┬────────┴───────┬───────┴─────┬──────┴──────┬──────────────┘
         │                │             │              │
         v                v             v              v
┌─────────────────────────────────────────────────────────────────────┐
│                    dh() (createClient) — 客户端工厂函数             │
│    ┌──────────────┬──────────────┬──────────────┬─────────────┐     │
│    │  firstParty  │   bedrock    │   vertex     │  foundry    │     │
│    │  AO (原生)   │ AnthropicBR  │ AnthropicVX  │ AnthropicFD │     │
│    │  x-api-key   │  AWS SigV4   │  GoogleAuth  │  AzureAD    │     │
│    └──────┬───────┴──────┬───────┴──────┬───────┴──────┬──────┘     │
└───────────┼──────────────┼──────────────┼──────────────┼────────────┘
            │              │              │              │
            v              v              v              v
┌─────────────────────────────────────────────────────────────────────┐
│                   Anthropic TypeScript SDK                          │
│   AO (BaseClient)                                                  │
│   ├─ makeRequest()   -> 构建 HTTP 请求                             │
│   ├─ shouldRetry()   -> 重试判断 (408/409/429/5xx)                 │
│   ├─ retryRequest()  -> 指数退避重试                               │
│   └─ buildHeaders()  -> 注入 anthropic-version / x-api-key / betas│
│                                                                     │
│   QbH (MessageStream)                                               │
│   ├─ _createMessage() -> stream: true                              │
│   ├─ SSE 事件分发     -> message_start / content_block_delta / ... │
│   └─ AsyncIterator    -> for await (const event of stream)         │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                v
                    ┌──────────────────┐
                    │  Anthropic API   │
                    │  /v1/messages    │
                    │  SSE Stream      │
                    └──────────────────┘
```

这套架构承担了五项核心职责：

| 职责 | 关键模块 | 解决的问题 |
|------|----------|-----------|
| **HTTP 通信** | `AO` (ApiClient) | 连接管理、超时控制、请求头构建 |
| **Provider 路由** | `N8()` (routeProvider) / `dh()` (createClient) | 4 种云端后端的透明切换 |
| **流式解码** | `m2H` (SseDecoder) / `QbH` (MessageStream) | SSE 字节流 -> 结构化事件 |
| **错误恢复** | `shouldRetry()` / `retryRequest()` | 3 层重试策略，优雅降级 |
| **Token 计量** | 5 维 usage 结构 | 精确追踪成本、触发自动紧凑 |

**小结**：API Client 不是一个独立模块，而是贯穿 Claude Code 所有功能的"血管系统"。理解它的设计，是理解整个 Agent 通信架构的基础。

---

## 5.2 HTTP 客户端核心：AO (ApiClient) 类

API Client 的基座是 `AO` 类——Anthropic TypeScript SDK 的核心 HTTP 客户端。它负责最底层的连接管理、请求构建和错误处理。理解 `AO` 就理解了所有 API 调用的基础设施。

### 5.2.1 构造函数 — 三个关键参数

```javascript
// 02_api_client.js:1339-1363
class AO {
    constructor({
        baseURL: H = nbH("ANTHROPIC_BASE_URL"),       // env: ANTHROPIC_BASE_URL
        apiKey: _ = nbH("ANTHROPIC_API_KEY") ?? null,  // env: ANTHROPIC_API_KEY
        authToken: q = nbH("ANTHROPIC_AUTH_TOKEN") ?? null,  // OAuth token
        ...$
    } = {}) {
        let K = {
            apiKey: _,
            authToken: q,
            ...$,
            baseURL: H || "https://api.anthropic.com"  // default base URL
        };
        this.baseURL = K.baseURL;
        this.timeout = K.timeout ?? pe_.DEFAULT_TIMEOUT;  // 600000ms (10 min)
        this.maxRetries = K.maxRetries ?? 2;               // default: retry 2 times
        this.apiKey = typeof _ === "string" ? _ : null;
        this.authToken = q;
    }
}
```

三个关键默认值揭示了设计意图：

- **baseURL = `https://api.anthropic.com`**：firstParty 是默认 Provider
- **timeout = 600000ms (10 分钟)**：LLM 生成可能很慢，超时必须足够长
- **maxRetries = 2**：默认重试 2 次，总共最多 3 次请求

### 5.2.2 错误类层级 — 每种 HTTP 状态码都有专用类

`AO` 注册了一套完整的错误类层级，覆盖了所有可能的 API 错误场景：

```javascript
// 02_api_client.js:1769-1782
AO.DEFAULT_TIMEOUT = 600000;
AO.AnthropicError = q7;              // base error class
AO.APIError = rq;                     // API error (with status code)
AO.APIConnectionError = zX;           // connection failed
AO.APIConnectionTimeoutError = up;     // connection timeout
AO.APIUserAbortError = FK;            // user cancelled (Ctrl+C)
AO.NotFoundError = W4H;               // 404
AO.ConflictError = wbH;               // 409
AO.RateLimitError = DbH;              // 429
AO.BadRequestError = AbH;             // 400
AO.AuthenticationError = X4H;         // 401
AO.InternalServerError = jbH;         // 500
AO.PermissionDeniedError = fbH;       // 403
AO.UnprocessableEntityError = YbH;    // 422
```

> **设计决策**：为什么不直接用 HTTP 状态码，而要创建这么多错误类？因为上层代码需要对不同错误做不同处理——429 需要退避重试，401 需要刷新 Token，400 需要报告给用户。类型化错误让上层可以用 `instanceof` 精确捕获，而不是到处写 `if (error.status === 429)`。

### 5.2.3 认证头注入 — 双模式认证

Claude Code 支持两种认证方式：API Key 和 OAuth Token。`authHeaders()` 方法将两者合并为统一的请求头：

```javascript
// 02_api_client.js:1394-1408
async authHeaders(H) {
    return W4([
        await this.apiKeyAuth(H),    // X-Api-Key header
        await this.bearerAuth(H)     // Authorization: Bearer header
    ]);
}

async apiKeyAuth(H) {
    if (this.apiKey == null) return;
    return W4([{ "X-Api-Key": this.apiKey }]);
}

async bearerAuth(H) {
    if (this.authToken == null) return;
    return W4([{ Authorization: `Bearer ${this.authToken}` }]);
}
```

认证验证确保至少有一种方式可用：

```javascript
// 02_api_client.js:1384-1392
validateHeaders({ values: H, nulls: _ }) {
    if (H.get("x-api-key") || H.get("authorization")) return;
    // ... fallback checks ...
    throw Error('Could not resolve authentication method. ' +
        'Expected either apiKey or authToken to be set.');
}
```

### 5.2.4 默认请求头 — 每个请求都携带的元数据

```javascript
// 02_api_client.js:1689-1712
async buildHeaders({ options: H, method: _, bodyHeaders: q, retryCount: $ }) {
    let O = W4([K, {
        Accept: "application/json",
        "User-Agent": this.getUserAgent(),
        "X-Stainless-Retry-Count": String($),           // current retry count
        ...H.timeout ? {
            "X-Stainless-Timeout": String(Math.trunc(H.timeout / 1000))
        } : {},
        "anthropic-version": "2023-06-01"                // API version
    },
    await this.authHeaders(H),
    this._options.defaultHeaders,
    q,
    H.headers
    ]);
    return this.validateHeaders(O), O.values;
}
```

注意 `X-Stainless-Retry-Count` 头——它告诉服务端"这是客户端的第几次重试"。这是一个双向协作的设计：服务端可以根据重试次数调整行为（例如优先处理多次重试的请求）。

**小结**：`AO` 是一个精心设计的 HTTP 基础设施层。它的错误类层级让上层能精确处理各种异常；双模式认证让 API Key 用户和 OAuth 用户使用相同的代码路径；默认请求头中的元数据实现了客户端-服务端的协作式通信。

---

## 5.3 多 Provider 路由：4 种后端的透明切换

Claude Code 不仅仅连接 Anthropic 官方 API。企业用户可能通过 AWS Bedrock、Google Vertex AI 或 Azure Foundry 访问 Claude 模型。这些 Provider 的 API 格式、认证方式、端点路径都不同，但 Claude Code 的业务层代码完全不需要感知这些差异——这就是 Provider 路由系统解决的问题。

### 5.3.1 Provider 类型判断 — `N8()` (routeProvider)

路由的起点是一个极其简洁的函数——通过环境变量决定使用哪个 Provider：

```javascript
// 06_permission_system.js:15428-15429
function N8() {   // routeProvider
    return lH(process.env.CLAUDE_CODE_USE_BEDROCK) ? "bedrock"
         : lH(process.env.CLAUDE_CODE_USE_VERTEX)  ? "vertex"
         : lH(process.env.CLAUDE_CODE_USE_FOUNDRY)  ? "foundry"
         : "firstParty";  // default
}
```

四种 Provider 的触发条件：

| Provider | 环境变量 | 认证方式 | API 端点 |
|----------|---------|---------|---------|
| `firstParty` | 默认（无需设置） | API Key / OAuth | `api.anthropic.com/v1/messages` |
| `bedrock` | `CLAUDE_CODE_USE_BEDROCK=1` | AWS SigV4 / Bearer Token | AWS Bedrock 端点 |
| `vertex` | `CLAUDE_CODE_USE_VERTEX=1` | Google Cloud Auth | `rawPredict` / `streamRawPredict` |
| `foundry` | `CLAUDE_CODE_USE_FOUNDRY=1` | Azure AD Token | Azure Foundry 端点 |

> **设计决策**：为什么用环境变量而不是配置文件来选择 Provider？因为 Provider 通常由部署环境决定——在 AWS 上部署就用 Bedrock，在 GCP 上就用 Vertex。环境变量是容器化部署中最自然的配置方式，不需要在代码仓库中维护敏感的 Provider 配置。

### 5.3.2 客户端工厂 — `dh()` (createClient)

`dh()` 是整个 API 层最关键的函数。它根据 Provider 类型创建对应的 SDK 客户端实例，内部封装了所有认证差异：

```javascript
// 07_crypto_encoding.js:13556-13676
async function dh({ apiKey: H, maxRetries: _, model: q,
                    fetchOverride: $, source: K }) {
    // 1. Common headers for ALL providers
    let f = {
        "x-app": "cli",
        "User-Agent": rS(),                  // "claude-code/2.1.86"
        "X-Claude-Code-Session-Id": v_(),     // session UUID
    };

    // 2. Common config
    let D = {
        defaultHeaders: f,
        maxRetries: _,
        timeout: parseInt(process.env.API_TIMEOUT_MS || String(600000), 10),
        dangerouslyAllowBrowser: true,
    };

    // 3. Provider-specific branching
    if (lH(process.env.CLAUDE_CODE_USE_BEDROCK)) {
        // --- Bedrock ---
        const { AnthropicBedrock: M } = await import("@anthropic-ai/bedrock-sdk");
        let P = { ...D, awsRegion: J };
        // ... AWS auth setup (SigV4 or Bearer Token) ...
        return new M(P);
    }

    if (lH(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
        // --- Azure Foundry ---
        const { AnthropicFoundry: M } = await import("@anthropic-ai/foundry-sdk");
        // ... Azure AD token provider setup ...
        return new M({ ...D, ...J && { azureADTokenProvider: J } });
    }

    if (lH(process.env.CLAUDE_CODE_USE_VERTEX)) {
        // --- Vertex AI ---
        const [{ AnthropicVertex: M }, { GoogleAuth: J }] = await Promise.all([...]);
        let R = new J({ scopes: ["...cloud-platform"] });
        return new M({ ...D, region: X$_(q), googleAuth: R });
    }

    // --- firstParty (default) ---
    let j = {
        apiKey: U8() ? null : H || _Z(),
        authToken: U8() ? t8()?.accessToken : undefined,
        ...D,
    };
    return new OI(j);   // OI extends AO
}
```

这段代码的核心设计模式是**工厂方法**：

```
              dh() (createClient)
                     |
        +------------+------------+-----------+
        |            |            |           |
   firstParty    bedrock      vertex      foundry
   (OI/AO)   (AnthropicBR) (AnthropicVX) (AnthropicFD)
        |            |            |           |
        +------------+------------+-----------+
                     |
             统一 SDK 接口:
           messages.create()
           beta.messages.create()
```

所有 Provider 返回的客户端都实现相同的 `messages.create()` 接口，上层代码无需关心底层差异。

### 5.3.3 Bedrock 认证 — 两种方式

```javascript
// 07_crypto_encoding.js:13610-13617
// Method 1: Direct Bearer Token
if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
    P.skipAuth = true;
    P.defaultHeaders = { ...P.defaultHeaders,
        Authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`
    };
}
// Method 2: Standard AWS STS credentials (SigV4 signing)
else {
    let X = await de();   // get AWS credentials
    P.awsAccessKey = X.accessKeyId;
    P.awsSecretKey = X.secretAccessKey;
    P.awsSessionToken = X.sessionToken;
}
```

### 5.3.4 Vertex 路径重写 — `rawPredict` 端点

Vertex AI 不使用标准的 `/v1/messages` 端点，需要重写请求路径：

```javascript
// 07_crypto_encoding.js:13521-13534
// Inside AnthropicVertex.buildRequest:
if (H.path === "/v1/messages" || H.path === "/v1/messages?beta=true") {
    let _ = H.body.model;
    delete H.body.model;   // model is part of the URL, not the body
    let $ = H.body.stream ?? false ? "streamRawPredict" : "rawPredict";
    H.path = `/projects/${this.projectId}/locations/${this.region}` +
             `/publishers/anthropic/models/${_}:${$}`;
}
```

这个路径重写清楚地展示了 Provider 差异的复杂度——同样是调用 Claude，Vertex 把模型名放在 URL 路径里，而 firstParty 放在 request body 里。

**小结**：Provider 路由系统的核心价值是**差异封装**。4 种 Provider 的认证方式（API Key / SigV4 / GoogleAuth / AzureAD）、端点格式、请求结构都不同，但通过工厂函数 `dh()` 统一封装后，Claude Code 的业务层只需调用 `messages.create()` 即可——完全不感知底层 Provider 的存在。

---

## 5.4 模型注册表：11 个模型 x 能力矩阵

Claude Code 需要知道每个模型的 ID 格式、支持哪些功能特性。这些信息通过**模型注册表**和**能力检测函数**来管理。理解这个子系统，才能理解 Agent 如何为不同模型适配行为。

### 5.4.1 四维模型 ID 映射

每个模型在 4 种 Provider 中有不同的 ID 格式：

```javascript
// 06_permission_system.js:15360-15425
const Of6 = {   // sonnet40
    firstParty: "claude-sonnet-4-20250514",
    bedrock:    "us.anthropic.claude-sonnet-4-20250514-v1:0",
    vertex:     "claude-sonnet-4@20250514",
    foundry:    "claude-sonnet-4"
};

const OPH = {   // opus46
    firstParty: "claude-opus-4-6",
    bedrock:    "us.anthropic.claude-opus-4-6-v1",
    vertex:     "claude-opus-4-6",
    foundry:    "claude-opus-4-6"
};

// Complete registry: 11 models
const ce = {
    haiku35: $f6,   haiku45: Kf6,
    sonnet35: qf6,  sonnet37: _f6,   sonnet40: Of6,
    sonnet45: Tf6,  sonnet46: wf6,
    opus40: zf6,    opus41: Af6,     opus45: ff6,    opus46: OPH
};
```

ID 格式差异一目了然：

| Provider | 格式示例 (Sonnet 4.0) | 特点 |
|----------|----------------------|------|
| firstParty | `claude-sonnet-4-20250514` | 带日期版本号 |
| bedrock | `us.anthropic.claude-sonnet-4-20250514-v1:0` | 带区域前缀 + 版本后缀 |
| vertex | `claude-sonnet-4@20250514` | `@` 分隔版本号 |
| foundry | `claude-sonnet-4` | 最简短名称 |

### 5.4.2 模型别名解析 — `s9()` (resolveModelAlias)

用户可以用简短的别名来指定模型，`s9()` 负责将别名解析为实际模型 ID：

```javascript
// 06_permission_system.js:21481-21502
function s9(H) {   // resolveModelAlias
    let K = H.trim().toLowerCase();
    switch (K) {
        case "sonnet":    return $Z();      // current default Sonnet
        case "haiku":     return NPH();     // current default Haiku
        case "opus":      return Ak();      // current default Opus
        case "opusplan":  return $Z();      // OpusPlan mode
        case "best":      return NKq();     // best available model
    }
    return H;   // pass through if not an alias
}
```

### 5.4.3 模型获取优先级链

模型选择有明确的优先级顺序：

```javascript
// 06_permission_system.js:21318-21333
function bS() {   // getModelSetting
    let H, _ = qI();                    // 1. CLI --model flag (highest priority)
    if (_ !== void 0) H = _;
    else {
        let q = X8() || {};
        H = process.env.ANTHROPIC_MODEL  // 2. environment variable
         || q.model                      // 3. settings.json "model" field
         || void 0;                      // 4. undefined -> use default
    }
    return H;
}

function X$() {   // getCurrentModelId
    let H = bS();
    if (H !== void 0) return s9(H);     // resolve alias
    return kX();                         // return default model ID
}
```

优先级图：

```
CLI --model   >   ANTHROPIC_MODEL env   >   settings.model   >   default
  (最高)                                                          (最低)
```

### 5.4.4 能力检测 — 运行时特性探测

不是所有模型都支持 Thinking、Adaptive Thinking 等特性。Claude Code 通过一组检测函数在运行时判断：

```javascript
// 09_data_processing.js:16291-16308
function ltq(H) {   // supportsThinking
    let q = M3(H), $ = N8();
    // Foundry and firstParty: everything except Claude 3.x supports thinking
    if ($ === "foundry" || $ === "firstParty") return !q.includes("claude-3-");
    // Bedrock/Vertex: only Sonnet 4+ and Opus 4+ support thinking
    return q.includes("sonnet-4") || q.includes("opus-4");
}

function JL_(H) {   // supportsAdaptiveThinking
    let q = M3(H);
    // Only the latest 4.6 models support adaptive thinking
    if (q.includes("opus-4-6") || q.includes("sonnet-4-6")) return true;
    let $ = N8();
    return $ === "firstParty" || $ === "foundry";
}
```

> **设计决策**：能力检测为什么同时依赖模型名和 Provider？因为相同的模型在不同 Provider 上可能有不同的功能支持。例如 Bedrock 上的某些 beta 特性可能还没有上线，而 firstParty 已经可用。这种双维度检测确保了功能使用的安全性。

### 5.4.5 Beta 标记系统 — 动态特性开关

Claude API 的很多新功能通过 `betas` 参数启用。`BJ_()` (buildBetas) 函数根据模型、Provider 和功能需求动态组装 beta 列表：

```javascript
// 07_crypto_encoding.js:14040-14066
const BJ_ = (H, _) => {   // buildBetas
    let q = [...ch(H)];
    if (fu() && (O || T)) q.push(cY_);        // context management beta
    if (K && m5H(H) && z) q.push(ae);          // structured output beta
    if ($ === "vertex" && CT4(H)) q.push(TY6); // Vertex-specific beta
    if ($ === "foundry") q.push(TY6);           // Foundry-specific beta
    if (K) q.push(vpH);                         // tool use beta
    // User-defined betas from environment variable
    if (process.env.ANTHROPIC_BETAS)
        q.push(...process.env.ANTHROPIC_BETAS.split(",").map(A => A.trim()));
    return q;
};

// Bedrock needs filtering — some betas are not supported
const ch = (H) => {   // getModelBetas
    let _ = yW6(H);
    if (N8() === "bedrock") return _.filter(q => !wY6.has(q));
    return _;
};
```

注意 Bedrock 的特殊处理——它通过 `wY6` 集合过滤掉不支持的 beta。这是一个实战中常见的问题：不同 Provider 对新特性的支持进度不一样，客户端必须主动适配。

**小结**：模型注册表解决了三个问题——(1) 4 种 Provider 的模型 ID 格式差异，(2) 用户友好的别名系统，(3) 运行时能力检测。这套系统让 Claude Code 能在多模型、多 Provider 的矩阵中正确选择和使用每一个模型。

---

## 5.5 SSE 双层架构

流式传输是 Claude Code 的默认通信模式——所有主查询都走 SSE 流式传输，只有轻量副查询才使用非流式请求。这套 SSE 系统分为两层：底层的字节流解码器和上层的语义事件管理器。理解这两层的分工，是理解 Claude Code 实时响应能力的关键。

### 5.5.1 底层：m2H (SseDecoder) — 字节流解码器

`m2H` 负责将 HTTP Response 的 `ReadableStream` 转换为结构化的 JSON 事件对象。它是流式传输的"译码器"：

```javascript
// 02_api_client.js:343-361
m2H = class m2H {   // SseDecoder
    constructor(H, _) {
        this.iterator = H;       // ReadableStream async iterator
        this.controller = _;     // AbortController (for cancellation)
    }

    async * decoder() {
        let H = new ls;          // SSE line decoder
        // Read chunks, decode into SSE event lines, parse JSON
        for await (let _ of this.iterator)
            for (let q of H.decode(_)) yield JSON.parse(q);
        // Flush remaining buffered data
        for (let _ of H.flush()) yield JSON.parse(_);
    }

    [Symbol.asyncIterator]() { return this.decoder(); }

    static fromResponse(H, _) {
        if (!H.body)
            throw new q7("Attempted to iterate over a response with no body");
        return new m2H(MbH(H.body), _);  // MbH: ReadableStream -> AsyncIterable
    }
}
```

数据流转过程：

```
HTTP Response Body (ReadableStream<Uint8Array>)
         |
         v  MbH() — ReadableStream -> AsyncIterable
AsyncIterable<Uint8Array>
         |
         v  ls.decode() — SSE line decoder
         |  (split by \n\n, extract "data:" field)
SSE event strings
         |
         v  JSON.parse()
Structured event objects
         |
         v  yield — async generator
for await (const event of decoder) { ... }
```

`ls` (SseLineDecoder) 在内部处理 SSE 协议的三个标准字段：

| 字段 | 含义 | 处理方式 |
|------|------|---------|
| `event:` | 事件类型 | 用于分发路由 |
| `data:` | 事件数据（JSON） | `JSON.parse()` 解析 |
| `retry:` | 重连间隔（毫秒） | 传递给重试逻辑 |

> **设计决策**：为什么用 `async *` 生成器而不是回调？因为生成器天然支持**背压控制**——消费者通过 `for await` 逐个消费事件，如果消费速度跟不上，生产者自动暂停。这避免了回调模式下事件积压导致内存暴涨的问题。

### 5.5.2 语义层：QbH (MessageStream) — 消息流管理器

`QbH` 建立在 `m2H` 之上，负责将原始 SSE 事件组装为完整的消息结构。它是流式传输的"语义理解层"：

```javascript
// 02_api_client.js:792-895
class QbH {   // MessageStream
    constructor(H, _) {
        this.messages = [];           // accumulated message params
        this.receivedMessages = [];   // completed messages
        this.controller = new AbortController();
    }

    // Create streaming message
    async _createMessage(H, _, q) {
        let { response: O, data: T } = await H.create({
            ..._,
            stream: true                // force streaming mode
        }, {
            ...q,
            signal: this.controller.signal
        }).withResponse();

        this._connected(O);            // mark connection established

        // Process SSE events one by one
        for await (let z of T)
            V6(this, nV, "m", Ce_).call(this, z);   // dispatch event

        V6(this, nV, "m", be_).call(this);           // mark stream end
    }
}
```

`QbH` 的 `AsyncIterator` 实现了一个精巧的生产者-消费者模式：

```javascript
// 02_api_client.js:841-882
[Symbol.asyncIterator]() {
    let H = [], _ = [], q = false;   // H: buffer, _: waiters, q: done

    this.on("streamEvent", ($) => {
        let K = _.shift();
        if (K) K.resolve($);       // waiter exists -> deliver directly
        else H.push($);            // no waiter -> buffer it
    });

    this.on("end", () => { q = true; /* resolve all waiters */ });
    this.on("error", ($) => { q = true; /* reject all waiters */ });

    return {
        next: async () => {
            if (!H.length) {
                if (q) return { value: undefined, done: true };
                // No buffered event -> create a Promise and wait
                return new Promise((K, O) => _.push({ resolve: K, reject: O }))
                    .then(K => K ? { value: K, done: false } : { done: true });
            }
            // Buffered event available -> return immediately
            return { value: H.shift(), done: false };
        },
        return: async () => { this.abort(); return { done: true }; }
    };
}
```

这个背压机制的工作方式：

```
情况 1: 消费者快于生产者（常见）
  Consumer calls next() -> no buffer -> creates Promise -> waits
  Producer emits event  -> finds waiter -> resolve(event) directly

情况 2: 生产者快于消费者（burst 场景）
  Producer emits event  -> no waiter -> push to buffer H[]
  Consumer calls next() -> buffer has data -> return H.shift()

情况 3: 流结束
  Producer emits "end"  -> q = true -> all waiters get { done: true }
  Consumer calls next() -> q = true -> return { done: true }
```

### 5.5.3 流式事件类型 — 完整生命周期

一次流式 API 调用产生的事件序列遵循严格的协议：

```
message_start          <-- message object init (model, usage, id)
  |
  +-- content_block_start  <-- content block begins (type: text / tool_use / thinking)
  |   |
  |   +-- content_block_delta (text_delta)        <-- text append
  |   +-- content_block_delta (input_json_delta)  <-- tool call JSON append
  |   +-- content_block_delta (thinking_delta)    <-- thinking text append
  |   +-- content_block_delta (signature_delta)   <-- thinking signature
  |   +-- content_block_delta (compaction_delta)  <-- context compaction
  |   |
  |   +-- content_block_stop  <-- content block ends
  |
  +-- content_block_start  <-- next content block...
  |   +-- ...
  |
  +-- message_delta     <-- final usage stats, stop_reason
      |
      +-- message_stop  <-- message complete
```

### 5.5.4 5 种 delta 类型的处理逻辑

事件分发函数 `Ce_()` 对 `content_block_delta` 事件按 delta 类型做不同处理：

```javascript
// 02_api_client.js:998-1025
case "content_block_delta": {
    let $ = q.content.at(_.index);   // locate content block by index

    switch (_.delta.type) {
        case "text_delta":
            // Append text to existing text block
            if ($?.type === "text") q.content[_.index] = {
                ...$, text: $.text + _.delta.text
            };
            break;

        case "input_json_delta":
            // Accumulate partial JSON for tool call arguments
            let K = ($ && bf8 in $ ? $[bf8] : "") + _.delta.partial_json;
            let O = { ...$ };
            if (K) try {
                O.input = b$_(K);   // try to parse accumulated JSON
            } catch (T) {
                // Parse failed: JSON not complete yet, keep accumulating
            }
            q.content[_.index] = O;
            break;

        case "thinking_delta":
            // Append thinking text
            if ($?.type === "thinking") q.content[_.index] = {
                ...$, thinking: $.thinking + _.delta.thinking
            };
            break;

        case "signature_delta":
            // Set cryptographic signature for thinking content
            if ($?.type === "thinking") q.content[_.index] = {
                ...$, signature: _.delta.signature
            };
            break;

        case "compaction_delta":
            // Accumulate context compaction summary
            if ($?.type === "compaction") q.content[_.index] = {
                ...$, content: ($.content || "") + _.delta.content
            };
            break;
    }
}
```

五种 delta 类型的对比：

| delta 类型 | 累积方式 | 数据完整性检查 | 用途 |
|-----------|---------|--------------|------|
| `text_delta` | 字符串拼接 | 无（追加即可） | 模型输出的文本 |
| `input_json_delta` | JSON 片段拼接 + 尝试解析 | `try { JSON.parse() }` | 工具调用参数 |
| `thinking_delta` | 字符串拼接 | 无 | 模型的思考过程 |
| `signature_delta` | 直接覆盖 | 无 | 思考内容的加密签名 |
| `compaction_delta` | 字符串拼接 | 无 | 长对话压缩摘要 |

> **设计决策**：`input_json_delta` 为什么要在每个 delta 到达时尝试 `JSON.parse()`？因为工具调用的参数需要尽早可用。每次新的 JSON 片段到达时尝试解析，如果成功就立即更新 `input` 字段，上层可以提前展示工具调用参数的预览。解析失败只是说明 JSON 还不完整，不是错误——静默 catch 继续累积即可。

### 5.5.5 `compaction_delta` — Claude Code 的独特扩展

`compaction_delta` 是其他 LLM SDK 中看不到的事件类型。当对话超出 Token 阈值（默认 100K）时，Claude Code 触发自动紧凑，服务端返回压缩后的对话摘要：

```javascript
// 02_api_client.js:213-224
Bf8 = async function() {   // shouldCompact
    let _ = V6(this, jM, "f").params.compactionControl;
    if (!_ || !_.enabled) return false;
    let q = 0;
    if (V6(this, Oh, "f") !== void 0) try {
        let A = await V6(this, Oh, "f");
        // Total tokens = input + cache_creation + cache_read + output
        q = A.usage.input_tokens
          + (A.usage.cache_creation_input_tokens ?? 0)
          + (A.usage.cache_read_input_tokens ?? 0)
          + A.usage.output_tokens;
    } catch { return false; }
    let $ = _.contextTokenThreshold ?? 100000;  // default threshold: 100K
    if (q < $) return false;
    // Threshold exceeded -> trigger context compaction
    ...
};
```

这是 Claude Code 能进行超长编程会话的关键技术——当上下文膨胀到快要超出模型窗口时，不是粗暴地截断历史，而是通过 API 请求服务端生成压缩摘要，用 `compaction_delta` 流式返回。

**小结**：SSE 双层架构的设计精妙之处在于**关注点分离**——`m2H` 只关心"字节流怎么变成 JSON"，`QbH` 只关心"JSON 事件怎么组装成消息"。底层用 `async *` 生成器实现背压控制，上层用 Promise 队列实现生产者-消费者协作。5 种 delta 类型覆盖了从文本输出到上下文紧凑的所有场景。

---

## 5.6 重试策略：3 层指数退避 + 抖动 + overloaded 特殊处理

网络调用不可能永远成功。API 可能限速、服务器可能过载、连接可能超时。Claude Code 的重试系统不是简单的"失败了就再试一次"，而是一套三层防线，确保在各种故障场景下都能优雅恢复。

### 5.6.1 第一层：`shouldRetry()` — 重试决策

```javascript
// 02_api_client.js:1605-1613
async shouldRetry(H) {
    let _ = H.headers.get("x-should-retry");
    if (_ === "true") return true;       // server says: please retry
    if (_ === "false") return false;     // server says: don't retry
    if (H.status === 408) return true;   // Request Timeout
    if (H.status === 409) return true;   // Conflict
    if (H.status === 429) return true;   // Rate Limit
    if (H.status >= 500) return true;    // all 5xx server errors
    return false;
}
```

三层判断逻辑清晰：

```
Layer 1: x-should-retry header  -- server has final say
         |
         v (header not present)
Layer 2: HTTP status code       -- 408/409/429/5xx -> retry
         |
         v (other status codes)
Layer 3: default                -- don't retry (e.g., 400/401/403)
```

> **设计决策**：为什么服务端的 `x-should-retry` 头有最高优先级？因为只有服务端知道错误的真实原因。例如，一个 429 可能是因为全局限速（应该重试），也可能是因为账户配额用尽（重试无意义）。通过这个头，服务端可以覆盖客户端的默认行为。

### 5.6.2 第二层：`retryRequest()` — 退避执行

```javascript
// 02_api_client.js:1615-1631
async retryRequest(H, _, q, $) {
    let K;

    // Priority 1: Retry-After-Ms header (millisecond precision)
    let O = $?.get("retry-after-ms");
    if (O) {
        let z = parseFloat(O);
        if (!Number.isNaN(z)) K = z;
    }

    // Priority 2: Retry-After header (second precision or HTTP-date)
    let T = $?.get("retry-after");
    if (T && !K) {
        let z = parseFloat(T);
        if (!Number.isNaN(z)) K = z * 1000;     // seconds -> ms
        else K = Date.parse(T) - Date.now();      // HTTP-date format
    }

    // Priority 3: calculated exponential backoff (if no server hint,
    //             or server hint > 60s)
    if (!(K && 0 <= K && K < 60000)) {
        K = this.calculateDefaultRetryTimeoutMillis(_, H.maxRetries ?? this.maxRetries);
    }

    await Tf8(K);                                // sleep
    return this.makeRequest(H, _ - 1, q);        // recursive retry
}
```

退避时间的优先级：

```
Retry-After-Ms (ms precision)  >  Retry-After (s precision)  >  exponential backoff
     最精确                           标准                          兜底
```

### 5.6.3 第三层：指数退避算法 — 带抖动

```javascript
// 02_api_client.js:1633-1637
calculateDefaultRetryTimeoutMillis(H, _) {
    let K = _ - H;                              // current retry index
    let O = Math.min(0.5 * Math.pow(2, K), 8);  // exponential: 0.5, 1, 2, 4, 8 (capped)
    let T = 1 - Math.random() * 0.25;           // jitter: 0.75 ~ 1.0
    return O * T * 1000;                         // to milliseconds
}
```

默认 `maxRetries=2` 时的退避时间表：

| 重试次数 | 基础延迟 | 加抖动后范围 | 说明 |
|---------|---------|------------|------|
| 第 1 次 | 0.5s | 375ms ~ 500ms | 快速首次重试 |
| 第 2 次 | 1.0s | 750ms ~ 1000ms | 稍长等待 |

> **设计决策**：为什么抖动因子是 `1 - random * 0.25`（即 0.75~1.0）而不是常见的 `random`（0~1）？因为 Claude Code 希望重试延迟是**可预测的下界**——至少等 75% 的基础延迟。全随机抖动可能产生接近 0 的延迟，对于 API 限速恢复来说太激进了。这种"温和抖动"在避免惊群效应的同时保证了最低退避时间。

### 5.6.4 连接失败的重试

HTTP 请求可能在连接阶段就失败（DNS 解析失败、TCP 连接超时等），这类错误需要单独处理：

```javascript
// 02_api_client.js:1501-1519
if (D instanceof globalThis.Error) {
    // Check if it's a timeout
    let X = oU(D) || /timed? ?out/i.test(
        String(D) + ("cause" in D ? String(D.cause) : "")
    );
    if (_) {  // retries remaining
        return this.retryRequest($, _, q ?? A);
    }
    // No retries left
    if (X) throw new up;     // APIConnectionTimeoutError
    throw new zX({ cause: D });  // APIConnectionError
}
```

### 5.6.5 非流式超时保护

对于可能生成大量 Token 的请求，Claude Code 强制要求使用流式模式：

```javascript
// 02_api_client.js:1639-1641
calculateNonstreamingTimeout(H, _) {
    // If max_tokens / 128000 * 3600000 > 600000 (i.e., generation may exceed 10 min)
    if (3600000 * H / 128000 > 600000 || _ != null && H > _)
        throw new q7(
            "Streaming is required for operations that may take longer than 10 minutes."
        );
    return 600000;
}
```

这个公式的含义：如果按模型最大生成速度（128K tokens/hour）计算，生成 `max_tokens` 个 token 需要超过 10 分钟，就强制报错。这避免了非流式请求因为生成时间过长而超时——流式请求没有这个问题，因为数据是逐块到达的。

**小结**：重试系统的三层防线各司其职——`shouldRetry()` 决定"该不该重试"，`retryRequest()` 决定"等多久再试"，指数退避+抖动算法提供合理的兜底延迟。服务端通过 `x-should-retry` 和 `Retry-After` 头拥有最终决定权，客户端有合理的默认行为。这种服务端-客户端协作式的设计，是高可用 API 通信的典范。

---

## 5.7 Token 追踪：5 维计量

准确的 Token 计量是 Agent 成本控制的基础。Claude Code 不是简单地记录"输入多少、输出多少"，而是追踪 5 个维度的 Token 用量——这种精细化计量直接驱动了自动紧凑、缓存优化等关键决策。

### 5.7.1 用量数据结构 — 5 维 + 2 层缓存

```javascript
// 14_html_parser.js:26988-27007
{
    input_tokens: 0,                       // direct input tokens
    cache_creation_input_tokens: 0,        // tokens used to create cache
    cache_read_input_tokens: 0,            // tokens read from cache (hit)
    output_tokens: 0,                      // model output tokens
    server_tool_use: {                     // server-side tool usage
        web_search_requests: 0,
        web_fetch_requests: 0
    },
    service_tier: "standard",
    cache_creation: {
        ephemeral_1h_input_tokens: 0,      // 1-hour cache creation tokens
        ephemeral_5m_input_tokens: 0       // 5-minute cache creation tokens
    },
    inference_geo: "",
    iterations: [],
    speed: "standard"
}
```

5 维计量矩阵：

```
                     ┌─────────────────────────────────────────┐
                     │            Token 计量维度                │
                     ├──────────────────────┬──────────────────┤
                     │      Input 侧       │    Output 侧     │
                     ├──────────────────────┼──────────────────┤
  直接 Token         │  input_tokens        │  output_tokens   │
                     ├──────────────────────┤                  │
  缓存创建           │  cache_creation_     │                  │
                     │  input_tokens        │                  │
                     ├──────────────────────┤                  │
  缓存命中           │  cache_read_         │                  │
                     │  input_tokens        │                  │
                     ├──────────────────────┤                  │
  服务端工具         │                      │  server_tool_use │
                     │                      │  (web_search /   │
                     │                      │   web_fetch)     │
                     └──────────────────────┴──────────────────┘
```

### 5.7.2 流式事件中的用量更新

`message_delta` 事件携带最新的用量统计，每次到达时更新消息对象：

```javascript
// 02_api_client.js:1061-1065
case "message_delta":
    q.usage.output_tokens = _.usage.output_tokens;
    if (_.usage.input_tokens != null)
        q.usage.input_tokens = _.usage.input_tokens;
    if (_.usage.cache_creation_input_tokens != null)
        q.usage.cache_creation_input_tokens = _.usage.cache_creation_input_tokens;
    if (_.usage.cache_read_input_tokens != null)
        q.usage.cache_read_input_tokens = _.usage.cache_read_input_tokens;
    if (_.usage.server_tool_use != null)
        q.usage.server_tool_use = _.usage.server_tool_use;
```

注意所有字段都用 `!= null` 检查——只有服务端实际返回了该字段才更新。这避免了用 `undefined` 覆盖已有数据。

### 5.7.3 缓存命中率计算

Claude Code 实时计算并展示缓存命中率，帮助用户了解 Prompt Caching 的效果：

```javascript
// 14_html_parser.js:25744-25746
let v = R.totalUsage.input_tokens
      + R.totalUsage.cache_creation_input_tokens
      + R.totalUsage.cache_read_input_tokens;
let y = v > 0
    ? (R.totalUsage.cache_read_input_tokens / v * 100).toFixed(1)
    : "0.0";
// Output: cache: read=12345 create=6789 input=1000 (92.3% hit)
```

计算公式：

```
               cache_read_input_tokens
hit_rate = ────────────────────────────────────────────────── x 100%
           input_tokens + cache_creation_tokens + cache_read_tokens
```

### 5.7.4 两层缓存时间窗口

Claude Code 的 Prompt Caching 支持两种时效：

| 缓存类型 | TTL | 用途 | 成本 |
|---------|-----|------|------|
| `ephemeral_5m` | 5 分钟 | 短期对话缓存 | 较低 |
| `ephemeral_1h` | 1 小时 | 系统提示等稳定内容 | 较高 |

```javascript
// 标记内容为可缓存
messages: [{
    role: "user",
    content: [{
        type: "text",
        text: "Hi",
        cache_control: { type: "ephemeral" }   // mark as cacheable
    }]
}]
```

1 小时缓存有资格控制：

```javascript
// 01_runtime_bootstrap.js:2907-2920
function yt_()  { return G_.promptCache1hAllowlist; }   // get allowlist
function St_()  { return G_.promptCache1hEligible; }     // check eligibility
```

### 5.7.5 用量遥测上报

每次 API 调用完成后，用量数据会被上报到遥测系统：

```javascript
// 17_system_prompt_full.js:5644-5654
Q("tengu_api_success", {
    requestId: E,
    querySource: H.querySource,
    model: k,
    inputTokens: y.usage.input_tokens,
    outputTokens: y.usage.output_tokens,
    cachedInputTokens: y.usage.cache_read_input_tokens ?? 0,
    uncachedInputTokens: y.usage.cache_creation_input_tokens ?? 0,
    durationMsIncludingRetries: S - v,
    timeSinceLastApiCallMs: x !== null ? S - x : void 0
});
```

注意 `durationMsIncludingRetries` 字段——它记录的是包含所有重试在内的总耗时。这对于监控 API 可用性和诊断性能问题至关重要。

### 5.7.6 Token 计量驱动的自动紧凑

Token 计量不仅用于成本追踪，还直接驱动了 Claude Code 的**自动紧凑**机制。当累计 Token 超过阈值时触发上下文压缩：

```javascript
// Total token calculation for compaction threshold check
q = A.usage.input_tokens
  + (A.usage.cache_creation_input_tokens ?? 0)
  + (A.usage.cache_read_input_tokens ?? 0)
  + A.usage.output_tokens;

let $ = _.contextTokenThreshold ?? 100000;  // default: 100K tokens
if (q < $) return false;  // not yet -> don't compact
// Exceeded -> trigger compaction
```

这里的阈值计算包含了所有 4 种 Token 类型（input + cache_creation + cache_read + output），因为它们都占用上下文窗口的空间。

**小结**：5 维 Token 计量是 Claude Code 成本控制和智能决策的基础。`cache_read` vs `cache_creation` 的区分让用户能直观看到 Prompt Caching 的投入产出比；`server_tool_use` 的独立计量支持 Web 搜索等服务端工具的成本追踪；累计 Token 数驱动自动紧凑，确保超长会话不会溢出上下文窗口。

---

## 5.8 设计启示

本章解析了 Claude Code API 通信层的完整架构。以下提炼出可迁移到任何 Agent 项目的工程经验：

### 1. 多 Provider 适配的工厂模式

Claude Code 的 `dh()` (createClient) 是一个教科书级的工厂模式：

- **统一接口**：所有 Provider 返回相同的 SDK 接口（`messages.create()` / `.stream()`）
- **差异封装**：Bedrock 的 SigV4 签名、Vertex 的 `rawPredict` 路径重写、Foundry 的 Azure AD Token——全部在工厂内部处理
- **环境变量驱动**：Provider 切换不需要改代码，只需设置环境变量

**可迁移经验**：如果你的 Agent 需要支持多个 LLM 后端（OpenAI / Anthropic / 本地模型），不要在业务层做 `if-else`，而是在客户端创建层用工厂模式封装差异。业务代码只调用统一接口，完全不感知 Provider。

### 2. 流式传输的分层设计

SSE 处理被分为两个独立的层次：

```
字节层 (m2H/SseDecoder):  bytes -> JSON events    (transport concern)
语义层 (QbH/MessageStream): events -> messages     (domain concern)
```

**可迁移经验**：流式处理应该分层——底层只关心协议解码，上层只关心业务语义。这样当底层传输协议变化时（比如从 SSE 切换到 WebSocket），上层代码完全不需要改。

### 3. 背压控制的 Promise 队列

`QbH` 的 AsyncIterator 实现了一个优雅的背压机制：

```
Producer (SSE events) -> Buffer H[] <-> Consumer (Promise waiters _[])
```

- 消费者快于生产者 → Promise 等待
- 生产者快于消费者 → 缓冲队列堆积
- 错误/结束 → 传播到所有等待者

**可迁移经验**：任何涉及流式数据的场景都应该考虑背压。`async *` 生成器和 Promise 队列是 JavaScript 中最轻量的背压实现方式。

### 4. 服务端-客户端协作式重试

重试决策不是客户端单方面做的：

```
服务端: x-should-retry 头          -> 最终裁决权
服务端: Retry-After / Retry-After-Ms -> 退避时间建议
客户端: HTTP 状态码判断              -> 默认策略
客户端: 指数退避 + 抖动              -> 兜底延迟
```

**可迁移经验**：重试策略应该是双向协作的。给服务端留一个"推翻客户端判断"的通道（如 `x-should-retry` 头），同时客户端有合理的独立判断能力。

### 5. 精细化 Token 计量驱动智能决策

Claude Code 的 5 维 Token 计量不仅用于计费，还驱动了：

- **自动紧凑**：累计 Token > 100K → 触发上下文压缩
- **缓存优化**：命中率监控 → 调整 cache_control 策略
- **性能诊断**：`durationMsIncludingRetries` → 发现重试导致的延迟

**可迁移经验**：Token 计量不是事后统计，而是运行时决策的数据源。设计计量系统时，要想好"这个数据将驱动什么决策"，然后反向设计需要采集的维度。

### 6. compaction_delta — 超长会话的生存策略

`compaction_delta` 是 Claude Code 独有的流式事件类型，用于在上下文膨胀时由服务端返回压缩摘要。这是 Claude Code 能进行数小时编程会话的关键技术。

**可迁移经验**：如果你的 Agent 需要支持长对话，不要只靠"截断旧消息"。考虑实现自动摘要/压缩机制，在保留关键上下文的同时控制 Token 用量。

---

## 速查表

### 核心类与函数

| 混淆名 | 推测英文名 | 文件:行号 | 功能 |
|--------|-----------|----------|------|
| `AO` | ApiClient | `02_api_client.js:1339` | HTTP 客户端基类，管理连接、超时、认证 |
| `OI` | ExtendedApiClient | `07_crypto_encoding.js:13670` | AO 子类，firstParty 专用客户端 |
| `m2H` | SseDecoder | `02_api_client.js:343` | SSE 字节流解码器，bytes -> JSON events |
| `ls` | SseLineDecoder | `02_api_client.js:300` | SSE 行解码器，按 `\n\n` 分隔事件 |
| `QbH` | MessageStream | `02_api_client.js:792` | 消息流管理器，events -> messages |
| `Ce_` | dispatchStreamEvent | `02_api_client.js:924` | 流式事件分发函数 |
| `Qf8` | updateMessageState | `02_api_client.js:1051` | 流式状态更新（message_start/delta/stop） |
| `Bf8` | shouldCompact | `02_api_client.js:213` | 判断是否需要触发上下文紧凑 |

### 路由与工厂

| 混淆名 | 推测英文名 | 文件:行号 | 功能 |
|--------|-----------|----------|------|
| `N8` | routeProvider | `06_permission_system.js:15428` | 根据环境变量判断 Provider 类型 |
| `Fe` | getProvider | `06_permission_system.js:15429` | N8 的别名 |
| `dh` | createClient | `07_crypto_encoding.js:13556` | 客户端工厂，按 Provider 创建 SDK 实例 |
| `lH` | isTruthy | `06_permission_system.js:15427` | 环境变量真值检查 |
| `BJ_` | buildBetas | `07_crypto_encoding.js:14040` | 动态组装 beta 标记列表 |
| `ch` | getModelBetas | `07_crypto_encoding.js:14070` | 获取模型支持的 beta（含 Bedrock 过滤） |

### 模型注册与解析

| 混淆名 | 推测英文名 | 文件:行号 | 功能 |
|--------|-----------|----------|------|
| `ce` | modelRegistry | `06_permission_system.js:15390` | 完整模型注册表（11 个模型） |
| `s9` | resolveModelAlias | `06_permission_system.js:21481` | 模型别名解析（sonnet/opus/haiku/best） |
| `bS` | getModelSetting | `06_permission_system.js:21318` | 获取模型配置（CLI > env > settings > default） |
| `X$` | getCurrentModelId | `06_permission_system.js:21329` | 获取当前使用的模型 ID |
| `M3` | getCanonicalModelName | `06_permission_system.js:21397` | 获取规范化模型名 |
| `vX` | cleanModelName | `06_permission_system.js:21545` | 清理模型名中的 `[1m]` 标记 |
| `B1` | getProviderModelMap | `06_permission_system.js:15507` | 获取当前 Provider 的模型映射表 |
| `ltq` | supportsThinking | `09_data_processing.js:16291` | 检测模型是否支持 Thinking |
| `JL_` | supportsAdaptiveThinking | `09_data_processing.js:16300` | 检测模型是否支持 Adaptive Thinking |

### 请求与重试

| 混淆名 | 推测英文名 | 文件:行号 | 功能 |
|--------|-----------|----------|------|
| `Ev` | sideQuery | `17_system_prompt_full.js:5555` | 非流式 API 查询（副查询） |
| `shouldRetry` | shouldRetry | `02_api_client.js:1605` | 重试决策（x-should-retry > 状态码） |
| `retryRequest` | retryRequest | `02_api_client.js:1615` | 执行重试（Retry-After > 指数退避） |
| `calculateDefaultRetryTimeoutMillis` | calcRetryTimeout | `02_api_client.js:1633` | 指数退避算法（0.5*2^n，上限 8s，抖动 0.75~1.0） |
| `calculateNonstreamingTimeout` | calcNonStreamTimeout | `02_api_client.js:1639` | 非流式超时保护（强制 <10min） |
| `Tf8` | sleep | `02_api_client.js:1630` | 异步等待（用于退避延迟） |

### 错误类层级

| 混淆名 | 推测英文名 | HTTP 状态码 | 是否自动重试 |
|--------|-----------|------------|------------|
| `q7` | AnthropicError | — | 基础错误类 |
| `rq` | APIError | 带 status | 取决于状态码 |
| `zX` | APIConnectionError | — | 是 |
| `up` | APIConnectionTimeoutError | — | 是 |
| `FK` | APIUserAbortError | — | 否 |
| `AbH` | BadRequestError | 400 | 否 |
| `X4H` | AuthenticationError | 401 | 否 |
| `fbH` | PermissionDeniedError | 403 | 否 |
| `W4H` | NotFoundError | 404 | 否 |
| `wbH` | ConflictError | 409 | 是 |
| `YbH` | UnprocessableEntityError | 422 | 否 |
| `DbH` | RateLimitError | 429 | 是 |
| `jbH` | InternalServerError | 500 | 是 |

### 认证相关

| 混淆名 | 推测英文名 | 文件:行号 | 功能 |
|--------|-----------|----------|------|
| `U8` | isOAuthUser | `06_permission_system.js:15720` | 判断是否为 OAuth 登录用户 |
| `t8` | getOAuthToken | `06_permission_system.js:15722` | 获取 OAuth access token |
| `_Z` | getApiKey | `07_crypto_encoding.js:13668` | 获取 API Key（env 或 helper） |
| `de` | getAwsCredentials | `07_crypto_encoding.js:13610` | 获取 AWS STS 凭证 |
| `yW8` | oauthEndpoints | `04_git_operations.js:9510` | OAuth URL 端点配置 |

### 关键常量

| 值 | 含义 |
|----|------|
| `600000` (10 min) | 默认 HTTP 超时 |
| `2` | 默认最大重试次数 |
| `100000` (100K tokens) | 默认上下文紧凑阈值 |
| `"2023-06-01"` | API 版本号 (`anthropic-version`) |
| `60000` (60s) | Retry-After 上限，超过则用默认退避 |
| `8` (s) | 指数退避上限 |
| `0.25` | 抖动系数（延迟 * [0.75, 1.0]） |
