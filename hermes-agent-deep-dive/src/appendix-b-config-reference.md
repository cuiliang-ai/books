
# 附录 B：配置 YAML Schema 与环境变量参考

> 本附录提供 Hermes Agent `config.yaml` 的完整配置项说明与所有支持的环境变量。当你在前面 30 章中看到某个配置项被提及却不确定其默认值或含义时，翻到这里查阅。

---

## B.1 配置系统概览

### 配置文件位置

Hermes 的所有配置集中在 `~/.hermes/` 目录下：

```
~/.hermes/
├── config.yaml      # 主配置文件（所有设置）
├── .env             # API 密钥与敏感信息
├── SOUL.md          # 人格指令文件
├── skills/          # 本地 Skill 存储
├── sessions/        # 会话持久化
├── memories/        # 记忆快照
├── logs/            # 日志文件
└── cron/            # 定时任务配置
```

`get_hermes_home()` 函数（定义在 `hermes_constants.py`，由 `config.py:200` 重导出）负责解析这个根目录。可以通过 `HERMES_HOME` 环境变量覆盖默认路径。

### 分层加载顺序

配置值的优先级从低到高为：

```
DEFAULT_CONFIG（硬编码默认值）
  → ~/.hermes/config.yaml（全局配置）
    → 项目级 .hermes/config.yaml（如果存在）
      → 环境变量（HERMES_* 等）
        → CLI 参数（--model, --yolo 等）
```

每一层都只覆盖它设置的字段，未设置的字段继承上一层的值。这种分层设计让你可以在全局配置中设置通用偏好，在项目级配置中覆盖特定项目的需求。

### 配置版本迁移

`DEFAULT_CONFIG` 的末尾有一个 `_config_version: 16`（`config.py:705`）。每次新增必需字段时，版本号递增。`ENV_VARS_BY_VERSION` 字典（`config.py:714`）记录了每个版本引入的新环境变量，迁移逻辑只提醒用户自上次版本以来新增的变量：

```python
# config.py:714
ENV_VARS_BY_VERSION: Dict[int, List[str]] = {
    3: ["FIRECRAWL_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "FAL_KEY"],
    4: ["VOICE_TOOLS_OPENAI_KEY", "ELEVENLABS_API_KEY"],
    5: ["WHATSAPP_ENABLED", "WHATSAPP_MODE", "WHATSAPP_ALLOWED_USERS",
        "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_ALLOWED_USERS"],
    10: ["TAVILY_API_KEY"],
    11: ["TERMINAL_MODAL_MODE"],
}
```

### Profile 系统

Hermes 支持多 profile，每个 profile 有独立的 `config.yaml`、`.env`、`sessions/`、`memories/` 等。`get_hermes_home()` 和 `display_hermes_home()` 根据当前活动的 profile 返回对应的路径。Profile 机制让同一台机器上可以运行多个独立配置的 Hermes 实例——比如一个用于开发，一个用于 Gateway 服务。

---

## B.2 模型配置

模型配置控制 Hermes 使用哪个 LLM 提供商和模型。

```yaml
# 主模型标识（provider/model 格式或直接模型名）
model: ""

# 提供商配置（按提供商名称索引）
providers: {}

# 回退提供商列表（主提供商不可用时依次尝试）
fallback_providers: []

# 凭据池轮换策略
credential_pool_strategies: {}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `model` | string | `""` | 主模型标识。格式为 `provider/model`（如 `openrouter/anthropic/claude-sonnet-4`）或直接模型名（如 `gpt-4o`）。空字符串在首次运行时触发 setup wizard |
| `providers` | dict | `{}` | 按提供商名称索引的配置。每个提供商可以有 `api_key`、`base_url` 等字段 |
| `fallback_providers` | list | `[]` | 回退提供商列表。当主提供商返回错误（速率限制、服务不可用等）时，按顺序尝试列表中的提供商 |
| `credential_pool_strategies` | dict | `{}` | 凭据池轮换策略（第 6 章）。支持 round-robin、random、least-used 等策略 |

**多模型无锁定**：Hermes 支持的提供商包括 OpenAI、Anthropic、OpenRouter、Google AI Studio（Gemini）、Nous Portal、Z.AI / GLM、Kimi / Moonshot、MiniMax、DeepSeek、DashScope（阿里云）、Qwen Portal、OpenCode Zen/Go、Hugging Face、Xiaomi MiMo、Ollama 等。每个提供商通过 `hermes_cli/auth.py` 实现统一的凭据解析（第 6 章）。

---

## B.3 Agent 配置

Agent 配置控制核心循环的行为参数。

```yaml
agent:
  max_turns: 90
  gateway_timeout: 1800
  restart_drain_timeout: 60
  service_tier: ""
  tool_use_enforcement: "auto"
  gateway_timeout_warning: 900
  gateway_notify_interval: 600
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `agent.max_turns` | int | `90` | 每次对话的最大工具调用迭代数。RL CLI 覆盖为 200（`rl_cli.py:19`） |
| `agent.gateway_timeout` | int | `1800` | Gateway 模式的不活跃超时（秒）。Agent 只要还在调用工具或等待 API 响应就不算不活跃。0 = 无限制 |
| `agent.restart_drain_timeout` | int | `60` | Gateway 重启时的优雅排空超时（秒）。停止接受新任务，等待运行中的 agent 完成，超时后中断 |
| `agent.service_tier` | string | `""` | 传递给 API 的服务层级参数（如 OpenAI 的 `default`、`flex` 等） |
| `agent.tool_use_enforcement` | string/bool/list | `"auto"` | 工具使用强制注入。`"auto"` 对 GPT/Codex 模型启用，`true`/`false` 强制开关，列表形式匹配模型名子串 |
| `agent.gateway_timeout_warning` | int | `900` | 不活跃警告阈值（秒）。在完全超时之前发送一次警告。0 = 禁用 |
| `agent.gateway_notify_interval` | int | `600` | 周期性"仍在工作"通知间隔（秒）。让用户知道 agent 还活着。0 = 禁用 |

### 工具集配置

```yaml
toolsets:
  - hermes-cli
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `toolsets` | list | `["hermes-cli"]` | 启用的工具集列表。可选值定义在 `toolsets.py` 的 `TOOLSETS` 字典中（第 9 章）。常用值：`hermes-cli`、`terminal`、`web`、`browser`、`file`、`skills`、`memory`、`rl` 等 |

### 上下文压缩配置

```yaml
compression:
  enabled: true
  threshold: 0.50
  target_ratio: 0.20
  protect_last_n: 20
  summary_model: ""
  summary_provider: "auto"
  summary_base_url: null
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `compression.enabled` | bool | `true` | 是否启用上下文压缩（第 7 章） |
| `compression.threshold` | float | `0.50` | 上下文使用率超过此阈值时触发压缩 |
| `compression.target_ratio` | float | `0.20` | 压缩后保留的近期消息占阈值的比例 |
| `compression.protect_last_n` | int | `20` | 最少保留多少条近期消息不被压缩 |
| `compression.summary_model` | string | `""` | 压缩摘要使用的模型。空字符串表示使用主模型 |
| `compression.summary_provider` | string | `"auto"` | 压缩摘要使用的提供商 |

### 智能模型路由

```yaml
smart_model_routing:
  enabled: false
  max_simple_chars: 160
  max_simple_words: 28
  cheap_model: {}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `smart_model_routing.enabled` | bool | `false` | 是否启用智能路由。启用后，简单消息使用廉价模型，复杂消息使用主模型 |
| `smart_model_routing.max_simple_chars` | int | `160` | 消息字符数低于此值视为"简单" |
| `smart_model_routing.max_simple_words` | int | `28` | 消息词数低于此值视为"简单" |
| `smart_model_routing.cheap_model` | dict | `{}` | 廉价模型配置（provider、model 等） |

### 上下文引擎

```yaml
context:
  engine: "compressor"
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `context.engine` | string | `"compressor"` | 上下文管理引擎。内置 `"compressor"` 使用有损摘要。可设为插件名（如 `"lcm"` — Lossless Context Management）。插件搜索路径：`plugins/context_engine/<name>/` 或 `~/.hermes/plugins/` |

### 子代理委派

```yaml
delegation:
  model: ""
  provider: ""
  base_url: ""
  api_key: ""
  max_iterations: 50
  reasoning_effort: ""
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `delegation.model` | string | `""` | 子代理使用的模型。空字符串继承父代理模型 |
| `delegation.provider` | string | `""` | 子代理使用的提供商。空字符串继承父代理 |
| `delegation.base_url` | string | `""` | 子代理直连的 OpenAI-compatible endpoint |
| `delegation.api_key` | string | `""` | 子代理 endpoint 的 API key，回退到 `OPENAI_API_KEY` |
| `delegation.max_iterations` | int | `50` | 每个子代理的独立迭代上限 |
| `delegation.reasoning_effort` | string | `""` | 子代理推理力度：`xhigh`/`high`/`medium`/`low`/`minimal`/`none`。空字符串继承父代理 |

---

## B.4 终端配置

终端配置控制命令执行后端——Hermes 的六种终端后端（第 12 章）都从这里读取参数。

```yaml
terminal:
  backend: "local"
  modal_mode: "auto"
  cwd: "."
  timeout: 180
  env_passthrough: []
  docker_image: "nikolaik/python-nodejs:python3.11-nodejs20"
  docker_forward_env: []
  docker_env: {}
  singularity_image: "docker://nikolaik/python-nodejs:python3.11-nodejs20"
  modal_image: "nikolaik/python-nodejs:python3.11-nodejs20"
  daytona_image: "nikolaik/python-nodejs:python3.11-nodejs20"
  container_cpu: 1
  container_memory: 5120
  container_disk: 51200
  container_persistent: true
  docker_volumes: []
  docker_mount_cwd_to_workspace: false
  persistent_shell: true
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `terminal.backend` | string | `"local"` | 终端后端类型。可选：`local`、`docker`、`ssh`、`modal`、`daytona`、`singularity` |
| `terminal.modal_mode` | string | `"auto"` | Modal 后端模式。`auto` 自动检测 Modal 凭据 |
| `terminal.cwd` | string | `"."` | 初始工作目录。`.` 表示使用当前目录 |
| `terminal.timeout` | int | `180` | 命令执行超时（秒） |
| `terminal.env_passthrough` | list | `[]` | 传递到沙箱环境的环境变量名列表。Skill 声明的 `required_environment_variables` 会自动传递 |
| `terminal.docker_image` | string | 见上 | Docker 后端使用的镜像 |
| `terminal.docker_forward_env` | list | `[]` | 从宿主机转发到 Docker 容器的环境变量名列表 |
| `terminal.docker_env` | dict | `{}` | 显式设置 Docker 容器内的环境变量键值对。适用于 systemd 服务等无法从宿主 shell 读取环境变量的场景 |
| `terminal.singularity_image` | string | 见上 | Singularity/Apptainer 后端使用的镜像 URI |
| `terminal.modal_image` | string | 见上 | Modal 后端使用的镜像 |
| `terminal.daytona_image` | string | 见上 | Daytona 后端使用的镜像 |
| `terminal.container_cpu` | int | `1` | 容器 CPU 核数限制（Docker/Singularity/Modal/Daytona） |
| `terminal.container_memory` | int | `5120` | 容器内存限制（MB，默认 5GB） |
| `terminal.container_disk` | int | `51200` | 容器磁盘限制（MB，默认 50GB） |
| `terminal.container_persistent` | bool | `true` | 是否跨会话保持容器文件系统 |
| `terminal.docker_volumes` | list | `[]` | Docker 卷挂载列表。每项格式为 `"host_path:container_path"` |
| `terminal.docker_mount_cwd_to_workspace` | bool | `false` | 是否将宿主机 CWD 挂载到容器 `/workspace`。默认关闭——将宿主目录传入沙箱会削弱隔离性 |
| `terminal.persistent_shell` | bool | `true` | 持久 shell——跨 `execute()` 调用保持 bash 进程，CWD/环境变量/shell 变量得以保留。非 local 后端默认启用 |

### 浏览器配置

```yaml
browser:
  inactivity_timeout: 120
  command_timeout: 30
  record_sessions: false
  allow_private_urls: false
  camofox:
    managed_persistence: false
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `browser.inactivity_timeout` | int | `120` | 浏览器不活跃超时（秒），超时后自动关闭浏览器会话 |
| `browser.command_timeout` | int | `30` | 单个浏览器命令超时（秒）——截图、导航等 |
| `browser.record_sessions` | bool | `false` | 是否自动录制浏览器会话为 WebM 视频 |
| `browser.allow_private_urls` | bool | `false` | 是否允许访问私有/内部 IP（localhost、192.168.x.x 等）。SSRF 防护的一部分（第 21 章） |
| `browser.camofox.managed_persistence` | bool | `false` | 是否向 Camofox 服务器发送稳定的 userId 以获取持久浏览器 profile |

### 文件系统检查点

```yaml
checkpoints:
  enabled: true
  max_snapshots: 50

file_read_max_chars: 100000
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `checkpoints.enabled` | bool | `true` | 是否在破坏性文件操作前自动创建快照。使用 `/rollback` 命令恢复 |
| `checkpoints.max_snapshots` | int | `50` | 每个目录最多保留的快照数 |
| `file_read_max_chars` | int | `100000` | `read_file` 单次返回的最大字符数。100K 字符 ≈ 25-35K token |

---

## B.5 显示配置

显示配置控制 CLI 的外观和交互行为。

```yaml
display:
  compact: false
  personality: "kawaii"
  resume_display: "full"
  busy_input_mode: "interrupt"
  bell_on_complete: false
  show_reasoning: false
  streaming: false
  inline_diffs: true
  show_cost: false
  skin: "default"
  interim_assistant_messages: true
  tool_progress_command: false
  tool_preview_length: 0
  platforms: {}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `display.compact` | bool | `false` | 紧凑模式——减少空行和装饰 |
| `display.personality` | string | `"kawaii"` | 显示人格。影响 emoji 和语气风格 |
| `display.resume_display` | string | `"full"` | 恢复会话时的显示模式 |
| `display.busy_input_mode` | string | `"interrupt"` | Agent 忙碌时用户输入的处理方式 |
| `display.bell_on_complete` | bool | `false` | 任务完成时是否响铃（终端 bell） |
| `display.show_reasoning` | bool | `false` | 是否显示模型的推理过程（thinking tokens） |
| `display.streaming` | bool | `false` | 是否启用流式输出 |
| `display.inline_diffs` | bool | `true` | 是否显示写入操作的内联 diff 预览 |
| `display.show_cost` | bool | `false` | 是否在状态栏显示费用 |
| `display.skin` | string | `"default"` | 界面皮肤 |
| `display.interim_assistant_messages` | bool | `true` | Gateway 模式：是否显示中间状态消息 |
| `display.tool_progress_command` | bool | `false` | Gateway 模式：是否启用 `/verbose` 命令 |
| `display.tool_preview_length` | int | `0` | 工具调用预览的最大字符数。0 = 不限制 |
| `display.platforms` | dict | `{}` | 按平台覆盖显示设置。如 `{"telegram": {"tool_progress": "all"}}` |

### 隐私配置

```yaml
privacy:
  redact_pii: false
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `privacy.redact_pii` | bool | `false` | 启用后对用户 ID 进行哈希处理，从 LLM 上下文中去除电话号码 |

### 人类延迟模拟

```yaml
human_delay:
  mode: "off"
  min_ms: 800
  max_ms: 2500
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `human_delay.mode` | string | `"off"` | 模拟人类打字延迟。`off` = 禁用 |
| `human_delay.min_ms` | int | `800` | 最小延迟（毫秒） |
| `human_delay.max_ms` | int | `2500` | 最大延迟（毫秒） |

---

## B.6 记忆配置

记忆配置控制持久化记忆系统（第 15 章）。

```yaml
memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 2200
  user_char_limit: 1375
  provider: ""
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `memory.memory_enabled` | bool | `true` | 是否启用 Agent 记忆（agent notes） |
| `memory.user_profile_enabled` | bool | `true` | 是否启用用户画像记忆 |
| `memory.memory_char_limit` | int | `2200` | Agent 记忆的最大字符数。~800 tokens（按 2.75 chars/token 估算） |
| `memory.user_char_limit` | int | `1375` | 用户画像的最大字符数。~500 tokens |
| `memory.provider` | string | `""` | 外部记忆提供商插件名。空字符串使用内置记忆。可选值：`openviking`、`mem0`、`hindsight`、`holographic`、`retaindb`、`byterover`。同时只能有一个外部提供商 |

### Skills 配置

```yaml
skills:
  external_dirs: []
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `skills.external_dirs` | list | `[]` | 外部 Skill 目录列表。路径支持 `~` 和 `${VAR}` 展开。只读——Skill 创建始终写入 `~/.hermes/skills/` |

### Honcho 记忆

```yaml
honcho: {}
```

Honcho 配置从 `~/.honcho/config.json` 读取，`config.yaml` 中的 `honcho` 节仅用于 Hermes 特定的覆盖。

---

## B.7 安全配置

安全配置控制审批系统和安全扫描（第 20-21 章）。

```yaml
approvals:
  mode: "manual"
  timeout: 60

command_allowlist: []

security:
  redact_secrets: true
  tirith_enabled: true
  tirith_path: "tirith"
  tirith_timeout: 5
  tirith_fail_open: true
  website_blocklist:
    enabled: false
    domains: []
    shared_files: []
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `approvals.mode` | string | `"manual"` | 审批模式。`manual` = 总是询问用户；`smart` = 用辅助 LLM 自动审批低风险命令；`off` = 跳过所有审批（等同 `--yolo`） |
| `approvals.timeout` | int | `60` | 等待用户审批的超时（秒） |
| `command_allowlist` | list | `[]` | 永久允许的危险命令模式列表（通过审批时选择"always"添加） |
| `security.redact_secrets` | bool | `true` | 是否从输出中编辑敏感信息 |
| `security.tirith_enabled` | bool | `true` | 是否启用 Tirith pre-exec 安全扫描 |
| `security.tirith_path` | string | `"tirith"` | Tirith 可执行文件路径 |
| `security.tirith_timeout` | int | `5` | Tirith 扫描超时（秒） |
| `security.tirith_fail_open` | bool | `true` | Tirith 超时或错误时是否允许执行（fail-open） |
| `security.website_blocklist.enabled` | bool | `false` | 是否启用网站黑名单 |
| `security.website_blocklist.domains` | list | `[]` | 被阻止的域名列表 |
| `security.website_blocklist.shared_files` | list | `[]` | 共享黑名单文件路径列表 |

### 快速命令

```yaml
quick_commands: {}
```

用户定义的快速命令，绕过 agent 循环直接执行。格式：`{"命令名": "shell命令"}`。仅支持 `exec` 类型。

### 自定义人格

```yaml
personalities: {}
```

自定义人格定义，支持两种格式。字符串格式：`{"name": "system prompt"}`。字典格式：`{"name": {"description": "...", "system_prompt": "...", "tone": "...", "style": "..."}}`。

---

## B.8 辅助模型配置

辅助模型（`auxiliary`）为各种侧任务配置独立的 LLM。每个侧任务都可以使用不同于主模型的提供商和模型——通常使用更快更便宜的模型。所有侧任务在配置的提供商不可用时，回退到 `openrouter:google/gemini-3-flash-preview`。

```yaml
auxiliary:
  vision:       { provider: "auto", model: "", base_url: "", api_key: "", timeout: 120, download_timeout: 30 }
  web_extract:  { provider: "auto", model: "", base_url: "", api_key: "", timeout: 360 }
  compression:  { provider: "auto", model: "", base_url: "", api_key: "", timeout: 120 }
  session_search: { provider: "auto", model: "", base_url: "", api_key: "", timeout: 30 }
  skills_hub:   { provider: "auto", model: "", base_url: "", api_key: "", timeout: 30 }
  approval:     { provider: "auto", model: "", base_url: "", api_key: "", timeout: 30 }
  mcp:          { provider: "auto", model: "", base_url: "", api_key: "", timeout: 30 }
  flush_memories: { provider: "auto", model: "", base_url: "", api_key: "", timeout: 30 }
```

八个辅助任务的职责和超时设计：

| 辅助任务 | 默认超时 | 职责 |
|---------|---------|------|
| `vision` | 120s | 图片分析。额外有 `download_timeout: 30` 控制图片下载超时 |
| `web_extract` | 360s（6分钟） | 网页内容提取与摘要。超时最长，因为大型网页的 LLM 摘要很慢 |
| `compression` | 120s | 上下文压缩摘要（第 7 章） |
| `session_search` | 30s | 跨会话搜索的查询重写 |
| `skills_hub` | 30s | Skills Hub 的 Skill 匹配 |
| `approval` | 30s | Smart 审批模式的风险评估。推荐使用快速/便宜模型（如 Gemini Flash、Haiku） |
| `mcp` | 30s | MCP 协议相关的辅助调用 |
| `flush_memories` | 30s | 记忆刷写（session 结束时的记忆整理） |

每个辅助任务的配置项结构相同：

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider` | string | 提供商名。`"auto"` = 自动检测最佳可用提供商 |
| `model` | string | 模型标识。空字符串使用提供商的默认辅助模型 |
| `base_url` | string | 直连 OpenAI-compatible endpoint（优先于 provider） |
| `api_key` | string | endpoint 的 API key（回退到 `OPENAI_API_KEY`） |
| `timeout` | int | LLM API 调用超时（秒） |

---

## B.9 TTS / STT / 语音配置

### 文字转语音（TTS）

```yaml
tts:
  provider: "edge"
  edge:       { voice: "en-US-AriaNeural" }
  elevenlabs: { voice_id: "pNInz6obpgDQGcFmaJgB", model_id: "eleven_multilingual_v2" }
  openai:     { model: "gpt-4o-mini-tts", voice: "alloy" }
  mistral:    { model: "voxtral-mini-tts-2603", voice_id: "c69964a6-..." }
  neutts:     { ref_audio: "", ref_text: "", model: "neuphonic/neutts-air-q4-gguf", device: "cpu" }
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `tts.provider` | string | `"edge"` | TTS 提供商。可选：`edge`（免费）、`elevenlabs`（高级）、`openai`、`minimax`、`mistral`、`neutts`（本地） |
| `tts.edge.voice` | string | `"en-US-AriaNeural"` | Edge TTS 语音名。常用：AriaNeural、JennyNeural、AndrewNeural 等 |
| `tts.openai.voice` | string | `"alloy"` | OpenAI TTS 语音。可选：alloy、echo、fable、onyx、nova、shimmer |
| `tts.neutts.device` | string | `"cpu"` | NeuTTS 本地推理设备。可选：`cpu`、`cuda`、`mps` |

### 语音转文字（STT）

```yaml
stt:
  enabled: true
  provider: "local"
  local:   { model: "base", language: "" }
  openai:  { model: "whisper-1" }
  mistral: { model: "voxtral-mini-latest" }
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `stt.enabled` | bool | `true` | 是否启用语音转文字 |
| `stt.provider` | string | `"local"` | STT 提供商。可选：`local`（免费，faster-whisper）、`groq`、`openai`、`mistral` |
| `stt.local.model` | string | `"base"` | 本地 Whisper 模型大小。可选：tiny、base、small、medium、large-v3 |
| `stt.local.language` | string | `""` | 强制语言代码（如 `"en"`、`"zh"`）。空字符串自动检测 |

### 语音交互

```yaml
voice:
  record_key: "ctrl+b"
  max_recording_seconds: 120
  auto_tts: false
  silence_threshold: 200
  silence_duration: 3.0
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `voice.record_key` | string | `"ctrl+b"` | 录音快捷键 |
| `voice.max_recording_seconds` | int | `120` | 最大录音时长（秒） |
| `voice.auto_tts` | bool | `false` | 是否自动将回复转为语音 |
| `voice.silence_threshold` | int | `200` | 静音阈值（RMS，0-32767） |
| `voice.silence_duration` | float | `3.0` | 静音持续多少秒后自动停止录音 |

---

## B.10 Gateway 平台配置

### Discord 配置

```yaml
discord:
  require_mention: true
  free_response_channels: ""
  allowed_channels: ""
  auto_thread: true
  reactions: true
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `discord.require_mention` | bool | `true` | 服务器频道中是否需要 @mention 才响应 |
| `discord.free_response_channels` | string | `""` | 不需要 @mention 的频道 ID（逗号分隔） |
| `discord.allowed_channels` | string | `""` | 白名单频道 ID（设置后只在这些频道响应） |
| `discord.auto_thread` | bool | `true` | 在频道中 @mention 时是否自动创建线程 |
| `discord.reactions` | bool | `true` | 处理消息时是否添加 👀/✅/❌ 表情反应 |

### WhatsApp 配置

```yaml
whatsapp:
  # reply_prefix: null  # 默认使用内置 "⚕ *Hermes Agent*" 头
```

WhatsApp 的配置相对简单——大部分设置通过环境变量控制（见 B.11）。`reply_prefix` 可以设为空字符串禁用消息头，或自定义（支持 `\n`）。

### Cron 定时任务

```yaml
cron:
  wrap_response: true
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `cron.wrap_response` | bool | `true` | 是否在 cron 响应中添加任务名头部和"agent 无法看到此消息"尾部。设为 `false` 获取干净输出 |

### 日志配置

```yaml
logging:
  level: "INFO"
  max_size_mb: 5
  backup_count: 3
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `logging.level` | string | `"INFO"` | `agent.log` 的最低日志级别。可选：DEBUG、INFO、WARNING |
| `logging.max_size_mb` | int | `5` | 单个日志文件的最大大小（MB），超出后轮转 |
| `logging.backup_count` | int | `3` | 保留的轮转备份文件数 |

### 网络配置

```yaml
network:
  force_ipv4: false
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `network.force_ipv4` | bool | `false` | 强制使用 IPv4。在 IPv6 不可用但系统仍尝试 AAAA 记录的服务器上，可解决连接超时问题 |

### 其他顶层配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `timezone` | string | `""` | IANA 时区（如 `"Asia/Shanghai"`、`"America/New_York"`）。空字符串使用服务器本地时间 |
| `prefill_messages_file` | string | `""` | 临时预填消息文件路径。JSON 格式的 `{role, content}` 列表，注入到每次 API 调用的开头。不会保存到会话、日志或轨迹中 |

---

## B.11 环境变量参考

环境变量存储在 `~/.hermes/.env` 文件中。`OPTIONAL_ENV_VARS` 字典（`config.py:730`）定义了约 60+ 个可选环境变量，每个变量都有元数据：`description`（说明）、`prompt`（设置向导提示语）、`url`（获取密钥的网址）、`password`（是否敏感）、`category`（分类）、`advanced`（是否高级选项）。

此外，`_EXTRA_ENV_KEYS`（`config.py:31`）定义了由 setup/provider 流程直接管理的环境变量（如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、各平台凭据等），这些不出现在 `OPTIONAL_ENV_VARS` 中但同样被识别。

### 提供商密钥（category: provider）

| 变量名 | 说明 | 敏感 |
|--------|------|------|
| `OPENAI_API_KEY` | OpenAI API 密钥 | ✓ |
| `OPENAI_BASE_URL` | OpenAI base URL 覆盖 | |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 | ✓ |
| `OPENROUTER_API_KEY` | OpenRouter API 密钥（视觉、网页抓取、MoA） | ✓ |
| `GOOGLE_API_KEY` | Google AI Studio API 密钥（也识别为 `GEMINI_API_KEY`） | ✓ |
| `GEMINI_API_KEY` | Google AI Studio 别名 | ✓ |
| `GEMINI_BASE_URL` | Google AI Studio base URL 覆盖 | |
| `GLM_API_KEY` | Z.AI / GLM 密钥（别名：`ZAI_API_KEY`、`Z_AI_API_KEY`） | ✓ |
| `KIMI_API_KEY` | Kimi / Moonshot 密钥 | ✓ |
| `KIMI_BASE_URL` | Kimi base URL 覆盖 | |
| `MINIMAX_API_KEY` | MiniMax 密钥（国际版） | ✓ |
| `MINIMAX_CN_API_KEY` | MiniMax 密钥（中国版） | ✓ |
| `DEEPSEEK_API_KEY` | DeepSeek 密钥 | ✓ |
| `DEEPSEEK_BASE_URL` | DeepSeek base URL 覆盖 | |
| `DASHSCOPE_API_KEY` | 阿里云 DashScope 密钥（Qwen 等） | ✓ |
| `DASHSCOPE_BASE_URL` | DashScope base URL 覆盖 | |
| `HERMES_QWEN_BASE_URL` | Qwen Portal base URL 覆盖 | |
| `OPENCODE_ZEN_API_KEY` | OpenCode Zen 密钥（按量付费） | ✓ |
| `OPENCODE_GO_API_KEY` | OpenCode Go 密钥（$10/月订阅） | ✓ |
| `HF_TOKEN` | Hugging Face 令牌（Inference Providers，20+ 开源模型） | ✓ |
| `XIAOMI_API_KEY` | 小米 MiMo 密钥 | ✓ |
| `NOUS_BASE_URL` | Nous Portal base URL 覆盖 | |

### 工具密钥（category: tool）

| 变量名 | 关联工具 | 说明 |
|--------|---------|------|
| `EXA_API_KEY` | web_search, web_extract | Exa AI 搜索密钥 |
| `PARALLEL_API_KEY` | web_search, web_extract | Parallel AI 搜索密钥 |
| `FIRECRAWL_API_KEY` | web_search, web_extract | Firecrawl 搜索与抓取密钥 |
| `FIRECRAWL_API_URL` | — | Firecrawl 自托管实例 URL |
| `TAVILY_API_KEY` | web_search, web_extract, web_crawl | Tavily AI 搜索密钥 |
| `BROWSERBASE_API_KEY` | browser_navigate, browser_click | Browserbase 云浏览器密钥 |
| `BROWSERBASE_PROJECT_ID` | browser_navigate, browser_click | Browserbase 项目 ID |
| `BROWSER_USE_API_KEY` | browser_navigate, browser_click | Browser Use 云浏览器密钥 |
| `CAMOFOX_URL` | browser_navigate, browser_click | Camofox 反检测浏览器 URL |
| `FAL_KEY` | image_generate | FAL 图片生成密钥 |
| `TINKER_API_KEY` | rl_start_training 等 | Tinker RL 训练密钥 |
| `WANDB_API_KEY` | rl_get_results 等 | Weights & Biases 实验追踪密钥 |
| `VOICE_TOOLS_OPENAI_KEY` | voice_transcription, openai_tts | OpenAI 语音密钥（Whisper + TTS） |
| `ELEVENLABS_API_KEY` | — | ElevenLabs 高级 TTS 密钥 |
| `MISTRAL_API_KEY` | — | Mistral Voxtral TTS/STT 密钥 |
| `GITHUB_TOKEN` | — | GitHub 令牌（Skills Hub、API 频率限制） |
| `HONCHO_API_KEY` | honcho_context | Honcho 持久记忆密钥 |
| `HONCHO_BASE_URL` | — | Honcho 自托管 URL |

### 消息平台（category: messaging）

| 变量名 | 平台 | 说明 |
|--------|------|------|
| `TELEGRAM_BOT_TOKEN` | Telegram | 从 @BotFather 获取的 bot token |
| `TELEGRAM_ALLOWED_USERS` | Telegram | 允许的用户 ID（逗号分隔） |
| `DISCORD_BOT_TOKEN` | Discord | 从 Developer Portal 获取的 bot token |
| `DISCORD_ALLOWED_USERS` | Discord | 允许的用户 ID（逗号分隔） |
| `DISCORD_REPLY_TO_MODE` | Discord | 回复线程模式：off/first/all |
| `SLACK_BOT_TOKEN` | Slack | Bot token（xoxb-），需要 chat:write 等权限 |
| `SLACK_APP_TOKEN` | Slack | App-level token（xapp-），用于 Socket Mode |
| `MATTERMOST_URL` | Mattermost | 服务器 URL |
| `MATTERMOST_TOKEN` | Mattermost | Bot token 或个人 access token |
| `MATTERMOST_ALLOWED_USERS` | Mattermost | 允许的用户 ID |
| `MATRIX_HOMESERVER` | Matrix | Homeserver URL |
| `MATRIX_ACCESS_TOKEN` | Matrix | Access token（推荐优于密码登录） |
| `MATRIX_USER_ID` | Matrix | 用户 ID（@user:server 格式） |
| `MATRIX_ALLOWED_USERS` | Matrix | 允许的用户 ID |
| `BLUEBUBBLES_SERVER_URL` | iMessage | BlueBubbles 服务器 URL |
| `BLUEBUBBLES_PASSWORD` | iMessage | BlueBubbles 服务器密码 |
| `BLUEBUBBLES_ALLOWED_USERS` | iMessage | 允许的 iMessage 地址 |
| `GATEWAY_ALLOW_ALL_USERS` | 全平台 | 允许所有用户（true/false） |
| `API_SERVER_ENABLED` | API Server | 启用 OpenAI-compatible API 服务器 |
| `API_SERVER_KEY` | API Server | Bearer token 认证密钥 |
| `API_SERVER_PORT` | API Server | 端口（默认 8642） |
| `API_SERVER_HOST` | API Server | 绑定地址（默认 127.0.0.1） |
| `WEBHOOK_ENABLED` | Webhook | 启用 webhook 适配器 |
| `WEBHOOK_PORT` | Webhook | Webhook 端口（默认 8644） |
| `WEBHOOK_SECRET` | Webhook | HMAC 签名验证密钥 |

### Agent 设置（category: setting）

| 变量名 | 说明 |
|--------|------|
| `MESSAGING_CWD` | Gateway 模式下终端命令的工作目录 |
| `SUDO_PASSWORD` | sudo 密码（用于需要 root 权限的命令） |
| `HERMES_MAX_ITERATIONS` | 每次对话的最大迭代数（默认 90） |
| `HERMES_PREFILL_MESSAGES_FILE` | 预填消息 JSON 文件路径 |
| `HERMES_EPHEMERAL_SYSTEM_PROMPT` | 临时系统提示（不持久化） |

### `_EXTRA_ENV_KEYS` 中的平台凭据

以下环境变量由 setup/provider 流程直接管理，不出现在 `OPTIONAL_ENV_VARS` 的设置向导中，但被 Hermes 识别和使用：

| 变量名 | 平台/用途 |
|--------|----------|
| `SIGNAL_ACCOUNT` / `SIGNAL_HTTP_URL` | Signal 平台 |
| `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET` | 钉钉平台 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_ENCRYPT_KEY` | 飞书平台 |
| `WECOM_BOT_ID` / `WECOM_SECRET` | 企业微信平台 |
| `WEIXIN_ACCOUNT_ID` / `WEIXIN_TOKEN` / `WEIXIN_BASE_URL` | 微信平台 |
| `TERMINAL_ENV` / `TERMINAL_SSH_KEY` / `TERMINAL_SSH_PORT` | SSH 终端后端 |

---

## B.12 pyproject.toml 依赖组

Hermes 使用 `pyproject.toml` 的 `[project.optional-dependencies]` 管理 20+ 个可选依赖组，让用户只安装需要的功能：

| 依赖组 | 说明 |
|--------|------|
| `gateway` | 消息平台 Gateway（Discord、Telegram、Slack 等） |
| `discord` | Discord 适配器 |
| `telegram` | Telegram 适配器 |
| `slack` | Slack 适配器 |
| `mattermost` | Mattermost 适配器 |
| `matrix` | Matrix 适配器（E2EE 支持） |
| `signal` | Signal 适配器 |
| `whatsapp` | WhatsApp 适配器 |
| `imessage` | iMessage（BlueBubbles）适配器 |
| `browser` | 浏览器自动化（Playwright） |
| `tts` | 文字转语音 |
| `stt` | 语音转文字（faster-whisper） |
| `voice` | 语音交互（完整 TTS + STT） |
| `image` | 图片生成（FAL） |
| `docker` | Docker 终端后端 |
| `modal` | Modal 终端后端 |
| `singularity` | Singularity/Apptainer 终端后端 |
| `rl` | RL 训练基础设施（Atropos、WandB） |
| `mcp` | MCP 协议支持 |
| `honcho` | Honcho 记忆提供商 |
| `dev` | 开发工具（pytest、ruff、mypy） |
| `all` | 所有可选依赖 |

安装示例：

```bash
# 最小安装
pip install hermes-agent

# 安装 Gateway + 浏览器支持
pip install "hermes-agent[gateway,browser]"

# 安装所有功能
pip install "hermes-agent[all]"
```

---

## 速查表

| 配置节 | 关键配置项 | 对应章节 |
|--------|-----------|---------|
| `model` / `providers` | 主模型、提供商、凭据池 | 第 1、6 章 |
| `agent.*` | 迭代上限、超时、工具强制 | 第 3 章 |
| `terminal.*` | 后端类型、容器配置、持久 shell | 第 12 章 |
| `browser.*` | 超时、SSRF 防护、Camofox | 第 13 章 |
| `compression.*` | 压缩阈值、保护消息数 | 第 7 章 |
| `memory.*` | 字符限制、外部提供商 | 第 15 章 |
| `auxiliary.*` | 8 个辅助任务的模型和超时 | 第 6 章 |
| `approvals.*` | 审批模式、超时 | 第 20 章 |
| `security.*` | Tirith 扫描、网站黑名单 | 第 21 章 |
| `display.*` | 界面、流式输出、diff 预览 | 第 2 章 |
| `tts.* / stt.* / voice.*` | 语音提供商、模型、交互 | — |
| `discord.* / whatsapp.*` | 平台特定行为 | 第 16 章 |
| `delegation.*` | 子代理模型、迭代上限 | 第 3 章 |
| `context.engine` | 上下文管理引擎插件 | 第 7 章 |
| `skills.external_dirs` | 外部 Skill 目录 | 第 14 章 |

| 环境变量类别 | 数量 | 典型代表 |
|-------------|------|---------|
| Provider 密钥 | ~20 | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY` |
| 工具密钥 | ~15 | `EXA_API_KEY`, `FAL_KEY`, `TAVILY_API_KEY` |
| 消息平台 | ~25 | `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN` |
| Agent 设置 | ~5 | `HERMES_MAX_ITERATIONS`, `SUDO_PASSWORD` |

> **提示**：运行 `hermes config` 查看当前生效的完整配置。运行 `hermes config edit` 在编辑器中打开 `config.yaml`。运行 `hermes config wizard` 重新执行设置向导。
