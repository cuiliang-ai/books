
# 第 1 章：产品特性与设计目标

## 你正在看什么

大多数 AI 编程工具的世界观是这样的：用户给一个指令，模型生成代码，工作结束。Claude Code 是一个终端里的编程专家。Aider 是一个 git-aware 的代码编辑器。Cursor 是一个被 AI 附体的 IDE。它们的共同特征是——它们不学习。每次会话从零开始，上次做过什么，下次照样不知道。

Hermes Agent 打破了这个模式。

`pyproject.toml` 第 8 行写着项目的自我定义：

```
"The self-improving AI agent — creates skills from experience,
 improves them during use, and runs anywhere"
```

这不是一句营销口号。它描述的是一个真实的架构特征：一个 10,594 行的核心类（`AIAgent` in `run_agent.py`），一个 78 个 Skill 文件的程序化记忆系统（`skills/`），一个 SQLite + FTS5 驱动的跨会话搜索引擎（`hermes_state.py`），以及一个将 MEMORY.md 和 USER.md 作为冻结快照持久化的记忆管理器（`agent/memory_manager.py`）。这些组件形成了一个闭环：解决问题 → 提炼 Skill → 持久化记忆 → 下次会话召回 → 改进 Skill → 再次持久化。

这是一个自进化系统。本书要做的，就是把这个系统拆开来看。

---

## 它是什么——不是什么

先说清楚 Hermes Agent **不是**什么：

- 它不是一个 IDE 插件。虽然它有 ACP 适配器可以连接 VS Code / Zed / JetBrains，但那只是 6 种入口之一。
- 它不是一个纯编程工具。它有 78 个 Skill 覆盖 26 个类别——从 DevOps 到数据科学到社交媒体到游戏到红队测试。
- 它不是绑定某一个模型的。它支持 10+ 推理提供商，一个 `hermes model` 命令就能切换，不改代码、不改配置文件。

那它**是**什么？

**Hermes Agent 是一个通用 AI Agent 运行时**——一个能在终端里交互、在 15 个消息平台上服务、在 6 种执行环境中运行命令、并从自己的经验中学习的智能体系统。它由 [Nous Research](https://nousresearch.com) 构建，MIT 许可证，完全开源。

核心数据：

| 指标 | 值 |
|------|-----|
| 版本 | v0.8.0 (2026-04-08) |
| 语言 | Python 3.11+，setuptools 打包，uv 管理依赖 |
| 核心文件 | `run_agent.py` (10,594 行), `cli.py` (9,956 行), `gateway/run.py` (8,982 行) |
| 工具 | 50+ 已注册工具，分布在 27 个工具源文件中 |
| Skills | 78 个 Skill 文件，横跨 26 个类别 |
| 消息平台 | 15 个（Telegram / Discord / Slack / WhatsApp / Signal / Email / Matrix / DingTalk / Feishu / WeCom / WeChat / BlueBubbles / SMS / Mattermost / Webhook） |
| 终端后端 | 6 种（Local / Docker / SSH / Modal / Daytona / Singularity） |
| 记忆插件 | 8 个（Honcho / Holographic / mem0 / ByteRover / Hindsight / RetainDB / SuperMemory / OpenViking） |
| 推理提供商 | 10+（OpenAI / Anthropic / OpenRouter / Google AI Studio / Nous Portal / Hugging Face / z.ai / Kimi / MiniMax / Ollama / 自定义端点） |

---

## 六个核心设计决策

每个架构都是一系列取舍的结果。Hermes Agent 的设计由六个根本性决策塑造，理解这些决策比理解任何具体实现细节都重要。

### 决策一：封闭学习循环

这是 Hermes 与所有同类工具的根本分歧。

README.md 的描述直接点明了这个架构：

> It's the only agent with a built-in learning loop — it creates skills from experience, improves them during use, nudges itself to persist knowledge, searches its own past conversations, and builds a deepening model of who you are across sessions.

这不是一个"支持自定义记忆"的功能。它是一个**四阶段闭环**：

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  1. 执行任务  │────▶│ 2. 提炼 Skill │────▶│ 3. 持久记忆  │────▶│ 4. 会话召回  │
│  (AIAgent)   │     │ (skills_tool) │     │ (memory_tool)│     │(session_search)│
└──────────────┘     └──────────────┘     └──────────────┘     └──────┬───────┘
       ▲                                                              │
       └──────────────────────────────────────────────────────────────┘
                              改进已有 Skill，循环继续
```

四个阶段各有对应的源码组件：

1. **执行任务** — `AIAgent.run_conversation()` 驱动主循环，模型推理后调用工具执行
2. **提炼 Skill** — `tools/skills_tool.py` 将成功解决的问题提炼为 SKILL.md 格式的可复用经验
3. **持久记忆** — `tools/memory_tool.py` 将关键知识写入 MEMORY.md（Agent 视角）和 USER.md（用户视角），使用 `§` 分隔符的冻结快照格式
4. **会话召回** — `tools/session_search_tool.py` 通过 FTS5 全文检索历史会话，配合 LLM 摘要生成精炼的上下文

闭环的微妙之处在于**主动推送**。Agent 不是被动等待用户要求它记住什么——它会在合适的时机**自己主动**建议创建 Skill 或更新记忆。这是 prompt_builder 中的行为指令驱动的，不是一个简单的 API 调用。

### 决策二：多模型无锁定

`pyproject.toml` 的依赖列表开头就是两行：

```python
"openai>=2.21.0,<3",
"anthropic>=0.39.0,<1",
```

Hermes 同时依赖 OpenAI SDK 和 Anthropic SDK——不是二选一。`agent/credential_pool.py` 实现了一个多凭据池，支持同一提供商的多个 API Key 自动轮换（`least_used` 策略），以及跨提供商的自动降级链（`fallback_providers`）。`agent/smart_model_routing.py` 根据任务复杂度在 cheap 模型和 strong 模型之间动态路由。`agent/anthropic_adapter.py` 将 Anthropic 的 Messages API 转换为 OpenAI 兼容格式，作为统一抽象的一部分。

结果是：一个 `hermes model` 命令就能从 Claude 切到 GPT 再切到 DeepSeek。模型是可替换的基础设施，不是被锁定的平台。

### 决策三：Agent 即服务

大多数 AI 编程工具只在终端里运行。Hermes 走了另一条路：**一个 Agent 进程，多个前端**。

`gateway/run.py`（8,982 行）实现了 `GatewayRunner`——一个单进程异步服务器，同时驱动 15 个消息平台适配器。每个适配器继承自 `gateway/platforms/base.py`（2,071 行）的 `BasePlatformAdapter`，实现平台特定的消息收发、文件上传、语音转录。

这意味着你可以在 Telegram 上给 Agent 发消息，让它在云端 VM 上编码，然后在 Discord 上检查进度——全是同一个 Agent 实例。

### 决策四：执行环境可替换

`tools/environments/` 目录包含 6 种终端后端的实现：

| 后端 | 文件 | 核心特征 |
|------|------|---------|
| Local | `local.py` | 本地进程，直接 subprocess |
| Docker | `docker.py` | 容器隔离，文件映射 |
| SSH | `ssh.py` | 远程 SSH 执行 |
| Modal | `modal.py` + `managed_modal.py` | 无服务器，休眠-唤醒，按需计费 |
| Daytona | `daytona.py` | 云开发环境，持久化工作区 |
| Singularity | `singularity.py` | HPC 容器，GPU 集群 |

所有后端继承自 `base.py` 的 `BaseEnvironment` 抽象类，实现统一的 `execute()` / `upload()` / `download()` 接口。对 Agent 来说，它不关心命令是在你的笔记本上还是在 Modal 的无服务器容器里执行——接口是一样的。

README.md 对此有一个务实的描述："Run it on a $5 VPS or a GPU cluster."

### 决策五：Skills 而非规则

传统 Agent 框架的"记忆"通常是一个 key-value 存储或向量数据库。Hermes 选择了一个更高层次的抽象：**Skill**。

一个 Skill 不是一条事实，而是一段**程序化知识**——它有标题、使用条件、步骤指南、甚至代码片段。存储格式是 SKILL.md，兼容 [agentskills.io](https://agentskills.io) 开放标准。加载策略是三级渐进式披露：

- **Tier 1**：标题 + 一句话描述（始终加载到上下文）
- **Tier 2**：使用说明（在 Agent 决定需要时加载）
- **Tier 3**：完整实现细节（在 Agent 真正执行时加载）

这不是任意的分层——它是上下文窗口管理的必然结果。78 个 Skill 的全文不可能同时放进任何模型的上下文窗口。三级披露让 Agent 知道自己*能做什么*（Tier 1 始终可见），但只在需要时加载*怎么做*的细节（Tier 2-3）。

### 决策六：研究就绪

Hermes 不只是一个产品——它也是 Nous Research 训练下一代工具调用模型的**基础设施**。

`batch_runner.py` 可以并行生成大量对话轨迹。`trajectory_compressor.py` 将长轨迹压缩为训练友好的格式。`environments/` 目录包含 Atropos RL 训练环境的集成。`rl_cli.py` 提供 RL 训练的命令行接口。

这解释了为什么 Hermes 的架构有些地方"过度设计"——比如为什么终端工具需要 6 种后端，为什么需要 `IterationBudget` 精确控制循环次数。这些不仅仅是面向用户的功能，也是面向训练数据生成的基础设施。

---

## 与同类工具的本质区别

理解 Hermes 最好的方式是对比它与两个最直接相关的系统——它的前身 OpenClaw，以及它在 coding agent 领域最直接的对标产品 Claude Code。

### Hermes vs OpenClaw：概念延续，代码重写

`hermes claw migrate` 命令的存在泄露了一段历史：Hermes Agent 的前身是 OpenClaw。

迁移命令支持导入 `~/.openclaw` 目录下的 SOUL.md（人格文件）、记忆、Skills、API keys、消息平台配置。这说明 OpenClaw 和 Hermes 共享核心概念——Skills 系统、记忆格式、Gateway 架构——但 Hermes 重写了整个技术栈。

两者的关系不是渐进升级，而是**概念延续、代码重写**。这种模式在开源项目中并不罕见（想想 Webpack 到 Vite，Express 到 Fastify）。OpenClaw 验证了"自进化 Agent"这个产品假设是成立的——Skills 闭环确实有用，多平台 Gateway 确实有需求，MEMORY.md 的冻结快照格式确实比向量数据库更可控。Hermes 在这些经验的基础上重新设计了技术实现：

| 维度 | OpenClaw（前身） | Hermes Agent v0.8.0 |
|------|-----------------|---------------------|
| 核心概念 | Skills + Memory + Gateway | 相同——完全继承 |
| 人格文件 | SOUL.md | 相同——`hermes claw migrate` 直接导入 |
| 代码架构 | 早期实现 | 完全重写——AIAgent 单类 10,594 行 |
| 模型支持 | 有限提供商 | 10+ 提供商 + Credential Pool + Fallback Chain |
| 平台覆盖 | 部分平台 | 15 个消息平台 + ACP + MCP Server |
| 终端后端 | 有限 | 6 种（Local/Docker/SSH/Modal/Daytona/Singularity） |
| 插件架构 | 无 | 8 个记忆插件 + 可插拔 ContextEngine |
| RL 训练 | 无 | 完整流水线（batch_runner + Atropos） |

这解释了为什么 Hermes 的架构在 v0.2 就已经如此成熟——它站在前人的肩膀上。OpenClaw 是原型，Hermes 是产品。

### Hermes vs Claude Code：通用 Agent 与编程专精

Claude Code 是 Anthropic 的官方 AI 编程工具——一个用 TypeScript/Bun 构建的终端 Agent，深度绑定 Claude 模型。它是一个精雕细琢的单一用途工具：编写代码、编辑文件、运行命令。

Hermes 是一个**通用 Agent 运行时**。代码编辑只是它的众多能力之一。核心区别：

| 维度 | Hermes Agent | Claude Code |
|------|-------------|-------------|
| 定位 | 通用自进化 Agent | 编程专精 Agent |
| 语言 | Python 3.11+（~227K 行） | TypeScript/Bun（~2K 文件） |
| 模型锁定 | 10+ 提供商，一键切换 | 仅 Anthropic Claude |
| 学习能力 | Skills + Memory 闭环，跨会话进化 | 无持久学习（CLAUDE.md 是静态文件） |
| 运行平台 | CLI + 15 个消息平台 | CLI + IDE 扩展 |
| 执行环境 | 6 种后端（含无服务器） | 仅本地 |
| 开源 | MIT，完全开源 | 有限开源 |

两者的共同点也很多：都有 Agentic Loop、工具注册表、上下文压缩、子 Agent 委派、MCP 支持。但架构哲学截然不同——Claude Code 追求**编程体验的极致打磨**，Hermes 追求**通用 Agent 能力的最大覆盖**。

一个值得注意的差异是**安全模型**。Claude Code 使用基于 Linux Landlock/seccomp 的文件系统级沙箱，通过权限模式（plan/auto/full-auto）控制 Agent 自主性。Hermes 没有系统调用级沙箱，但提供了**更灵活的环境隔离**——Docker 容器、SSH 远程执行、Modal 无服务器、Singularity HPC 容器——加上 `tools/approval.py` 的三模式审批系统（manual/smart/off）。两种方式各有取舍：Claude Code 更安全但只能在本地运行，Hermes 更灵活但安全责任更多地落在用户的环境选择上。

---

## Python 单仓：一个有意为之的选择

227,000 行 Python，全部在一个仓库里。没有 monorepo 工具（Turborepo、Nx），没有微服务拆分，没有构建系统（纯 setuptools）。这是一个极其有意识的选择。

优势是显而易见的：

- **Import 即集成**。`run_agent.py` 直接 import `tools/registry.py`，没有包管理、没有版本对齐、没有接口协商
- **重构友好**。全局搜索替换就能完成 API 变更，不需要跨包发布
- **类型一致**。一个 `AIAgent` 类型贯穿全栈，从 CLI 到 Gateway 到 ACP
- **部署简单**。`pip install hermes-agent[all]` 安装一切

代价也是真实的：

- `run_agent.py` 有 10,594 行。这是一个 God Object 的气味
- `cli.py` 有 9,956 行，几乎同样庞大
- `gateway/run.py` 有 8,982 行，第三大文件

三个文件加起来 29,532 行——超过很多完整项目的总代码量。但如果你读过 Chapter 5 就会理解为什么这些文件很大却不复杂：它们是**编排器**，把很多小组件连接在一起的单点。就像一个交响乐指挥的乐谱——很长，但结构清晰。

---

## 本章为什么重要

本书后续的每一章都会深入一个具体的子系统。但在潜入细节之前，你需要一张地图。

本章提供的六个核心设计决策就是这张地图：

1. **封闭学习循环** — 第 16–20 章展开
2. **多模型无锁定** — 第 8–9 章展开
3. **Agent 即服务** — 第 21–23 章展开
4. **执行环境可替换** — 第 12 章展开
5. **Skills 而非规则** — 第 18 章展开
6. **研究就绪** — 第 29 章展开

每个决策都不是孤立的。学习循环需要跨会话存储（SessionDB，第 16 章），存储需要上下文压缩（ContextEngine，第 7 章），压缩需要辅助模型调用（多模型路由，第 8 章），辅助调用需要凭据池（Credential Pool，第 25 章）。一切都连在一起。

下一章从入口点开始——六种运行模态如何共享同一个 AIAgent 核心。

---

## 速查表

| 文件 | 行数 | 角色 |
|------|------|------|
| `README.md` | — | 产品定位与特性概览 |
| `pyproject.toml` | 134 | 项目元数据、依赖、入口点、20+ 可选依赖组 |
| `run_agent.py` | 10,594 | AIAgent 核心类——整个系统的重心 |
| `cli.py` | 9,956 | HermesCLI 交互式终端编排器 |
| `gateway/run.py` | 8,982 | GatewayRunner 多平台网关 |
| `RELEASE_v0.*.md` | 7 files | 版本发布说明，记录架构演进 |
| `skills/` | 78 SKILL.md | 26 类内置 Skill |
| `plugins/memory/` | 8 dirs | 可插拔记忆后端 |
| `gateway/platforms/` | 15+ files | 消息平台适配器 |
| `tools/environments/` | 6 backends | 终端执行后端 |
| `LICENSE` | — | MIT 许可证 |
