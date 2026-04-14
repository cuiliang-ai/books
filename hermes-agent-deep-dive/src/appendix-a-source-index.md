
# 附录 A：源码锚点索引与 Slash 命令速查

> 本附录汇总全书引用的所有关键源文件、类、函数，以及 Hermes Agent 的 Slash 命令列表。

---

## A.1 核心文件索引

| 文件 | 行数 | 主要内容 |
|------|------|---------|
| `run_agent.py` | ~10,600 | AIAgent 类、run_conversation()、IterationBudget |
| `cli.py` | ~10,000 | HermesCLI 类、交互式 CLI 编排器 |
| `gateway/run.py` | ~9,000 | GatewayRunner、多平台网关 |
| `hermes_cli/main.py` | ~6,000 | CLI 入口、子命令系统 |
| `model_tools.py` | ~580 | 工具编排层、同步-异步桥接 |
| `toolsets.py` | ~660 | Toolset 定义与解析 |
| `hermes_state.py` | — | SessionDB、SQLite + FTS5 |

> TODO: 完整文件索引（按模块分组）

---

## A.2 关键类索引

| 类名 | 文件 | 描述 |
|------|------|------|
| `AIAgent` | `run_agent.py` | 核心 Agent 类 |
| `ToolRegistry` | `tools/registry.py` | 工具注册表单例 |
| `ToolEntry` | `tools/registry.py` | 工具条目数据结构 |
| `IterationBudget` | `run_agent.py` | 迭代预算控制 |
| `ContextEngine` | `agent/context_engine.py` | 上下文引擎抽象基类 |
| `ContextCompressor` | `agent/context_compressor.py` | 默认上下文压缩器 |
| `MemoryManager` | `agent/memory_manager.py` | 记忆编排器 |
| `MemoryProvider` | `agent/memory_provider.py` | 记忆提供者抽象 |
| `BaseEnvironment` | `tools/environments/base.py` | 终端后端抽象基类 |
| `BasePlatformAdapter` | `gateway/platforms/base.py` | 平台适配器基类 |
| `GatewayRunner` | `gateway/run.py` | 网关运行器 |
| `SessionDB` | `hermes_state.py` | 会话数据库 |
| `HermesCLI` | `cli.py` | CLI 编排器 |

> TODO: 完整类索引

---

## A.3 关键函数索引

| 函数 | 文件 | 描述 |
|------|------|------|
| `run_conversation()` | `run_agent.py` | 核心会话循环 |
| `resolve_toolset()` | `toolsets.py` | Toolset 图展开 |
| `_should_parallelize_tool_batch()` | `run_agent.py` | 并行安全判断 |
| `choose_cheap_model_route()` | `agent/smart_model_routing.py` | 模型路由 |
| `_scan_context_content()` | `agent/prompt_builder.py` | 注入检测 |
| `sanitize_context()` | `agent/memory_manager.py` | 记忆内容净化 |
| `tick()` | `cron/scheduler.py` | 定时调度心跳 |

> TODO: 完整函数索引

---

## A.4 Slash 命令速查

| 命令 | 功能 |
|------|------|
| `/help` | 显示帮助 |
| `/model` | 切换模型 |
| `/tools` | 工具管理 |
| `/skills` | Skills 管理 |
| `/memory` | 记忆管理 |
| `/config` | 配置管理 |

> TODO: 完整 Slash 命令列表（从 `hermes_cli/commands.py` 提取）

---

## A.5 入口点速查

| 入口 | 命令 | 源文件 |
|------|------|--------|
| CLI | `hermes` | `hermes_cli/main.py` |
| Gateway | `hermes gateway start` | `gateway/run.py` |
| ACP | `hermes-acp` | `acp_adapter/entry.py` |
| Batch | `python batch_runner.py` | `batch_runner.py` |
| MCP Server | `python mcp_serve.py` | `mcp_serve.py` |
| RL | `python rl_cli.py` | `rl_cli.py` |
