
# 第 22 章：Platform Adapter 模式

> **核心问题**：BasePlatformAdapter 如何用三个抽象方法统一 15+ 个消息平台？各平台适配器的差异化实现有哪些值得关注的工程决策？

---

## 22.1 BasePlatformAdapter：三个抽象方法的力量

`gateway/platforms/base.py`（2,071 行）定义了所有平台适配器的基类。它只有三个抽象方法——这是整个适配器系统的核心契约：

```python
# gateway/platforms/base.py:942-976
@abstractmethod
async def connect(self) -> bool:
    """Connect to the platform and start receiving messages."""
    pass

@abstractmethod
async def disconnect(self) -> None:
    """Disconnect from the platform."""
    pass

@abstractmethod
async def send(
    self,
    chat_id: str,
    content: str,
    reply_to: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> SendResult:
    """Send a message to a chat."""
    pass
```

只有这三个方法是子类**必须**实现的。但 BasePlatformAdapter 还定义了一系列**可选覆盖**方法，每一个都有合理的默认降级行为：

| 方法 | 默认行为 | 覆盖场景 |
|------|---------|---------|
| `send_typing()` | no-op | Telegram/Discord 显示 "正在输入" |
| `stop_typing()` | no-op | Slack 需要显式停止 |
| `send_image()` | 发送 URL 文本 | 原生图片附件 |
| `send_animation()` | 委托 `send_image()` | Telegram GIF 自动播放 |
| `send_voice()` | 发送路径文本 | Telegram 语音气泡 |
| `send_video()` | 发送路径文本 | 原生视频播放 |
| `send_document()` | 发送路径文本 | 可下载附件 |
| `send_image_file()` | 发送路径文本 | 本地图片附件 |
| `edit_message()` | `SendResult(success=False)` | 编辑已发送消息 |

这种"default degradation"模式意味着一个新的平台适配器只需实现 `connect/disconnect/send` 就能工作——所有富媒体功能自动降级为纯文本。随着适配器成熟，开发者可以逐步覆盖更多方法以获得原生体验。

**构造函数**（第 790 行）初始化了几个关键的并发控制结构：

```python
# gateway/platforms/base.py:790-811
def __init__(self, config: PlatformConfig, platform: Platform):
    self.config = config
    self.platform = platform
    self._message_handler: Optional[MessageHandler] = None
    self._running = False
    self._fatal_error_code: Optional[str] = None
    # ...
    self._active_sessions: Dict[str, asyncio.Event] = {}
    self._pending_messages: Dict[str, MessageEvent] = {}
    self._background_tasks: set[asyncio.Task] = set()
    self._auto_tts_disabled_chats: set = set()
    self._typing_paused: set = set()
```

`_active_sessions` 和 `_pending_messages` 是 handle_message 并发模型的核心，我们在 22.2 节详细讨论。

---

## 22.2 消息归一化：MessageEvent 与 SendResult

跨平台消息处理的第一步是将各平台的原始消息格式统一为 `MessageEvent`（第 655 行）：

```python
# gateway/platforms/base.py:655-692
@dataclass
class MessageEvent:
    text: str
    message_type: MessageType = MessageType.TEXT
    source: SessionSource = None
    raw_message: Any = None
    message_id: Optional[str] = None
    media_urls: List[str] = field(default_factory=list)
    media_types: List[str] = field(default_factory=list)
    reply_to_message_id: Optional[str] = None
    reply_to_text: Optional[str] = None
    auto_skill: Optional[str | list[str]] = None
    internal: bool = False
    timestamp: datetime = field(default_factory=datetime.now)
```

`MessageType` 枚举（第 634 行）覆盖了所有消息类型：TEXT、LOCATION、PHOTO、VIDEO、AUDIO、VOICE、DOCUMENT、STICKER、COMMAND。适配器负责在 `connect()` 的回调中将平台原生消息转换为 `MessageEvent`。

`media_urls` 不是远程 URL——它们是**本地文件路径**。Telegram 图片 URL 在一小时后过期，Discord 的 CDN 链接也有签名时效。适配器在收到媒体消息时立即下载到本地缓存（`cache_image_from_url`、`cache_audio_from_bytes` 等），然后将缓存路径放入 `media_urls`，这样 vision tool 可以随时读取。

`auto_skill` 字段支持按频道/话题自动加载技能——比如 Telegram DM Topics 或 Discord 的 `channel_skill_bindings` 配置。它可以是单个字符串或有序列表，后者允许一个频道同时加载多个技能。

`reply_to_text` 字段值得特别注意。当用户回复一条旧消息时，适配器将被回复消息的文本放入这个字段。Gateway 在构建 Agent 提示词时将其作为上下文注入——"用户回复了这条消息：{reply_to_text}"。这让 Agent 能理解回复的语境，而不仅仅看到孤立的新消息。

`internal` 标志用于系统生成的合成事件（比如后台进程完成通知），这类事件必须绕过用户授权检查——它们不是来自真实用户。

`SendResult`（第 719 行）是发送操作的返回值：

```python
# gateway/platforms/base.py:719-726
@dataclass
class SendResult:
    success: bool
    message_id: Optional[str] = None
    error: Optional[str] = None
    raw_response: Any = None
    retryable: bool = False  # True for transient connection errors
```

`retryable` 字段让 `_send_with_retry()` 区分瞬态错误（网络断开、连接超时）和永久错误（格式错误、权限不足）。瞬态错误触发指数退避重试（最多 2 次），永久错误降级为纯文本发送。

---

## 22.3 handle_message 并发模型

`handle_message()`（第 1482 行）是 BasePlatformAdapter 中最精巧的方法。它的设计目标是：快速返回，后台处理，支持中断。

```python
# gateway/platforms/base.py:1482-1561 (structure)
async def handle_message(self, event: MessageEvent) -> None:
    session_key = build_session_key(event.source, ...)

    # 1. If session is already active...
    if session_key in self._active_sessions:
        cmd = event.get_command()
        if cmd in ("approve", "deny", "stop", "new", "reset", ...):
            # Dispatch command inline — DON'T use background task
            response = await self._message_handler(event)
            if response:
                await self._send_with_retry(...)
            return

        # Photo bursts: merge without interrupt
        if event.message_type == MessageType.PHOTO:
            merge_pending_message_event(self._pending_messages, session_key, event)
            return

        # Normal text: interrupt running agent
        self._pending_messages[session_key] = event
        self._active_sessions[session_key].set()  # Signal interrupt
        return

    # 2. Mark session as active BEFORE spawning task
    self._active_sessions[session_key] = asyncio.Event()

    # 3. Spawn background task
    task = asyncio.create_task(self._process_message_background(event, session_key))
    self._background_tasks.add(task)
```

这里有三个值得深入理解的设计决策：

**同步守卫优先于异步任务**。第 1558 行 `self._active_sessions[session_key] = asyncio.Event()` 在 `create_task` **之前**执行。如果放在 task 内部，两条近乎同时到达的消息可能都通过 `if session_key in self._active_sessions` 检查，然后各自启动一个 task——导致重复处理。这个模式与 grammY 的 sequentialize 中间件和 aiogram 的 EventIsolation 异曲同工。源码注释直接引用了这两个框架：

```python
# gateway/platforms/base.py:1553-1558
# Mark session as active BEFORE spawning background task to close
# the race window where a second message arriving before the task
# starts would also pass the _active_sessions check and spawn a
# duplicate task.  (grammY sequentialize / aiogram EventIsolation
# pattern — set the guard synchronously, not inside the task.)
self._active_sessions[session_key] = asyncio.Event()
```

这里使用的 `asyncio.Event` 不仅是存在性标记，还是中断信号通道。当后续消息到达一个已有活跃任务的 session 时，`self._active_sessions[session_key].set()` 触发中断信号——正在运行的 `_process_message_background` task 会检查这个 Event 并传递中断给 Agent。

**命令内联分发**。`/approve`、`/deny`、`/stop` 等命令**不通过** `_process_message_background` 处理。原因是 `_process_message_background` 管理会话生命周期（激活/去激活），它的清理逻辑会与正在运行的 task 竞态。特别是 `/approve` 和 `/deny`——Agent 线程阻塞在 `threading.Event.wait()` 上等待审批结果，发送中断无法唤醒它，必须直接路由到审批处理器。

**Photo burst 合并**。移动端的"相册"功能会在几百毫秒内发送多条 PHOTO 消息。`merge_pending_message_event()`（第 729 行）将它们合并到同一个 `MessageEvent` 中，扩展 `media_urls` 和 `media_types` 列表，合并 caption（使用行级精确匹配去重）。这样 Agent 在下一轮看到的是完整相册，而非碎片化的单张图片。

---

## 22.4 主流平台适配器

### Telegram

`TelegramAdapter`（`telegram.py:114`）是最成熟的适配器，使用 `python-telegram-bot` 库。它面临的独特挑战是 **MarkdownV2 转义**和 **UTF-16 长度计量**。

Telegram 的消息长度限制是 4,096 个 **UTF-16 编码单元**，不是 Unicode 码点。一个 emoji 如 😀 在 Python 的 `len()` 中计为 1，但在 UTF-16 中是一个代理对，占 2 个编码单元。`utf16_len()`（`base.py:24`）解决了这个问题：

```python
# gateway/platforms/base.py:24-36
def utf16_len(s: str) -> int:
    """Count UTF-16 code units in *s*.
    Telegram's message-length limit (4 096) is measured in UTF-16 code units,
    **not** Unicode code-points. Characters outside the Basic Multilingual
    Plane (emoji, CJK Extension B, musical symbols, …) consume **two** UTF-16
    code units each, even though Python's len() counts them as one.
    """
    return len(s.encode("utf-16-le")) // 2
```

配套的 `_prefix_within_utf16_limit()`（第 39 行）使用二分查找找到不超过限制的最长安全前缀，确保永远不会在代理对中间截断。

Telegram 适配器还有一个 **网络降级** 机制：如果 MarkdownV2 格式发送失败（Telegram 的 MarkdownV2 转义规则极其严格，任何未转义的特殊字符都会导致 400 错误），自动降级为 HTML 格式，如果 HTML 也失败则降级为纯文本。

### Discord

`DiscordAdapter`（`discord.py:411`）基于 `discord.py` 库。它的核心约束是 **2,000 字符限制**——Discord 历史上最严格的消息长度限制之一。

```python
# discord.py:411+
MAX_MESSAGE_LENGTH = 2000
```

超长消息被拆分为多条消息发送。DiscordAdapter 还实现了**自动线程化**：当配置为 `auto_thread=True` 时，每条用户消息的回复会自动创建一个 Discord thread，将对话与频道主流隔离。

Discord 适配器还支持 **语音**（加入语音频道进行实时对话）和 **斜杠命令**（注册 Discord 原生的 `/` 命令），以及消息去重机制防止 discord.py 的重连重播。

Discord 的另一个挑战是 **Embed 限制**。Agent 的回复可能包含代码块、图片链接、markdown 表格——这些在 Discord 中有各自的渲染规则和长度限制。适配器将超长消息按自然段落边界拆分，避免在代码块中间截断。

### Slack

`SlackAdapter`（`slack.py:64`）使用 **Bolt SDK** 的 **Socket Mode**——不需要公网 webhook，通过 WebSocket 接收事件。

```python
# slack.py:64+
MAX_MESSAGE_LENGTH = 39000  # Slack's actual limit
```

Slack 适配器的独特之处在于**多工作区支持**和 **AI Assistant 线程**。当检测到 Slack 的 AI Assistant API 可用时，适配器使用 `assistant_threads_setStatus` 管理打字指示器——这会禁用用户的输入框，所以在等待 `/approve` 时必须暂停（`_typing_paused`）。

---

## 22.5 中国平台适配器

### 钉钉（DingTalk）

`DingTalkAdapter`（`dingtalk.py`）使用 **Stream Mode** 而非传统的 webhook——类似 Slack Socket Mode，通过长连接接收事件，不需要公网 IP。需要 `dingtalk-stream` 包以及 `DINGTALK_CLIENT_ID` 和 `DINGTALK_CLIENT_SECRET`。消息长度限制为 20,000 字符。每条消息通过 session webhook 回复，而非单独的 API 调用。

### 飞书（Feishu）

`FeishuAdapter`（`feishu.py`）支持 **双传输模式**：WebSocket（`lark-oapi` 长连接）和 Webhook（HTTP 回调）。WebSocket 是首选，因为无需公网端口。飞书适配器还实现了 ACK emoji（收到消息时自动添加表情回应）和卡片消息按钮（card buttons），这些继承自 OpenClaw 项目。

### 企业微信（WeCom）

WeCom 有两个适配器：`WeComAdapter`（`wecom.py`，polling 模式）和 `WecomCallbackAdapter`（`wecom_callback.py`，回调模式）。前者适合测试，后者用于生产。

### 微信公众号（Weixin）

`WeixinAdapter`（`weixin.py`）面临微信开放平台最严苛的限制：**5 秒响应超时**。如果不在 5 秒内回复 HTTP 请求，微信会重试 3 次然后放弃。适配器的解决方案是先返回一条 "正在处理" 的空响应，然后异步处理消息，通过客服消息接口发送实际回复。需要 `aiohttp` 和 `cryptography`（用于消息加解密）。

---

## 22.6 长尾平台与跨平台基础设施

### 长尾平台

Gateway 还支持 WhatsApp（Node.js 桥接 Baileys 库）、Signal（通过 signal-cli HTTP API）、Matrix（mautrix 库，支持 E2EE 端到端加密）、Email（IMAP 轮询 + SMTP 发送）、SMS（Twilio API）、BlueBubbles（iMessage 桥接）、Mattermost（WebSocket）、Webhook（入站 HMAC 验证 + 出站 HTTP POST）、HomeAssistant（状态变化事件）和 API Server（REST/WebSocket 端点）。

每个适配器都遵循同样的三方法契约，差异化只在 `connect/disconnect/send` 的实现细节中。

### 跨平台差异矩阵

| 平台 | 传输方式 | 消息限制 | 富媒体支持 | 独特挑战 |
|------|---------|---------|-----------|---------|
| Telegram | Bot API (long polling) | 4096 UTF-16 | 图片/视频/语音/文件/GIF | MarkdownV2 转义地狱 |
| Discord | discord.py (WebSocket) | 2000 字符 | 图片/视频/语音/Embed | 自动线程管理 |
| Slack | Bolt SDK (Socket Mode) | 39000 字符 | 图片/文件/Block Kit | AI Assistant API 交互 |
| WhatsApp | Node.js 桥接 (Baileys) | 65536 字符 | 图片/视频/语音/文件 | LID/JID 身份映射 |
| Signal | signal-cli HTTP API | 无硬性限制 | 图片/语音/文件 | UUID vs 电话号码 |
| Matrix | mautrix (WebSocket) | 无硬性限制 | 全部 | E2EE 密钥管理 |
| DingTalk | Stream Mode | 20000 字符 | 图片/文件 | Session webhook 回复 |
| Feishu | lark-oapi WS/Webhook | 无硬性限制 | 图片/文件/卡片 | ACK emoji |
| Email | IMAP/SMTP | 无硬性限制 | 附件/HTML | 轮询间隔 vs 延迟 |
| SMS | Twilio API | 1600 字符 | 无 | 成本控制 |

### 媒体缓存系统

`base.py` 包含三套独立的缓存系统：

**图片缓存**（第 317 行）：`cache_image_from_bytes()` 和 `cache_image_from_url()`。关键安全措施是 **magic byte 验证**——`_looks_like_image()` 检查文件头的魔术字节（PNG: `\x89PNG\r\n\x1a\n`、JPEG: `\xff\xd8\xff`、GIF: `GIF87a/GIF89a`、BMP: `BM`、WebP: `RIFF...WEBP`），防止将 HTML 错误页面或恶意文件伪装为图片。

```python
# gateway/platforms/base.py:326-340
def _looks_like_image(data: bytes) -> bool:
    if len(data) < 4:
        return False
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return True
    if data[:3] == b"\xff\xd8\xff":
        return True
    # ... GIF, BMP, WebP checks
    return False
```

**音频缓存** 和 **文档缓存** 类似，文档缓存额外做了**路径遍历防护**：

```python
# gateway/platforms/base.py:607-608
if not filepath.resolve().is_relative_to(cache_dir.resolve()):
    raise ValueError(f"Path traversal rejected: {filename!r}")
```

### 代理支持

`resolve_proxy_url()`（第 148 行）按优先级检查：平台专用环境变量（`DISCORD_PROXY`）→ 通用代理变量（`HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY`）→ macOS 系统代理（`scutil --proxy` 自动检测）。

`proxy_kwargs_for_bot()`（第 170 行）处理 SOCKS 和 HTTP 代理的差异。SOCKS 代理使用 `aiohttp_socks.ProxyConnector`，关键参数是 **`rdns=True`**：

```python
# gateway/platforms/base.py:188
connector = ProxyConnector.from_url(proxy_url, rdns=True)
```

`rdns=True` 强制通过代理进行远程 DNS 解析——这在 GFW 环境下至关重要。如果在本地解析 DNS，DNS 污染会导致 Telegram Bot API 等服务不可达。远程 DNS 通过代理隧道解析，绕过了污染。

### SSRF 防护

`_ssrf_redirect_guard()`（第 290 行）是一个 httpx 响应钩子，在每次 HTTP 重定向时重新验证目标地址的安全性：

```python
# gateway/platforms/base.py:290-304
async def _ssrf_redirect_guard(response):
    """Re-validate each redirect target to prevent redirect-based SSRF."""
    if response.is_redirect and response.next_request:
        redirect_url = str(response.next_request.url)
        from tools.url_safety import is_safe_url
        if not is_safe_url(redirect_url):
            raise ValueError(
                f"Blocked redirect to private/internal address: {safe_url_for_log(redirect_url)}"
            )
```

没有这个守卫，攻击者可以注册一个公网 URL 然后 302 重定向到 `http://169.254.169.254/`（AWS metadata endpoint），绕过预飞行的 `is_safe_url()` 检查。

`is_network_accessible()`（第 77 行）检查主机地址是否暴露了超出 loopback 的网络接口，包括对 IPv4-mapped IPv6 地址（`::ffff:127.0.0.1`）的特殊处理——Python 的 `ip_address.is_loopback` 对 mapped 地址返回 False，必须显式检查底层的 IPv4 地址。

### 发送重试

`_send_with_retry()`（第 1384 行）实现了分层重试策略：

1. 首次发送
2. 如果失败且是网络错误 → 指数退避重试（2s, 5s）+ 随机抖动
3. 如果所有重试耗尽 → 发送一条 "⚠️ 消息投递失败" 通知
4. 如果是非网络错误（格式问题）→ 纯文本降级
5. 如果纯文本也失败 → 记录错误，放弃

注意超时错误（read/write timeout）被**排除**在重试之外。超时意味着请求可能已经到达服务器——重试会导致重复发送。只有连接错误（`connecterror`、`connectionreset`）才是安全的重试场景。这个区分在 `_RETRYABLE_ERROR_PATTERNS`（第 762 行）中编码为一个元组：

```python
# gateway/platforms/base.py:762-772
_RETRYABLE_ERROR_PATTERNS = (
    "connecterror",
    "connectionerror",
    "connectionreset",
    "connectionrefused",
    "connecttimeout",
    "network",
    "broken pipe",
    "remotedisconnected",
    "eoferror",
)
```

注意 `"timeout"` 和 `"timed out"` **不在**这个列表中——只有 `"connecttimeout"` 是安全的，因为连接超时意味着 TCP 握手未完成，请求肯定没有到达服务器。

### typing indicator 管理

`_keep_typing()`（第 1301 行）持续发送打字指示器直到被取消。Telegram 和 Discord 的打字状态约 5 秒后自动过期，所以每 2 秒刷新一次。方法支持 `_typing_paused` 集合——当 Agent 等待 `/approve` 审批时，打字指示器暂停。这对 Slack 的 AI Assistant API 特别关键：`assistant_threads_setStatus` 会禁用用户的输入框，如果在等待审批时不暂停，用户就无法输入 `/approve`。

### extract_media 与 extract_local_files

Agent 的回复中可能包含媒体引用。`extract_media()`（第 1192 行）解析 `MEDIA:/path/to/file` 标签和 `[[audio_as_voice]]` 指令，返回 `(path, is_voice)` 对列表。`extract_images()`（第 1051 行）解析 markdown 图片 `![alt](url)` 和 HTML `<img>` 标签。`extract_local_files()`（第 1234 行）检测回复文本中的裸路径（如 `/tmp/result.png`），验证文件实际存在后提取。

这三个方法确保 Agent 生成的媒体内容能通过原生平台附件发送，而不是作为纯文本 URL 或路径呈现给用户。

---

## 速查表

| 文件 / 位置 | 角色 |
|-------------|------|
| `gateway/platforms/base.py:24` | `utf16_len()` — UTF-16 编码单元计数 |
| `gateway/platforms/base.py:77` | `is_network_accessible()` — 网络暴露检测 |
| `gateway/platforms/base.py:148` | `resolve_proxy_url()` — 代理解析（含 macOS 自动检测）|
| `gateway/platforms/base.py:170` | `proxy_kwargs_for_bot()` — SOCKS `rdns=True` |
| `gateway/platforms/base.py:290` | `_ssrf_redirect_guard()` — 重定向 SSRF 防护 |
| `gateway/platforms/base.py:326` | `_looks_like_image()` — magic byte 验证 |
| `gateway/platforms/base.py:634` | `MessageType` 枚举 |
| `gateway/platforms/base.py:655` | `MessageEvent` 数据类 |
| `gateway/platforms/base.py:719` | `SendResult` 数据类 |
| `gateway/platforms/base.py:729` | `merge_pending_message_event()` — 相册合并 |
| `gateway/platforms/base.py:779` | `BasePlatformAdapter` 类 |
| `gateway/platforms/base.py:1384` | `_send_with_retry()` — 分层重试 |
| `gateway/platforms/base.py:1482` | `handle_message()` — 并发消息处理 |
| `gateway/platforms/telegram.py:114` | `TelegramAdapter` — MarkdownV2, utf16_len |
| `gateway/platforms/discord.py:411` | `DiscordAdapter` — 2000 字符限制, 自动线程 |
| `gateway/platforms/slack.py:64` | `SlackAdapter` — Socket Mode, AI Assistant |
| `gateway/platforms/dingtalk.py` | `DingTalkAdapter` — Stream Mode |
| `gateway/platforms/feishu.py` | `FeishuAdapter` — WebSocket + Webhook 双传输 |
