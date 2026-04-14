
# 第 20 章：封闭学习循环 — 自我进化的闭环

> **核心问题**：Skill 自动创建 → 使用中改进 → 记忆持久化 → Session 召回的完整闭环如何运作？

---

## 20.1 学习循环解决什么问题

前四章分别剖析了 Hermes Agent 的四大持久化子系统：SessionDB 负责结构化存储对话记录（第 16 章），Memory 系统将用户偏好和关键信息冻结到 MEMORY.md 与 USER.md（第 17 章），Skills 系统以渐进式披露管理可复用知识（第 18 章），Session Search 则通过 FTS5 + LLM 摘要实现跨会话检索（第 19 章）。

但这四个子系统有一个共同的问题：**谁来往里填内容？** Memory 需要有人调用 `memory("add", ...)` 才有数据，Skills 需要有人调用 `skill_manage("create", ...)` 才有模板。如果完全依赖用户手动保存，大量有价值的知识会随着对话结束而丢失——用户不可能在每次对话后都记得提炼偏好、创建 Skill。

学习循环就是解决这个问题的。它通过 **Nudge 计数器**追踪对话的量，在阈值到达时自动派生一个**影子 Agent** 在后台审查对话，提炼值得持久化的知识。整个过程对用户完全透明——用户看到的只是 Agent 越来越"懂"自己。

```
用户提出新问题
    │
    ▼
Agent 在工具调用中解决问题（多轮迭代）
    │
    ├──── 轮次计数器 _turns_since_memory++
    ├──── 迭代计数器 _iters_since_skill++
    │
    ▼
对话结束，检查 nudge 阈值
    │
    ├── 记忆阈值到达？ ──▶ 设置 _should_review_memory = True
    ├── 技能阈值到达？ ──▶ 设置 _should_review_skills = True
    │
    ▼
_spawn_background_review()
    │
    ├──▶ 影子 AIAgent（daemon 线程）
    │       ├── 共享 _memory_store 引用
    │       ├── 回顾对话快照
    │       ├── 调用 memory / skill_manage 工具
    │       └── 输出 💾 摘要通知
    │
    ▼
持久化到磁盘
    ├── MEMORY.md / USER.md  ──▶ 下次会话 system prompt
    ├── SKILL.md 文件        ──▶ 下次会话渐进式披露
    └── SessionDB (SQLite)   ──▶ 下次会话 session_search
```

这个循环最精妙之处在于它完全是**被动触发**的。Agent 不会主动询问"我该记住什么？"——它只是在自然对话的间隙中观察、提炼、保存。

### 本章结构

| 部分 | 节 | 内容 | 重要度 |
|------|-----|------|--------|
| **一、核心：触发与执行** | §20.2–20.4 | Nudge 机制 → 影子 Agent → 记忆 Flush | ⭐⭐⭐ 必读 |
| **二、全景：闭环与节奏** | §20.5–20.6 | 四子系统协作 → 节奏控制与配置 | ⭐⭐ 理解完整闭环 |
| **三、边界：安全与外部集成** | §20.7–20.8 | 安全约束 → 外部记忆提供者 | ⭐ 按需查阅 |

---

# 一、核心：触发与执行

> 学习循环有三个核心机制：Nudge 计数器决定"何时学习"，影子 Agent 执行"学什么"，记忆 Flush 处理"紧急情况下怎么学"。这三者构成了学习循环的引擎。

## 20.2 Nudge 机制：何时触发学习

学习循环的第一个关键问题是：系统如何决定"现在该回顾了"？答案是两个独立的计数器，分别追踪用户交互的"量"：

```python
# run_agent.py — AIAgent.__init__()
self._memory_nudge_interval = 10
self._memory_flush_min_turns = 6
self._turns_since_memory = 0
self._iters_since_skill = 0
```

`_memory_nudge_interval` 控制每隔多少个用户轮次触发一次记忆回顾。默认值 10 意味着用户发送第 10 条消息后，系统会安排一次后台记忆审查。`_skill_nudge_interval` 则以工具调用迭代次数为单位，默认同样是 10——当 Agent 在一系列对话中累计执行了 10 次工具迭代后，系统会审视是否有值得提炼的操作模式。

这两个间隔值都可以通过配置文件覆盖：

```python
# run_agent.py — AIAgent.__init__()
mem_config = _agent_cfg.get("memory", {})
self._memory_nudge_interval = int(mem_config.get("nudge_interval", 10))

skills_config = _agent_cfg.get("skills", {})
self._skill_nudge_interval = int(skills_config.get("creation_nudge_interval", 10))
```

为什么选择两个不同的度量维度？因为记忆和技能的触发场景截然不同。用户偏好的揭示与对话轮次相关——用户在第 3 轮说"我喜欢简洁的输出"、第 7 轮说"不要用 emoji"——这些信号散布在对话的时间线上，按轮次计数最自然。而可复用操作模式的发现与工具调用密度相关——如果 Agent 在一轮对话中连续调用了 8 个工具来完成一项复杂任务，这种密集操作本身就暗示着值得提炼的流程，即使对话总轮次并不多。

### 20.2.1 记忆 Nudge 的触发位置

记忆计数器在 `run_conversation()` 的入口处递增，这确保了每个用户轮次都被计入：

```python
# run_agent.py — run_conversation() 入口
_should_review_memory = False
if (self._memory_nudge_interval > 0
        and "memory" in self.valid_tool_names
        and self._memory_store):
    self._turns_since_memory += 1
    if self._turns_since_memory >= self._memory_nudge_interval:
        _should_review_memory = True
        self._turns_since_memory = 0
```

三个前置条件缺一不可：nudge 间隔必须为正数（0 表示禁用）、memory 工具必须注册在当前工具集中、_memory_store 必须已初始化。当计数器达到阈值时，`_should_review_memory` 被设为 True，计数器归零开始下一个周期。

源码中有一条关键注释值得特别关注：

```python
# run_agent.py — run_conversation()
# NOTE: _turns_since_memory and _iters_since_skill are NOT reset here.
# They are initialized in __init__ and must persist across run_conversation
# calls so that nudge logic accumulates correctly in CLI mode.
```

在 CLI 模式下，同一个 `AIAgent` 实例会处理多轮对话，每轮调用一次 `run_conversation()`。计数器在 `__init__` 中初始化后一直累积，跨越多次 `run_conversation` 调用。这意味着即使每次对话只有两三轮，累积到第十轮时仍然会触发审查。如果在 `run_conversation` 入口重置计数器，就会丢失跨调用的累积信息。

### 20.2.2 技能 Nudge 的触发位置

技能计数器的递增位置不同——它在 Agent 主循环的每次迭代中递增：

```python
# run_agent.py — agent 主循环
# Track tool-calling iterations for skill nudge.
# Counter resets whenever skill_manage is actually used.
if (self._skill_nudge_interval > 0
        and "skill_manage" in self.valid_tool_names):
    self._iters_since_skill += 1
```

但技能的阈值检查发生在 `run_conversation()` 的出口处，在 Agent 完成响应之后：

```python
# run_agent.py — run_conversation() 结尾
_should_review_skills = False
if (self._skill_nudge_interval > 0
        and self._iters_since_skill >= self._skill_nudge_interval
        and "skill_manage" in self.valid_tool_names):
    _should_review_skills = True
    self._iters_since_skill = 0
```

入口递增、出口检查——这种分离设计意味着技能审查总是在本轮对话的所有工具调用完成之后才触发。这很重要：如果在工具调用过程中途触发审查，影子 Agent 看到的对话快照是不完整的，可能会错误地提炼出半成品技能。

### 20.2.3 计数器重置：主动使用时的短路

如果用户或 Agent 在对话中**主动**使用了 memory 或 skill_manage 工具，计数器会立即重置：

```python
# run_agent.py — 工具执行阶段
# Reset nudge counters
if function_name == "memory":
    self._turns_since_memory = 0
elif function_name == "skill_manage":
    self._iters_since_skill = 0
```

这段逻辑出现了两次——一次在并行工具执行路径（tool_calls 批量解析时），一次在串行工具执行路径（逐个工具调用时）。双重覆盖确保无论 Agent 走哪条执行分支，主动使用都能正确短路 nudge 计时器。

短路逻辑的设计意图是避免冗余：如果 Agent 在第 5 轮就已经主动保存了记忆，那么第 10 轮的自动审查就没有必要。计数器归零，下一个 10 轮周期重新开始。

---

## 20.3 影子 Agent：后台审查的实现

> 影子 Agent 是学习循环中最精妙的组件——它复用了 AIAgent 的全部能力，但运行在后台线程中，对用户完全不可见。

当 nudge 阈值到达且对话正常完成（未被中断）时，系统调用 `_spawn_background_review()` 来执行后台审查：

```python
# run_agent.py — run_conversation() 结尾
if final_response and not interrupted and (_should_review_memory or _should_review_skills):
    try:
        self._spawn_background_review(
            messages_snapshot=list(messages),
            review_memory=_should_review_memory,
            review_skills=_should_review_skills,
        )
    except Exception:
        pass  # Background review is best-effort
```

两个守卫条件值得注意。`final_response` 确保 Agent 确实产生了有效输出——如果对话因 API 错误而失败，没有有效的对话内容可供审查。`not interrupted` 排除了用户中断的情况——被 Ctrl+C 打断的对话往往是不完整的，从中提炼知识可能产生误导性结论。

`messages_snapshot=list(messages)` 创建了消息列表的浅拷贝。影子 Agent 在后台线程中运行，如果直接引用主线程的 messages 列表，可能会因为并发修改导致不可预测的行为。浅拷贝确保影子 Agent 看到的是触发审查那一刻的对话快照。

### 20.3.1 审查 Prompt 的三种形态

影子 Agent 接收的 prompt 根据审查类型有三种变体：

```python
# run_agent.py — AIAgent 类
_MEMORY_REVIEW_PROMPT = (
    "Review the conversation above and consider saving to memory "
    "if appropriate.\n\n"
    "Focus on:\n"
    "1. Has the user revealed things about themselves — their persona, "
    "desires, preferences, or personal details worth remembering?\n"
    "2. Has the user expressed expectations about how you should behave, "
    "their work style, or ways they want you to operate?\n\n"
    "If something stands out, save it using the memory tool. "
    "If nothing is worth saving, just say 'Nothing to save.' and stop."
)
```

Memory Review Prompt 聚焦于两类信息：用户的个人特征（身份、偏好、习惯）和用户对 Agent 行为的期望（工作风格、输出格式、交互方式）。这两类恰好对应 MEMORY.md 和 USER.md 的分工——前者存储用户画像，后者存储 Agent 应遵循的行为约束。

```python
_SKILL_REVIEW_PROMPT = (
    "Review the conversation above and consider saving or updating "
    "a skill if appropriate.\n\n"
    "Focus on: was a non-trivial approach used to complete a task "
    "that required trial and error, or changing course due to "
    "experiential findings along the way, or did the user expect "
    "or desire a different method or outcome?\n\n"
    "If a relevant skill already exists, update it with what you learned. "
    "Otherwise, create a new skill if the approach is reusable.\n"
    "If nothing is worth saving, just say 'Nothing to save.' and stop."
)
```

Skill Review Prompt 关注的是"非平凡的方法"——trial and error（试错）、changing course（改变策略）、experiential findings（经验性发现）。这些词汇精确地描述了值得提炼为 Skill 的知识类型：不是简单的 API 调用序列，而是需要在实践中才能获得的操作智慧。

当两个计数器同时到达阈值时，使用 Combined Prompt 合并两个审查任务：

```python
_COMBINED_REVIEW_PROMPT = (
    "Review the conversation above and consider two things:\n\n"
    "**Memory**: Has the user revealed things about themselves — ...\n\n"
    "**Skills**: Was a non-trivial approach used to complete a task ...\n\n"
    "Only act if there's something genuinely worth saving. "
    "If nothing stands out, just say 'Nothing to save.' and stop."
)
```

合并审查节省了一次 LLM API 调用。单独审查需要两次调用（一次记忆、一次技能），合并后只需一次。考虑到这是后台操作，不会阻塞用户，额外的 API 调用主要是成本问题而非延迟问题。

### 20.3.2 影子 Agent 的构造

`_spawn_background_review()` 的实现揭示了影子 Agent 的完整构造过程：

```python
# run_agent.py — _spawn_background_review()
def _run_review():
    import contextlib, os as _os
    review_agent = None
    try:
        with open(_os.devnull, "w") as _devnull, \
             contextlib.redirect_stdout(_devnull), \
             contextlib.redirect_stderr(_devnull):
            review_agent = AIAgent(
                model=self.model,
                max_iterations=8,
                quiet_mode=True,
                platform=self.platform,
                provider=self.provider,
            )
            review_agent._memory_store = self._memory_store
            review_agent._memory_enabled = self._memory_enabled
            review_agent._user_profile_enabled = self._user_profile_enabled
            review_agent._memory_nudge_interval = 0
            review_agent._skill_nudge_interval = 0

            review_agent.run_conversation(
                user_message=prompt,
                conversation_history=messages_snapshot,
            )
```

有几个关键设计决策。首先，`contextlib.redirect_stdout(_devnull)` 和 `redirect_stderr(_devnull)` 将影子 Agent 的所有标准输出和错误输出重定向到 `/dev/null`。影子 Agent 在构造 AIAgent 时会打印初始化信息，在工具调用时会打印进度，这些信息混入主线程的输出会让用户困惑。静默构造确保用户永远不会看到后台活动的杂乱日志。

其次，`review_agent._memory_store = self._memory_store` 通过直接赋值共享了主 Agent 的 MemoryStore 实例。这是整个学习循环的关键连接点——影子 Agent 调用 memory 工具时，写入的是与主 Agent 相同的 MEMORY.md 文件。不需要 IPC、不需要消息队列，Python 对象引用即是最简单的共享机制。由于 MemoryStore 内部使用了文件锁（见第 17 章 `_write_snapshot()` 的 `fcntl.flock` 保护），即使两个 Agent 同时写入也不会产生数据损坏。

第三，`review_agent._memory_nudge_interval = 0` 和 `_skill_nudge_interval = 0` 禁用了影子 Agent 自身的 nudge 逻辑。如果不禁用，影子 Agent 在审查过程中可能再次触发 nudge，导致递归生成更多影子 Agent——一个经典的无限循环问题。

`max_iterations=8` 为影子 Agent 设置了迭代上限。审查任务通常只需要 1-3 次工具调用（读取当前记忆、决定是否保存、执行保存），但 8 次的上限为更复杂的情况提供了余量，例如需要先查看已有 Skill 列表再决定是创建还是更新。

### 20.3.3 审查结果的反馈

影子 Agent 完成审查后，其工具调用的结果会被扫描并以简洁摘要的形式通知用户：

```python
# run_agent.py — _run_review() 末尾
actions = []
for msg in getattr(review_agent, "_session_messages", []):
    if not isinstance(msg, dict) or msg.get("role") != "tool":
        continue
    try:
        data = json.loads(msg.get("content", "{}"))
    except (json.JSONDecodeError, TypeError):
        continue
    if not data.get("success"):
        continue
    message = data.get("message", "")
    target = data.get("target", "")
    if "created" in message.lower():
        actions.append(message)
    elif "updated" in message.lower():
        actions.append(message)
    # ... 更多匹配模式

if actions:
    summary = " · ".join(dict.fromkeys(actions))
    self._safe_print(f"  💾 {summary}")
```

这段代码遍历影子 Agent 的会话消息，提取所有成功的工具调用结果，根据关键词（created、updated、added、removed、replaced）分类，去重后用 `·` 连接成一行摘要。用户会在终端看到类似 `💾 Memory updated · Skill "docker-compose-debug" created` 这样的简洁通知。

`dict.fromkeys(actions)` 用于去重——如果影子 Agent 对 MEMORY.md 做了两次更新（比如先添加一个条目再修改另一个），用户只会看到一次 "Memory updated"。

`self._safe_print()` 而非直接 `print()` 的选择确保了线程安全。影子 Agent 在 daemon 线程中运行，如果主线程同时在输出（比如用户已经在处理下一轮对话），直接 print 可能导致输出交错。`_safe_print` 内部使用锁来序列化打印操作。

`background_review_callback` 则为网关模式（Slack/Teams/Discord）提供了回调接口——在这些平台上，直接 print 到 stdout 没有意义，需要通过回调将通知推送到对应的聊天频道。

### 20.3.4 线程模型与资源清理

影子 Agent 运行在 daemon 线程中：

```python
t = threading.Thread(target=_run_review, daemon=True, name="bg-review")
t.start()
```

`daemon=True` 意味着当主进程退出时，daemon 线程会被强制终止而不会阻止进程退出。这是一个务实的选择——后台审查是 best-effort 的，如果用户在审查完成前退出了 Hermes，丢失一次审查机会不会造成数据损失。

资源清理在 `finally` 块中处理：

```python
finally:
    if review_agent is not None:
        try:
            review_agent.close()
        except Exception:
            pass
```

`review_agent.close()` 关闭 httpx 客户端、子进程和其他资源。注释特别提到，如果不显式关闭，Python GC 在清理时可能会遇到"Event loop is closed"错误——这是因为 daemon 线程在主线程的 asyncio event loop 已经关闭后仍然持有对它的引用。

---

## 20.4 记忆 Flush：压缩前的紧急保存

> 除了定期的后台审查，还有一个更紧迫的保存时机——当对话即将被压缩时。Flush 机制是学习循环的"安全网"。

除了定期的后台审查，还有一个更紧迫的保存时机——当对话即将被压缩（context window 即将溢出）时。此时如果不保存，压缩后的摘要会丢失细节，用户偏好可能就此湮没。

```python
# run_agent.py — _flush_memory_before_compression()
def _flush_memory_before_compression(self, messages=None, min_turns=None):
    """Flush pending observations to MEMORY.md before context compression.

    Called before compression, session reset, or CLI exit. Injects a flush
    message, makes one API call, executes any memory tool calls, then
    strips all flush artifacts from the message list.
    """
    if self._memory_flush_min_turns == 0 and min_turns is None:
        return
    if "memory" not in self.valid_tool_names or not self._memory_store:
        return
    effective_min = min_turns if min_turns is not None else self._memory_flush_min_turns
    if self._user_turn_count < effective_min:
        return
```

Flush 机制的触发有一个最低轮次门槛 `_memory_flush_min_turns`（默认值 6）。如果用户只交互了两三轮就触发了压缩（可能因为粘贴了大段代码），对话内容太少，提炼记忆的价值不大。6 轮的门槛确保只有足够丰富的对话才值得紧急保存。

Flush 的实现比后台审查更直接——它不是派生影子 Agent，而是在当前对话上下文中注入一条系统消息，然后执行一次同步 API 调用：

```python
flush_content = (
    "[System: The session is being compressed. "
    "Save anything worth remembering — prioritize user preferences, "
    "corrections, and recurring patterns over task-specific details.]"
)
```

注入的提示词明确指出了保存优先级：用户偏好 > 纠正 > 模式 > 任务细节。这个优先级反映了一个务实的判断——任务细节可以通过 session_search 检索到，但用户偏好如果丢失就需要用户重复表达。

Flush 完成后，所有注入的消息（flush prompt、LLM 响应、工具调用结果）都会从消息列表中移除，不留任何痕迹。这确保了 Flush 操作对后续的压缩和会话持久化完全透明。

---

# 二、全景：闭环与节奏

> 核心机制已经清晰了。这部分将镜头拉远，展示四个子系统如何在一个完整的使用场景中协作，以及如何通过配置调整学习的节奏。

## 20.5 四个子系统的闭环协作

现在让我们追踪一个完整的学习循环，从知识的产生到重新激活。

**第一阶段：知识产生**。用户第一次要求 Hermes 配置一个复杂的 Docker Compose 环境。Agent 经过 12 次工具迭代——读取文件、修改 YAML、运行容器、排查错误、再次修改——最终完成任务。在这个过程中，用户提到"我的项目都用 port 3000-3010 这个范围"，并纠正了 Agent 的一个假设："不要用 Alpine 镜像，我需要完整的 Debian 基础镜像"。

**第二阶段：Nudge 触发**。这次对话中 Agent 执行了 12 次工具迭代，`_iters_since_skill` 达到了阈值 10。同时因为这已经是今天的第 11 轮对话，`_turns_since_memory` 也达到了阈值。两个标志同时被设置，系统选择 Combined Review Prompt。

**第三阶段：后台审查**。`_spawn_background_review()` 创建影子 Agent。影子 Agent 分析对话快照，做出两个决定：
1. 调用 `memory("add", target="user", text="Prefers Debian-based images over Alpine · Uses port range 3000-3010 for local projects")`
2. 调用 `skill_manage("create", name="docker-compose-debug", content="...")`，其中 content 包含了从试错过程中提炼的调试步骤

用户在终端看到：`💾 User profile updated · Skill "docker-compose-debug" created`

**第四阶段：持久化**。memory 工具调用将偏好写入 `~/.hermes/user/USER.md`（参见第 17 章的 `_write_snapshot` 原子写入流程）。skill_manage 工具调用将 SKILL.md 文件写入 `~/.hermes/skills/docker-compose-debug/SKILL.md`（参见第 18 章的技能创建流程）。同时，整段对话已经被 SessionDB 存储到 SQLite 数据库，并通过 FTS5 触发器建立了全文索引（参见第 16 章）。

**第五阶段：下次会话激活**。一周后，用户开始新会话，说"帮我调试 Docker Compose 的网络问题"。三个子系统同时响应：
- **Memory**：USER.md 的内容已经嵌入 system prompt 的冻结快照区域，Agent 知道应该使用 Debian 基础镜像和 3000-3010 端口范围，无需再次询问。
- **Skills**：当 Agent 调用 `skills_list("docker")` 时，"docker-compose-debug" 出现在列表中。Agent 调用 `skill_view("docker-compose-debug")` 获取完整的调试步骤，跳过了上次的试错过程。
- **Session Search**：如果 Agent 需要了解上次的具体细节（比如用户的项目用了哪些服务），可以调用 `session_search("docker compose")` 找到上次对话的摘要。

这就是完整的闭环。没有任何子系统单独完成了这个循环——SessionDB 存储了原始对话但不会主动提炼知识，Memory 持久化了偏好但不知道如何发现偏好，Skills 管理了操作模式但依赖影子 Agent 来创建它们，Session Search 检索了历史但需要 FTS5 索引作为基础。四个子系统各自专注于自己的职责，通过影子 Agent 这个编排者串联成一个有机整体。

---

## 20.6 学习循环的节奏控制

默认的 nudge 间隔（每 10 轮/迭代）并非随意选择。太频繁的审查会产生大量低质量的记忆条目和技能文件——大多数 2-3 轮的简短对话不包含值得持久化的信息。太稀疏的审查则可能导致重要信息在压缩中丢失（尽管有 flush 机制作为安全网）。

10 这个数字在 CLI 模式下意味着大约每 10 分钟到 1 小时触发一次审查（取决于用户的交互速度）。在网关模式（Slack/Teams）下，由于每条消息都是一次独立的 `run_conversation` 调用，10 轮可能跨越数小时甚至数天。这种自然的节奏适应了不同平台的使用模式。

配置文件允许精细调整：

```yaml
# ~/.hermes/config.yaml
memory:
  memory_enabled: true
  nudge_interval: 5       # 更频繁的记忆审查
  flush_min_turns: 3      # 更低的 flush 门槛

skills:
  creation_nudge_interval: 15  # 更保守的技能创建节奏
```

将 `nudge_interval` 设为 0 会完全禁用后台记忆审查。将 `creation_nudge_interval` 设为 0 会禁用技能审查。但即使禁用了自动审查，用户和 Agent 仍然可以主动调用 memory 和 skill_manage 工具——nudge 机制只是自动化的补充，而非唯一的知识获取通道。

### 学习循环的时序全景

将本章介绍的所有机制放在一个时间轴上，可以清晰地看到学习循环的完整节奏：

```
时间线: 用户轮次 T1 ... T10 ... T20 ... Tn
─────────────────────────────────────────────────

_turns_since_memory:  1  2  3  ...  10(→审查→0)  1  2  ...
_iters_since_skill:   3  5  8  ...  12(→审查→0)  2  4  ...
                                ↑                     ↑
                         memory+skill review    skill review only

对话压缩触发（context window 满）:
  └── _flush_memory_before_compression()
      └── 同步 API 调用，紧急保存关键记忆

Session 结束 / CLI exit:
  └── on_session_end() → 外部提供者最终同步

下次会话启动:
  ├── MEMORY.md → frozen snapshot → system prompt
  ├── Skills → progressive disclosure → 按需加载
  └── SessionDB → FTS5 → session_search → LLM 摘要
```

这个时序图展示了三种不同时间尺度的知识流动：**实时**（外部提供者的 sync_all 在每轮对话后执行）、**周期性**（nudge 机制每 10 轮/迭代触发后台审查）、**事件驱动**（压缩前的紧急 flush）。三种机制互相补充，确保了知识在不同场景下都不会丢失。

---

# 三、边界：安全与外部集成

> 学习循环赋予了 Agent 自我改进的能力，但这种能力必须受到约束。这部分讨论安全限制和外部记忆提供者的协作。

## 20.7 自进化的边界与安全约束

学习循环赋予了 Agent 自我改进的能力，但这种能力必须受到严格约束。Hermes 的设计在三个层面施加了限制。

**第一层：工具级约束**。memory 工具的 `_scan_memory_content()` 会扫描 58 种注入威胁模式（见第 17 章），防止恶意内容通过学习循环注入 system prompt。skill_manage 工具在创建 SKILL.md 时会检查路径遍历攻击（`../`），确保技能文件只能写入授权的目录。这些约束确保即使 LLM 产生了恶意输出，也无法通过学习循环持久化危险内容。

**第二层：影子 Agent 的能力限制**。影子 Agent 的 `max_iterations=8` 限制了它的操作范围。它共享了主 Agent 的工具集（包括文件读写工具），理论上可以修改任意文件。但审查 prompt 的设计——明确要求只使用 memory 和 skill_manage 工具——加上 8 次迭代的预算，使得影子 Agent 实际上只能执行有限的保存操作。这是一种"软约束"，依赖于 LLM 对 prompt 的遵循。

**第三层：知识积累的自然淘汰**。MEMORY.md 有字符数限制（默认 2200 字符），当积累到上限时，新条目会替换旧条目。SKILL.md 文件虽然没有自动删除机制，但 `skill_manage` 工具的 `disable` 操作允许用户或 Agent 停用过时的技能（参见第 18 章的 `disabled_skills` 配置）。这种有限容量的设计天然地迫使系统只保留最有价值的知识。

当前版本的学习循环有一个值得注意的局限：影子 Agent 无法评估自己创建的知识的质量。它可能创建了一个错误的 Skill（因为 LLM 误解了对话意图），但没有自动验证机制来发现这个错误。纠错依赖用户在后续会话中发现问题并手动修改或删除。这是 v0.8.0 版本的已知限制，未来版本可能会引入"知识验证"机制——在应用 Skill 后检查结果是否符合预期，并据此更新或淘汰 Skill。

---

## 20.8 与外部记忆提供者的协作

第 17 章介绍了 MemoryManager 如何协调内建记忆和外部提供者。在学习循环的语境下，外部提供者增加了一个额外的知识同步节点。

在 `run_conversation()` 的结尾，对话完成后，外部提供者会收到同步通知：

```python
# run_agent.py — run_conversation() 结尾
if self._memory_manager and final_response and original_user_message:
    try:
        self._memory_manager.sync_all(original_user_message, final_response)
        self._memory_manager.queue_prefetch_all(original_user_message)
    except Exception:
        pass
```

`sync_all()` 将当前轮次的用户消息和 Agent 响应发送给外部提供者（如 Honcho、mem0）。这些提供者可以用自己的方式分析和存储这些信息——比如 Honcho 会基于对话历史构建用户画像，mem0 会通过向量嵌入建立语义索引。

`queue_prefetch_all()` 为下一轮对话预取相关记忆。当用户发送下一条消息时，外部提供者已经准备好了可能相关的上下文，无需等待查询。

注意 `original_user_message` 的使用——这是未注入 Skill 内容的原始用户消息。如果使用处理后的 `user_message`（可能包含了 `build_skill_invocation_message()` 注入的大段 Skill 内容），会导致外部提供者接收到大量不相关的文本，污染其知识索引。

---

## 20.9 本章小结

封闭学习循环是 Hermes Agent 的核心竞争力之一。它不要求用户显式地"教"Agent 任何东西——学习发生在对话的自然节奏中，通过 nudge 计数器触发，由影子 Agent 在后台默默执行。

这个循环的设计体现了几个核心原则。**非侵入性**——用户永远不会被学习过程打断，只会在学习完成后收到一行简洁的 💾 通知。**渐进积累**——知识不是一次性提取的，而是在多次对话中逐步积累和精炼的。**容错设计**——每个环节都包裹在 `try/except` 中，任何一个子系统的失败都不会影响核心对话功能。**有限容量**——MEMORY.md 的字符限制和 Skills 的禁用机制确保知识库不会无限膨胀。

从第 16 章的 SQLite 存储层到第 20 章的封闭循环，Part 4 完整地描绘了 Hermes Agent 如何在会话之间保持连续性。下一部分（Part 5）将转向 Agent 的安全边界——当 Agent 拥有了文件读写、命令执行、甚至自我进化的能力时，如何确保它不会造成不可逆的损害。

---

## 速查表

| 组件 | 文件 | 角色 |
|------|------|------|
| Nudge 计数器 | `run_agent.py` L1093-1096 | 追踪轮次/迭代数，决定何时触发审查 |
| 审查 Prompt | `run_agent.py` L2070-2103 | Memory/Skill/Combined 三种审查指令 |
| `_spawn_background_review()` | `run_agent.py` L2105-2204 | 创建影子 Agent，执行后台审查 |
| 记忆 Nudge 触发 | `run_agent.py` L7667-7677 | 在 `run_conversation()` 入口检查 |
| 技能 Nudge 递增 | `run_agent.py` L7920-7924 | 在 Agent 主循环每次迭代时递增 |
| 技能 Nudge 触发 | `run_agent.py` L10309-10315 | 在 `run_conversation()` 出口检查 |
| 计数器重置 | `run_agent.py` L6826-6832, L7029-7032 | 主动使用工具时短路计数器 |
| 记忆 Flush | `run_agent.py` L6430-6490 | 压缩前的紧急记忆保存 |
| 外部提供者同步 | `run_agent.py` L10317-10325 | 每轮对话后同步到外部记忆服务 |
| 后台审查回调 | `run_agent.py` L2184-2189 | 网关模式的审查结果推送 |

| 配置项 | 默认值 | 含义 |
|--------|--------|------|
| `memory.nudge_interval` | 10 | 每 N 个用户轮次触发记忆审查 |
| `memory.flush_min_turns` | 6 | 压缩前 flush 的最低轮次门槛 |
| `skills.creation_nudge_interval` | 10 | 每 N 次工具迭代触发技能审查 |
| `memory.memory_char_limit` | 2200 | MEMORY.md 的字符上限 |
| `memory.user_char_limit` | 1375 | USER.md 的字符上限 |
