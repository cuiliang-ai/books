
# 附录 A：源码锚点索引与 Slash 命令速查

> 本附录汇总全书引用的所有关键源文件、类、函数，以及 Hermes Agent 的完整 Slash 命令列表。在阅读正文时，如果你需要快速定位某个组件在源码中的位置，这里就是你的导航地图。所有锚点基于 hermes-agent v0.8.0。

---

## A.1 核心文件索引

Hermes Agent 的 227K 行代码分布在多个模块中。下面按功能分组列出最重要的文件——每个文件都至少在正文的一个章节中被深入分析过。

### Agent 核心

| 文件 | 行数 | 主要内容 | 详见 |
|------|------|---------|------|
| `run_agent.py` | ~10,600 | `AIAgent` 类、`run_conversation()` 主循环、`IterationBudget` | 第 4、5 章 |
| `model_tools.py` | ~580 | 工具编排层、`_discover_tools()`、`handle_function_call()`、同步-异步桥接 | 第 10、27 章 |
| `toolsets.py` | ~660 | Toolset 定义、`_HERMES_CORE_TOOLS`、`resolve_toolset()` 图展开 | 第 11 章 |
| `hermes_state.py` | — | `SessionDB`、SQLite + FTS5 全文检索 | 第 16 章 |
| `hermes_constants.py` | — | `get_hermes_home()`、`display_hermes_home()`、全局常量 | 第 25 章 |

### Agent 内部模块（`agent/`）

| 文件 | 主要内容 | 详见 |
|------|---------|------|
| `agent/prompt_builder.py` | 系统提示组装、`_scan_context_content()` 注入检测 | 第 6 章 |
| `agent/context_compressor.py` | 默认上下文压缩器、有损摘要 | 第 7 章 |
| `agent/context_engine.py` | `ContextEngine` 抽象基类 | 第 7 章 |
| `agent/prompt_caching.py` | Anthropic prompt caching 支持 | 第 6 章 |
| `agent/auxiliary_client.py` | 辅助 LLM 客户端（vision、summarization） | 第 8 章 |
| `agent/model_metadata.py` | 模型上下文长度、token 估算 | 第 8 章 |
| `agent/smart_model_routing.py` | `choose_cheap_model_route()`、双模型路由 | 第 8 章 |
| `agent/credential_pool.py` | 多凭据池、`least_used` 轮换策略 | 第 8、25 章 |
| `agent/anthropic_adapter.py` | Anthropic Messages → OpenAI 格式转换 | 第 8 章 |
| `agent/memory_manager.py` | `MemoryManager`、`sanitize_context()` 净化 | 第 17 章 |
| `agent/memory_provider.py` | `MemoryProvider` 抽象基类 | 第 17、28 章 |
| `agent/trajectory.py` | 轨迹保存、`convert_scratchpad_to_think()` | 第 29 章 |
| `agent/display.py` | `KawaiiSpinner`、tool preview 格式化 | 第 24 章 |
| `agent/skill_commands.py` | Skill slash 命令、skills 目录扫描 | 第 18 章 |

### CLI 模块（`hermes_cli/`）

| 文件 | 主要内容 | 详见 |
|------|---------|------|
| `hermes_cli/main.py` | CLI 入口点、`hermes` 子命令系统 | 第 2 章 |
| `hermes_cli/config.py` | `DEFAULT_CONFIG`、`OPTIONAL_ENV_VARS`、配置迁移 | 附录 B |
| `hermes_cli/commands.py` | `COMMAND_REGISTRY`、`CommandDef`、`SlashCommandCompleter` | 第 24、28 章 |
| `hermes_cli/callbacks.py` | 终端回调（clarify、sudo、approval） | 第 26 章 |
| `hermes_cli/setup.py` | 交互式 setup wizard | 第 2 章 |
| `hermes_cli/skin_engine.py` | 皮肤引擎、数据驱动 CLI 主题化 | 第 24 章 |
| `hermes_cli/auth.py` | Provider 凭据解析 | 第 25 章 |
| `hermes_cli/model_switch.py` | `/model` 切换流水线 | 第 8 章 |

### 工具模块（`tools/`）

| 文件 | 主要内容 | 详见 |
|------|---------|------|
| `tools/registry.py` | `ToolRegistry` 单例、`ToolEntry`、`tool_error()`/`tool_result()` | 第 10、28 章 |
| `tools/approval.py` | 危险命令检测 | 第 26 章 |
| `tools/terminal_tool.py` | 终端编排、后端选择 | 第 12 章 |
| `tools/process_registry.py` | 后台进程管理 | 第 12 章 |
| `tools/file_tools.py` | 文件读/写/搜索/patch | 第 13 章 |
| `tools/web_tools.py` | Web 搜索/提取（Parallel + Firecrawl） | 第 13 章 |
| `tools/browser_tool.py` | Browserbase 浏览器自动化 | 第 14 章 |
| `tools/code_execution_tool.py` | `execute_code` 沙箱 | 第 15 章 |
| `tools/delegate_tool.py` | 子 Agent 委派 | 第 15 章 |
| `tools/mcp_tool.py` | MCP 客户端（~1050 行） | 第 14 章 |
| `tools/skills_tool.py` | Skill CRUD 操作 | 第 18 章 |
| `tools/memory_tool.py` | Memory 读/写 | 第 17 章 |
| `tools/session_search_tool.py` | Session FTS5 搜索 | 第 19 章 |
| `tools/environments/base.py` | `BaseEnvironment` 抽象基类、`ProcessHandle` 协议 | 第 12、28 章 |

### Gateway 模块（`gateway/`）

| 文件 | 主要内容 | 详见 |
|------|---------|------|
| `gateway/run.py` | `GatewayRunner`、消息分发、slash 命令处理 | 第 21 章 |
| `gateway/session.py` | `SessionStore`、会话持久化 | 第 21 章 |
| `gateway/platforms/base.py` | `BasePlatformAdapter`、`MessageEvent`、消息生命周期 | 第 22、28 章 |
| `gateway/config.py` | `Platform` 枚举、`PlatformConfig` | 第 21 章 |
| `gateway/status.py` | 运行时状态、scoped lock | 第 25 章 |

### RL 与训练

| 文件 | 主要内容 | 详见 |
|------|---------|------|
| `batch_runner.py` | `BatchRunner`、并行轨迹生成 | 第 29 章 |
| `toolset_distributions.py` | `DISTRIBUTIONS`、概率化 Toolset 采样 | 第 29 章 |
| `rl_cli.py` | RL 专用 CLI | 第 29 章 |
| `environments/hermes_base_env.py` | `HermesAgentBaseEnv`（Atropos 集成） | 第 29 章 |
| `environments/agent_loop.py` | `HermesAgentLoop`、`AgentResult` | 第 29 章 |
| `environments/tool_context.py` | `ToolContext`（Reward 函数工具访问） | 第 29 章 |

---

## A.2 关键类索引

| 类名 | 文件 | 描述 |
|------|------|------|
| `AIAgent` | `run_agent.py` | 核心 Agent 类，10,594 行，编排主循环 |
| `ToolRegistry` | `tools/registry.py` | 工具注册表单例，管理 schema/handler/dispatch |
| `ToolEntry` | `tools/registry.py` | 工具条目数据结构（10 个 slot） |
| `IterationBudget` | `run_agent.py` | 迭代预算控制，防止无限循环 |
| `ContextEngine` | `agent/context_engine.py` | 上下文引擎抽象基类（可插拔） |
| `ContextCompressor` | `agent/context_compressor.py` | 默认上下文压缩器（有损摘要） |
| `MemoryManager` | `agent/memory_manager.py` | 记忆编排器，管理多 provider |
| `MemoryProvider` | `agent/memory_provider.py` | 记忆提供者抽象基类 |
| `BaseEnvironment` | `tools/environments/base.py` | 终端后端抽象基类（统一 execute 流程） |
| `ProcessHandle` | `tools/environments/base.py` | 进程句柄协议（duck type） |
| `_ThreadedProcessHandle` | `tools/environments/base.py` | SDK 后端的进程适配器 |
| `BasePlatformAdapter` | `gateway/platforms/base.py` | 平台适配器基类（15 个平台共用） |
| `MessageEvent` | `gateway/platforms/base.py` | 规范化入站消息数据类 |
| `SendResult` | `gateway/platforms/base.py` | 消息发送结果 |
| `GatewayRunner` | `gateway/run.py` | 网关运行器，编排多平台消息分发 |
| `SessionDB` | `hermes_state.py` | SQLite + FTS5 会话数据库 |
| `HermesCLI` | `cli.py` | CLI 编排器，Rich + prompt_toolkit |
| `CommandDef` | `hermes_cli/commands.py` | Slash 命令定义（frozen dataclass） |
| `SkinConfig` | `hermes_cli/skin_engine.py` | 皮肤配置数据类 |
| `BatchRunner` | `batch_runner.py` | 批量轨迹生成器 |
| `HermesAgentBaseEnv` | `environments/hermes_base_env.py` | Atropos RL 环境基类 |
| `HermesAgentLoop` | `environments/agent_loop.py` | 可复用多轮 Agent 引擎 |
| `AgentResult` | `environments/agent_loop.py` | Agent 循环执行结果 |
| `ToolContext` | `environments/tool_context.py` | Reward 函数全工具访问句柄 |

---

## A.3 关键函数索引

| 函数 | 文件 | 描述 |
|------|------|------|
| `run_conversation()` | `run_agent.py` | 核心会话循环，while 迭代 + tool call |
| `chat()` | `run_agent.py` | 简化接口，返回最终响应字符串 |
| `handle_function_call()` | `model_tools.py` | 工具调用分发到 registry.dispatch() |
| `get_tool_definitions()` | `model_tools.py` | 构建 OpenAI-format tool schemas |
| `_discover_tools()` | `model_tools.py` | 触发所有工具文件的 import-time 注册 |
| `resolve_toolset()` | `toolsets.py` | Toolset 图展开（递归解析 includes） |
| `resolve_command()` | `hermes_cli/commands.py` | 命令名/别名 → CommandDef 查找 |
| `registry.register()` | `tools/registry.py` | 工具自注册（import-time 调用） |
| `registry.dispatch()` | `tools/registry.py` | 工具执行分发（含异步桥接和异常捕获） |
| `registry.get_definitions()` | `tools/registry.py` | 获取 tool schemas（含 check_fn 过滤） |
| `choose_cheap_model_route()` | `agent/smart_model_routing.py` | 双模型路由决策 |
| `_scan_context_content()` | `agent/prompt_builder.py` | Prompt injection 检测 |
| `sanitize_context()` | `agent/memory_manager.py` | 记忆内容净化 |
| `save_trajectory()` | `agent/trajectory.py` | 轨迹 JSONL 追加写入 |
| `convert_scratchpad_to_think()` | `agent/trajectory.py` | 推理标签格式转换 |
| `sample_toolsets_from_distribution()` | `toolset_distributions.py` | 概率化 toolset 采样 |
| `tick()` | `cron/scheduler.py` | 定时调度心跳 |
| `_run_async()` | `model_tools.py` | sync→async 桥接（所有 async 工具的入口） |
| `execute()` | `tools/environments/base.py` | 统一的命令执行流程 |
| `_wrap_command()` | `tools/environments/base.py` | 命令包装（snapshot + CWD tracking） |
| `truncate_message()` | `gateway/platforms/base.py` | 消息长度分段（UTF-16 安全） |
| `handle_message()` | `gateway/platforms/base.py` | 入站消息生命周期管理 |

---

## A.4 Slash 命令完整列表

以下列表从 `hermes_cli/commands.py` 的 `COMMAND_REGISTRY`（行 56-163）完整提取。每个命令都标注了适用范围（CLI / Gateway / 全部）和别名。

### Session 类

| 命令 | 别名 | 范围 | 描述 |
|------|------|------|------|
| `/new` | `/reset` | 全部 | 开始新会话（清空历史 + 新 session ID） |
| `/clear` | — | CLI | 清屏并开始新会话 |
| `/history` | — | CLI | 显示对话历史 |
| `/save` | — | CLI | 保存当前对话 |
| `/retry` | — | 全部 | 重试最后一条消息 |
| `/undo` | — | 全部 | 撤销最后一轮对话 |
| `/title` | — | 全部 | 设置当前会话标题 |
| `/branch` | `/fork` | 全部 | 分支当前会话（探索不同路径） |
| `/compress` | — | 全部 | 手动压缩对话上下文 |
| `/rollback` | — | 全部 | 列出或恢复文件系统检查点 |
| `/stop` | — | 全部 | 终止所有后台进程 |
| `/approve` | — | Gateway | 批准挂起的危险命令 |
| `/deny` | — | Gateway | 拒绝挂起的危险命令 |
| `/background` | `/bg` | 全部 | 在后台运行 prompt |
| `/btw` | — | 全部 | 临时侧问题（不保存，不用工具） |
| `/queue` | `/q` | 全部 | 排队 prompt（不中断当前任务） |
| `/status` | — | 全部 | 显示会话信息 |
| `/sethome` | `/set-home` | Gateway | 设置当前聊天为 home channel |
| `/resume` | — | 全部 | 恢复先前命名的会话 |
| `/restart` | — | Gateway | 优雅重启 gateway（drain 活跃运行） |

### Configuration 类

| 命令 | 别名 | 范围 | 描述 |
|------|------|------|------|
| `/config` | — | CLI | 显示当前配置 |
| `/model` | — | 全部 | 切换当前会话的模型 |
| `/provider` | — | 全部 | 显示可用 provider 和当前 provider |
| `/personality` | — | 全部 | 设置预定义人格 |
| `/statusbar` | `/sb` | CLI | 切换上下文/模型状态栏 |
| `/verbose` | — | CLI* | 循环 tool progress 显示级别 |
| `/yolo` | — | 全部 | 切换 YOLO 模式（跳过审批） |
| `/reasoning` | — | 全部 | 管理推理 effort 和显示 |
| `/fast` | — | 全部 | 切换 Fast/Priority 处理模式 |
| `/skin` | — | CLI | 显示或切换显示皮肤/主题 |
| `/voice` | — | 全部 | 切换语音模式 |

*`/verbose` 标记为 `cli_only`，但设置 `gateway_config_gate: "display.tool_progress_command"` 后也可在 Gateway 中使用。

### Tools & Skills 类

| 命令 | 别名 | 范围 | 描述 |
|------|------|------|------|
| `/tools` | — | CLI | 工具管理：list/disable/enable |
| `/toolsets` | — | CLI | 列出可用 toolset |
| `/skills` | — | CLI | 搜索、安装、检查、管理 Skills |
| `/cron` | — | CLI | 管理定时任务 |
| `/reload` | — | 全部 | 重新加载 .env 变量 |
| `/reload-mcp` | `/reload_mcp` | 全部 | 重新加载 MCP 服务器配置 |
| `/browser` | — | CLI | 通过 CDP 连接 Chrome 浏览器工具 |
| `/plugins` | — | CLI | 列出已安装插件及状态 |

### Info 类

| 命令 | 别名 | 范围 | 描述 |
|------|------|------|------|
| `/commands` | — | Gateway | 浏览所有命令和 Skills（分页） |
| `/help` | — | 全部 | 显示可用命令 |
| `/usage` | — | 全部 | 显示 token 用量和速率限制 |
| `/insights` | — | 全部 | 显示使用分析 |
| `/platforms` | `/gateway` | CLI | 显示 gateway/消息平台状态 |
| `/paste` | — | CLI | 检查剪贴板图片并附加 |
| `/image` | — | CLI | 附加本地图片文件 |
| `/update` | — | Gateway | 更新 Hermes Agent 到最新版本 |
| `/profile` | — | 全部 | 显示活跃 profile 名和 home 目录 |
| `/debug` | — | 全部 | 上传调试报告 |

### Exit 类

| 命令 | 别名 | 范围 | 描述 |
|------|------|------|------|
| `/quit` | `/exit`, `/q` | CLI | 退出 CLI |

---

## A.5 入口点速查

Hermes Agent 有六个独立的入口点，全部复用同一个 `AIAgent` 核心和工具注册表。

| 入口 | 命令 | 源文件 | 用途 |
|------|------|--------|------|
| CLI | `hermes` | `hermes_cli/main.py` | 交互式终端 |
| Gateway | `hermes gateway start` | `gateway/run.py` | 消息平台服务 |
| ACP | `hermes-acp` | `acp_adapter/entry.py` | VS Code/Zed/JetBrains |
| Batch | `python batch_runner.py` | `batch_runner.py` | 批量轨迹生成 |
| MCP Server | `python mcp_serve.py` | `mcp_serve.py` | MCP 协议服务器 |
| RL | `python rl_cli.py` | `rl_cli.py` | RL 训练工作流 |

---

## A.6 工具注册表

以下是 `_HERMES_CORE_TOOLS`（`toolsets.py:31-63`）中的核心工具和各 toolset 中的专用工具汇总。

### 核心工具（所有平台默认启用）

| 工具名 | Toolset | 描述 |
|--------|---------|------|
| `web_search` | web | 网络搜索 |
| `web_extract` | web | 网页内容提取 |
| `terminal` | terminal | 终端命令执行 |
| `process` | terminal | 后台进程管理 |
| `read_file` | file | 文件读取 |
| `write_file` | file | 文件写入 |
| `patch` | file | 模糊匹配补丁 |
| `search_files` | file | 文件/内容搜索 |
| `vision_analyze` | vision | 图像分析 |
| `image_generate` | image_gen | 图像生成 |
| `skills_list` | skills | 列出 Skills |
| `skill_view` | skills | 查看 Skill 内容 |
| `skill_manage` | skills | 创建/编辑/删除 Skill |
| `browser_navigate` | browser | 浏览器导航 |
| `browser_snapshot` | browser | 浏览器截图 |
| `browser_click` | browser | 浏览器点击 |
| `browser_type` | browser | 浏览器输入 |
| `browser_scroll` | browser | 浏览器滚动 |
| `browser_back` | browser | 浏览器后退 |
| `browser_press` | browser | 浏览器按键 |
| `browser_get_images` | browser | 获取页面图片 |
| `browser_vision` | browser | 浏览器视觉分析 |
| `browser_console` | browser | 浏览器控制台 |
| `text_to_speech` | tts | 文本转语音 |
| `todo` | todo | 任务规划和跟踪 |
| `memory` | memory | 持久化记忆读写 |
| `session_search` | session_search | 历史会话搜索 |
| `clarify` | clarify | 向用户提出澄清问题 |
| `execute_code` | code_execution | Python 沙箱执行 |
| `delegate_task` | delegation | 子 Agent 委派 |
| `cronjob` | cronjob | 定时任务管理 |
| `send_message` | messaging | 跨平台消息发送 |

### RL 专用工具

| 工具名 | 描述 |
|--------|------|
| `rl_list_environments` | 列出可用 RL 环境 |
| `rl_select_environment` | 选择 RL 环境 |
| `rl_get_current_config` | 获取当前 RL 配置 |
| `rl_edit_config` | 编辑 RL 配置 |
| `rl_start_training` | 启动 RL 训练 |
| `rl_check_status` | 检查训练状态 |
| `rl_stop_training` | 停止训练 |
| `rl_get_results` | 获取训练结果 |
| `rl_list_runs` | 列出训练运行 |
| `rl_test_inference` | 测试推理 |
