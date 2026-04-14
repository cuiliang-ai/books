
# 第 10 章：Tool Registry 与发现链

## 工具的集散中心

一个拥有 50+ 工具的 Agent 系统，面临的第一个架构挑战不是"如何调用工具"，而是"如何知道有哪些工具可以调用"。

答案藏在一个 336 行的文件里。`tools/registry.py` 定义了整个 Hermes Agent 工具系统的核心数据结构和注册协议。它不调用任何工具，不导入任何工具模块，甚至不知道 `terminal` 或 `web_search` 的存在。它只做一件事：提供一个全局注册中心，让每个工具文件在 import 时自报家门。

这种设计的关键在于**反向控制**：不是中心去发现工具，而是工具主动注册到中心。

---

## 10.1 ToolRegistry 单例模式

打开 `tools/registry.py`，跳到最底部，你会看到一行不起眼的代码：

```python
# tools/registry.py:290
registry = ToolRegistry()
```

这就是全局单例。没有用 `__new__` 重写、没有 metaclass、没有 `@singleton` 装饰器——就是一个模块级变量。Python 的模块系统天然保证同一个模块只被 import 一次（`sys.modules` 缓存），所以模块级变量就是最简单的单例实现。

`ToolRegistry` 的 `__init__` 只初始化两个字典：

```python
# tools/registry.py:48-53
class ToolRegistry:
    """Singleton registry that collects tool schemas + handlers from tool files."""

    def __init__(self):
        self._tools: Dict[str, ToolEntry] = {}
        self._toolset_checks: Dict[str, Callable] = {}
```

`_tools` 存储所有已注册工具的元数据，key 是工具名（如 `"terminal"`、`"web_search"`）。`_toolset_checks` 存储每个 toolset 的可用性检查函数——同一 toolset 的多个工具共享一个 check function，所以用 toolset 名做 key，不用工具名。

为什么不用 class-level 的 Borg 模式或者 `__new__` 单例？因为没必要。工具注册只发生在模块导入阶段，不存在竞争条件。而且模块级变量有一个额外好处：类型检查器和 IDE 能直接推断 `registry` 的类型，不需要额外的 `cast` 或 type: ignore。

---

## 10.2 ToolEntry：十槽数据结构

每个注册到 registry 的工具都被包装成一个 `ToolEntry` 对象。这个类使用 `__slots__` 优化内存布局：

```python
# tools/registry.py:24-45
class ToolEntry:
    """Metadata for a single registered tool."""

    __slots__ = (
        "name", "toolset", "schema", "handler", "check_fn",
        "requires_env", "is_async", "description", "emoji",
        "max_result_size_chars",
    )
```

十个 slot，每一个都有明确的职责：

| Slot | 类型 | 语义 |
|------|------|------|
| `name` | `str` | 工具唯一标识，如 `"terminal"` |
| `toolset` | `str` | 所属工具集，如 `"terminal"` 或 `"web"` |
| `schema` | `dict` | OpenAI function calling 格式的 JSON Schema |
| `handler` | `Callable` | 实际执行函数，接受 `(args, **kwargs)` |
| `check_fn` | `Callable` | 可用性检查函数，返回 `bool` |
| `requires_env` | `list` | 依赖的环境变量列表（用于 UI 提示） |
| `is_async` | `bool` | handler 是否返回 coroutine |
| `description` | `str` | 人类可读描述 |
| `emoji` | `str` | CLI 显示用的 emoji |
| `max_result_size_chars` | `int\|float\|None` | 每次调用返回的最大字符数 |

为什么用 `__slots__` 而不是普通 `__dict__`？50+ 个 ToolEntry 实例常驻内存，`__slots__` 省掉了每个实例的 `__dict__` 开销（通常 ~200 bytes/instance）。但更重要的是**可读性**——slots 声明明确告诉读者"这个类只有这 10 个字段，没有其他的"。

`check_fn` 是一个关键设计。并非所有工具在所有时候都可用——`web_search` 需要 API key，`browser_navigate` 需要 Playwright 安装，`ha_list_entities` 需要 Home Assistant token。`check_fn` 允许每个工具声明自己的可用性条件，registry 在生成 schema 时根据 `check_fn()` 的返回值过滤不可用的工具。

`requires_env` 看起来和 `check_fn` 功能重叠，但用途不同：`check_fn` 决定工具是否可用，`requires_env` 决定在 UI 中展示什么提示信息。一个工具的 `check_fn` 可能检查 10 种条件（安装状态、配置文件、网络连通性），但 `requires_env` 只列出关键的环境变量名，让用户知道该设置什么。

---

## 10.3 自注册模式

注册 API 的签名展示了设计意图——工具文件在被 import 时，立刻调用 `registry.register()` 完成自报家门：

```python
# tools/registry.py:59-93
def register(
    self,
    name: str,
    toolset: str,
    schema: dict,
    handler: Callable,
    check_fn: Callable = None,
    requires_env: list = None,
    is_async: bool = False,
    description: str = "",
    emoji: str = "",
    max_result_size_chars: int | float | None = None,
):
    """Register a tool.  Called at module-import time by each tool file."""
    existing = self._tools.get(name)
    if existing and existing.toolset != toolset:
        logger.warning(
            "Tool name collision: '%s' (toolset '%s') is being "
            "overwritten by toolset '%s'",
            name, existing.toolset, toolset,
        )
    self._tools[name] = ToolEntry(...)
```

注意第 73-79 行的冲突检测：如果两个不同 toolset 试图注册同名工具，registry 会发出 warning 但仍允许覆盖。这是一个宽容策略——MCP 和 plugin 系统可能注册与内置工具同名的增强版本，覆盖是预期行为。但如果同一 toolset 内部重复注册（比如因为模块被 import 了两次），则静默覆盖，不发 warning。

第 92-93 行有一个微妙的优化：

```python
if check_fn and toolset not in self._toolset_checks:
    self._toolset_checks[toolset] = check_fn
```

同一个 toolset 的所有工具共享同一个 `check_fn`。`web_search` 和 `web_extract` 都属于 `"web"` toolset，它们的可用性条件是相同的（有没有配置 web backend），所以只需要存储一次。这避免了在 `get_definitions()` 中对同一个检查函数重复调用。

---

## 10.4 反循环 import 链

文件头部的注释揭示了一个关键的架构决策：

```python
# tools/registry.py:1-14
"""Central registry for all hermes-agent tools.

Import chain (circular-import safe):
    tools/registry.py  (no imports from model_tools or tool files)
           ^
    tools/*.py  (import from tools.registry at module level)
           ^
    model_tools.py  (imports tools.registry + all tool modules)
           ^
    run_agent.py, cli.py, batch_runner.py, etc.
"""
```

这是一个严格的**单向依赖图**。`registry.py` 不 import 任何工具文件，工具文件 import `registry.py`，`model_tools.py` import 所有工具文件。箭头永远向上，不会形成环。

为什么这很重要？考虑一个循环 import 的灾难场景：如果 `registry.py` import 了 `terminal_tool.py`（比如为了注册 terminal 工具），而 `terminal_tool.py` 又 import 了 `registry.py`（为了获取 `registry` 实例），Python 会在第二次 import 时得到一个**部分初始化**的模块——`registry` 变量可能还不存在，导致 `AttributeError`。

自注册模式完美避免了这个问题。`registry.py` 只定义数据结构，不触发任何 import。工具文件在自己的模块顶层调用 `registry.register()`，此时 `registry.py` 已经完全初始化。`model_tools.py` 最后一个 import 所有工具文件，触发连锁注册。

这个 import 链在 `model_tools.py` 的第 29 行体现得很清楚：

```python
# model_tools.py:29
from tools.registry import registry
```

这是 `model_tools.py` 对 registry 的唯一 import。之后的 `_discover_tools()` 函数通过 `importlib.import_module()` 动态加载所有工具模块，触发它们的注册调用。

---

## 10.5 三阶段工具发现

`model_tools.py` 的模块顶层执行了一个三阶段的发现流程：

**第一阶段：内置工具** — `_discover_tools()` 在模块加载时自动执行：

```python
# model_tools.py:132-168
def _discover_tools():
    _modules = [
        "tools.web_tools",
        "tools.terminal_tool",
        "tools.file_tools",
        "tools.vision_tools",
        # ... 20 个模块
        "tools.homeassistant_tool",
    ]
    import importlib
    for mod_name in _modules:
        try:
            importlib.import_module(mod_name)
        except Exception as e:
            logger.warning("Could not import tool module %s: %s", mod_name, e)

_discover_tools()  # 模块加载时执行
```

关键设计：每个 import 都被 try/except 包裹。如果某个工具模块因为缺少依赖而 import 失败（比如 `fal_client` 没安装导致 image generation 不可用），其他工具不受影响。这是一种**容错式发现**——系统永远能启动，即使某些工具不可用。

**第二阶段：MCP 工具** — 紧随其后：

```python
# model_tools.py:172-177
try:
    from tools.mcp_tool import discover_mcp_tools
    discover_mcp_tools()
except Exception as e:
    logger.debug("MCP tool discovery failed: %s", e)
```

MCP（Model Context Protocol）服务器可以提供额外的工具。`discover_mcp_tools()` 读取配置中的 MCP server 列表，连接每个服务器，获取其暴露的工具 schema，然后通过 `registry.register()` 将这些外部工具注册到同一个 registry 中。从 registry 的角度看，MCP 工具和内置工具没有区别——它们都是 ToolEntry。

**第三阶段：Plugin 工具** — 最后执行：

```python
# model_tools.py:179-184
try:
    from hermes_cli.plugins import discover_plugins
    discover_plugins()
except Exception as e:
    logger.debug("Plugin discovery failed: %s", e)
```

Plugin 系统允许用户和第三方通过 pip 包或本地文件扩展 Hermes 的工具集。Plugin 使用和内置工具相同的 `registry.register()` API——自注册模式对所有参与者一视同仁。

三阶段的顺序有意义：内置工具先注册（基线），MCP 工具可能覆盖同名内置工具（增强），Plugin 工具最后注册（最高优先级）。冲突时后注册的覆盖先注册的，但 registry 会记录 warning。

---

## 10.6 Schema 检索与 check_fn 缓存

当 Agent 需要构建发送给 LLM 的 tool definitions 时，最终会调用 `registry.get_definitions()`：

```python
# tools/registry.py:116-143
def get_definitions(self, tool_names: Set[str], quiet: bool = False) -> List[dict]:
    result = []
    check_results: Dict[Callable, bool] = {}
    for name in sorted(tool_names):
        entry = self._tools.get(name)
        if not entry:
            continue
        if entry.check_fn:
            if entry.check_fn not in check_results:
                try:
                    check_results[entry.check_fn] = bool(entry.check_fn())
                except Exception:
                    check_results[entry.check_fn] = False
            if not check_results[entry.check_fn]:
                continue
        schema_with_name = {**entry.schema, "name": entry.name}
        result.append({"type": "function", "function": schema_with_name})
    return result
```

这段代码有两个精妙之处：

**check_fn 结果缓存**（第 123 行的 `check_results` 字典）：同一个 check function 只调用一次。假设 `web_search` 和 `web_extract` 共享同一个 `check_firecrawl_api_key` 函数，`check_results` 确保它只被调用一次，结果被复用。这不仅是性能优化——某些 check function 可能涉及网络调用（检查 Docker 是否运行、MCP 服务器是否可达），避免重复调用是必要的。

**异常安全**（第 131-133 行）：如果 check function 抛出异常，工具被视为不可用（`False`），但不会中断整个 schema 生成流程。这遵循了贯穿 Hermes 的**优雅降级**原则。

返回值是标准的 OpenAI function calling 格式：`[{"type": "function", "function": {...}}]`。第 141 行的 `{**entry.schema, "name": entry.name}` 确保即使原始 schema 没有 `name` 字段，最终输出也一定包含。

---

## 10.7 工具分发与异步桥接

当 LLM 决定调用某个工具时，调用链最终到达 `registry.dispatch()`：

```python
# tools/registry.py:149-166
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
        logger.exception("Tool %s dispatch error: %s", name, e)
        return json.dumps({"error": f"Tool execution failed: ..."})
```

注意异步处理的延迟 import：`from model_tools import _run_async` 写在 `dispatch()` 内部而不是模块顶部。这不是代码风格问题——这是为了维护 import 链的单向性。`registry.py` 不能在模块级 import `model_tools`，因为 `model_tools` import `registry.py`。延迟 import 在运行时（`dispatch()` 被调用时）解析依赖，此时 `model_tools` 已经完全加载。

`_run_async()` 本身（详见第 11 章）是一个三路桥接函数，根据当前线程状态选择不同的策略：主线程用持久化 event loop，工作线程用 per-thread event loop，已有 running loop 时用 ThreadPoolExecutor 跳板。

所有异常都被捕获并转换为 JSON 错误字符串。这是一个重要的合约：**dispatch 永远返回 str，永远不抛异常**。调用方不需要 try/except。

---

## 10.8 工具响应序列化助手

文件末尾定义了两个辅助函数，消除了整个代码库中数百次重复的 `json.dumps` 样板：

```python
# tools/registry.py:309-335
def tool_error(message, **extra) -> str:
    result = {"error": str(message)}
    if extra:
        result.update(extra)
    return json.dumps(result, ensure_ascii=False)

def tool_result(data=None, **kwargs) -> str:
    if data is not None:
        return json.dumps(data, ensure_ascii=False)
    return json.dumps(kwargs, ensure_ascii=False)
```

`ensure_ascii=False` 是一个被忽视但重要的细节。Hermes 支持中文、日文等非 ASCII 内容，如果使用默认的 `ensure_ascii=True`，所有非 ASCII 字符都会被转义为 `\uXXXX`，浪费 token 且降低可读性。

工具文件的导入模式因此变成标准化的单行：

```python
from tools.registry import registry, tool_error, tool_result
```

三个名字，一行导入，覆盖了工具文件的所有 registry 交互需求。

---

## 10.9 Deregister：为 MCP 而生

`deregister()` 方法的存在揭示了一个动态性需求：

```python
# tools/registry.py:95-110
def deregister(self, name: str) -> None:
    """Remove a tool from the registry.

    Used by MCP dynamic tool discovery to nuke-and-repave
    when a server sends ``notifications/tools/list_changed``.
    """
    entry = self._tools.pop(name, None)
    if entry is None:
        return
    if entry.toolset in self._toolset_checks and not any(
        e.toolset == entry.toolset for e in self._tools.values()
    ):
        self._toolset_checks.pop(entry.toolset, None)
```

MCP 服务器可以在运行时动态更改其暴露的工具列表（通过 `notifications/tools/list_changed` 通知）。当这种情况发生时，Hermes 的 MCP 客户端需要先删除旧工具、再注册新工具——这就是 `deregister()` 的用途。

代码中的清理逻辑值得注意：删除工具后，检查同一 toolset 是否还有其他工具。如果某 toolset 的最后一个工具被删除，对应的 `_toolset_checks` 条目也一并清理。这防止了 "phantom toolset" 问题——toolset 的 check function 还在，但实际上已经没有属于它的工具了。

内置工具不需要 `deregister()`——它们在进程生命周期内是常驻的。只有 MCP 和 Plugin 工具才有动态卸载的需求。

---

## 10.10 查询辅助方法

`ToolRegistry` 类提供了一组查询方法，替代了旧版 `model_tools.py` 中散落的字典和函数：

```python
# tools/registry.py:172-286
def get_max_result_size(self, name, default=None) -> int | float:
def get_all_tool_names(self) -> List[str]:
def get_schema(self, name) -> Optional[dict]:
def get_toolset_for_tool(self, name) -> Optional[str]:
def get_emoji(self, name, default="⚡") -> str:
def get_tool_to_toolset_map(self) -> Dict[str, str]:
def is_toolset_available(self, toolset) -> bool:
def check_toolset_requirements(self) -> Dict[str, bool]:
def get_available_toolsets(self) -> Dict[str, dict]:
def get_toolset_requirements(self) -> Dict[str, dict]:
def check_tool_availability(self, quiet=False):
```

这些方法的共同特征是**安全取值**——对不存在的工具名返回 `None` 或默认值，从不抛 `KeyError`。`get_emoji()` 的 `default="⚡"` 参数确保 CLI 显示永远有一个 emoji，即使某个工具忘记注册 emoji。

`get_schema()` 特别值得注意：它不经过 `check_fn` 过滤。这是为 token 估算和内省设计的——你可能需要知道一个工具的 schema 有多大（影响 context window），即使这个工具当前不可用。

`model_tools.py` 在发现阶段结束后（第 191-193 行），用这些查询方法构建向后兼容的常量：

```python
# model_tools.py:191-193
TOOL_TO_TOOLSET_MAP: Dict[str, str] = registry.get_tool_to_toolset_map()
TOOLSET_REQUIREMENTS: Dict[str, dict] = registry.get_toolset_requirements()
```

这些常量曾经是 `model_tools.py` 中手动维护的巨型字典。重构后，它们从 registry 自动生成——单一事实来源（single source of truth）。

---

## 本章小结

Tool Registry 的设计遵循了一个简单的原则：**让注册成本最低，让查询最安全**。

工具文件只需要在模块顶层调用一次 `registry.register()`，提供 name、schema、handler 三个必要参数，就完成了整个注册流程。不需要继承基类，不需要实现接口，不需要在某个中心配置文件里添加条目。这使得添加新工具变得极其容易——写好工具函数，注册到 registry，在 `_discover_tools()` 列表里加一行 import。

查询侧同样简单：`get_definitions()` 一次调用返回 LLM 可用的 schema 列表，自动过滤不可用的工具；`dispatch()` 一次调用完成工具执行，自动处理异步桥接和异常捕获。

下一章我们将看到 ToolRegistry 之上的下一层抽象——Toolset 代数系统，它决定了 50+ 工具如何被分组、组合、过滤，最终交付到不同平台的 Agent 手中。

---

## 速查表

| 文件 | 行数 | 角色 |
|------|------|------|
| `tools/registry.py` | 336 | ToolRegistry 单例 + ToolEntry 数据结构 + 注册/分发/查询 API |
| `model_tools.py` | 578 | 三阶段工具发现 + get_tool_definitions + handle_function_call |
| `tools/*.py` (各工具文件) | — | 模块顶层调用 `registry.register()` 自注册 |

| 概念 | 说明 |
|------|------|
| ToolEntry | 10-slot 数据结构，描述一个工具的全部元数据 |
| 自注册模式 | 工具文件在 import 时主动调用 `registry.register()` |
| 三阶段发现 | 内置工具 → MCP 工具 → Plugin 工具，容错加载 |
| check_fn 缓存 | `get_definitions()` 对同一 check function 只调用一次 |
| 异步桥接 | `dispatch()` 通过延迟 import `_run_async` 处理 async handler |
| deregister | MCP nuke-and-repave 场景的动态工具卸载 |
| tool_error/tool_result | 标准化 JSON 响应序列化，`ensure_ascii=False` |
