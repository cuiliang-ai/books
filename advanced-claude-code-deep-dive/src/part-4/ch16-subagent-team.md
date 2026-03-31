
# 第 16 章：Sub-Agent 与 Team — 多智能体协作

> **核心问题**：一个 Agent 如何将复杂任务分解为子任务，交给专门的 Sub-Agent 执行？多个 Agent 如何在同一个代码库上并行协作而不冲突？

Claude Code 实现了一个三层协作模型：**Sub-Agent**（同步/异步子任务代理）、**Fork**（带完整上下文的克隆分支）、**Team**（通过 tmux 管理的多进程协作）。本章深入解析这套多智能体系统的架构。

---

## 16.1 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                     主 Agent (Parent)                     │
│                                                           │
│  AgentTool.call()                                         │
│  ┌─────────────┬──────────────┬──────────────────────┐   │
│  │ Sub-Agent   │ Fork Agent   │ Team (Teammate)       │   │
│  │ 同步/异步   │ 上下文克隆    │ tmux 多进程          │   │
│  │             │              │                       │   │
│  │ runAgent()  │ 带完整消息   │ spawnTeammate()      │   │
│  │ 使用 agent  │ 历史的分支   │ SendMessage 通信     │   │
│  │ 定义的工具  │              │                       │   │
│  └──────┬──────┴──────┬───────┴──────────┬───────────┘   │
│         │             │                  │                │
│  ┌──────▼──────┐ ┌────▼─────┐ ┌──────────▼────────────┐ │
│  │ 内置 Agent  │ │ Fork     │ │ in-process / tmux     │ │
│  │ 定义       │ │ 分支     │ │ teammate              │ │
│  │            │ │          │ │                        │ │
│  │ Explore    │ │ 完整的   │ │ UDS 消息传递          │ │
│  │ Plan       │ │ 消息历史 │ │ worktree 隔离         │ │
│  │ 自定义 .md │ │ 共享 Git │ │ 命名管理              │ │
│  └────────────┘ └──────────┘ └────────────────────────┘ │
│                                                           │
│  Task 系统：                                              │
│  ┌───────────────────────────────────────────────────┐   │
│  │ TaskType: local_bash | local_agent | remote_agent │   │
│  │           | in_process_teammate | local_workflow   │   │
│  │ TaskStatus: pending | running | completed | failed │   │
│  └───────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 16.2 AgentTool：统一的 Agent 调用入口

### 工具定义

```typescript
// src/tools/AgentTool/constants.ts
export const AGENT_TOOL_NAME = 'Agent'
export const LEGACY_AGENT_TOOL_NAME = 'Task'  // 旧名称兼容
export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'Explore', 'Plan',  // 运行一次就返回，不需要 SendMessage 继续
])
```

### 输入 Schema

```typescript
// src/tools/AgentTool/AgentTool.tsx
const baseInputSchema = lazySchema(() => z.object({
  description: z.string(),     // 3-5 词的任务描述
  prompt: z.string(),          // 任务详情
  subagent_type: z.string().optional(),   // 专门化 agent 类型
  model: z.enum(['sonnet', 'opus', 'haiku']).optional(),
  run_in_background: z.boolean().optional(),  // 后台执行
}))

// 完整 schema 添加多 agent 参数
const fullInputSchema = lazySchema(() => {
  return baseInputSchema().merge(z.object({
    name: z.string().optional(),       // Teammate 可寻址名称
    team_name: z.string().optional(),  // 团队名称
    mode: permissionModeSchema().optional(),  // 权限模式
  })).extend({
    isolation: z.enum(['worktree']).optional(),  // 隔离模式
    cwd: z.string().optional(),        // 工作目录覆盖
  })
})
```

### 路由逻辑

`AgentTool.call()` 根据参数决定走哪条路径：

```
AgentTool.call()
    │
    ├── team_name + name 都设置？
    │   └── YES → spawnTeammate()  [Team 模式]
    │
    ├── subagent_type 设置？
    │   └── YES → 查找匹配的 AgentDefinition
    │       └── 不存在？检查是否被 deny 规则拒绝
    │
    ├── Fork gate 启用 + 无 subagent_type？
    │   └── YES → FORK_AGENT [Fork 模式]
    │
    └── 默认 → GENERAL_PURPOSE_AGENT [通用 Sub-Agent]
            │
            ├── isolation: 'worktree'？
            │   └── 创建 git worktree 隔离
            ├── run_in_background: true？
            │   └── 注册 async agent task
            └── 同步执行 runAgent()
```

---

## 16.3 Agent 定义系统

### AgentDefinition 结构

Agent 定义可以来自 `.claude/agents/` 目录下的 Markdown 文件或 JSON 文件：

```typescript
// src/tools/AgentTool/loadAgentsDir.ts
const AgentJsonSchema = lazySchema(() =>
  z.object({
    description: z.string().min(1),
    tools: z.array(z.string()).optional(),        // 允许使用的工具
    disallowedTools: z.array(z.string()).optional(),
    prompt: z.string().min(1),                     // Agent 系统提示
    model: z.string().optional(),                  // 如 'inherit', 'haiku'
    effort: z.union([z.enum(EFFORT_LEVELS), z.number().int()]).optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    mcpServers: z.array(AgentMcpServerSpecSchema()).optional(),
    hooks: HooksSchema().optional(),               // Agent 自己的 hooks
    maxTurns: z.number().int().positive().optional(),
    skills: z.array(z.string()).optional(),
    initialPrompt: z.string().optional(),
    memory: z.enum(['user', 'project', 'local']).optional(),
    background: z.boolean().optional(),            // 默认后台执行
    isolation: z.enum(['worktree']).optional(),     // 默认 worktree 隔离
  })
)
```

### 内置 Agent 类型

```typescript
// src/tools/AgentTool/builtInAgents.ts → 各个 built-in 文件

// Explore Agent - 代码探索
// src/tools/AgentTool/built-in/exploreAgent.ts
// 使用 Read/Glob/Grep 工具探索代码库

// Plan Agent - 制定计划
// src/tools/AgentTool/built-in/planAgent.ts
// 分析需求并生成实现计划

// Verification Agent - 验证检查
// src/tools/AgentTool/built-in/verificationAgent.ts
// 执行验证任务（如运行测试、检查格式）

// General Purpose Agent - 通用
// src/tools/AgentTool/built-in/generalPurposeAgent.ts
// 继承父 Agent 的完整工具集
```

### Agent 权限过滤

Agent 可以被 deny 规则阻止：

```typescript
// src/utils/permissions/permissions.ts
export function filterDeniedAgents<T extends { agentType: string }>(
  agents: T[],
  context: ToolPermissionContext,
  agentToolName: string,
): T[] {
  // 一次性收集所有 Agent(x) 的 deny 规则
  const deniedAgentTypes = new Set<string>()
  for (const rule of getDenyRules(context)) {
    if (rule.ruleValue.toolName === agentToolName
        && rule.ruleValue.ruleContent !== undefined) {
      deniedAgentTypes.add(rule.ruleValue.ruleContent)
    }
  }
  return agents.filter(agent => !deniedAgentTypes.has(agent.agentType))
}
```

设置 `Agent(Explore)` 为 deny 规则即可禁用 Explore agent。

---

## 16.4 Task 系统

### TaskType 和 TaskStatus

```typescript
// src/Task.ts
export type TaskType =
  | 'local_bash'           // 本地 Bash 后台任务
  | 'local_agent'          // 本地 Agent 任务
  | 'remote_agent'         // 远程 Agent 任务
  | 'in_process_teammate'  // 进程内队友
  | 'local_workflow'       // 本地工作流
  | 'monitor_mcp'          // MCP 监控任务
  | 'dream'                // 后台推理任务

export type TaskStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'killed'

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}
```

### Task ID 生成

```typescript
// src/Task.ts
const TASK_ID_PREFIXES: Record<string, string> = {
  local_bash: 'b',
  local_agent: 'a',
  remote_agent: 'r',
  in_process_teammate: 't',
  local_workflow: 'w',
  monitor_mcp: 'm',
  dream: 'd',
}

// 36^8 ≈ 2.8 万亿组合，足够抵御暴力枚举的符号链接攻击
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function generateTaskId(type: TaskType): string {
  const prefix = getTaskIdPrefix(type)
  const bytes = randomBytes(8)
  // ...
}
```

### Task 生命周期管理

```typescript
// src/tasks/LocalAgentTask/LocalAgentTask.ts（导入归纳）

// Agent 注册
registerAsyncAgent()      // 注册异步 agent（后台运行）
registerAgentForeground() // 注册前台 agent
unregisterAgentForeground()

// 进度追踪
createProgressTracker()
updateProgressFromMessage()
getProgressUpdate()

// 完成/失败
completeAsyncAgent()      // 标记为完成
failAsyncAgent()          // 标记为失败
killAsyncAgent()          // 强制终止
```

---

## 16.5 Worktree 隔离

当 agent 使用 `isolation: 'worktree'` 时，会创建一个独立的 Git worktree：

```typescript
// src/utils/worktree.ts（导入自 AgentTool.tsx）
import { createAgentWorktree, hasWorktreeChanges, removeAgentWorktree }
  from '../../utils/worktree.js'
```

```
主仓库 /project
    │
    ├── .git/
    ├── .claude/worktrees/
    │   ├── agent-abc123/       ← Agent A 的 worktree
    │   │   ├── src/
    │   │   └── .git → 指向主仓库
    │   └── agent-def456/       ← Agent B 的 worktree
    │       ├── src/
    │       └── .git → 指向主仓库
    └── src/                    ← 主工作目录
```

关键特性：
- 每个 Agent 有独立的文件系统视图
- 共享 Git 历史和对象存储
- 修改不影响主工作目录
- 任务完成后可以检查变更并决定是否合并

---

## 16.6 Team 协作：多 Agent 通信

### 队友生成

当 `team_name` 和 `name` 都提供时，触发 Team 模式：

```typescript
// src/tools/AgentTool/AgentTool.tsx
if (teamName && name) {
  // 设置 agent 颜色用于分组 UI 显示
  if (agentDef?.color) setAgentColor(subagent_type!, agentDef.color)

  const result = await spawnTeammate({
    name,
    prompt,
    description,
    team_name: teamName,
    use_splitpane: true,
    plan_mode_required: spawnMode === 'plan',
    model: model ?? agentDef?.model,
    agent_type: subagent_type,
  }, toolUseContext)

  return { data: { status: 'teammate_spawned', ... } }
}
```

### 安全约束

```typescript
// 递归防护：队友不能生成队友
if (isTeammate() && teamName && name) {
  throw new Error('Teammates cannot spawn other teammates — ' +
    'the team roster is flat.')
}

// 进程内队友不能生成后台 agent
if (isInProcessTeammate() && teamName && run_in_background === true) {
  throw new Error('In-process teammates cannot spawn background agents.')
}
```

### TeammateSpawnedOutput

```typescript
type TeammateSpawnedOutput = {
  status: 'teammate_spawned'
  prompt: string
  teammate_id: string
  agent_id: string
  agent_type?: string
  model?: string
  name: string
  color?: string
  tmux_session_name: string
  tmux_window_name: string
  tmux_pane_id: string
  team_name?: string
  is_splitpane?: boolean
  plan_mode_required?: boolean
}
```

---

## 16.7 MCP Server 要求

Agent 定义可以指定必需的 MCP server，系统在启动前验证：

```typescript
// src/tools/AgentTool/AgentTool.tsx
if (requiredMcpServers?.length) {
  // 等待 pending 的 MCP server 连接
  const hasPendingRequiredServers = appState.mcp.clients.some(
    c => c.type === 'pending' && requiredMcpServers.some(
      pattern => c.name.toLowerCase().includes(pattern.toLowerCase())
    ))

  if (hasPendingRequiredServers) {
    const MAX_WAIT_MS = 30_000
    const POLL_INTERVAL_MS = 500
    const deadline = Date.now() + MAX_WAIT_MS
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS)
      // 检查是否有已失败的 server → 提前退出
      // 检查是否还有 pending 的 → 继续等待
    }
  }
  // 验证所有必需 server 都有工具可用
  // ...
}
```

```typescript
// src/tools/AgentTool/loadAgentsDir.ts
export function hasRequiredMcpServers(
  agent: AgentDefinition,
  availableServers: string[]
): boolean { /* ... */ }

export function filterAgentsByMcpRequirements(
  agents: AgentDefinition[],
  availableServers: string[]
): AgentDefinition[] { /* ... */ }
```

---

## 16.8 Fork Agent：上下文克隆分支

Fork Agent 是一种特殊的 Sub-Agent 模式，它将主 Agent 的完整消息历史传递给子 Agent：

```typescript
// src/tools/AgentTool/forkSubagent.ts（导入归纳）
import {
  buildForkedMessages,     // 构建包含父 Agent 消息的 fork 输入
  buildWorktreeNotice,     // worktree 通知文本
  FORK_AGENT,              // Fork Agent 定义
  isForkSubagentEnabled,   // Gate 检查
  isInForkChild            // 递归防护
} from './forkSubagent.js'
```

### 递归防护

```typescript
// src/tools/AgentTool/AgentTool.tsx
if (isForkPath) {
  // 主要检查：querySource（compaction 安全 — 在 spawn 时设置）
  // 消息扫描回退：检查消息中是否有 fork 标记
  if (toolUseContext.options.querySource === `agent:builtin:${FORK_AGENT.agentType}`
      || isInForkChild(toolUseContext.messages)) {
    throw new Error('Fork is not available inside a forked worker.')
  }
  selectedAgent = FORK_AGENT
}
```

---

## 章末速查表

| 概念 | 文件 | 关键函数/类型 |
|------|------|-------------|
| Agent 工具入口 | `AgentTool/AgentTool.tsx` | `AgentTool.call()` |
| 工具名常量 | `AgentTool/constants.ts` | `AGENT_TOOL_NAME` |
| Agent 定义加载 | `AgentTool/loadAgentsDir.ts` | `loadMarkdownFilesForSubdir()` |
| Agent JSON Schema | `AgentTool/loadAgentsDir.ts` | `AgentJsonSchema` |
| 内置 Agent | `AgentTool/builtInAgents.ts` | `getBuiltInAgents()` |
| Agent 运行 | `AgentTool/runAgent.ts` | `runAgent()` |
| Fork 分支 | `AgentTool/forkSubagent.ts` | `FORK_AGENT` |
| Teammate 生成 | `shared/spawnMultiAgent.ts` | `spawnTeammate()` |
| Task 类型 | `Task.ts` | `TaskType`/`TaskStatus` |
| Task ID | `Task.ts` | `generateTaskId()` |
| 异步 Agent | `tasks/LocalAgentTask/` | `registerAsyncAgent()` |
| Worktree | `utils/worktree.ts` | `createAgentWorktree()` |
| 权限过滤 | `permissions/permissions.ts` | `filterDeniedAgents()` |
| Agent Prompt | `AgentTool/prompt.ts` | `getPrompt()` |
| 进度追踪 | `tasks/LocalAgentTask/` | `createProgressTracker()` |
