
# 第 28 章：扩展实战 — 新增工具、平台与后端

> **核心问题**：一个 227K 行的单仓项目如何保持可扩展性？当你需要新增一个工具、一个消息平台、一个终端后端、一个记忆插件，或者一个 Slash 命令时，需要改动哪些文件、遵循哪些契约？

---

## 为什么扩展性是架构的核心关切

Hermes Agent 的代码量庞大，但它的扩展点却出奇地规整。这不是偶然的——当你回顾第 1 章讨论的六个设计决策，会发现"插件优于分叉"是贯穿整个架构的隐性原则。无论你想加一个新工具、一个新的消息平台、一个沙箱后端、还是一个记忆插件，模式都是相同的：找到抽象基类或注册表，实现具体逻辑，通过一个注册动作将新实现接入系统。没有配置文件扫描的魔法，没有运行时反射的黑箱——每一步都是显式的、可追溯的。

本章将逐一走过六个核心扩展点。如果你在读完本书后只想动手做一件事——比如给 Hermes 加一个新工具——这一章就是你的起点。

---

## 28.1 新增工具：三文件契约

在第 9 章我们深入分析了 `ToolRegistry` 单例的内部结构。现在让我们从实践角度看：要新增一个工具，你需要改动**恰好三个文件**。这个"三文件契约"在 `AGENTS.md` 中有明确文档——它不是隐含的约定，而是官方的开发者指南。

### 第一步：创建工具文件

每个工具都是 `tools/` 目录下的一个独立 Python 文件。它的核心职责是：定义 JSON Schema、实现 handler 函数、调用 `registry.register()` 完成自注册。来看 `AGENTS.md` 给出的规范模板：

```python
# tools/your_tool.py                            ← 新建文件
import json, os
from tools.registry import registry

def check_requirements() -> bool:
    """可选的可用性门控：检查 API Key 是否存在"""
    return bool(os.getenv("EXAMPLE_API_KEY"))

def example_tool(param: str, task_id: str = None) -> str:
    """实际执行逻辑。必须返回 JSON 字符串。"""
    return json.dumps({"success": True, "data": "..."})

registry.register(
    name="example_tool",
    toolset="example",
    schema={
        "name": "example_tool",
        "description": "Does something useful",
        "parameters": {
            "type": "object",
            "properties": {
                "param": {"type": "string", "description": "Input parameter"}
            },
            "required": ["param"]
        }
    },
    handler=lambda args, **kw: example_tool(
        param=args.get("param", ""),
        task_id=kw.get("task_id")
    ),
    check_fn=check_requirements,
    requires_env=["EXAMPLE_API_KEY"],
)
```

这段代码中有几个设计决策值得逐一解读。

`registry.register()` 在**模块导入时**执行（`tools/registry.py:72`），这意味着注册是声明式的——不需要任何启动仪式或初始化调用。`ToolEntry` 的十个 `__slots__` 定义了一个工具的完整元数据模型：

```python
# tools/registry.py:27-31
class ToolEntry:
    __slots__ = (
        "name", "toolset", "schema", "handler", "check_fn",
        "requires_env", "is_async", "description", "emoji",
        "max_result_size_chars",
    )
```

其中 `check_fn` 是**可用性门控**。当 `get_definitions()` 构建要发送给模型的工具列表时，它会调用每个工具的 `check_fn()`（`tools/registry.py:122-139`），只有返回 `True` 的工具才会被包含在 schema 中。这就是为什么即使 `BROWSERBASE_API_KEY` 没设置，浏览器工具也不会出现在 tool schema 里——用户根本不知道它存在，模型也不会尝试调用它。而且 `check_fn` 的结果被缓存在局部 `check_results` 字典中，同一个检查函数只执行一次——因为同一个 toolset 内的多个工具通常共享同一个 `check_fn`。

`handler` 接收 `args` 字典和 `**kwargs`（包含 `task_id`），必须返回 JSON 字符串。这个契约是硬性的。如果 handler 抛出异常，`registry.dispatch()` 会捕获它并包装为标准错误格式：

```python
# tools/registry.py:156-166
def dispatch(self, name: str, args: dict, **kwargs) -> str:
    entry = self._tools.get(name)
    if not entry:
        return json.dumps({"error": f"Unknown tool: {name}"})
    try:
        if entry.is_async:
            from model_tools import _run_async
            return _run_async(entry.handler(args, **kwargs))
        return entry.handler(args, **kwargs)
    except Exception as e:
        return json.dumps({"error": f"Tool execution failed: {type(e).__name__}: {e}"})
```

注意 `is_async` 标志——异步 handler 通过 `_run_async()` 桥接（第 11 章详述），这让工具作者可以自由使用 `async/await` 而不用关心调用方是同步还是异步。

为了减少样板代码，`registry.py` 底部提供了两个辅助函数 `tool_error()` 和 `tool_result()`（行 309-335），取代了遍布各工具文件的 `json.dumps({"error": msg})` 模式。

### 第二步：注册导入

新工具文件创建后，需要在 `model_tools.py` 的 `_discover_tools()` 函数中添加一行 import。这是**唯一的手动连接点**。import 触发工具文件的模块级 `registry.register()` 调用，把工具注入注册表。整个依赖链如第 9 章所述：

```
tools/registry.py  →  tools/*.py  →  model_tools.py  →  run_agent.py
```

`registry.py` 不导入任何工具文件（无循环依赖），工具文件只导入 `registry.py`，`model_tools.py` 导入所有工具文件触发注册。这个单向依赖链是精心设计的——在 `AGENTS.md` 的 "File Dependency Chain" 部分有明确文档。

### 第三步：加入 Toolset

工具必须属于一个 toolset 才能被启用。打开 `toolsets.py`，要么将工具名加入 `_HERMES_CORE_TOOLS` 列表（所有平台默认可用的 50+ 工具），要么加入某个特定 toolset 的 `tools` 列表。`_HERMES_CORE_TOOLS` 包含了从 `web_search` 到 `delegate_task` 的全部核心工具：

```python
# toolsets.py:31-63
_HERMES_CORE_TOOLS = [
    "web_search", "web_extract",
    "terminal", "process",
    "read_file", "write_file", "patch", "search_files",
    "vision_analyze", "image_generate",
    "skills_list", "skill_view", "skill_manage",
    "browser_navigate", "browser_snapshot", "browser_click",
    # ... 完整列表约 35 个工具 ...
    "execute_code", "delegate_task",
    "cronjob", "send_message",
    "ha_list_entities", "ha_get_state", "ha_list_services", "ha_call_service",
]
```

如果工具属于一个全新的类别，创建一个新的 toolset 条目即可——`TOOLSETS` 字典中的每个条目都有 `description`、`tools` 列表和 `includes`（允许 toolset 组合）。`resolve_toolset()` 会递归展开 `includes` 引用（第 10 章详述）。

### 陷阱清单

`AGENTS.md` 记录了几个容易踩的坑，这里逐一列出：

如果 schema description 中提到文件路径，使用 `display_hermes_home()` 而不是硬编码 `~/.hermes`——profile 系统（第 26 章）会改变 `HERMES_HOME`。工具的持久化状态必须存储在 `get_hermes_home()` 返回的目录下。schema description 中不能硬编码引用其他 toolset 的工具名——那些工具可能被禁用，模型会幻觉出不存在的调用。如果需要动态引用，在 `model_tools.py` 的 `get_tool_definitions()` 中做后处理。

最后，`todo` 和 `memory` 工具是特殊的——它们是 "Agent-level tools"，在 `run_agent.py` 的主循环中被拦截，不走 `handle_function_call()` 路径。如果你的新工具需要访问 agent 内部状态，这是可以参考的模式。

---

## 28.2 新增 Slash 命令：单注册表派生一切

Slash 命令系统是 Hermes 架构中最优雅的设计之一——一个注册表，七个消费者自动派生。所有命令定义在 `hermes_cli/commands.py` 的 `COMMAND_REGISTRY` 列表中：

```python
# hermes_cli/commands.py:38-49
@dataclass(frozen=True)
class CommandDef:
    name: str                          # 规范名（不带 /）
    description: str                   # 人类可读描述
    category: str                      # "Session" | "Configuration" | "Tools & Skills" | "Info" | "Exit"
    aliases: tuple[str, ...] = ()      # 别名元组
    args_hint: str = ""                # 参数占位符，如 "<prompt>" "[name]"
    subcommands: tuple[str, ...] = ()  # Tab 补全子命令
    cli_only: bool = False             # 仅 CLI 可用
    gateway_only: bool = False         # 仅 Gateway 可用
    gateway_config_gate: str | None = None  # 配置门控 dotpath
```

七个消费者全部从这一个列表自动派生：CLI dispatch 的 `resolve_command()`、Gateway dispatch 的 `GATEWAY_KNOWN_COMMANDS` frozenset、Gateway help 的 `gateway_help_lines()`、Telegram 菜单的 `telegram_bot_commands()`、Slack 子命令的 `slack_subcommand_map()`、CLI 自动补全的 `COMMANDS` dict、以及 CLI help 的 `COMMANDS_BY_CATEGORY` dict。

新增命令的步骤：在 `COMMAND_REGISTRY` 中添加 `CommandDef` 条目，在 `cli.py` 的 `process_command()` 中添加 handler，如果需要 gateway 端则在 `gateway/run.py` 中也添加 handler。添加别名只需修改 `aliases` 元组——所有七个消费者自动更新。

`gateway_config_gate` 字段特别巧妙：它允许一个标记为 `cli_only` 的命令在配置值为 truthy 时也暴露给 gateway。`/verbose` 就是这样工作的——默认 CLI-only，但设置 `display.tool_progress_command: true` 后也能在 Telegram 中使用。

---

## 28.3 新增平台适配器

`BasePlatformAdapter`（`gateway/platforms/base.py:779`）定义了四个必须实现的抽象方法：`connect()` 返回是否连接成功，`disconnect()` 断开连接，`send()` 发送消息并返回 `SendResult`，`get_chat_info()` 返回聊天信息。

除了这四个核心方法，基类还提供了十余个可选的 hook 方法。`send_typing()` 发送打字指示器，`send_image()` 发送图片，`send_voice()` 发送语音，`send_video()` 发送视频，`send_document()` 发送文件，`edit_message()` 编辑已发消息，`play_tts()` 播放 TTS 音频。每个 hook 都有合理的默认实现——例如 `send_image()` 默认回退为发送 URL 文本。子类只需覆盖自己平台原生支持的方法。

消息的接收端同样被规范化了。所有平台的入站消息都被转换为 `MessageEvent` 数据类（`base.py:656`），包含统一的字段：`text`、`message_type`（TEXT / PHOTO / VOICE / DOCUMENT 等枚举）、`source`（SessionSource）、`media_urls`、`reply_to_message_id`、`auto_skill` 等。这种规范化是 Gateway 能以**一套逻辑**处理 15 个平台的关键——上层代码只和 `MessageEvent` 打交道，不需要知道消息来自 Telegram 还是 Discord。

基类的 `handle_message()` 方法（`base.py:1482`）实现了完整的消息生命周期：会话锁定（`_active_sessions` dict 防止同一会话并发处理）、中断支持（新消息到达时通过 `asyncio.Event` 触发中断）、照片合并（photo burst 的多张图自动合并到同一事件）、后台任务管理（`_background_tasks` set 跟踪所有 in-flight 处理任务）、typing 指示器（`_keep_typing()` 每 2 秒刷新一次）。在消息发送端，`_send_with_retry()` 实现了带指数退避的重试、暂时性错误和永久性错误的区分、以及 plain-text 回退。

子类通常**不需要**覆盖 `handle_message()` ——只需正确实现 `connect()` 和 `send()`，基类就能处理所有复杂的并发和生命周期逻辑。

如果适配器使用唯一凭据连接（比如 Telegram bot token），必须在 `connect()` 中调用 `_acquire_platform_lock()`（`base.py:880`）来防止两个 profile 使用同一个凭据。这是 v0.8.0 multi-profile 架构（第 26 章）的安全网。

消息长度处理也值得一提。`truncate_message()` 静态方法（`base.py:1942`）处理了一个看似简单实则复杂的问题：如何拆分长消息。它不仅按平台的最大长度分段，还正确处理代码块边界（关闭/重开 triple-backtick fence，保留语言标签），避免在 inline code span 的未配对 backtick 处断开，并且支持 UTF-16 长度计量——Telegram 的 4096 限制是以 UTF-16 code unit 计的，不是 Python 的 `len()`。`utf16_len()` 辅助函数（`base.py:24`）正是为这个边界条件而存在。

---

## 28.4 新增终端后端

第 12 章详细分析了六种终端后端的执行模型。新增一个后端的核心工作量很小——继承 `BaseEnvironment`（`tools/environments/base.py:226`），实现两个方法即可。

```python
# tools/environments/base.py:226-280
class BaseEnvironment(ABC):
    _stdin_mode: str = "pipe"       # "pipe" 或 "heredoc"
    _snapshot_timeout: int = 30     # 快照创建超时

    def __init__(self, cwd: str, timeout: int, env: dict = None):
        self.cwd = cwd
        self.timeout = timeout
        self._session_id = uuid.uuid4().hex[:12]
        # ...

    def _run_bash(self, cmd_string: str, *, login: bool = False,
                  timeout: int = 120, stdin_data: str | None = None
                  ) -> ProcessHandle:
        """唯一的执行原语——子类必须实现"""
        raise NotImplementedError

    @abstractmethod
    def cleanup(self):
        """释放后端资源"""
        ...
```

`_run_bash()` 接收一个 bash 命令字符串，返回一个 `ProcessHandle`。标准的 `subprocess.Popen` 天然满足 `ProcessHandle` 协议（`poll()`、`kill()`、`wait()`、`stdout` 属性、`returncode` 属性）。对于 SDK 后端（Modal、Daytona），项目提供了 `_ThreadedProcessHandle` 适配器（`base.py:143`），它在后台线程中运行阻塞的 `exec_fn()`，通过 `os.pipe()` 模拟 stdout 流。

基类的 `execute()` 方法编排了完整的执行流程。`_wrap_command()` 生成一个包含 session snapshot sourcing、`cd` 到工作目录、执行命令、re-dump 环境变量、CWD marker 输出的完整 bash 脚本。`_wait_for_process()` 提供了统一的轮询-等待逻辑，包含中断检测、超时控制、stdout draining、以及 activity callback（让 gateway 知道命令还在运行）。子类不需要关心这些——只需让 `_run_bash()` 能在目标环境中执行 bash 即可。

两个类属性值得注意：`_stdin_mode` 控制 stdin 传递方式——`"pipe"` 用标准管道（本地和 SSH），`"heredoc"` 将 stdin 内嵌为 heredoc（Modal 和 Daytona，因为它们的 SDK 不支持管道）。`_snapshot_timeout` 可以被覆盖用于冷启动较慢的后端。

---

## 28.5 新增记忆插件

记忆插件的扩展点是 `MemoryProvider` 抽象基类（`agent/memory_provider.py:42`）。第 15 章分析了 `MemoryManager` 的编排逻辑，这里关注插件作者需要做什么。

必须实现三个方法：`name` 属性返回短标识符（如 `"honcho"`），`is_available()` 快速检查配置和依赖是否就绪（不做网络请求），`initialize()` 接收 `session_id` 和丰富的 kwargs 并建立连接。

可选 hook 涵盖记忆的完整生命周期：`system_prompt_block()` 注入静态指令到 system prompt；`prefetch(query)` 在每轮 API 调用前执行召回；`sync_turn(user, asst)` 在每轮对话后异步写入；`get_tool_schemas()` 和 `handle_tool_call()` 暴露自定义工具给模型；`on_session_end(messages)` 在会话结束时提取知识；`on_pre_compress(messages)` 在上下文压缩前保存信息（防止丢失）；`on_memory_write()` 镜像内置记忆写入；`on_delegation()` 观察子 agent 的执行结果。

激活方式：在 `config.yaml` 中设置 `memory.provider: "your_name"`。内置记忆始终作为第一个 provider——外部 provider 是附加的，不会替换内置存储。系统强制只允许一个外部 provider 同时运行。

---

## 28.6 新增 Skill 与配置项

Skill 是最轻量的扩展点——创建一个 Markdown 文件放在 `~/.hermes/skills/` 目录下即可，不需要修改任何代码。文件名即 Skill 名，内容是面向模型的指令。`agent/skill_commands.py` 扫描 skills 目录，将匹配的 Skill 内容作为用户消息注入——这个设计选择是为了保持 prompt caching 有效（第 8 章详述）。Skill 可以通过 `hermes skills config` 按平台启用/禁用，外部目录可以通过 `skills.external_dirs` 配置。

新增配置项的流程同样在 `AGENTS.md` 中有文档。添加 `config.yaml` 选项需要在 `hermes_cli/config.py` 的 `DEFAULT_CONFIG` 字典中添加默认值，并递增 `_config_version`（当前为 16）触发迁移。添加 `.env` 变量需要在 `OPTIONAL_ENV_VARS` 字典中添加元数据条目。注意配置系统有三个独立的加载器——CLI 模式、setup 子命令、Gateway 直接加载——这是历史遗留的复杂性，附录 B 有完整参考。

---

## 速查表

| 扩展类型 | 关键文件 | 必改文件数 | 核心抽象 | 详见章节 |
|---------|---------|-----------|---------|---------|
| 新增工具 | `tools/your_tool.py` | 3 | `registry.register()` | 第 9 章 |
| 新增 Slash 命令 | `hermes_cli/commands.py` | 2-3 | `CommandDef` | 第 5 章 |
| 新增平台适配器 | `gateway/platforms/your.py` | 1 | `BasePlatformAdapter` | 第 16 章 |
| 新增终端后端 | `tools/environments/your.py` | 1 | `BaseEnvironment._run_bash()` | 第 12 章 |
| 新增记忆插件 | `plugins/memory/your/` | 1 | `MemoryProvider` | 第 15 章 |
| 新增 Skill | `~/.hermes/skills/your.md` | 0 | SKILL.md 格式 | 第 14 章 |
| 新增配置项 | `hermes_cli/config.py` | 1 | `DEFAULT_CONFIG` | 附录 B |

| 设计原则 | 体现 |
|---------|------|
| 声明式注册 | `registry.register()` 在 import 时执行，无启动仪式 |
| 单一事实源 | `COMMAND_REGISTRY` → 七个消费者自动派生 |
| 协议适配 | `ProcessHandle` 协议 + `_ThreadedProcessHandle` 适配器 |
| 门控可用性 | `check_fn` + `requires_env` 控制工具暴露 |
| Profile 安全 | `_acquire_platform_lock()` 防止凭据冲突 |
| 内置不可替换 | Built-in memory 始终作为第一个 provider |

> **下一步**：如果你的扩展涉及 RL 训练——比如新增一个 Atropos 评估环境——请继续阅读第 29 章，了解 Trajectory 生成和强化学习基础设施的完整架构。
