
# 第 14 章：Browser 自动化与 MCP 协议

## 两种外部世界的接口

Agent 和外部世界的交互有两种范式：**行动式**（Agent 操作一个真实的浏览器——点击、输入、滚动）和**协议式**（Agent 通过标准化协议连接外部服务器，获取工具和资源）。

`tools/browser_tool.py`（2,387 行）实现了第一种——一个基于 Accessibility Tree 的无视觉浏览器操控系统。`tools/mcp_tool.py`（2,195 行）实现了第二种——一个完整的 Model Context Protocol 客户端，支持 stdio 和 HTTP 双传输、采样回调、动态工具发现。

这两个工具模块是 Hermes 代码库中最大的单文件，也是外部集成最复杂的部分。

---

## 14.1 Browser 工具：agent-browser CLI

Browser 工具不是直接调用 Playwright 或 Puppeteer——它通过一个叫 `agent-browser` 的外部 CLI 工具间接控制浏览器。`agent-browser` 是一个 Node.js 程序，负责实际的 CDP（Chrome DevTools Protocol）通信。Hermes 通过 subprocess 调用 `agent-browser <command> [args]`，解析其 JSON 输出。

这种间接架构的好处是**隔离**：浏览器进程的崩溃不会影响 Python Agent 进程。`agent-browser` 管理浏览器的生命周期（启动、连接、关闭），Hermes 只需要发送命令和接收结果。

10 个 browser tool 覆盖了完整的浏览器交互操作：

| 工具 | 功能 |
|------|------|
| `browser_navigate` | 导航到 URL |
| `browser_snapshot` | 获取当前页面的 Accessibility Tree 快照 |
| `browser_click` | 点击元素（使用 ref selector 如 `@e5`） |
| `browser_type` | 在输入框中输入文本 |
| `browser_scroll` | 页面滚动（上/下/指定元素） |
| `browser_back` | 返回上一页 |
| `browser_press` | 按键操作（Enter、Escape 等） |
| `browser_get_images` | 获取页面中的图片列表 |
| `browser_vision` | 截图 + 视觉模型分析 |
| `browser_console` | 执行 JavaScript 代码 |

---

## 14.2 三种浏览器后端

Browser 工具支持三种执行后端，通过配置自动选择：

**Local Chromium**：默认模式。`agent-browser install` 下载无头 Chromium，所有操作在本地执行。零成本，适合开发和自托管。

**Browserbase**：云浏览器服务。浏览器在 Browserbase 的基础设施上运行，Hermes 通过 WebSocket 连接 CDP 端点。支持代理、隐身模式、会话持久化。需要 `BROWSERBASE_API_KEY`。

**Browser Use**：另一个云浏览器服务，是 Nous 订阅用户的默认选择。通过 managed tool gateway 访问，无需单独的 API key。

后端选择逻辑在 `_get_cloud_provider()` 中：

```python
# tools/browser_tool.py:258-299
def _get_cloud_provider() -> Optional[CloudBrowserProvider]:
    # 1. config.yaml 显式配置
    provider_key = normalize_browser_cloud_provider(
        browser_cfg.get("cloud_provider")
    )
    if provider_key == "local":
        return None  # 显式本地模式
    if provider_key in _PROVIDER_REGISTRY:
        return _PROVIDER_REGISTRY[provider_key]()

    # 2. 自动检测：优先 Browser Use，回退 Browserbase
    fallback = BrowserUseProvider()
    if fallback.is_configured():
        return fallback
    fallback = BrowserbaseProvider()
    if fallback.is_configured():
        return fallback
    return None  # 无云后端可用，使用本地模式
```

所有后端继承自 `CloudBrowserProvider` 基类，实现 `create_session()` / `close_session()` / `is_configured()` 接口。browser_tool 的核心逻辑不关心底层是本地 Chromium 还是云服务——它只调用 `agent-browser` CLI，由 CLI 负责连接正确的 CDP 端点。

**CDP URL 覆盖**也被支持：用户可以通过 `BROWSER_CDP_URL` 环境变量指定一个 Chrome DevTools Protocol 端点（比如已经在运行的 Chrome 实例），跳过所有后端选择逻辑直接连接。

---

## 14.3 Accessibility Tree：LLM 的页面视图

大多数浏览器自动化工具使用 CSS 选择器或 XPath 定位元素。但 LLM 看不到 DOM——它需要一个**文本表示**。

`browser_snapshot` 返回的是页面的 **ariaSnapshot**——一个从 Accessibility Tree 导出的结构化文本。Accessibility Tree 是浏览器为屏幕阅读器构建的页面语义模型，每个可交互元素都有角色（button、link、textbox）、名称和 ref selector（`@e1`、`@e2`...）。

一个典型的 ariaSnapshot 看起来像：

```
- navigation "Main Menu":
  - link "Home" @e1
  - link "Products" @e2
  - link "About" @e3
- main:
  - heading "Welcome" [level=1]
  - paragraph: "This is the main content..."
  - button "Sign Up" @e4
  - textbox "Email" @e5
```

LLM 看到这个文本后，可以指示 Agent：`browser_click("@e4")` 点击 "Sign Up" 按钮，或 `browser_type("@e5", "user@example.com")` 在 Email 输入框中输入。

这种方法比 CSS 选择器更适合 LLM：

1. **语义化**：LLM 理解 "button" 和 "link" 的含义，不理解 `#btn-primary-42`
2. **稳定性**：ref selector（`@e5`）在页面不变时保持稳定，不受 CSS class 名变化影响
3. **紧凑**：ariaSnapshot 比完整 DOM 小一到两个数量级，更适合 context window

当快照内容超过 `SNAPSHOT_SUMMARIZE_THRESHOLD`（8,000 tokens）时，browser_tool 使用辅助 LLM 对快照进行摘要，结合用户当前任务的上下文提取关键信息。

---

## 14.4 MCP 协议：开放式工具扩展

MCP（Model Context Protocol）是一个由 Anthropic 主导的开放协议，用于在 AI Agent 和外部工具服务器之间建立标准化连接。Hermes 的 MCP 客户端支持从外部 MCP 服务器动态发现和注册工具。

配置在 `~/.hermes/config.yaml` 的 `mcp_servers` 段：

```yaml
mcp_servers:
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_..."
  remote_api:
    url: "https://my-mcp-server.example.com/mcp"
    headers:
      Authorization: "Bearer sk-..."
```

---

## 14.5 Stdio 与 HTTP 双传输

MCP 支持两种传输方式：

**Stdio 传输**：MCP 服务器是一个本地命令行程序。Hermes 启动子进程（如 `npx @modelcontextprotocol/server-filesystem`），通过 stdin/stdout 交换 JSON-RPC 消息。

**HTTP/StreamableHTTP 传输**：MCP 服务器是一个远程 HTTP 服务。Hermes 通过 HTTP POST 发送请求，通过 Server-Sent Events (SSE) 接收响应。

传输方式由配置决定：有 `command` 字段的使用 stdio，有 `url` 字段的使用 HTTP。

**Stdio 安全：环境变量过滤**

Stdio 子进程默认只继承最小的环境变量集合：

```python
# tools/mcp_tool.py:168-170
_SAFE_ENV_KEYS = frozenset({
    "PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR",
})
```

`_build_safe_env()` 只传递这些安全变量和 `XDG_*` 变量，加上用户在配置中显式指定的变量。这防止了 API key、密码等敏感信息意外泄露到 MCP 服务器子进程中。

**凭据清洗**

MCP 工具调用失败时，错误消息在返回给 LLM 之前经过 `_sanitize_error()` 处理：

```python
# tools/mcp_tool.py:172-185
_CREDENTIAL_PATTERN = re.compile(
    r"(?:ghp_[A-Za-z0-9_]{1,255}"       # GitHub PAT
    r"|sk-[A-Za-z0-9_]{1,255}"          # OpenAI-style key
    r"|Bearer\s+\S+"                     # Bearer token
    r"|token=[^\s&,;\"']{1,255}"        # token=...
    r"|password=[^\s&,;\"']{1,255})"    # password=...
    , re.IGNORECASE,
)
```

所有匹配的凭据模式被替换为 `[REDACTED]`。即使 MCP 服务器在错误堆栈中暴露了 API key，LLM 也看不到真实值。

---

## 14.6 架构：专用后台 Event Loop

MCP 客户端使用一个专用的后台线程运行 event loop，所有 MCP 服务器的连接和通信都在这个 loop 上执行：

```python
# mcp_tool.py 中的架构设计
# _mcp_loop:   专用 event loop，在 _mcp_thread 中运行
# _servers:    Dict[str, MCPServerTask]，每个服务器一个长生命周期 Task
# tool calls:  从调用线程通过 run_coroutine_threadsafe() 调度到 _mcp_loop
```

每个 MCP 服务器运行为一个 asyncio Task，保持传输连接（stdio pipe 或 HTTP session）的上下文。工具调用是从 Agent 的调用线程通过 `asyncio.run_coroutine_threadsafe()` 调度到后台 loop 的。

关闭时，每个 Task 被信号通知退出其 `async with` 块——这确保 anyio cancel-scope 的清理发生在**打开连接的同一个 Task** 中（anyio 的要求），而不是从另一个线程强制取消。

**自动重连**

如果 MCP 服务器的连接断开，客户端会自动重试，使用指数退避策略：

```python
# 重试参数
_MAX_RECONNECT_RETRIES = 5
_MAX_BACKOFF_SECONDS = 60
```

最多重试 5 次，退避间隔从初始值指数增长到 60 秒。每次重连成功后，重新执行 `tools/list` 获取最新的工具列表。

---

## 14.7 Sampling：服务器发起的 LLM 请求

MCP 协议中最独特的特性是 **Sampling**——MCP 服务器可以主动向 Agent 发起 LLM 补全请求。场景：一个代码分析 MCP 服务器发现了代码问题，需要 LLM 帮助生成修复建议。它不是把所有代码发给 Agent 让 Agent 自己分析，而是直接通过 sampling/createMessage 向 Agent 请求一次 LLM 调用。

`SamplingHandler` 类管理每个 MCP 服务器的采样能力：

```python
# tools/mcp_tool.py:349-383
class SamplingHandler:
    def __init__(self, server_name: str, config: dict):
        self.max_rpm = _safe_numeric(config.get("max_rpm", 10), 10, int)
        self.timeout = _safe_numeric(config.get("timeout", 30), 30, float)
        self.max_tokens_cap = _safe_numeric(config.get("max_tokens_cap", 4096), 4096, int)
        self.max_tool_rounds = _safe_numeric(config.get("max_tool_rounds", 5), 5, int, minimum=0)
        self.model_override = config.get("model")
        self.allowed_models = config.get("allowed_models", [])
```

安全措施包括：

- **速率限制**：滑动窗口限制每分钟最多 `max_rpm` 次采样请求
- **Token 上限**：单次采样最多 `max_tokens_cap` token
- **Tool Loop 限制**：如果 LLM 响应包含 tool_calls（采样中的工具循环），最多执行 `max_tool_rounds` 轮
- **模型白名单**：`allowed_models` 限制服务器可以请求的模型范围
- **凭据隔离**：采样配置中的 API key 不泄露到 MCP 服务器

消息转换是 SamplingHandler 的核心复杂性所在。MCP 的消息格式和 OpenAI 的不同——MCP 使用 `TextContent`、`ToolUseContent`、`ToolResultContent` 等类型化的 content block，需要转换为 OpenAI 的 `content: str` 或 `tool_calls: [...]` 格式。`_convert_messages()` 方法处理这个转换，包括多模态内容（图片的 base64 编码）。

---

## 14.8 动态工具注册

MCP 服务器的工具在连接建立后通过 `tools/list` 请求获取，然后逐一注册到 Hermes 的 ToolRegistry：

```python
# mcp_tool.py 中的工具注册逻辑
for tool in server_tools:
    registry.register(
        name=f"mcp_{server_name}_{tool.name}",
        toolset=f"mcp_{server_name}",
        schema=convert_mcp_schema_to_openai(tool),
        handler=make_mcp_tool_handler(server_name, tool.name),
        ...
    )
```

工具名会加上 `mcp_{server_name}_` 前缀以避免与内置工具冲突。toolset 设置为 `mcp_{server_name}`，使得每个 MCP 服务器的工具形成独立的 toolset，可以被 `resolve_toolset()` 发现和管理。

**notifications/tools/list_changed**

MCP 协议支持服务器通知客户端工具列表已变更。当收到 `ToolListChangedNotification` 时，Hermes 执行 **nuke-and-repave**：

1. 通过 `registry.deregister()` 删除该服务器的所有旧工具
2. 重新调用 `tools/list` 获取新的工具列表
3. 重新注册所有工具

这实现了运行时的动态工具更新——MCP 服务器可以在不重启 Agent 的情况下添加、修改或删除工具。

前提是 MCP SDK 版本支持 `message_handler` 参数（通过 `_check_message_handler_support()` 检查）。旧版 SDK 不支持通知处理，动态工具发现功能自动降级为启动时一次性发现。

---

## 14.9 命令解析与 Node.js 路径

Stdio 传输面临一个实际问题：`npx` 命令可能不在 PATH 中。`_resolve_stdio_command()` 处理这种情况：

```python
# tools/mcp_tool.py:234-267
def _resolve_stdio_command(command: str, env: dict) -> tuple[str, dict]:
    resolved_command = os.path.expanduser(str(command).strip())
    if os.sep not in resolved_command:
        which_hit = shutil.which(resolved_command, path=path_arg)
        if which_hit:
            resolved_command = which_hit
        elif resolved_command in {"npx", "npm", "node"}:
            candidates = [
                os.path.join(hermes_home, "node", "bin", resolved_command),
                os.path.join("~/.local/bin", resolved_command),
            ]
            for candidate in candidates:
                if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                    resolved_command = candidate
                    break
```

对于 `npx`、`npm`、`node` 这些常见命令，如果 PATH 找不到，会额外检查 `~/.hermes/node/bin/`（Hermes 自带的 Node.js 安装）和 `~/.local/bin/`。解析后的命令目录被自动 prepend 到子进程的 PATH 中。

连接失败时，`_format_connect_error()` 递归遍历嵌套异常，提取 `FileNotFoundError` 中的可执行文件路径，生成可操作的错误消息：

```
missing executable 'npx' (ensure Node.js is installed and PATH includes 
its bin directory, or set mcp_servers.<name>.command to an absolute path)
```

---

## 本章小结

Browser 工具和 MCP 客户端代表了 Agent 与外部世界交互的两种模式。

Browser 工具通过 `agent-browser` CLI 间接控制浏览器，使用 Accessibility Tree（ariaSnapshot）提供 LLM 友好的页面文本表示。三种后端（Local、Browserbase、Browser Use）通过 `CloudBrowserProvider` 接口统一，ref selector（`@e1`、`@e2`...）提供稳定的元素定位方式。

MCP 客户端实现了 Model Context Protocol 的完整客户端栈——stdio 和 HTTP 双传输、自动重连、安全的环境变量过滤、凭据清洗、动态工具注册（`notifications/tools/list_changed`）、以及 Sampling（服务器发起的 LLM 请求）。专用后台 event loop 和线程安全的调度机制确保 MCP 通信不阻塞 Agent 主循环。

下一章我们进入 Agent 系统最深的递归层——代码执行工具让 LLM 编写调用工具的脚本（工具调用工具），子 Agent 委派让 Agent 创建新的 Agent 实例来处理子任务（Agent 调用 Agent）。

---

## 速查表

| 文件 | 行数 | 角色 |
|------|------|------|
| `tools/browser_tool.py` | 2,387 | 浏览器自动化，10 个 browser 工具 |
| `tools/browser_providers/base.py` | — | CloudBrowserProvider 基类 |
| `tools/browser_providers/browserbase.py` | — | Browserbase 云后端 |
| `tools/browser_providers/browser_use.py` | — | Browser Use 云后端 |
| `tools/mcp_tool.py` | 2,195 | MCP 客户端，stdio/HTTP 传输，Sampling |

| 概念 | 说明 |
|------|------|
| agent-browser CLI | Node.js 浏览器控制程序，通过 subprocess 调用 |
| ariaSnapshot | Accessibility Tree 的文本导出，LLM 友好 |
| ref selector | `@e1`、`@e2` 等元素引用，从 ariaSnapshot 获取 |
| 三种浏览器后端 | Local Chromium / Browserbase / Browser Use |
| CDP URL 覆盖 | `BROWSER_CDP_URL` 直连已运行的 Chrome 实例 |
| _SAFE_ENV_KEYS | MCP stdio 子进程只继承 8 个安全环境变量 |
| _sanitize_error | 从错误消息中清洗 API key、token 等凭据 |
| SamplingHandler | MCP 服务器发起的 LLM 请求，带速率限制和 token 上限 |
| notifications/tools/list_changed | MCP 服务器动态更新工具列表 |
| nuke-and-repave | 收到 list_changed 后先 deregister 再重新注册所有工具 |
