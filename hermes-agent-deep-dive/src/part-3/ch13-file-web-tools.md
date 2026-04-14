
# 第 13 章：文件操作与 Web 工具族

## 两个最常被调用的工具族

如果你观察一个 Hermes Agent 的典型会话，`read_file` 和 `terminal` 会交替出现在 tool trace 的前列。文件工具和 Terminal 工具构成了 Agent 日常工作的基石——读代码、改代码、搜索代码、查网页、提取内容。

这一章分析两个工具族的源码设计：`tools/file_tools.py`（700+ 行）负责文件 CRUD 和智能搜索，`tools/web_tools.py`（2,100+ 行）负责 Web 搜索与内容提取。两者看似简单，但内部隐藏了大量防御性设计——读取去重、循环检测、过期检测、URL 安全检查、多后端路由、LLM 内容摘要。

---

## 13.1 read_file：不只是读文件

`read_file_tool()` 是整个代码库中防御层最厚的函数。一次文件读取要通过**六道守卫**才能到达用户：

**第一道：设备路径拦截**

```python
# tools/file_tools.py:62-71
_BLOCKED_DEVICE_PATHS = frozenset({
    "/dev/zero", "/dev/random", "/dev/urandom", "/dev/full",
    "/dev/stdin", "/dev/tty", "/dev/console",
    "/dev/stdout", "/dev/stderr",
    "/dev/fd/0", "/dev/fd/1", "/dev/fd/2",
})
```

读取 `/dev/zero` 或 `/dev/urandom` 会产生无限输出，读取 `/dev/stdin` 会阻塞等待输入。这些路径在 Agent 场景中永远不应该被读取。检查使用字面路径（不做 symlink 解析），因为 `realpath` 会跟踪 `/dev/stdin → /proc/self/fd/0 → /dev/pts/0`，反而跳过了检查。

**第二道：二进制文件拦截**

```python
# tools/file_tools.py:297-305
if has_binary_extension(str(_resolved)):
    _ext = _resolved.suffix.lower()
    return json.dumps({
        "error": f"Cannot read binary file '{path}' ({_ext}). "
                 "Use vision_analyze for images, or terminal to inspect binary files."
    })
```

`.png`、`.exe`、`.zip` 等二进制文件被扩展名检查拦截。错误消息主动引导 Agent 使用正确的工具（`vision_analyze` 看图片，`terminal` 用 `hexdump` 看二进制）。

**第三道：Hermes 内部路径拦截**

```python
# tools/file_tools.py:309-326
_blocked_dirs = [
    _hermes_home / "skills" / ".hub" / "index-cache",
    _hermes_home / "skills" / ".hub",
]
```

Hermes 的 Skill Hub 索引缓存可能包含来自不受信任来源的元数据，读取它们有 prompt injection 风险。直接拦截，引导使用 `skills_list` 或 `skill_view` 工具。

**第四道：去重检查**

```python
# tools/file_tools.py:329-355
dedup_key = (resolved_str, offset, limit)
cached_mtime = task_data.get("dedup", {}).get(dedup_key)

if cached_mtime is not None:
    current_mtime = os.path.getmtime(resolved_str)
    if current_mtime == cached_mtime:
        return json.dumps({
            "content": "File unchanged since last read...",
            "dedup": True,
        })
```

如果 Agent 对同一文件的同一范围重复读取，且文件自上次读取后没有修改（mtime 相同），返回一个轻量的 "unchanged" 提示而不是重新发送全部内容。这节省了大量 context window 空间——一个 500 行文件的内容 vs 一句 "file unchanged" 的差距可能是数千 token。

**第五道：字符数限制**

```python
# tools/file_tools.py:370-384
max_chars = _get_max_read_chars()  # 默认 100,000
if content_len > max_chars:
    return json.dumps({
        "error": f"Read produced {content_len:,} characters which exceeds "
                 f"the safety limit ({max_chars:,} chars). "
                 "Use offset and limit to read a smaller range."
    })
```

100K 字符 ≈ 25-35K token。超过这个阈值的单次读取是 context window 的灾难。错误消息引导 Agent 使用 `offset` 和 `limit` 参数缩小读取范围。阈值可通过 `config.yaml` 的 `file_read_max_chars` 配置。

**第六道：敏感信息脱敏**

```python
# tools/file_tools.py:387-389
if result.content:
    result.content = redact_sensitive_text(result.content)
```

即使文件通过了所有检查，内容在返回给 LLM 之前还要经过 `redact_sensitive_text()` 处理，遮掩 API key、密码等敏感模式。

---

## 13.2 循环读取检测

Agent 有时会陷入循环：反复读取同一个文件，每次期望看到不同结果（但文件没有改变）。`_read_tracker` 跟踪每个 task 的连续读取模式：

```python
# tools/file_tools.py:131-147
# Per task_id we store:
#   "last_key":     the key of the most recent read/search call
#   "consecutive":  how many times that exact call has been repeated
#   "dedup":        dict mapping (path, offset, limit) → mtime
#   "read_timestamps": dict mapping path → mtime (for staleness detection)
```

当同一个 `(function_name, path, offset, limit)` 元组被连续调用 4 次以上时，系统触发硬性阻断——返回错误而不是文件内容，强制 Agent 改变策略。

关键的"连续"定义来自 `notify_other_tool_call()`：当 Agent 调用任何**非读取/搜索工具**时（比如 `terminal`、`write_file`、`patch`），连续计数器被重置。这意味着 "read → terminal → read" 模式不被视为循环——两次读取之间穿插了其他操作，说明 Agent 在做有意义的工作。

---

## 13.3 写操作与过期检测

`write_file_tool()` 和 `patch_tool()` 在写入之前检查文件是否在 Agent 上次读取后被外部修改：

```python
# tools/file_tools.py 写操作中的 staleness 检测逻辑
read_mtime = task_data.get("read_timestamps", {}).get(resolved_str)
if read_mtime is not None:
    current_mtime = os.path.getmtime(resolved_str)
    if current_mtime != read_mtime:
        # File was modified externally since agent's last read
        warning = "⚠️ File has been modified since your last read..."
```

场景：Agent 在 t=0 读取了 `main.py`，用户在 t=5 手动编辑了 `main.py`，Agent 在 t=10 试图基于 t=0 的内容写入 `main.py`。Staleness 检测发现 mtime 不匹配，在写入结果中附加警告。它不阻止写入（Agent 可能确实需要覆盖），但确保 Agent 知道文件已经变化。

写入成功后，`read_timestamps` 被更新为新的 mtime，防止后续的连续写入（同一个 Agent 的多次编辑）触发虚假的 staleness 警告。

---

## 13.4 敏感路径保护

某些系统路径需要 sudo 权限才能修改，文件工具不应该尝试直接写入：

```python
# tools/file_tools.py:93-116
_SENSITIVE_PATH_PREFIXES = ("/etc/", "/boot/", "/usr/lib/systemd/")
_SENSITIVE_EXACT_PATHS = {"/var/run/docker.sock", "/run/docker.sock"}

def _check_sensitive_path(filepath: str) -> str | None:
    resolved = os.path.realpath(os.path.expanduser(filepath))
    for prefix in _SENSITIVE_PATH_PREFIXES:
        if resolved.startswith(prefix):
            return (
                f"Refusing to write to sensitive system path: {filepath}\n"
                "Use the terminal tool with sudo if you need to modify system files."
            )
```

错误消息引导 Agent 使用 `terminal` 工具加 `sudo` 来修改系统文件——这样会触发 terminal 的危险命令审批系统（第 12 章），用户可以明确决定是否允许。

---

## 13.5 ShellFileOperations 适配器

文件工具的实际 I/O 不是直接在 Python 进程中执行的——它通过 `ShellFileOperations` 适配器转发到当前的 terminal 环境：

```python
# tools/file_tools.py:150-158
def _get_file_ops(task_id: str = "default") -> ShellFileOperations:
    from tools.terminal_tool import _active_environments, ...
    # 获取或创建 terminal 环境
    # 包装为 ShellFileOperations
    file_ops = ShellFileOperations(terminal_env)
    return file_ops
```

这意味着当 `TERMINAL_ENV=docker` 时，`read_file` 实际上是在 Docker 容器内读取文件，而不是在宿主机上。文件工具和 Terminal 工具共享同一个执行环境——用户在 terminal 中安装的文件、在 terminal 中创建的目录，都能被 `read_file` 访问到。

`_get_file_ops()` 使用与 terminal_tool 相同的 per-task 创建锁，防止并发创建多个环境实例。

---

## 13.6 Web 搜索：四后端策略

`tools/web_tools.py` 支持四个 Web 搜索后端：

| 后端 | 特点 | 环境变量 |
|------|------|---------|
| **Exa** | 语义搜索优先，支持域名过滤 | `EXA_API_KEY` |
| **Firecrawl** | 搜索+提取一体，支持自托管 | `FIRECRAWL_API_KEY` 或 `FIRECRAWL_API_URL` |
| **Parallel** | 高并发搜索 | `PARALLEL_API_KEY` |
| **Tavily** | AI 优化的搜索 API | `TAVILY_API_KEY` |

后端选择逻辑在 `_get_backend()` 中：

```python
# tools/web_tools.py:83-107
def _get_backend() -> str:
    configured = (_load_web_config().get("backend") or "").lower().strip()
    if configured in ("parallel", "firecrawl", "tavily", "exa"):
        return configured

    # Fallback: pick the highest-priority available backend
    backend_candidates = (
        ("firecrawl", _has_env("FIRECRAWL_API_KEY") or ...),
        ("parallel", _has_env("PARALLEL_API_KEY")),
        ("tavily", _has_env("TAVILY_API_KEY")),
        ("exa", _has_env("EXA_API_KEY")),
    )
    for backend, available in backend_candidates:
        if available:
            return backend

    return "firecrawl"  # default
```

优先级：config.yaml 显式配置 > 按 API key 存在顺序检测 > 默认 firecrawl。

Firecrawl 后端有一个特殊路径：Nous Research 的订阅用户可以通过 managed tool gateway 访问 Firecrawl，无需自己的 API key。`_is_tool_gateway_ready()` 检查 gateway URL 和 Nous 用户 token 是否配置：

```python
# tools/web_tools.py:150-152
def _is_tool_gateway_ready() -> bool:
    return resolve_managed_tool_gateway("firecrawl", token_reader=_read_nous_access_token) is not None
```

---

## 13.7 LLM 内容摘要

Web 页面的原始内容通常太长，无法直接放入 Agent 的 context window。`web_extract` 工具使用一个辅助 LLM（lightweight model）对抓取的内容进行摘要：

```python
# web_tools.py 中的 process_content_with_llm 调用
result = await async_call_llm(
    client=get_async_text_auxiliary_client(),
    model=...,
    messages=[{
        "role": "user",
        "content": f"Extract the key information from this page content:\n\n{page_content}"
    }]
)
```

辅助 LLM 客户端来自 `agent/auxiliary_client.py`，通常使用一个便宜快速的模型（如 Gemini Flash）。它的任务是：

1. 从完整页面内容中提取关键信息
2. 生成 Markdown 格式的摘要
3. 保留代码块、数据表格等结构化内容
4. 丢弃广告、导航菜单、页脚等噪音

压缩率通常在 5:1 到 20:1 之间——一个 50KB 的页面被压缩到 2.5-10KB 的摘要。这让 Agent 能在一个 context window 中处理多个页面的信息。

---

## 13.8 URL 安全与网站访问策略

Web 工具在请求 URL 之前需要通过两道安全检查：

**URL 安全检查**（`tools/url_safety.py`）：

```python
from tools.url_safety import is_safe_url
```

检查 URL 是否指向安全的 HTTP/HTTPS 地址。拒绝 `file://`、`ftp://`、`javascript:` 等 scheme，防止 SSRF（Server-Side Request Forgery）攻击。也拒绝内网地址（127.0.0.1、10.x.x.x、192.168.x.x），防止通过 Agent 探测内网。

**网站访问策略**（`tools/website_policy.py`）：

```python
from tools.website_policy import check_website_access
```

某些网站明确禁止自动化访问（robots.txt disallow）。`check_website_access()` 检查目标网站的 robots.txt 规则，对明确禁止的 URL 返回警告。这不是硬性拦截（Agent 仍然可以访问），而是一个 advisory check——告知 Agent 该网站可能不欢迎自动化访问。

---

## 13.9 搜索后端特性对比

四个后端的 API 接口不同，但 `web_tools.py` 将它们统一为相同的返回格式：

**web_search 返回**：
```json
{
    "data": {
        "web": [
            {"url": "...", "title": "...", "description": "..."},
            ...
        ]
    }
}
```

**web_extract 返回**：
```json
{
    "results": [
        {"url": "...", "title": "...", "content": "...", "error": null},
        ...
    ]
}
```

每个后端在内部将其原生 API 响应转换为这个统一格式。Exa 的 `search()` 返回语义相关性排序的结果；Firecrawl 的 `search()` 同时返回搜索结果和页面内容；Parallel 的 `search()` 支持高并发批量搜索；Tavily 的 `search()` 针对 AI 场景优化了摘要质量。

`web_extract` 支持同时提取多个 URL 的内容。每个 URL 独立处理，失败的 URL 不影响其他 URL 的结果。每个结果项都有 `error` 字段——`null` 表示成功，否则包含错误描述。

---

## 13.10 Debug 模式

`WEB_TOOLS_DEBUG=true` 环境变量启用 Web 工具的详细日志记录：

```python
from tools.debug_helpers import DebugSession
```

Debug 模式会在 `./logs/` 目录创建 `web_tools_debug_UUID.json` 文件，记录每次 API 调用的完整请求/响应、LLM 摘要的压缩率、后端选择过程等。这对排查 "web_search 返回了意外结果" 或 "web_extract 提取的内容不正确" 等问题非常有用。

---

## 本章小结

文件工具和 Web 工具是 Agent 的"眼睛和手"——读文件获取信息，搜网页获取知识，写文件实施修改。

文件工具的设计哲学是**防御优先**：六道守卫保护 read_file，staleness 检测保护 write/patch，循环检测防止 Agent 陷入无意义的重复读取。每一道防御都不是简单的拦截——它提供引导性的错误消息，告诉 Agent 应该怎么做（用 `vision_analyze` 看图片，用 `offset/limit` 缩小范围，用 `terminal` + `sudo` 修改系统文件）。

Web 工具的设计哲学是**多后端统一接口**：四个搜索/提取后端在 API 和定价上各不相同，但对 Agent 暴露的是完全相同的 schema 和返回格式。LLM 内容摘要作为后处理步骤，将原始页面内容压缩到 context window 可容纳的范围。

两者共同的设计特征是**通过 ShellFileOperations / terminal backend 间接执行 I/O**——这确保了文件工具和 terminal 工具看到的是同一个文件系统，无论它是本地目录、Docker 容器还是远程 SSH 服务器。

---

## 速查表

| 文件 | 行数 | 角色 |
|------|------|------|
| `tools/file_tools.py` | 700+ | read/write/patch/search，六道读取守卫 |
| `tools/web_tools.py` | 2,100+ | 四后端 Web 搜索/提取 + LLM 摘要 |
| `tools/file_operations.py` | — | ShellFileOperations 适配器 |
| `tools/url_safety.py` | — | URL scheme 和内网地址检查 |
| `tools/website_policy.py` | — | robots.txt 访问策略检查 |

| 概念 | 说明 |
|------|------|
| 六道读取守卫 | 设备路径 → 二进制 → 内部路径 → 去重 → 字符数限 → 脱敏 |
| 去重缓存 | (path, offset, limit) → mtime，文件未修改时返回 "unchanged" |
| 循环检测 | 连续 4 次相同读取触发硬性阻断 |
| Staleness 检测 | 读取时记录 mtime，写入时对比，mtime 不一致则警告 |
| 四 Web 后端 | Exa（语义搜索）/ Firecrawl（搜索+提取）/ Parallel（高并发）/ Tavily（AI 优化） |
| LLM 内容摘要 | 辅助轻量模型压缩页面内容，压缩率 5:1 到 20:1 |
| managed tool gateway | Nous 订阅用户通过 gateway 访问 Firecrawl，无需自有 API key |
| ShellFileOperations | 文件 I/O 通过 terminal 后端执行，共享同一文件系统 |
