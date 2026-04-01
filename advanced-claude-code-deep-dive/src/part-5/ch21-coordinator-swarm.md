
# 第 21 章：Coordinator — Swarm 协调模式

> **核心问题**：当任务复杂到需要一个"指挥官"来分解工作、分配给多个 Worker、监控进度并整合结果时，Claude Code 如何从单 Agent 进化为一个完整的 Swarm 系统？Coordinator 模式的工作流、Worker 通信协议和并发管理策略是什么？

在第 16 章中，我们剖析了 Sub-Agent、Fork 和 Team 三层多智能体协作模型。这三层模型解决了"怎么把工作分出去"的问题，但它们有一个共同的局限：**决策权仍然在人类用户手中**。用户需要自己判断何时派生 Sub-Agent、如何分解任务、怎样验证结果。

Coordinator 模式改变了这个范式。它在系统提示词层面将 Claude Code 重新定义为一个**指挥官角色**：不再直接执行任务，而是制定策略、生成 Worker、综合结果、驱动验证。这是从"有工具的 Agent"到"有 Agent 的 Orchestrator"的质变。

---

## 21.1 从 Team 到 Coordinator：架构进化

### 三层模型的局限

回顾第 16 章的三层协作模型：

```
┌──────────────┐   ┌──────────────┐   ┌──────────────────┐
│  Sub-Agent   │   │    Fork      │   │      Team        │
│  简单委派     │   │  廉价并行     │   │  完整协作         │
└──────────────┘   └──────────────┘   └──────────────────┘
```

这三层模型的共同特点是：**主 Agent 既是决策者，也是执行者**。它自己写代码、自己跑命令、顺便派一两个 Sub-Agent 做辅助工作。这在"修一个 bug"级别的任务中完全够用，但面对"重构整个认证模块"这样的大任务时，主 Agent 的上下文窗口会被自身的执行细节淹没，无法保持战略视角。

### Coordinator 的定位

Coordinator 模式引入了一个新的抽象层：

```
┌─────────────────────────────────────────────────┐
│               Coordinator (指挥官)                │
│                                                   │
│  ◆ 不直接执行工具（Bash/Read/Edit 等）            │
│  ◆ 只拥有 Agent + SendMessage + TaskStop 三种工具  │
│  ◆ 通过 Worker 完成所有实际工作                     │
│  ◆ 自身专注于：理解问题 → 分解任务 → 综合结果       │
└─────────┬─────────────┬──────────────┬──────────┘
          │             │              │
    ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐
    │ Worker A  │ │ Worker B  │ │ Worker C  │
    │ (研究)    │ │ (实现)    │ │ (验证)    │
    │           │ │           │ │           │
    │ Bash/Read │ │ Edit/Write│ │ Bash/Read │
    │ Grep/Glob │ │ Bash/Grep │ │ Grep/Glob │
    └───────────┘ └───────────┘ └───────────┘
```

| 维度 | Team Lead（第16章） | Coordinator |
|------|---------------------|-------------|
| 自身工具 | 全部工具 + TeamCreate/SendMessage | 仅 Agent + SendMessage + TaskStop |
| 代码执行 | 自己写代码 + 委派 | **从不直接执行**，全部委派 |
| 上下文用途 | 执行细节 + 协调 | **纯协调** — 理解、综合、分配 |
| Worker 通信 | SendMessage（双向邮箱） | `<task-notification>` XML 通知 |
| Worker 类型 | 多种 subagent_type | 统一使用 `worker` 类型 |
| 并发模型 | 手动管理 | **内建并发策略**（读并行/写串行） |

> **设计决策**：Coordinator 通过**剥夺自身的执行工具**来强制关注点分离。这不是能力限制，而是架构约束 — 一个不能直接写代码的 Agent 必须学会清晰表达意图、有效分解任务、精确验证结果。这与软件工程中"架构师不写业务代码"的理念一脉相承。

---

## 21.2 Coordinator 模式激活

### 环境变量门控

Coordinator 模式的激活需要两个条件同时满足：

```typescript
// src/coordinator/coordinatorMode.ts:36-41
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {              // 编译期 feature flag
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)  // 运行时环境变量
  }
  return false
}
```

双重门控的设计确保了：
1. **编译期**：通过 `bun:bundle` 的 `feature('COORDINATOR_MODE')` 控制代码是否打包，支持 dead code elimination
2. **运行时**：通过 `CLAUDE_CODE_COORDINATOR_MODE` 环境变量控制实际激活

### 会话模式匹配

当用户通过 `--resume` 恢复一个 Coordinator 会话时，系统需要确保当前模式与保存的模式一致：

```typescript
// src/coordinator/coordinatorMode.ts:49-78
export function matchSessionMode(
  sessionMode: 'coordinator' | 'normal' | undefined,
): string | undefined {
  if (!sessionMode) return undefined       // 旧版会话，无模式信息

  const currentIsCoordinator = isCoordinatorMode()
  const sessionIsCoordinator = sessionMode === 'coordinator'

  if (currentIsCoordinator === sessionIsCoordinator) return undefined

  // 模式不匹配 — 翻转环境变量
  if (sessionIsCoordinator) {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
  } else {
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
  }
  // ...
}
```

这意味着：如果你恢复了一个 Coordinator 会话，即使当前没有设置 `CLAUDE_CODE_COORDINATOR_MODE`，系统也会自动切换到 Coordinator 模式。模式跟随会话，而不是跟随环境。

### 与 Fork Subagent 的互斥

Coordinator 模式与 Fork Subagent 机制互斥：

```typescript
// src/tools/AgentTool/forkSubagent.ts:32-39
export function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {
    if (isCoordinatorMode()) return false   // ← 互斥
    if (getIsNonInteractiveSession()) return false
    return true
  }
  return false
}
```

> **设计决策**：Fork 的核心优势是"继承父 Agent 的上下文以共享 prompt cache"。但 Coordinator 的上下文是纯协调信息（任务分解、Worker 状态），对 Worker 毫无用处。Fork 继承这些协调上下文反而是噪声，因此直接禁用。

### 系统提示词注入

Coordinator 模式的系统提示词通过 `buildEffectiveSystemPrompt` 注入：

```typescript
// src/utils/systemPrompt.ts:59-75
if (
  feature('COORDINATOR_MODE') &&
  isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE) &&
  !mainThreadAgentDefinition
) {
  const { getCoordinatorSystemPrompt } =
    require('../coordinator/coordinatorMode.js')
  return asSystemPrompt([
    getCoordinatorSystemPrompt(),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])
}
```

注意条件 `!mainThreadAgentDefinition`：当用户通过 Agent 前端（如自定义 Agent）启动时，Agent 自身的 system prompt 优先。Coordinator 模式只在"裸启动"时生效。

### 工具池裁剪

在 Coordinator 模式下，主线程的工具池被大幅裁剪：

```typescript
// src/tools.ts:288-296
// 简单模式下的 Coordinator 工具池
const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
if (coordinatorModeModule?.isCoordinatorMode()) {
  simpleTools.push(AgentTool, TaskStopTool, getSendMessageTool())
}
```

Coordinator 自身不需要 Bash、Read、Edit 等工具 — 这些工具是给 Worker 用的。Coordinator 的工具池只包含三个核心工具：

| 工具 | 用途 |
|------|------|
| `Agent` | 生成新 Worker |
| `SendMessage` | 继续已有 Worker 或发送后续指令 |
| `TaskStop` | 停止正在运行的 Worker |

---

## 21.3 系统提示词深度解析

Coordinator 的系统提示词（约370行）是整个 Swarm 系统的"操作手册"。它不仅定义了角色，还精确规定了工作流、通信协议和反模式。让我们逐段解析。

### 角色定义（Section 1）

```
You are Claude Code, an AI assistant that orchestrates
software engineering tasks across multiple workers.

You are a **coordinator**. Your job is to:
- Help the user achieve their goal
- Direct workers to research, implement and verify code changes
- Synthesize results and communicate with the user
- Answer questions directly when possible — don't delegate work
  that you can handle without tools
```

关键词：**orchestrates**。不是 "executes"，不是 "implements" — 是编排。最后一条尤其重要：简单问题直接回答，不要为了"看起来很忙"而派 Worker 去做搜索。

### 工具说明（Section 2）

系统提示词明确列出了 Coordinator 可用的工具，并附带**使用约束**：

```
When calling Agent:
- Do not use one worker to check on another
- Do not use workers to trivially report file contents
- Do not set the model parameter
- Continue workers whose work is complete via SendMessage
- After launching agents, briefly tell the user what you launched
  and end your response
- Never fabricate or predict agent results
```

每条约束都有深层原因：

| 约束 | 原因 |
|------|------|
| 不要用 Worker 检查 Worker | Worker 完成后自动通知，轮询浪费 token |
| 不要用 Worker 读文件 | 这是浪费整个 agentic loop 的开销 |
| 不要设置 model 参数 | Worker 需要默认模型处理实质性工作 |
| 用 SendMessage 继续已完成 Worker | 复用其已加载的上下文，避免重新搜索 |
| 启动后简短告知用户并结束回复 | 不要阻塞等待 Worker 结果 |
| 不要伪造或预测结果 | 结果以 `<task-notification>` 异步到达 |

### Worker 通知协议

Worker 的结果以特殊的 XML 格式作为 user-role 消息到达：

```xml
<task-notification>
  <task-id>{agentId}</task-id>
  <status>completed|failed|killed</status>
  <summary>{human-readable status summary}</summary>
  <result>{agent's final text response}</result>
  <usage>
    <total_tokens>N</total_tokens>
    <tool_uses>N</tool_uses>
    <duration_ms>N</duration_ms>
  </usage>
</task-notification>
```

这是一个精心设计的消息协议：

```
┌──────────────────────────────────────────────────┐
│                  消息流向                          │
│                                                    │
│  Coordinator                    Worker              │
│       │                           │                 │
│       │  Agent({prompt: "..."})   │                 │
│       ├─────────────────────────→ │  (异步启动)     │
│       │                           │                 │
│       │                           │  ...执行工具... │
│       │                           │  ...Bash/Read...│
│       │                           │  ...Edit/Write..│
│       │                           │                 │
│       │  <task-notification>      │                 │
│       │ ◁━━━━━━━━━━━━━━━━━━━━━━━━━┤  (完成/失败)    │
│       │  (作为 user 消息到达)      │                 │
│       │                           │                 │
│       │  SendMessage({to: id})    │                 │
│       ├─────────────────────────→ │  (继续执行)     │
│       │                           │                 │
└──────────────────────────────────────────────────┘
```

> **设计决策**：Worker 结果以 `user-role message` 而非 `tool_result` 到达。这让 Coordinator 可以在一个回合中同时收到多个 Worker 的结果，而不需要每个结果都对应一个 tool_use 调用。XML 标签 `<task-notification>` 是结构化的，但内嵌在自然语言流中，Claude 可以自然地解析和响应。

---

## 21.4 四阶段工作流

Coordinator 的核心工作流由四个阶段组成：

```
┌──────────┐    ┌──────────┐    ┌──────────────┐    ┌──────────┐
│  研究     │    │  综合     │    │  实现          │    │  验证     │
│ Research  │───▶│ Synthesis│───▶│ Implementation│───▶│ Verify   │
│          │    │          │    │              │    │          │
│ Workers  │    │Coordinator│    │  Workers      │    │ Workers  │
│ (并行)    │    │  (独占)   │    │  (按文件串行)  │    │ (并行)   │
└──────────┘    └──────────┘    └──────────────┘    └──────────┘
```

系统提示词中的阶段定义：

```
| Phase          | Who            | Purpose                                |
|----------------|----------------|----------------------------------------|
| Research       | Workers (并行) | 调查代码库, 找到文件, 理解问题          |
| Synthesis      | **Coordinator**| 阅读发现, 理解问题, 制定实现规格        |
| Implementation | Workers        | 按规格做定向修改, 提交                 |
| Verification   | Workers        | 测试变更有效                           |
```

### 阶段 1：研究（Research）

Coordinator 将研究任务拆分为多个角度，并行发射：

```typescript
// 系统提示词中的示例
Agent({ description: "Investigate auth bug",
        subagent_type: "worker",
        prompt: "Investigate the auth module in src/auth/. Find where
                 null pointer exceptions could occur around session
                 handling and token validation... Report specific
                 file paths, line numbers, and types involved.
                 Do not modify files." })

Agent({ description: "Research auth tests",
        subagent_type: "worker",
        prompt: "Find all test files related to src/auth/. Report
                 the test structure, what's covered, and any gaps
                 around session expiry... Do not modify files." })
```

关键约束：
- **明确说明"Do not modify files"** — 研究 Worker 只读
- **要求报告具体的文件路径、行号、类型签名** — 为综合阶段提供精确数据
- **多角度并行** — 同一条消息中多个 Agent 调用并行启动

### 阶段 2：综合（Synthesis）

这是 Coordinator **最重要的工作**，也是系统提示词着墨最多的部分。综合阶段由 Coordinator 自己完成，不委派给 Worker：

```
When workers report research findings, **you must understand them
before directing follow-up work**. Read the findings. Identify
the approach. Then write a prompt that proves you understood by
including specific file paths, line numbers, and exactly what
to change.

Never write "based on your findings" or "based on the research."
These phrases delegate understanding to the worker instead of
doing it yourself.
```

**反模式 vs 正模式**：

```typescript
// ✗ 反模式 — 懒惰委派
Agent({ prompt: "Based on your findings, fix the auth bug" })
Agent({ prompt: "The worker found an issue. Please fix it." })

// ✓ 正模式 — 综合后的精确规格
Agent({ prompt: "Fix the null pointer in src/auth/validate.ts:42.
                  The user field on Session (src/auth/types.ts:15)
                  is undefined when sessions expire but the token
                  remains cached. Add a null check before user.id
                  access — if null, return 401 with 'Session expired'.
                  Commit and report the hash." })
```

> **设计决策**："Never delegate understanding" 是 Coordinator 模式最核心的设计哲学。一个合格的指挥官必须**理解**每个 Worker 的发现，然后**精确表达**下一步的要求。如果 Coordinator 自己不理解问题就把工作扔给下一个 Worker，整个 Swarm 就退化成了一个低效的消息传递链。

### 阶段 3：实现（Implementation）

基于综合结果，Coordinator 向 Worker 下达精确的实现指令：

```
"Fix the null pointer in src/auth/validate.ts:42. Add a null check
 before accessing user.id — if null, return 401 with 'Session expired'.
 Commit and report the hash."
```

每个实现指令包含：
1. **具体位置**：文件路径 + 行号
2. **具体操作**：添加什么代码、修改什么逻辑
3. **完成标准**："Commit and report the hash"
4. **自验证要求**："Run relevant tests and typecheck"

### 阶段 4：验证（Verification）

系统提示词对验证有极其严格的要求：

```
Verification means **proving the code works**, not confirming
it exists. A verifier that rubber-stamps weak work undermines
everything.

- Run tests **with the feature enabled**
- Run typechecks and **investigate errors** — don't dismiss
  as "unrelated"
- Be skeptical — if something looks off, dig in
- **Test independently** — prove the change works, don't
  rubber-stamp
```

验证 Worker 应当独立于实现 Worker：

```
| Situation                          | Mechanism  | Why                    |
|------------------------------------|-----------|------------------------|
| Verifying code another worker wrote | Spawn fresh| 验证者应以新鲜眼光查看代码|
```

---

## 21.5 并发管理策略

### 并行是超能力

系统提示词对并发的强调非常直接：

```
**Parallelism is your superpower. Workers are async. Launch
independent workers concurrently whenever possible — don't
serialize work that can run simultaneously and look for
opportunities to fan out.**
```

### 三级并发规则

```
┌──────────────────────────────────────────────────────┐
│                 并发管理矩阵                           │
│                                                        │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────┐ │
│  │  只读任务     │   │  写入任务     │   │  验证任务  │ │
│  │  (研究)       │   │  (实现)       │   │           │ │
│  │              │   │              │   │           │ │
│  │  ✓ 自由并行  │   │  ✗ 每文件集  │   │  ✓ 可与   │ │
│  │              │   │    一次一个   │   │   不同区域 │ │
│  │  多角度同时  │   │              │   │   的实现   │ │
│  │  研究        │   │  避免写冲突  │   │   并行     │ │
│  └──────────────┘   └──────────────┘   └───────────┘ │
└──────────────────────────────────────────────────────┘
```

具体规则：

| 任务类型 | 并发策略 | 原因 |
|----------|----------|------|
| Read-only（研究） | 自由并行 | 不修改文件系统，无冲突风险 |
| Write-heavy（实现） | 每文件集一个 Worker | 避免多个 Worker 同时修改同一文件 |
| Verification（验证） | 可与不同区域的实现并行 | 验证的文件区域与正在实现的区域不重叠即可 |

### Continue vs Spawn 决策矩阵

综合阶段结束后，Coordinator 需要决定：继续已有 Worker 还是启动新 Worker？

```
| 情况                                | 机制       | 原因                      |
|-------------------------------------|-----------|---------------------------|
| 研究恰好覆盖了需要编辑的文件         | Continue   | Worker 已有文件上下文       |
| 研究范围广但实现范围窄              | Spawn fresh| 避免拖入探索噪声            |
| 修正失败或扩展近期工作              | Continue   | Worker 有错误上下文         |
| 验证另一个 Worker 的代码            | Spawn fresh| 验证者应独立查看            |
| 第一次实现完全用错了方法            | Spawn fresh| 错误上下文会锚定错误路径     |
| 完全无关的任务                      | Spawn fresh| 无有用上下文可复用          |
```

---

## 21.6 Worker 生命周期

### 生成（Spawn）

Worker 通过 `Agent` 工具生成。在 Coordinator 模式下，Agent 工具的 prompt 被简化（因为协调指南已在 Coordinator 系统提示词中）：

```typescript
// src/tools/AgentTool/prompt.ts:213-218
// Coordinator mode gets the slim prompt -- the coordinator system prompt
// already covers usage notes, examples, and when-not-to-use guidance.
if (isCoordinator) {
  return shared   // 只返回基本描述，省略详细使用说明
}
```

Worker 使用统一的 `subagent_type: "worker"` 类型。其可用工具通过 `getCoordinatorUserContext` 动态计算：

```typescript
// src/coordinator/coordinatorMode.ts:88-96
const workerTools = isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
  ? [BASH_TOOL_NAME, FILE_READ_TOOL_NAME, FILE_EDIT_TOOL_NAME]
      .sort().join(', ')
  : Array.from(ASYNC_AGENT_ALLOWED_TOOLS)
      .filter(name => !INTERNAL_WORKER_TOOLS.has(name))
      .sort().join(', ')
```

`INTERNAL_WORKER_TOOLS` 过滤掉了 Worker 不应该拥有的工具：

```typescript
// src/coordinator/coordinatorMode.ts:29-34
const INTERNAL_WORKER_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,    // Worker 不能创建团队
  TEAM_DELETE_TOOL_NAME,    // Worker 不能删除团队
  SEND_MESSAGE_TOOL_NAME,   // Worker 不能发消息（只有 Coordinator 能）
  SYNTHETIC_OUTPUT_TOOL_NAME, // 内部合成输出工具
])
```

Worker 的完整工具集（标准模式下）包括：

| 工具类别 | 包含的工具 |
|----------|-----------|
| 文件 I/O | Read, Write, Edit, Glob, Grep, NotebookEdit |
| 执行 | Bash (所有 shell 变体) |
| 搜索 | WebSearch, WebFetch |
| 任务管理 | TodoWrite, Skill, ToolSearch |
| 隔离 | EnterWorktree, ExitWorktree |

### 通知与继续（Notification & Continue）

Worker 完成后的通知由 `runAsyncAgentLifecycle` 驱动：

```typescript
// src/tools/AgentTool/agentToolUtils.ts:624-637
enqueueAgentNotification({
  taskId,
  description,
  status: 'completed',        // 或 'failed' / 'killed'
  setAppState: rootSetAppState,
  finalMessage,
  usage: {
    totalTokens: getTokenCountFromTracker(tracker),
    toolUses: agentResult.totalToolUseCount,
    durationMs: agentResult.totalDurationMs,
  },
  toolUseId: toolUseContext.toolUseId,
  ...worktreeResult,
})
```

通知以 `<task-notification>` XML 封装后作为 user-role 消息注入到 Coordinator 的对话流中。Coordinator 可以通过 `SendMessage` 继续该 Worker：

```typescript
// SendMessageTool 路由到 in-process subagent
if (typeof input.message === 'string' && input.to !== '*') {
  const appState = context.getAppState()
  const registered = appState.agentNameRegistry.get(input.to)
  const agentId = registered ?? toAgentId(input.to)
  if (agentId) {
    const task = appState.tasks[agentId]
    if (isLocalAgentTask(task)) {
      if (task.status === 'running') {
        // 运行中 — 排队等待下一轮工具调用
        queuePendingMessage(agentId, input.message, ...)
      } else {
        // 已停止 — 自动恢复
        resumeAgentBackground({ agentId, prompt: input.message, ... })
      }
    }
  }
}
```

### 停止（Stop）

`TaskStop` 工具用于终止方向错误的 Worker：

```typescript
// src/tools/TaskStopTool/TaskStopTool.ts:107-131
async call({ task_id, shell_id }, { getAppState, setAppState }) {
  const id = task_id ?? shell_id
  const result = await stopTask(id, { getAppState, setAppState })
  return {
    data: {
      message: `Successfully stopped task: ${result.taskId}`,
      task_id: result.taskId,
      task_type: result.taskType,
      command: result.command,
    },
  }
}
```

系统提示词中的停止示例：

```typescript
// 启动了一个错误方向的 Worker
Agent({ description: "Refactor auth to JWT",
        subagent_type: "worker",
        prompt: "Replace session-based auth with JWT..." })
// ... 返回 task_id: "agent-x7q"

// 用户澄清："实际上保留 sessions，只修 null pointer"
TaskStop({ task_id: "agent-x7q" })

// 用修正指令继续
SendMessage({ to: "agent-x7q",
              message: "Stop the JWT refactor. Instead, fix
                       the null pointer in validate.ts:42..." })
```

注意停止和继续是可以连续使用的 — 停止的 Worker 保留了其上下文，可以通过 SendMessage 恢复并给予新指令。

---

## 21.7 Scratchpad 共享：Worker 间的文件系统协作

### Scratchpad 机制

当 `tengu_scratch` feature gate 开启时，Coordinator 会在用户上下文中注入 Scratchpad 目录信息：

```typescript
// src/coordinator/coordinatorMode.ts:104-106
if (scratchpadDir && isScratchpadGateEnabled()) {
  content += `\n\nScratchpad directory: ${scratchpadDir}
Workers can read and write here without permission prompts.
Use this for durable cross-worker knowledge — structure files
however fits the work.`
}
```

Scratchpad 的路径格式为 `/tmp/claude-{uid}/{sanitized-cwd}/{sessionId}/scratchpad/`，其特点：

```
┌──────────────────────────────────────────────────────┐
│              Scratchpad 共享协作模型                    │
│                                                        │
│  Worker A (研究)                  Worker B (实现)       │
│       │                               │                │
│       │  Write: findings.md           │                │
│       ├───────────┐                   │                │
│       │           ▼                   │                │
│       │    ┌────────────┐             │                │
│       │    │ Scratchpad │             │                │
│       │    │ Directory  │             │                │
│       │    │            │             │                │
│       │    │findings.md │ ←───────────┤  Read: findings│
│       │    │plan.md     │             │                │
│       │    │notes/      │             │                │
│       │    └────────────┘             │                │
│       │                               │                │
│  ◆ 无需权限提示                                        │
│  ◆ Worker 自由组织文件结构                              │
│  ◆ 持久化跨 Worker 知识                                │
└──────────────────────────────────────────────────────┘
```

| 特性 | 说明 |
|------|------|
| 免权限 | Worker 读写 Scratchpad 不触发权限提示 |
| 临时性 | 路径绑定到 session ID，会话结束后可清理 |
| 自由结构 | 没有预设的文件组织方式，Worker 按需创建 |
| 安全隔离 | 路径在 `/tmp` 下，不影响项目代码库 |

> **设计决策**：Scratchpad 是 Worker 之间唯一的"共享内存"。它有意选择了最简单的共享机制 — 文件系统 — 而不是数据库、消息队列或共享内存。原因是 Worker 已经擅长读写文件（它们的核心工具就是 Read/Write），用文件系统做共享零学习成本。

---

## 21.8 权限处理：coordinatorHandler

### 背景

Coordinator 的 Worker 是异步运行的后台 Agent。当 Worker 需要执行敏感操作（如修改文件）时，它不能直接弹出权限对话框（因为它没有控制终端）。`coordinatorHandler` 解决了这个问题：

```typescript
// src/hooks/toolPermission/handlers/coordinatorHandler.ts
async function handleCoordinatorPermission(
  params: CoordinatorPermissionParams,
): Promise<PermissionDecision | null> {
  try {
    // 1. 先尝试 permission hooks（快速，本地）
    const hookResult = await ctx.runHooks(
      permissionMode, suggestions, updatedInput
    )
    if (hookResult) return hookResult

    // 2. 再尝试 classifier（慢，推理 — 仅 bash）
    const classifierResult = feature('BASH_CLASSIFIER')
      ? await ctx.tryClassifier?.(pendingClassifierCheck, updatedInput)
      : null
    if (classifierResult) return classifierResult
  } catch (error) {
    // 自动化检查失败 — 降级到交互式对话框
    logError(error instanceof Error ? error :
             new Error(`Automated permission check failed: ${String(error)}`))
  }

  // 3. 都没解决 — 降级到用户交互对话框
  return null
}
```

### 三层决策瀑布

```
┌──────────────────────────────────┐
│  Worker 请求敏感操作              │
│  (例如: Bash "rm -rf build/")   │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  Layer 1: Permission Hooks       │
│  (本地规则匹配，毫秒级)           │
│  ✓ → 允许/拒绝                   │
│  ✗ → 继续                        │
└──────────────┬───────────────────┘
               │ (hooks 未匹配)
               ▼
┌──────────────────────────────────┐
│  Layer 2: Bash Classifier        │
│  (AI 推理，秒级，仅 bash 命令)    │
│  ✓ → 允许/拒绝                   │
│  ✗ → 继续                        │
└──────────────┬───────────────────┘
               │ (classifier 未匹配)
               ▼
┌──────────────────────────────────┐
│  Layer 3: Interactive Dialog     │
│  (弹出到用户终端，需人工审批)     │
│  → 最终允许/拒绝                  │
└──────────────────────────────────┘
```

对于 Coordinator 模式的 Worker，`awaitAutomatedChecksBeforeDialog` 标志被设置，这意味着在弹出交互对话框之前，系统会完整等待 hooks 和 classifier 的结果。这避免了频繁打断用户：

```typescript
// src/tools/AgentTool/runAgent.ts:456-463
// For background agents that can show prompts, await automated checks
// before showing the permission dialog.
if (isAsync && !shouldAvoidPrompts) {
  toolPermissionContext = {
    ...toolPermissionContext,
    awaitAutomatedChecksBeforeDialog: true,
  }
}
```

---

## 21.9 Swarm 初始化

### useSwarmInitialization Hook

`useSwarmInitialization` 是一个 React Hook（Claude Code 使用 Ink 框架构建 TUI），负责在启动时初始化 Swarm 相关上下文：

```typescript
// src/hooks/useSwarmInitialization.ts
export function useSwarmInitialization(
  setAppState: SetAppState,
  initialMessages: Message[] | undefined,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  useEffect(() => {
    if (!enabled) return
    if (isAgentSwarmsEnabled()) {
      const firstMessage = initialMessages?.[0]
      const teamName = firstMessage && 'teamName' in firstMessage
        ? firstMessage.teamName : undefined
      const agentName = firstMessage && 'agentName' in firstMessage
        ? firstMessage.agentName : undefined

      if (teamName && agentName) {
        // 恢复的 Agent 会话 — 从存储信息重建上下文
        initializeTeammateContextFromSession(setAppState, teamName, agentName)
        // ... 初始化 hooks
      } else {
        // 全新会话 — 从环境变量读取上下文
        const context = getDynamicTeamContext?.()
        if (context?.teamName && context?.agentId && context?.agentName) {
          initializeTeammateHooks(setAppState, getSessionId(), { ... })
        }
      }
    }
  }, [setAppState, initialMessages, enabled])
}
```

### Swarm 功能门控

Swarm 功能的激活有独立的门控逻辑：

```typescript
// src/utils/agentSwarmsEnabled.ts
export function isAgentSwarmsEnabled(): boolean {
  // Ant 内部用户：始终启用
  if (process.env.USER_TYPE === 'ant') return true

  // 外部用户：需要 opt-in + killswitch
  if (!isEnvTruthy(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS)
      && !isAgentTeamsFlagSet()) return false

  // Killswitch — 外部用户始终检查
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_flint', true))
    return false

  return true
}
```

| 用户类型 | 激活条件 |
|----------|----------|
| 内部 (ant) | 始终可用 |
| 外部 | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 或 `--agent-teams` + GrowthBook killswitch |

### 初始化流程

```
启动 Claude Code
       │
       ▼
  isAgentSwarmsEnabled()?
       │
   ┌───┴───┐
   │ false │ → 正常单 Agent 模式
   └───────┘
   │ true
   ▼
  isCoordinatorMode()?
       │
   ┌───┴───┐
   │ false │ → Team 模式（第16章）
   └───────┘
   │ true
   ▼
  注入 Coordinator 系统提示词
       │
       ▼
  裁剪工具池（仅 Agent/SendMessage/TaskStop）
       │
       ▼
  注入 Worker 工具上下文
       │
       ▼
  注入 Scratchpad 路径（如果启用）
       │
       ▼
  ✓ Coordinator 就绪
```

---

## 21.10 与 Team 系统的关系

Coordinator 模式和 Team 模式共享大量基础设施，但使用方式不同：

### 共享的基础设施

| 组件 | Team 中的角色 | Coordinator 中的角色 |
|------|--------------|---------------------|
| `AgentTool` | 生成 Sub-Agent/Fork/Teammate | 生成 Worker |
| `SendMessage` | Teammate 间双向通信 | Coordinator → Worker 后续指令 |
| `TaskStop` | 停止后台任务 | 停止错误方向的 Worker |
| `runAgent` | 驱动子 Agent 的 agentic loop | 驱动 Worker 的 agentic loop |
| `runAsyncAgentLifecycle` | 管理异步 Agent 生命周期 | 管理 Worker 生命周期 |
| Scratchpad | 不使用 | **Worker 间知识共享** |

### 不使用的 Team 组件

Coordinator 模式**不使用**以下 Team 专属组件：

| 组件 | 原因 |
|------|------|
| `TeamCreate` / `TeamDelete` | Worker 不需要正式团队结构 |
| Task CRUD 工具族 | Coordinator 不通过共享任务列表管理工作 |
| Mailbox 系统 | Worker 通知通过 `<task-notification>` 而非邮箱 |
| Teammate 注册与发现 | Worker 由 Coordinator 直接管理 |
| Shutdown 协议 | Worker 由 TaskStop 直接停止 |

> **设计决策**：Team 模式适合"自治 Agents 的松散联盟" — 每个 Teammate 有自己的上下文和目标，通过共享任务列表和消息邮箱协作。Coordinator 模式适合"中央指挥的紧密编队" — Coordinator 掌握全局视图，Worker 只执行被分配的精确任务。两种模式解决不同的协作模式。

---

## 21.11 Worker Prompt 最佳实践

系统提示词中花了大量篇幅讲解如何编写 Worker prompt，因为**prompt 质量直接决定 Swarm 效率**。

### 目的声明（Purpose Statement）

每个 Worker prompt 应包含目的说明，帮助 Worker 校准深度：

```
好例子：
- "This research will inform a PR description — focus on user-facing changes."
- "I need this to plan an implementation — report file paths, line numbers, and type signatures."
- "This is a quick check before we merge — just verify the happy path."
```

### 自包含原则

Worker 看不到 Coordinator 的对话历史。每个 prompt 必须自包含：

```
Workers can't see your conversation. Every prompt must be
self-contained with everything the worker needs.
```

### 完成标准

明确定义什么算"完成"：

```
好例子：
- 实现类: "Run relevant tests and typecheck, then commit your
           changes and report the hash"
- 研究类: "Report findings — do not modify files"
- Git 操作: "Create a new branch from main called 'fix/session-expiry'.
             Cherry-pick only commit abc123 onto it. Push and create
             a draft PR targeting main. Report the PR URL."
```

### 反模式清单

```
坏例子及其问题：
1. "Fix the bug we discussed"
   → Worker 没有上下文，不知道讨论了什么

2. "Based on your findings, implement the fix"
   → 把理解的责任推给 Worker

3. "Create a PR for the recent changes"
   → 范围模糊：哪些变更？哪个分支？draft 还是 ready？

4. "Something went wrong with the tests, can you look?"
   → 没有错误信息、文件路径或方向
```

---

## 21.12 设计启示

### 1. 关注点分离的极致实践

Coordinator 模式的核心洞见是：**理解和执行是两种不同的能力，应该分离**。Coordinator 专注于"理解问题并精确表达解决方案"，Worker 专注于"按照规格执行并报告结果"。这种分离让 Coordinator 的上下文窗口只包含战略信息，不被执行细节污染。

### 2. 通信协议设计

`<task-notification>` XML 协议是一个精妙的设计：
- 结构化但可读 — Claude 既能解析字段，又能理解语义
- 作为 user message 注入 — 不需要特殊的消息路由基础设施
- 包含 usage 指标 — Coordinator 可以感知 Worker 的资源消耗

### 3. 反模式的系统化防御

系统提示词中充斥着"不要做X"的约束，这不是消极的限制，而是对常见失败模式的系统化防御：
- "Never fabricate results" — 防止幻觉
- "Never delegate understanding" — 防止职责稀释
- "Don't use workers for trivial tasks" — 防止资源浪费
- "Don't peek at fork output" — 防止上下文污染

### 4. 渐进式降级

权限系统的三层瀑布（hooks → classifier → dialog）确保了即使自动化手段失败，系统仍然可以通过人工交互兜底。这种"优雅降级"策略贯穿了 Claude Code 的整体设计。

### 5. 从"有工具的 Agent"到"有 Agent 的 Orchestrator"

Coordinator 模式代表了 Agent 架构的一个重要演进方向。传统 Agent 是"一个 LLM + 一堆工具"，Coordinator 是"一个 LLM + 一群 Agent"。这个范式转换的关键是：当 Agent 本身变成了工具，系统的表达能力会指数级增长。

---

## 章末速查表

### 激活 Coordinator 模式

```bash
# 设置环境变量
export CLAUDE_CODE_COORDINATOR_MODE=1

# 启动 Claude Code
claude
```

### 核心工具

| 工具 | 用途 | 参数 |
|------|------|------|
| `Agent` | 生成 Worker | `prompt`, `description`, `subagent_type: "worker"` |
| `SendMessage` | 继续 Worker | `to: <agentId>`, `message: <string>` |
| `TaskStop` | 停止 Worker | `task_id: <agentId>` |

### 四阶段工作流

| 阶段 | 执行者 | 并发 | 输出 |
|------|--------|------|------|
| Research | Workers | 并行 | 发现报告 |
| Synthesis | Coordinator | 独占 | 实现规格 |
| Implementation | Workers | 按文件集串行 | 代码变更 + commit hash |
| Verification | Workers | 并行 | 通过/失败报告 |

### Worker 通信协议

```xml
<!-- Worker → Coordinator (自动通知) -->
<task-notification>
  <task-id>agent-xxx</task-id>
  <status>completed|failed|killed</status>
  <summary>...</summary>
  <result>...</result>
</task-notification>

<!-- Coordinator → Worker (主动指令) -->
SendMessage({ to: "agent-xxx", message: "..." })
```

### 关键环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLAUDE_CODE_COORDINATOR_MODE` | 未设置 | 设为 `1` 启用 Coordinator 模式 |
| `CLAUDE_CODE_SIMPLE` | 未设置 | 设为 `1` 时 Worker 只有 Bash/Read/Edit |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | 未设置 | 外部用户启用 Swarm 功能 |

### 源码导航

| 文件 | 职责 |
|------|------|
| `coordinator/coordinatorMode.ts` | Coordinator 模式核心：门控、系统提示词、上下文注入 |
| `tools/AgentTool/` | Worker 生成引擎 |
| `tools/SendMessageTool/` | Worker 通信 |
| `tools/TaskStopTool/` | Worker 停止 |
| `hooks/toolPermission/handlers/coordinatorHandler.ts` | Worker 权限决策瀑布 |
| `hooks/useSwarmInitialization.ts` | Swarm 启动初始化 |
| `utils/systemPrompt.ts` | Coordinator 系统提示词注入点 |
| `utils/agentSwarmsEnabled.ts` | Swarm 功能门控 |
