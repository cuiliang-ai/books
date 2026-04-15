
# 第 25 章：配置、凭据与 Profiles

> **核心问题**：分层配置如何工作？多密钥轮换的 Credential Pool 如何设计？

---

## 25.1 配置系统架构

Hermes 的配置系统不是一个扁平的键值存储，而是一个具有明确优先级链的分层合并系统。要理解它为什么这样设计，需要先理解它服务的场景：一个用户可能在家用 `~/.hermes/config.yaml` 配置 OpenRouter，在公司项目里用项目级配置覆盖为 Anthropic，同时通过环境变量 `OPENROUTER_API_KEY` 注入密钥。这三层配置必须无缝叠加。

`hermes_cli/config.py` 定义了配置的基础路径设施：

```python
# hermes_cli/config.py:203-209
def get_config_path() -> Path:
    """Get the main config file path."""
    return get_hermes_home() / "config.yaml"

def get_env_path() -> Path:
    """Get the .env file path (for API keys)."""
    return get_hermes_home() / ".env"
```

`get_hermes_home()` 的返回值本身受 Profile 系统影响——如果用户执行了 `hermes -p coder chat`，那么 `HERMES_HOME` 被 `_apply_profile_override()` 设置为 `~/.hermes/profiles/coder/`（如第 24 章所述），所有后续的路径解析都指向这个隔离目录。

`cli.py` 中的 `load_cli_config()` 实现了完整的配置合并逻辑。它先构造一个硬编码的默认字典：

```python
# cli.py:214-311 (abbreviated)
defaults = {
    "model": {"default": "", "base_url": "", "provider": "auto"},
    "terminal": {"env_type": "local", "cwd": ".", "timeout": 60, ...},
    "compression": {"enabled": True, "threshold": 0.50, ...},
    "display": {"compact": False, "skin": "default", "streaming": True, ...},
    "agent": {"max_turns": 90, "verbose": False, ...},
    "delegation": {"max_iterations": 45, "default_toolsets": ["terminal", "file", "web"]},
}
```

然后从文件加载并执行**深度合并**——字典类型递归合并，标量类型直接覆盖：

```python
# cli.py:361-374
for key in defaults:
    if key == "model":
        continue  # model has special handling
    if key in file_config:
        if isinstance(defaults[key], dict) and isinstance(file_config[key], dict):
            defaults[key].update(file_config[key])
        else:
            defaults[key] = file_config[key]

# Carry over keys from file_config that aren't in defaults
for key in file_config:
    if key not in defaults and key != "model":
        defaults[key] = file_config[key]
```

第二个循环的存在是关键——它确保 `config.yaml` 中的自定义顶层键（如 `honcho`、`memory`、`platform_toolsets`、`mcp_servers`）被保留，即使代码中没有预定义它们。这种"开放式合并"让 Hermes 能在不修改核心代码的情况下通过配置扩展新功能——一个新的 memory provider 只需要在 config.yaml 中添加自己的配置段，不需要核心代码为它预留位置。

model 配置有专门的处理逻辑，因为它经历了格式演化。旧格式是字典（`model: {default: "claude-sonnet-4-20250514", provider: "anthropic"}`），新格式是纯字符串（`model: "claude-sonnet-4-20250514"`）。合并逻辑检测格式并统一处理，还有一个向后兼容补丁：如果用户在 model 段里设置了 `model:` 但没有设置 `default:`，代码会自动提升 `model.model` 到 `model.default`，防止用户的选择被硬编码默认值覆盖。

配置还支持环境变量插值——`_expand_env_vars()` 处理 `${ENV_VAR}` 引用。合并完成后，终端相关的配置通过设置环境变量桥接到 `terminal_tool`——这是因为 terminal_tool 是通过环境变量获取配置的，而 CLI 配置是通过 YAML 文件加载的。

安全方面，`_secure_dir()` 和 `_secure_file()` 确保 `~/.hermes/` 目录和敏感文件（auth.json、.env）只有 owner 可读写（Unix 上设为 0700/0600）。但在 NixOS managed 模式下，这些权限函数会跳过——NixOS 的 activation script 设置了 group-readable 权限（0750/0640），让 interactive 用户和 gateway 服务共享状态。

---

## 25.2 config.yaml 详解

`hermes_cli/config.py` 中的 `DEFAULT_CONFIG` 字典是所有配置项的权威清单。让我们走一遍关键段，理解每个段的设计意图：

**agent 段**控制 Agent 行为参数：

```python
# hermes_cli/config.py:317-344
"agent": {
    "max_turns": 90,                     # 最大工具调用迭代次数
    "gateway_timeout": 1800,             # 不活跃超时（秒）
    "restart_drain_timeout": 60,         # 优雅停机排水超时
    "service_tier": "",                  # OpenAI Priority Processing
    "tool_use_enforcement": "auto",      # 工具使用强制引导
    "gateway_timeout_warning": 900,      # 超时前警告阈值
    "gateway_notify_interval": 600,      # "still working" 通知间隔
},
```

`tool_use_enforcement` 值得特别注意。设为 `"auto"` 时，它只对模型名包含 "gpt"、"codex"、"gemini" 等子串的模型启用（见第 14 章 prompt_builder 的 `TOOL_USE_ENFORCEMENT_MODELS`），注入一段System Prompt指导模型"必须使用工具而不是空谈"。这是因为某些模型倾向于描述它会做什么而不是实际调用工具——一个在实践中发现的行为模式。

**terminal 段**配置执行环境：

```python
# hermes_cli/config.py:346-383
"terminal": {
    "backend": "local",
    "cwd": ".",
    "timeout": 180,
    "env_passthrough": [],              # 传递到沙箱的环境变量
    "docker_image": "nikolaik/python-nodejs:python3.11-nodejs20",
    "docker_env": {},                   # 容器内环境变量
    "docker_volumes": [],               # 卷挂载
    "docker_mount_cwd_to_workspace": False,  # 挂载 cwd 到 /workspace
    "container_cpu": 1,
    "container_memory": 5120,           # MB
    "container_disk": 51200,            # MB
    "container_persistent": True,       # 跨会话持久化
    "persistent_shell": True,           # 保持长期 shell 实例
},
```

`docker_mount_cwd_to_workspace` 默认为 `False` 是一个安全决策——将宿主目录挂载到沙箱会削弱隔离性。用户必须显式 opt-in。`env_passthrough` 控制哪些环境变量从宿主传入沙箱，这与第 26 章的安全讨论直接相关。

**display 段**中的 `skin` 字段与第 24 章的 Skin Engine 关联。`init_skin_from_config()` 在 CLI 启动时读取这个字段设置活跃主题。`busy_input_mode` 控制用户在 Agent 忙碌时输入的行为——`"interrupt"` 允许中断当前执行，`"queue"` 将输入排队等待。

**approvals 段**控制危险命令审批行为——`"manual"`（默认，用户手动审批）、`"smart"`（LLM 辅助判断，见第 26 章）、`"off"`（跳过所有审批）。`timeout` 控制审批等待超时，`gateway_timeout` 控制 Gateway 场景下的超时。

**checkpoints 段**控制文件系统快照：

```python
# hermes_cli/config.py:399+ (inferred from DEFAULT_CONFIG)
"checkpoints": {
    "enabled": True,    # 自动在破坏性文件操作前创建快照
},
```

这个功能在 agent 执行 `write_file` 或 `patch` 之前自动备份受影响的文件，用户可以通过 `/rollback` 命令恢复。这是第 26 章安全纵深的一部分——即使 Agent 写了错误的内容，用户也能回滚。

---

## 25.3 Credential Pool

Credential Pool 是 Hermes 最精密的基础设施之一——它管理多个 API 密钥，处理配额耗尽时的自动轮换，执行 OAuth token 刷新，并在多个进程之间同步凭据状态。它解决了一个真实的运维痛点：当你有多个 API Key（每个有独立的速率限制），你希望系统自动切换而不是手动替换 `.env` 文件。

核心数据模型是 `PooledCredential`：

```python
# agent/credential_pool.py:93-117
@dataclass
class PooledCredential:
    provider: str
    id: str
    label: str
    auth_type: str              # "oauth" or "api_key"
    priority: int
    source: str                 # "manual", "env:OPENROUTER_API_KEY", etc.
    access_token: str
    refresh_token: Optional[str] = None
    last_status: Optional[str] = None
    last_status_at: Optional[float] = None
    last_error_code: Optional[int] = None
    last_error_reset_at: Optional[float] = None
    base_url: Optional[str] = None
    request_count: int = 0
    extra: Dict[str, Any] = None
```

`source` 字段驱动行为差异——手动添加（`"manual"`）的凭据在优先级排序中排在前面；环境变量来源（`"env:OPENROUTER_API_KEY"`）的凭据在环境变量被删除时自动清理；`"claude_code"` 来源的凭据会与 `~/.claude/.credentials.json` 保持同步。`extra` 字典存储 provider 特定的元数据（`token_type`、`scope`、`client_id` 等），通过 `__getattr__` 代理提供透明访问。

Pool 支持四种选择策略：

```python
# agent/credential_pool.py:64-70
STRATEGY_FILL_FIRST = "fill_first"       # 用完一个再用下一个（默认）
STRATEGY_ROUND_ROBIN = "round_robin"     # 轮流使用
STRATEGY_RANDOM = "random"               # 随机选择
STRATEGY_LEAST_USED = "least_used"       # 使用次数最少优先
```

`_select_unlocked()` 实现了策略分发：

```python
# agent/credential_pool.py:823-851
def _select_unlocked(self) -> Optional[PooledCredential]:
    available = self._available_entries(clear_expired=True, refresh=True)
    if not available:
        return None

    if self._strategy == STRATEGY_RANDOM:
        return random.choice(available)

    if self._strategy == STRATEGY_LEAST_USED and len(available) > 1:
        return min(available, key=lambda e: e.request_count)

    if self._strategy == STRATEGY_ROUND_ROBIN and len(available) > 1:
        entry = available[0]
        # Rotate: move first entry to end, re-index priorities
        rotated = [c for c in self._entries if c.id != entry.id]
        rotated.append(replace(entry, priority=len(self._entries) - 1))
        self._entries = [replace(c, priority=idx) for idx, c in enumerate(rotated)]
        self._persist()
        return entry

    return available[0]  # fill_first: simply return highest priority
```

`round_robin` 策略的实现很巧妙——它不是维护一个循环指针，而是在每次选择后修改优先级，把刚使用的条目放到最后。这样即使 Pool 被序列化到磁盘再重新加载，轮换状态也不会丢失。

**耗尽与冷却**是 Pool 的核心状态机。当 API 返回 429 或 402，`mark_exhausted_and_rotate()` 标记当前凭据为 `STATUS_EXHAUSTED` 并尝试选择下一个：

```python
# agent/credential_pool.py:73-77
EXHAUSTED_TTL_429_SECONDS = 60 * 60      # 1 hour for rate limits
EXHAUSTED_TTL_DEFAULT_SECONDS = 60 * 60  # 1 hour default
```

`_exhausted_until()` 计算冷却期结束时间——优先使用 provider 提供的 `reset_at` 时间戳，否则使用默认 TTL。`_available_entries()` 在枚举可用凭据时检查冷却期，过期的自动恢复为 `STATUS_OK`。

**OAuth 刷新**是 Pool 中最复杂的部分。refresh token 是一次性的——使用后立即失效。如果 Claude Code CLI 或另一个 Hermes Profile 已经用掉了这个 refresh token，Pool 中持有的就是废弃 token。解决方案是**跨进程同步**：

```python
# agent/credential_pool.py:416-451 (simplified)
def _sync_anthropic_entry_from_credentials_file(self, entry):
    """Sync from ~/.claude/.credentials.json if tokens differ."""
    creds = read_claude_code_credentials()
    if creds and creds.get("refreshToken") != entry.refresh_token:
        updated = replace(entry, access_token=creds["accessToken"],
                          refresh_token=creds["refreshToken"], ...)
        self._replace_entry(entry, updated)
        self._persist()
        return updated
    return entry
```

刷新失败时，代码还有重试路径——先同步外部文件的最新 token，用新 token 再次尝试刷新。刷新成功后，Pool 将新 token 写回共享文件和 auth.json，确保所有消费者看到一致的状态。

**Lease 机制**支持并发 API 调用。`acquire_lease()` 返回一个凭据 ID，`release_lease()` 归还。Pool 优先分配租约数最少的凭据，当所有凭据都达到软上限时仍然返回（不阻塞）：

```python
# agent/credential_pool.py:883-911
def acquire_lease(self, credential_id=None):
    with self._lock:
        available = self._available_entries(clear_expired=True, refresh=True)
        below_cap = [e for e in available
                     if self._active_leases.get(e.id, 0) < self._max_concurrent]
        candidates = below_cap if below_cap else available
        chosen = min(candidates,
                     key=lambda e: (self._active_leases.get(e.id, 0), e.priority))
        self._active_leases[chosen.id] = self._active_leases.get(chosen.id, 0) + 1
        return chosen.id
```

这个设计与第 27 章的并行工具执行直接关联——delegate_task 并行运行多个子 Agent 时，每个子 Agent 获取不同的凭据租约，分散速率限制压力。

---

## 25.4 Profiles

Profile 系统让一个用户运行多个完全隔离的 Hermes 实例。每个 Profile 有独立的配置、密钥、记忆、Skill、会话和 Gateway 服务。

Profile 的物理结构如下：

```python
# hermes_cli/profiles.py:36-50
_PROFILE_DIRS = [
    "memories", "sessions", "skills", "skins",
    "logs", "plans", "workspace", "cron",
    "home",  # Per-profile HOME for subprocesses
]
```

`"home"` 目录是一个安全设计——它为每个 Profile 提供独立的 `$HOME`，子进程（git、ssh、gh、npm）的配置文件落在这里，防止凭据在 Profile 之间泄漏。在第 26 章的安全讨论中，这是防止凭据扩散的一道屏障。

创建 Profile 有三种模式。`--clone` 复制配置文件和记忆文件但不复制会话和 Skill——适合"同一个人的不同工作场景"。`--clone-all` 完整复制后剥离运行时状态——适合创建一个可分享的 Profile 快照。`_CLONE_ALL_STRIP` 列表确保 PID 文件和 Gateway 状态不会被复制到新 Profile 中导致冲突。

Profile 导出有一个特殊考虑——默认 Profile（`~/.hermes` 本身）包含大量基础设施文件（git checkout、数据库、缓存、二进制文件），直接打包会非常大。`_DEFAULT_EXPORT_EXCLUDE_ROOT` frozenset 排除了 30+ 个路径，确保导出只包含实际的 Profile 数据。

Profile 切换的核心机制回到了第 24 章的 `_apply_profile_override()`。`hermes profile use coder` 写入 `~/.hermes/active_profile` 文件，后续的 `hermes` 命令在解析 sys.argv 之前就读取这个文件，自动设置 `HERMES_HOME`。这个设计的关键约束是"在任何模块 import 之前"——因为 `hermes_constants.get_hermes_home()` 在模块级别缓存路径，一旦被 import 就固化了。

---

## 25.5 认证配置

`hermes_cli/auth.py` 管理着 Hermes 支持的 15+ 个推理提供商的认证。`PROVIDER_REGISTRY` 为每个提供商定义了认证蓝图：

```python
# hermes_cli/auth.py:102-200 (sampled)
PROVIDER_REGISTRY: Dict[str, ProviderConfig] = {
    "nous": ProviderConfig(
        id="nous", name="Nous Portal",
        auth_type="oauth_device_code",
        portal_base_url="https://portal.nousresearch.com",
        inference_base_url="https://inference-api.nousresearch.com/v1",
        client_id="hermes-cli",
        scope="inference:mint_agent_key",
    ),
    "openai-codex": ProviderConfig(
        id="openai-codex", name="OpenAI Codex",
        auth_type="oauth_external",
        inference_base_url="https://chatgpt.com/backend-api/codex",
    ),
    "anthropic": ProviderConfig(
        id="anthropic", name="Anthropic",
        auth_type="api_key",
        inference_base_url="https://api.anthropic.com",
        api_key_env_vars=("ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"),
    ),
    "gemini": ProviderConfig(
        id="gemini", name="Google AI Studio",
        auth_type="api_key",
        api_key_env_vars=("GOOGLE_API_KEY", "GEMINI_API_KEY"),
        base_url_env_var="GEMINI_BASE_URL",
    ),
    # ... deepseek, zai, kimi-coding, minimax, alibaba, copilot, ...
}
```

`auth_type` 决定认证流程。`"api_key"` 最简单——从 `api_key_env_vars` 列出的环境变量中按优先级查找密钥。`"oauth_device_code"` 使用 RFC 8628 设备码流程——在终端显示 URL 和验证码，用户在浏览器完成认证，CLI 以不超过每秒一次的速率轮询令牌端点。`"oauth_external"` 共享来自其他工具的 OAuth token——比如 Codex CLI 的 `~/.codex/auth.json`。

认证状态持久化在 `~/.hermes/auth.json` 中，用跨进程文件锁保护：

```python
# hermes_cli/auth.py:58-59
AUTH_STORE_VERSION = 1
AUTH_LOCK_TIMEOUT_SECONDS = 15.0
```

文件锁是跨平台的——Unix 用 `fcntl.flock()`，Windows 用 `msvcrt.locking()`。`_auth_store_lock()` 上下文管理器封装了锁的获取/释放，15 秒超时防止死锁。

`load_pool()` 是凭据加载的主入口，编排了一个三阶段 seeding 管道：

```python
# agent/credential_pool.py:1334-1357
def load_pool(provider: str) -> CredentialPool:
    raw_entries = read_credential_pool(provider)
    entries = [PooledCredential.from_dict(provider, p) for p in raw_entries]

    singleton_changed, singleton_sources = _seed_from_singletons(provider, entries)
    env_changed, env_sources = _seed_from_env(provider, entries)
    changed = singleton_changed or env_changed
    changed |= _prune_stale_seeded_entries(entries, singleton_sources | env_sources)
    changed |= _normalize_pool_priorities(provider, entries)

    if changed:
        write_credential_pool(provider, [e.to_dict() for e in sorted(entries, ...)])
    return CredentialPool(provider, entries)
```

**Singleton seeding** 从 Claude Code 的 credentials.json、Hermes PKCE OAuth、Nous 的 auth.json state、Codex CLI 的 auth.json 中发现凭据。有一个重要的安全检查——Anthropic 的自动发现只在用户显式配置了 `anthropic` 作为 provider 时才激活，防止在未经同意的情况下读取 `~/.claude/.credentials.json`。

**环境变量 seeding** 从 `OPENROUTER_API_KEY`、`ANTHROPIC_API_KEY` 等环境变量中发现凭据。**Stale pruning** 清理来源已消失的凭据——比如用户删除了某个环境变量。

整个系统的设计哲学是**零配置发现**——设置环境变量或完成 OAuth 登录，凭据就自动出现在 Pool 中。但用户仍可通过 `hermes auth pool add` 手动管理，或通过 `credential_pool_strategies` 配置选择策略。这种"自动 + 可覆盖"的模式和第 24 章的 Skin Engine 继承模式一脉相承——提供好的默认值，同时保留完全的定制空间。

---

## 速查表

| 文件 | 角色 | 关键机制 |
|------|------|----------|
| `hermes_cli/config.py` | 配置基础设施 | get_hermes_home, DEFAULT_CONFIG, ensure_hermes_home, managed mode, _secure_dir/file |
| `cli.py` (load_cli_config) | CLI 配置合并 | 四层优先级链, 深度合并, 环境变量插值, model 格式兼容 |
| `agent/credential_pool.py` | 凭据池管理 | PooledCredential, 4 种策略, 耗尽/冷却 TTL, OAuth 刷新链, Lease 并发控制 |
| `hermes_cli/auth.py` | 认证基础设施 | PROVIDER_REGISTRY (15+ providers), auth.json 文件锁, device_code OAuth |
| `hermes_cli/profiles.py` | Profile 隔离 | _PROFILE_DIRS, --clone/--clone-all, active_profile sticky, 独立 HOME 目录 |
