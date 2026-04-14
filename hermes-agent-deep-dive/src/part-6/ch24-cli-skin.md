
# 第 24 章：CLI 交互设计与 Skin Engine

> **核心问题**：Rich + prompt_toolkit 如何构建交互式 CLI？Skin Engine 的主题系统如何工作？

---

## 24.1 HermesCLI 架构

当你在终端键入 `hermes` 并开始对话，你看到的一切——金色的 ASCII art banner、闪烁的 spinner、自动补全的斜杠命令、带语法高亮的代码块——都来自两个互补的库的精密协作：**Rich** 负责富文本输出，**prompt_toolkit** 负责交互式输入。理解这两个库如何被编织在一起，是理解整个 CLI 层的关键。

先看 `cli.py` 的导入区域，这是一份精心挑选的组件清单：

```python
# cli.py:39-56
from prompt_toolkit.history import FileHistory
from prompt_toolkit.styles import Style as PTStyle
from prompt_toolkit.patch_stdout import patch_stdout
from prompt_toolkit.application import Application
from prompt_toolkit.layout import Layout, HSplit, Window, FormattedTextControl, ConditionalContainer
from prompt_toolkit.layout.processors import Processor, Transformation
from prompt_toolkit.layout.dimension import Dimension
from prompt_toolkit.layout.menus import CompletionsMenu
from prompt_toolkit.widgets import TextArea
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit import print_formatted_text as _pt_print
from prompt_toolkit.formatted_text import ANSI as _PT_ANSI
```

这不是一个简单的 `input()` 替代品。`HermesCLI` 构建了一个完整的 TUI（Terminal User Interface）应用——用 `HSplit` 将终端垂直分割为多个区域：顶部的输出区域显示 AI 响应和工具执行结果，底部是固定的输入区域。`TextArea` 提供多行编辑、光标移动、历史回溯；`CompletionsMenu` 在你输入 `/` 时弹出命令菜单；`KeyBindings` 捕获 Ctrl+C、Ctrl+D 等快捷键。

这个架构带来一个棘手的问题：当 prompt_toolkit 控制终端输出时，其他线程（比如 spinner 动画线程、工具执行线程）不能直接写 `sys.stdout`。`patch_stdout` 上下文管理器解决了这个冲突——它用一个 `StdoutProxy` 替换 `sys.stdout`，将所有输出写入队列，由 prompt_toolkit 的事件循环在安全的时机刷新到屏幕上。

这个代理的存在直接影响了 `KawaiiSpinner` 的设计（我们在 24.4 节详述）。Spinner 必须检测自己是否在 `StdoutProxy` 下运行，如果是，就跳过基于 `\r` 的覆写动画——因为 `StdoutProxy` 会在每次 flush 时注入换行符，导致 spinner 的每一帧都出现在新的一行上。

`cli.py` 的配置加载函数 `load_cli_config()` 展示了另一个设计意图——它建立了一个优先级链：

```python
# cli.py:192-201
def load_cli_config() -> Dict[str, Any]:
    """
    Load CLI configuration from config files.

    Config lookup order:
    1. ~/.hermes/config.yaml (user config - preferred)
    2. ./cli-config.yaml (project config - fallback)

    Environment variables take precedence over config file values.
    """
```

用户配置 → 项目配置 → 硬编码默认值 → 环境变量覆盖。这个四层叠加的配置模型贯穿整个 Hermes，我们在第 25 章会做完整的分析。

CLI 的启动还有一个值得注意的细节——在任何 Rich 或 prompt_toolkit 代码执行之前，`cli.py` 的模块级代码就设置了 `os.environ["HERMES_QUIET"] = "1"`（第 34 行），抑制所有后续模块导入时的启动消息，确保用户看到的第一个输出是精心排版的 banner，而不是一堆 logging 噪声。

---

## 24.2 Slash 命令系统

当你在 CLI 中输入 `/help`，你触发了一个设计精良的命令分发系统。它的核心是一个数据驱动的注册表——`COMMAND_REGISTRY`，定义在 `hermes_cli/commands.py` 中。

每个命令是一个 frozen dataclass：

```python
# hermes_cli/commands.py:37-49
@dataclass(frozen=True)
class CommandDef:
    """Definition of a single slash command."""
    name: str                          # canonical name without slash
    description: str                   # human-readable description
    category: str                      # "Session", "Configuration", etc.
    aliases: tuple[str, ...] = ()      # alternative names: ("bg",)
    args_hint: str = ""                # argument placeholder
    subcommands: tuple[str, ...] = ()  # tab-completable subcommands
    cli_only: bool = False             # only available in CLI
    gateway_only: bool = False         # only available in gateway
    gateway_config_gate: str | None = None  # config dotpath override
```

`frozen=True` 是一个深思熟虑的选择——命令定义在模块加载后不可变，任何尝试运行时修改命令的行为都会抛出 `FrozenInstanceError`。注册表本身是一个列表，包含了大约 40 个命令，覆盖 Session、Configuration、Tools & Skills、Info 和 Exit 五个类别：

```python
# hermes_cli/commands.py:56-163 (sampled)
COMMAND_REGISTRY: list[CommandDef] = [
    CommandDef("new", "Start a new session", "Session", aliases=("reset",)),
    CommandDef("clear", "Clear screen and start a new session", "Session", cli_only=True),
    CommandDef("model", "Switch model for this session", "Configuration",
               args_hint="[model] [--global]"),
    CommandDef("skin", "Show or change the display skin/theme", "Configuration",
               cli_only=True, args_hint="[name]"),
    CommandDef("yolo", "Toggle YOLO mode (skip all dangerous command approvals)",
               "Configuration"),
    CommandDef("reasoning", "Manage reasoning effort and display", "Configuration",
               args_hint="[level|show|hide]",
               subcommands=("none", "minimal", "low", "medium", "high", ...)),
    CommandDef("quit", "Exit the CLI", "Exit", cli_only=True, aliases=("exit", "q")),
    # ...
]
```

这个注册表的巧妙之处在于它是**所有消费者的唯一数据源**。CLI 的 `/help` 输出、Gateway 的帮助文本、Telegram 的 BotCommands 菜单、Slack 的子命令映射、自动补全——全部从同一个 `COMMAND_REGISTRY` 派生。这避免了不同入口点之间的命令列表不一致。

派生数据在模块导入时构建一次：

```python
# hermes_cli/commands.py:170-180
def _build_command_lookup() -> dict[str, CommandDef]:
    """Map every name and alias to its CommandDef."""
    lookup: dict[str, CommandDef] = {}
    for cmd in COMMAND_REGISTRY:
        lookup[cmd.name] = cmd
        for alias in cmd.aliases:
            lookup[alias] = cmd
    return lookup

_COMMAND_LOOKUP: dict[str, CommandDef] = _build_command_lookup()
```

当插件注册新命令后，`rebuild_lookups()` 重建所有派生字典——`COMMANDS`、`COMMANDS_BY_CATEGORY`、`SUBCOMMANDS`、`GATEWAY_KNOWN_COMMANDS`——确保插件命令出现在帮助、自动补全、Gateway 分发等所有表面上。

自动补全器 `SlashCommandCompleter` 是一个值得细看的组件。它不仅补全斜杠命令，还支持三种上下文感知补全模式：

```python
# hermes_cli/commands.py:915-928
def get_completions(self, document, complete_event):
    text = document.text_before_cursor
    if not text.startswith("/"):
        # Try @ context completion (Claude Code-style)
        ctx_word = self._extract_context_word(text)
        if ctx_word is not None:
            yield from self._context_completions(ctx_word)
            return
        # Try file path completion for non-slash input
        path_word = self._extract_path_word(text)
        if path_word is not None:
            yield from self._path_completions(path_word)
        return
```

输入 `@` 触发 Claude Code 风格的上下文引用补全（`@diff`、`@staged`、`@file:path`）；输入包含 `/` 的路径片段触发文件路径补全；输入 `/model ` 后触发模型别名补全，从 `DIRECT_ALIASES` 和 `MODEL_ALIASES` 两个来源动态加载。这三种模式的优先级和触发条件都通过 `_extract_*_word()` 方法精确控制。

`SlashCommandAutoSuggest` 则提供"幽灵文本"（ghost text）——当你输入 `/upd` 时，后面会以灰色显示 `ate`，按右箭头接受。它与 `Completer` 的区别是：Completer 弹出菜单供用户选择，AutoSuggest 直接在光标后显示建议。

Gateway 端的命令路由有一个特殊机制——`gateway_config_gate`。某些命令（如 `/verbose`）在设计上是 `cli_only=True` 的，但可以通过 config.yaml 中的特定 dotpath 解锁 Gateway 可用性：

```python
# hermes_cli/commands.py:326-338
def _is_gateway_available(cmd: CommandDef, config_overrides: set[str] | None = None) -> bool:
    if not cmd.cli_only:
        return True
    if cmd.gateway_config_gate:
        overrides = config_overrides if config_overrides is not None else _resolve_config_gates()
        return cmd.name in overrides
    return False
```

Telegram 菜单注册还需要一个名称清洗步骤——Telegram Bot API 只允许小写字母、数字和下划线，所以 `_sanitize_telegram_name()` 将连字符替换为下划线，移除其他非法字符，并将名称截断到 32 字符限制。`_clamp_command_names()` 处理截断后的冲突——在名称末尾附加数字后缀以去重。

---

## 24.3 Skin Engine

Hermes 的主题系统是一个数据驱动的皮肤引擎，它让用户不修改一行代码就能完全改变 CLI 的视觉外观——从颜色方案到 spinner 动画到品牌文案。

引擎的核心数据结构是 `SkinConfig`：

```python
# hermes_cli/skin_engine.py:112-123
@dataclass
class SkinConfig:
    """Complete skin configuration."""
    name: str
    description: str = ""
    colors: Dict[str, str] = field(default_factory=dict)
    spinner: Dict[str, Any] = field(default_factory=dict)
    branding: Dict[str, str] = field(default_factory=dict)
    tool_prefix: str = "┊"
    tool_emojis: Dict[str, str] = field(default_factory=dict)
    banner_logo: str = ""    # Rich-markup ASCII art logo
    banner_hero: str = ""    # Rich-markup hero art
```

`colors` 字典定义了 15 个色彩槽位——从 `banner_border` 到 `ui_error` 到 `session_label`。每个槽位用 hex 色值表示（如 `"#FFD700"`），可以被 Rich 和 ANSI 转义码直接消费。`branding` 字典控制文本元素——agent 名称、欢迎语、告别语、提示符号。`spinner` 字典控制等待动画——kawaii 表情、思考动词、装饰翼。

系统内置了 7 个主题，每个都有完整的"人格"：

```python
# hermes_cli/skin_engine.py:151-504 (sampled)
_BUILTIN_SKINS: Dict[str, Dict[str, Any]] = {
    "default": { ... },    # Classic Hermes — gold and kawaii
    "ares": { ... },       # War-god — crimson and bronze
    "mono": { ... },       # Monochrome — clean grayscale
    "slate": { ... },      # Cool blue — developer-focused
    "poseidon": { ... },   # Ocean-god — deep blue and seafoam
    "sisyphus": { ... },   # Sisyphean — austere grayscale
    "charizard": { ... },  # Volcanic — burnt orange and ember
}
```

ares 的 spinner 说"forging"和"tempering steel"，poseidon 的说"charting currents"和"sounding the depth"，sisyphus 的说"resetting the boulder"和"enduring the loop"。每个战争/神话主题还包含自定义的 Rich markup ASCII art——ares 有一个盾牌图腾，poseidon 有一个三叉戟，sisyphus 有一块巨石，charizard 有一团火焰。这些图腾用 Unicode braille 字符绘制，再用 Rich 的 `[bold #color]...[/]` 标签着色。

主题加载遵循"用户优先，默认继承"原则：

```python
# hermes_cli/skin_engine.py:533-554
def _build_skin_config(data: Dict[str, Any]) -> SkinConfig:
    """Build a SkinConfig from a raw dict."""
    default = _BUILTIN_SKINS["default"]
    colors = dict(default.get("colors", {}))
    colors.update(data.get("colors", {}))
    spinner = dict(default.get("spinner", {}))
    spinner.update(data.get("spinner", {}))
    branding = dict(default.get("branding", {}))
    branding.update(data.get("branding", {}))
    return SkinConfig(
        name=data.get("name", "unknown"),
        colors=colors, spinner=spinner, branding=branding, ...
    )
```

无论是内置主题还是用户自定义 YAML，都先以 `default` 主题为基础，然后覆盖指定的字段。用户只需要在 `~/.hermes/skins/mytheme.yaml` 中指定想改变的部分，其余自动继承默认值。这个继承策略和第 25 章的配置合并逻辑是同一个模式——提供完善的默认值，只要求用户指定差异。

运行时的主题管理采用模块级全局单例模式，惰性初始化：

```python
# hermes_cli/skin_engine.py:510-625
_active_skin: Optional[SkinConfig] = None
_active_skin_name: str = "default"

def get_active_skin() -> SkinConfig:
    global _active_skin
    if _active_skin is None:
        _active_skin = load_skin(_active_skin_name)
    return _active_skin

def set_active_skin(name: str) -> SkinConfig:
    global _active_skin, _active_skin_name
    _active_skin_name = name
    _active_skin = load_skin(name)
    return _active_skin
```

`set_active_skin()` 在用户执行 `/skin ares` 时被调用，立即更新全局状态。但单纯切换数据还不够——prompt_toolkit 的 TUI 需要实时刷新样式。`get_prompt_toolkit_style_overrides()` 解决了这个问题：它从当前主题派生出 20 多个 prompt_toolkit 样式覆盖，包括输入区域颜色、补全菜单背景、审批框边框、sudo 提示颜色等。切换主题后，CLI 立即将这些覆盖应用到 TUI Application 上，用户无需重启就能看到新主题。

`display.py` 中的 diff 渲染也是主题感知的。`_diff_ansi()` 函数从当前主题解析颜色，将 hex 值转换为 ANSI 24-bit 颜色转义码，并缓存结果。当主题切换时，`reset_diff_colors()` 清除缓存，确保下一次 diff 渲染使用新主题的颜色。

---

## 24.4 KawaiiSpinner 与工具预览

`KawaiiSpinner` 是 CLI 在等待 API 响应或工具执行时的视觉反馈组件。它的设计看似简单——一个旋转的 Unicode 动画——但实际上要处理多种输出环境的适配。

```python
# agent/display.py:577-607
class KawaiiSpinner:
    SPINNERS = {
        'dots': ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
        'bounce': ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
        'grow': ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', ...],
        'star': ['✶', '✷', '✸', '✹', '✺', '✹', '✸', '✷'],
        'brain': ['🧠', '💭', '💡', '✨', '💫', '🌟', '💡', '💭'],
    }
    KAWAII_WAITING = ["(｡◕‿◕｡)", "(◕‿◕✿)", "٩(◕‿◕｡)۶", ...]
    KAWAII_THINKING = ["(｡•́︿•̀｡)", "(◔_◔)", "(¬‿¬)", ...]
    THINKING_VERBS = ["pondering", "contemplating", "musing", ...]
```

Spinner 运行在一个独立的 daemon 线程上，每 120 毫秒更新一帧。构造函数中有一个关键细节——它在创建时捕获 `sys.stdout` 的引用：

```python
# agent/display.py:623-624
self._out = sys.stdout  # Capture stdout NOW, before any redirect
```

这是因为子 agent 后来可能用 `redirect_stdout(devnull)` 替换 `sys.stdout`，如果 spinner 在那之后才读 `sys.stdout`，它会写到一个黑洞里。提前捕获确保 spinner 总能写到真实的终端。

`_animate()` 方法包含三个不同的代码路径：

**路径一：非 TTY**（Docker、systemd、管道）——跳过全部动画，只打印一行 `[tool] message`，避免日志噪声。

**路径二：StdoutProxy 下**（prompt_toolkit 的 `patch_stdout` 激活时）——完全静默，因为 CLI 有专用的 TUI widget 来显示 spinner 状态。

**路径三：真实 TTY**——使用 `\r` 回车符覆写当前行，展示带皮肤装饰翼的动画：

```python
# agent/display.py:692-707
skin = _get_skin()
wings = skin.get_spinner_wings() if skin else []
while self.running:
    frame = self.spinner_frames[self.frame_idx % len(self.spinner_frames)]
    elapsed = time.time() - self.start_time
    if wings:
        left, right = wings[self.frame_idx % len(wings)]
        line = f"  {left} {frame} {self.message} {right} ({elapsed:.1f}s)"
    else:
        line = f"  {frame} {self.message} ({elapsed:.1f}s)"
    self._write(f"\r{line}{' ' * pad}", end='', flush=True)
```

在 ares 主题下，spinner 会显示为 `⟪⚔ ⠹ forging ⚔⟫ (2.3s)`，而在 poseidon 主题下是 `⟪≈ ⠹ charting currents ≈⟫ (2.3s)`。

**工具预览系统**是 spinner 的补充。`build_tool_preview()` 为每个工具提取"主要参数"作为预览文本，使用一个硬编码的映射表：

```python
# agent/display.py:186-197
primary_args = {
    "terminal": "command", "web_search": "query", "web_extract": "urls",
    "read_file": "path", "write_file": "path", "patch": "path",
    "search_files": "pattern", "browser_navigate": "url",
    "skill_view": "name", "execute_code": "code",
    "delegate_task": "goal", "clarify": "question",
}
```

当工具完成执行时，`get_cute_tool_message()` 生成格式化的完成信息，替换掉 spinner。每个工具都有专属的 emoji 和动词——`🔍 search`、`💻 $`、`📖 read`、`✍️ write`、`🔧 patch`。路径使用尾部截断（`...path/to/file`），文本使用头部截断（`text...`）。失败的工具调用获得信息后缀（如 `[exit 1]` 或 `[error]`），通过 `_detect_tool_failure()` 检测。

**内联 diff 预览**是另一个精巧的显示功能。当 `write_file` 或 `patch` 成功执行后，系统自动显示彩色 unified diff。这通过 `LocalEditSnapshot` 实现——在工具执行前通过 `capture_local_edit_snapshot()` 捕获文件内容快照，执行后与当前内容比较。`_summarize_rendered_diff_sections()` 还实现了智能截断——最多显示 6 个文件、80 行 diff，超出部分显示 `… omitted N diff line(s) across M additional file(s)`。

---

## 24.5 CLI 子命令系统

`hermes_cli/main.py` 是整个 CLI 的入口分发器——它将 `hermes chat`、`hermes gateway start`、`hermes setup`、`hermes doctor` 等子命令路由到各自的处理模块。

但在任何 argparse 处理之前，有一个必须优先执行的步骤——Profile 覆盖：

```python
# hermes_cli/main.py:83-119
def _apply_profile_override() -> None:
    """Pre-parse --profile/-p and set HERMES_HOME before module imports."""
    argv = sys.argv[1:]
    profile_name = None

    # 1. Check for explicit -p / --profile flag
    for i, arg in enumerate(argv):
        if arg in ("--profile", "-p") and i + 1 < len(argv):
            profile_name = argv[i + 1]
            break

    # 2. If no flag, check active_profile sticky file
    if profile_name is None:
        active_path = get_default_hermes_root() / "active_profile"
        if active_path.exists():
            name = active_path.read_text().strip()
            if name and name != "default":
                profile_name = name
```

这个函数必须在**任何 Hermes 模块被 import 之前**运行，因为很多模块在模块级别就缓存了 `HERMES_HOME` 的值（我们在第 25 章详细分析 Profile 系统）。如果先 import 模块再设置 `HERMES_HOME`，那些模块就会使用错误的路径。

子命令涵盖了 Hermes 的整个操作面——`chat`（默认，启动交互式 CLI）、`gateway`（管理 Gateway 服务）、`setup`（交互式设置向导）、`config`（配置管理）、`model`（模型选择 TUI）、`tools`（工具管理 TUI）、`doctor`（诊断检查）、`profile`（Profile 管理）、`sessions`（会话浏览器）、`skills`（Skill Hub）、`cron`（定时任务管理）等。

某些交互式命令有一个 TTY 检查守卫：

```python
# hermes_cli/main.py:53-67
def _require_tty(command_name: str) -> None:
    if not sys.stdin.isatty():
        print(
            f"Error: 'hermes {command_name}' requires an interactive terminal.\n"
            f"It cannot be run through a pipe or non-interactive subprocess.",
            file=sys.stderr,
        )
        sys.exit(1)
```

这防止了需要 curses TUI 的命令在管道或非交互式环境中被调用——它们会因为没有 TTY 而 100% CPU 空转。

`main.py` 还支持 NixOS 容器模式。当 `~/.hermes/.container-mode` 文件存在时，宿主机上的 `hermes` 命令会透明地 `exec` 进入 Docker/Podman 容器内部运行。这在第 25 章的 managed mode 讨论中有更详细的分析。

---

## 速查表

| 文件 | 角色 | 关键组件 |
|------|------|----------|
| `cli.py` | HermesCLI 主逻辑 | prompt_toolkit Application, HSplit 布局, patch_stdout 桥接 |
| `hermes_cli/commands.py` | Slash 命令注册表 | COMMAND_REGISTRY, CommandDef, SlashCommandCompleter, SlashCommandAutoSuggest |
| `hermes_cli/skin_engine.py` | 主题引擎 | SkinConfig, 7 个内置主题, YAML 用户主题, 默认继承, get_prompt_toolkit_style_overrides |
| `agent/display.py` | 显示组件 | KawaiiSpinner (3 路径适配), build_tool_preview, get_cute_tool_message, LocalEditSnapshot diff |
| `hermes_cli/main.py` | CLI 入口与子命令 | _apply_profile_override (pre-import), argparse 子命令, _require_tty 守卫, 容器模式透传 |
