
# 第 11 章：Toolset 代数与工具分类

## 工具集的组合数学

上一章我们看到了 ToolRegistry 如何让 50+ 工具完成自注册。但注册只是第一步——下一个问题是：**哪些工具应该交付给哪个 Agent 实例？**

一个在 Telegram 上运行的 Hermes bot 需要和在 CLI 中运行的 Hermes 使用相同的工具集吗？一个被委派的子 Agent 应该继承父 Agent 的所有工具吗？一个只需要做 web research 的任务，为什么要加载 browser automation 的 10 个工具？

`toolsets.py`（656 行）回答了这些问题。它定义了一个**工具集代数系统**——一组命名的工具集合，支持引用包含、递归展开、菱形依赖去重、运行时动态创建。如果说 ToolRegistry 是工具的仓库，那 Toolset 就是工具的配送系统。

---

## 11.1 核心工具清单：_HERMES_CORE_TOOLS

打开 `toolsets.py`，第一个映入眼帘的数据结构是一个 34 元素的列表：

```python
# toolsets.py:31-63
_HERMES_CORE_TOOLS = [
    # Web
    "web_search", "web_extract",
    # Terminal + process management
    "terminal", "process",
    # File manipulation
    "read_file", "write_file", "patch", "search_files",
    # Vision + image generation
    "vision_analyze", "image_generate",
    # Skills
    "skills_list", "skill_view", "skill_manage",
    # Browser automation
    "browser_navigate", "browser_snapshot", "browser_click",
    "browser_type", "browser_scroll", "browser_back",
    "browser_press", "browser_get_images",
    "browser_vision", "browser_console",
    # Text-to-speech
    "text_to_speech",
    # Planning & memory
    "todo", "memory",
    # Session history search
    "session_search",
    # Clarifying questions
    "clarify",
    # Code execution + delegation
    "execute_code", "delegate_task",
    # Cronjob management
    "cronjob",
    # Cross-platform messaging
    "send_message",
    # Home Assistant
    "ha_list_entities", "ha_get_state", "ha_list_services", "ha_call_service",
]
```

这个列表的注释 "Shared tool list for CLI and all messaging platform toolsets. Edit this once to update all platforms simultaneously." 揭示了它的核心目的：**单点维护**。

Hermes 支持 15+ 个消息平台（Telegram、Discord、Slack、WhatsApp、Signal、Matrix、DingTalk、Feishu...），每个平台的 bot 都需要相同的基础工具集。如果每个平台 toolset 各自维护一份工具列表，添加一个新工具就意味着修改 15 个地方。`_HERMES_CORE_TOOLS` 把这变成了修改一处。

注意列表中包含了一些通过 `check_fn` 门控的工具：`send_message` 需要 gateway 运行，`ha_list_entities` 等 Home Assistant 工具需要 `HASS_TOKEN`。它们被包含在 core list 中不是因为它们总是可用，而是因为它们应该在**所有平台**上可用（只要条件满足）。可用性检查是 ToolRegistry 的责任，不是 Toolset 的责任。

---

## 11.2 TOOLSETS 字典：叶子与组合

`TOOLSETS` 是一个字典，key 是 toolset 名称，value 是一个结构化定义：

```python
# toolsets.py:68-391
TOOLSETS = {
    "web": {
        "description": "Web research and content extraction tools",
        "tools": ["web_search", "web_extract"],
        "includes": []
    },
    "terminal": {
        "description": "Terminal/command execution and process management tools",
        "tools": ["terminal", "process"],
        "includes": []
    },
    "browser": {
        "description": "Browser automation for web interaction...",
        "tools": [
            "browser_navigate", "browser_snapshot", "browser_click",
            "browser_type", "browser_scroll", "browser_back",
            "browser_press", "browser_get_images",
            "browser_vision", "browser_console", "web_search"
        ],
        "includes": []
    },
    # ...
}
```

每个 toolset 有三个字段：

- `description`: 人类可读的描述，被 CLI 和 delegate_task schema 使用
- `tools`: 直接包含的工具名列表
- `includes`: 引用其他 toolset 的名称列表

这三个字段定义了两类 toolset：

**叶子 toolset**（`includes` 为空）：直接列出工具名。如 `"web"` 包含 `["web_search", "web_extract"]`，`"terminal"` 包含 `["terminal", "process"]`。它们是原子单位。

**组合 toolset**（`includes` 非空）：通过引用其他 toolset 来组合。最典型的例子是 `"debugging"`：

```python
"debugging": {
    "description": "Debugging and troubleshooting toolkit",
    "tools": ["terminal", "process"],
    "includes": ["web", "file"]
},
```

`"debugging"` 自身直接包含 `["terminal", "process"]`，同时通过 `includes` 引入 `"web"` 和 `"file"` 的全部工具。展开后的工具集是：`terminal`, `process`, `web_search`, `web_extract`, `read_file`, `write_file`, `patch`, `search_files`。

另一个组合 toolset 是 `"safe"`——一个没有终端访问的安全工具集：

```python
"safe": {
    "description": "Safe toolkit without terminal access",
    "tools": [],
    "includes": ["web", "vision", "image_gen"]
},
```

注意 `tools` 为空列表——所有工具完全来自 `includes`。这是组合 toolset 的极端形式。

`"browser"` toolset 有一个有趣的设计决策：它的 `tools` 列表中包含了 `"web_search"`，虽然 `"web_search"` 同时也属于 `"web"` toolset。这不是错误——`browser_navigate` 的 schema 描述中说 "For simple information retrieval, prefer web_search or web_extract"，所以 browser toolset 需要包含 `web_search` 以确保模型在只启用 browser toolset 时也能执行 web 搜索。

---

## 11.3 平台 Toolset：15 个平台共享一份列表

`TOOLSETS` 字典中最大的一块是 15 个消息平台的 toolset 定义：

```python
# toolsets.py:278-391
"hermes-cli": {
    "description": "Full interactive CLI toolset",
    "tools": _HERMES_CORE_TOOLS,
    "includes": []
},
"hermes-telegram": {
    "description": "Telegram bot toolset",
    "tools": _HERMES_CORE_TOOLS,
    "includes": []
},
"hermes-discord": {
    "description": "Discord bot toolset",
    "tools": _HERMES_CORE_TOOLS,
    "includes": []
},
# ... hermes-whatsapp, hermes-slack, hermes-signal, hermes-bluebubbles,
# hermes-homeassistant, hermes-email, hermes-mattermost, hermes-matrix,
# hermes-dingtalk, hermes-feishu, hermes-weixin, hermes-wecom,
# hermes-wecom-callback, hermes-sms, hermes-webhook
```

每一个都引用 `_HERMES_CORE_TOOLS`——Python 列表是引用传递，所以它们共享同一个列表对象。修改 `_HERMES_CORE_TOOLS` 就修改了所有 15 个平台的工具集。

`hermes-acp` 是个例外。它用于编辑器集成（VS Code、Zed、JetBrains），有自己的精简工具列表——没有 `clarify`（IDE 不支持多选 UI），没有 `text_to_speech`（IDE 不播放音频），没有 `send_message`（代码编辑不需要跨平台消息），没有 `image_generate`（聚焦编程）。

`hermes-gateway` 是最终的组合 toolset：

```python
"hermes-gateway": {
    "description": "Gateway toolset - union of all messaging platform tools",
    "tools": [],
    "includes": ["hermes-telegram", "hermes-discord", "hermes-whatsapp",
                  "hermes-slack", "hermes-signal", "hermes-bluebubbles",
                  "hermes-homeassistant", "hermes-email", "hermes-sms",
                  "hermes-mattermost", "hermes-matrix", "hermes-dingtalk",
                  "hermes-feishu", "hermes-wecom", "hermes-wecom-callback",
                  "hermes-weixin", "hermes-webhook"]
},
```

Gateway 进程同时服务所有消息平台，所以它的 toolset 是所有平台 toolset 的并集。由于每个平台 toolset 目前都使用 `_HERMES_CORE_TOOLS`，展开后 `hermes-gateway` 的工具集和 `hermes-cli` 相同。但如果将来某个平台需要独有工具（比如 Telegram 的投票功能），只需要在该平台的 `tools` 列表中添加，gateway 会自动包含。

---

## 11.4 resolve_toolset()：图展开与环检测

给定一个 toolset 名称，如何得到它包含的所有工具名？这是 `resolve_toolset()` 的工作：

```python
# toolsets.py:410-467
def resolve_toolset(name: str, visited: Set[str] = None) -> List[str]:
    if visited is None:
        visited = set()

    # Special aliases
    if name in {"all", "*"}:
        all_tools: Set[str] = set()
        for toolset_name in get_toolset_names():
            resolved = resolve_toolset(toolset_name, visited.copy())
            all_tools.update(resolved)
        return list(all_tools)

    # Cycle / diamond detection
    if name in visited:
        return []

    visited.add(name)

    toolset = TOOLSETS.get(name)
    if not toolset:
        # Plugin fallback
        if name in _get_plugin_toolset_names():
            from tools.registry import registry
            return [e.name for e in registry._tools.values() if e.toolset == name]
        return []

    tools = set(toolset.get("tools", []))

    for included_name in toolset.get("includes", []):
        included_tools = resolve_toolset(included_name, visited)
        tools.update(included_tools)

    return list(tools)
```

这是一个经典的**图遍历**算法，用 `visited` 集合处理两种边界情况：

**环检测**（第 440-441 行）：如果 A includes B，B includes A，递归会无限循环。`visited` 集合记录已经访问过的节点，再次访问时直接返回空列表。代码注释说 "Silently return [] — either this is a diamond (not a bug, tools already collected via another path) or a genuine cycle (safe to skip)."

**菱形依赖去重**（同样的 `visited` 机制）：如果 C includes A 和 B，A 和 B 都 includes D，D 的工具只需要收集一次。当从 A 路径访问 D 时，D 被加入 `visited`；从 B 路径再次遇到 D 时，直接跳过。结果集使用 `set` 类型，所以即使 D 的工具被多路径添加，也天然去重。

`"all"` 和 `"*"` 是特殊别名（第 429-435 行），展开为所有已知 toolset 的并集。注意每个分支使用 `visited.copy()` 创建独立的 visited 集合——这是因为 "all" 需要遍历所有 toolset，不能让一个分支的 visited 状态污染其他分支。

Plugin 回退（第 448-452 行）是一个优雅的扩展点：如果一个 toolset 名在 `TOOLSETS` 字典中找不到，但 registry 中存在属于该 toolset 的工具（由 plugin 注册），则直接从 registry 中收集。这意味着 plugin 不需要修改 `toolsets.py`——只需要在注册工具时指定 toolset 名，`resolve_toolset()` 就能发现它们。

---

## 11.5 resolve_multiple_toolsets()：集合并

多个 toolset 的组合更简单——就是集合并：

```python
# toolsets.py:470-486
def resolve_multiple_toolsets(toolset_names: List[str]) -> List[str]:
    all_tools = set()
    for name in toolset_names:
        tools = resolve_toolset(name)
        all_tools.update(tools)
    return list(all_tools)
```

这个函数是 Agent 初始化时的主要入口。`run_agent.py` 传入 `enabled_toolsets=["hermes-cli"]`，或者 gateway 传入 `enabled_toolsets=["hermes-telegram"]`，最终都通过 `resolve_multiple_toolsets()` 转换为具体的工具名列表。

---

## 11.6 get_tool_definitions()：从 Toolset 到 Schema

`model_tools.py` 的 `get_tool_definitions()` 是 Toolset 系统的最终消费者。它执行一个三步管线：

**步骤一：Toolset 展开**（第 255-299 行）

```python
# model_tools.py:255-259
if enabled_toolsets is not None:
    for toolset_name in enabled_toolsets:
        if validate_toolset(toolset_name):
            resolved = resolve_toolset(toolset_name)
            tools_to_include.update(resolved)
```

`enabled_toolsets` 参数决定哪些 toolset 被激活。如果不提供（默认），则激活所有 toolset。如果提供了 `disabled_toolsets`，则从全集中减去指定的 toolset。

向后兼容也在这里处理：旧版配置可能使用 `"web_tools"` 这样的后缀名（来自 `_LEGACY_TOOLSET_MAP`），新代码会自动映射到 `["web_search", "web_extract"]`。

**步骤二：Registry 过滤**（第 302 行）

```python
filtered_tools = registry.get_definitions(tools_to_include, quiet=quiet_mode)
```

从 Toolset 展开得到的是**期望的**工具名集合。但实际可用的工具可能更少——`check_fn` 失败的工具会被过滤掉。`available_tool_names` 是过滤后**实际可用**的工具名。

**步骤三：动态 Schema 重写**（第 314-341 行）

这是最精妙的部分。两个特殊工具的 schema 需要根据实际可用的工具集动态调整：

```python
# model_tools.py:314-322
if "execute_code" in available_tool_names:
    from tools.code_execution_tool import SANDBOX_ALLOWED_TOOLS, build_execute_code_schema
    sandbox_enabled = SANDBOX_ALLOWED_TOOLS & available_tool_names
    dynamic_schema = build_execute_code_schema(sandbox_enabled)
    for i, td in enumerate(filtered_tools):
        if td.get("function", {}).get("name") == "execute_code":
            filtered_tools[i] = {"type": "function", "function": dynamic_schema}
            break
```

`execute_code` 的 schema 中列出了 sandbox 里可用的工具。如果 `web_search` 因为没有 API key 而不可用，`execute_code` 的 schema 就不应该提到 `web_search`——否则 LLM 会在 sandbox 代码中调用一个不存在的工具。

`browser_navigate` 也有类似的动态调整：如果 `web_search` 和 `web_extract` 都不可用，就从 `browser_navigate` 的描述中删掉 "prefer web_search or web_extract" 的建议，防止 LLM 幻觉调用不存在的工具。

这种**schema 随可用性动态变化**的设计，是 Hermes 工具系统的一个独特特征。大多数 Agent 框架的 tool schema 是静态的，在启动时确定后就不再改变。Hermes 在每次调用 `get_tool_definitions()` 时都会重新计算可用性，确保 LLM 看到的 schema 总是反映当前的真实状态。

---

## 11.7 运行时 Toolset 创建

`create_custom_toolset()` 允许在运行时动态创建新的 toolset：

```python
# toolsets.py:566-585
def create_custom_toolset(
    name: str,
    description: str,
    tools: List[str] = None,
    includes: List[str] = None
) -> None:
    TOOLSETS[name] = {
        "description": description,
        "tools": tools or [],
        "includes": includes or []
    }
```

它直接修改 `TOOLSETS` 字典——没有验证 `tools` 列表中的工具名是否存在，也没有检查 `includes` 引用的 toolset 是否有效。这是故意的宽松设计：运行时创建的 toolset 可能引用尚未注册的工具（plugin 可能稍后注册），过早验证会导致合法用例失败。

---

## 11.8 Plugin Toolset 桥接

Plugin 工具注册到 ToolRegistry 时指定一个 toolset 名。如果这个 toolset 名不在 `TOOLSETS` 字典中，它就成为一个"plugin-only toolset"。`_get_plugin_toolset_names()` 负责发现这些 toolset：

```python
# toolsets.py:489-503
def _get_plugin_toolset_names() -> Set[str]:
    try:
        from tools.registry import registry
        return {
            entry.toolset
            for entry in registry._tools.values()
            if entry.toolset not in TOOLSETS
        }
    except Exception:
        return set()
```

这个函数遍历 registry 中所有工具，找出 toolset 名不在 `TOOLSETS` 中的——这些就是由 plugin 引入的动态 toolset。

`get_all_toolsets()` 合并静态和动态 toolset：

```python
# toolsets.py:506-528
def get_all_toolsets() -> Dict[str, Dict[str, Any]]:
    result = TOOLSETS.copy()
    for ts_name in _get_plugin_toolset_names():
        if ts_name not in result:
            from tools.registry import registry
            tools = [e.name for e in registry._tools.values() if e.toolset == ts_name]
            result[ts_name] = {
                "description": f"Plugin toolset: {ts_name}",
                "tools": tools,
            }
    return result
```

Plugin toolset 的 description 被设置为 `"Plugin toolset: {name}"`，让用户在 CLI 的 toolset 列表中能区分内置和 plugin 工具集。

---

## 11.9 参数类型矫正：coerce_tool_args

虽然不属于 Toolset 系统，但 `model_tools.py` 中的 `coerce_tool_args()` 是工具分发管线的关键一环，值得在这里提及：

```python
# model_tools.py:372-408
def coerce_tool_args(tool_name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    schema = registry.get_schema(tool_name)
    if not schema:
        return args
    properties = (schema.get("parameters") or {}).get("properties")
    for key, value in args.items():
        if not isinstance(value, str):
            continue
        prop_schema = properties.get(key)
        expected = prop_schema.get("type")
        coerced = _coerce_value(value, expected)
        if coerced is not value:
            args[key] = coerced
    return args
```

LLM 经常把数字返回为字符串（`"42"` 而不是 `42`），把布尔值返回为字符串（`"true"` 而不是 `true`）。`coerce_tool_args()` 对照工具的 JSON Schema，把字符串值安全地转换为声明的类型。

支持三种类型矫正：`"integer"` / `"number"` 的字符串→数字转换，`"boolean"` 的字符串→布尔值转换，以及联合类型（`"type": ["integer", "string"]`）的逐一尝试。转换失败时保留原始字符串值，不抛异常。

这个矫正发生在 `handle_function_call()` 的第一行（第 485 行），在工具实际执行之前。所有工具都受益于这个全局矫正，不需要各自处理类型转换。

---

## 11.10 _AGENT_LOOP_TOOLS：被拦截的工具

`model_tools.py` 定义了一个特殊集合：

```python
# model_tools.py:364-365
_AGENT_LOOP_TOOLS = {"todo", "memory", "session_search", "delegate_task"}
```

这四个工具的 handler 不通过 `registry.dispatch()` 执行——它们被 Agent 主循环（`run_agent.py`）拦截，因为它们需要访问 Agent 级别的状态（TodoStore、MemoryStore、session DB 等），这些状态不在 registry 的作用域内。

如果某个调用路径绕过了 Agent 主循环（比如 PTC sandbox 中的直接 dispatch），这些工具会返回一个说明性错误：

```python
if function_name in _AGENT_LOOP_TOOLS:
    return json.dumps({"error": f"{function_name} must be handled by the agent loop"})
```

这是一种**防御性编程**——确保即使在非预期路径上，工具也不会静默失败。

---

## 本章小结

Toolset 代数系统解决了"哪些工具在哪里可用"的问题。它的核心抽象是一个带 `tools` 和 `includes` 字段的字典条目，通过 `resolve_toolset()` 的递归展开实现组合。

`_HERMES_CORE_TOOLS` 列表确保 15+ 消息平台共享同一份工具清单，单点修改全局生效。`hermes-gateway` 作为顶层组合 toolset 汇聚所有平台工具。Plugin 工具通过 `_get_plugin_toolset_names()` 自动发现，无需修改静态配置。

`get_tool_definitions()` 的三步管线（Toolset 展开 → Registry 过滤 → 动态 Schema 重写）确保 LLM 看到的工具描述总是准确反映当前的可用状态——这一点比大多数 Agent 框架做得更好。

下一章我们将进入工具的执行层——六种 Terminal 后端如何在本地进程、Docker 容器、SSH 远程主机、Modal 无服务器实例、Daytona 云开发环境和 Singularity HPC 容器之间提供统一的命令执行体验。

---

## 速查表

| 文件 | 行数 | 角色 |
|------|------|------|
| `toolsets.py` | 656 | Toolset 定义、解析、组合 |
| `model_tools.py` | 578 | Toolset→Schema 管线、参数矫正、分发 |

| 概念 | 说明 |
|------|------|
| `_HERMES_CORE_TOOLS` | 34 个工具的共享列表，15+ 平台复用 |
| 叶子 Toolset | `includes` 为空，直接列出工具名 |
| 组合 Toolset | 通过 `includes` 引用其他 Toolset |
| `resolve_toolset()` | 递归图展开，`visited` 集合处理环和菱形依赖 |
| `"all"` / `"*"` 别名 | 展开为所有已知 Toolset 的并集 |
| Plugin Toolset | Registry 中存在但 TOOLSETS 字典中不存在的 toolset |
| 动态 Schema 重写 | `execute_code` 和 `browser_navigate` 根据可用工具调整描述 |
| `coerce_tool_args()` | 字符串→数字/布尔的全局参数矫正 |
| `_AGENT_LOOP_TOOLS` | 4 个需要 Agent 状态的工具，被主循环拦截 |
| `create_custom_toolset()` | 运行时动态创建 Toolset，宽松验证 |
