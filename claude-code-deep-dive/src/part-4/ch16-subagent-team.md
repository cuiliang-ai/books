
# 第 16 章：Sub-Agent 与 Team — 多智能体协作

> **核心问题**：当任务复杂到一个 Agent 无法高效完成时 — 既要探索代码库、又要制定计划、还要并行修改多个模块 — 如何将一个 Agent 拆分为多个协作单元，同时确保它们之间的上下文隔离、权限安全和通信顺畅？

单个 Agent 的能力边界是清晰的：它有一个 agentic loop、一份 system prompt、一个上下文窗口。当任务涉及多文件并行修改、代码探索与编辑分离、或者需要不同权限级别的操作时，单 Agent 模式会遭遇上下文膨胀、串行瓶颈和权限冲突三大问题。

Claude Code 的解决方案是构建一套**三层协作模型** — 从最简单的 Sub-Agent 委派，到继承上下文的 Fork 分叉，再到完整的 Team 多智能体协作系统。每一层都解决特定的复杂度需求，同时保持向下兼容。

---

## 16.1 概述：从单 Agent 到多 Agent

### 为什么需要多 Agent

单 Agent 架构在以下场景面临瓶颈：

1. **任务分解**：一个复杂任务（如"重构整个模块的错误处理"）包含多个独立子任务，串行执行效率低下
2. **并行执行**：Pro 用户有充足的 API 配额，多个 Agent 可以并行探索代码、并行修改文件
3. **上下文隔离**：代码探索产生的大量搜索结果不应污染编辑 Agent 的上下文窗口
4. **权限分离**：探索型任务只需只读权限，编辑型任务需要写入权限，混在一起增加安全风险

### 三层协作模型

Claude Code v2.1.86 实现了三层递进的多 Agent 协作：

```
复杂度递增 ──────────────────────────────────────────────▶

┌──────────────┐   ┌──────────────┐   ┌──────────────────┐
│  Sub-Agent   │   │    Fork      │   │      Team        │
│              │   │              │   │                  │
│ - 独立上下文  │   │ - 继承上下文  │   │ - 独立进程       │
│ - 任务完成即终 │   │ - 共享 Cache │   │ - 双向通信       │
│ - 结果直接返回 │   │ - 结果返回   │   │ - 共享任务列表    │
│ - 可嵌套      │   │ - 不可嵌套   │   │ - 存活到 shutdown│
└──────────────┘   └──────────────┘   └──────────────────┘
    简单委派            廉价并行          完整协作
```

| 维度 | Sub-Agent | Fork | Team |
|------|----------|------|------|
| 创建方式 | `Agent({subagent_type})` | `Agent()`（省略 type） | `TeamCreate` + `Agent({name, team_name})` |
| 上下文 | 独立（仅 prompt） | 继承父 Agent 完整上下文 | 独立（team lead 初始化） |
| 通信 | 结果返回给父 Agent | 结果返回给父 Agent | `SendMessage` 双向通信 |
| 生存期 | 完成即终止 | 完成即终止 | 存活直到 shutdown |
| 进程模型 | 父进程内 agentic loop | 父进程内 agentic loop | 独立进程（tmux/pane/in-process） |
| Cache 共享 | 否 | 是 | 否 |
| 可嵌套 | 是 | 否 | 否（flat roster） |

### 整体架构

```
用户 (REPL / CLI)
    │ prompt
    ▼
┌────────────────────────────────────────────────┐
│            主 Agent (team-lead)                  │
│  system prompt + tool registry + agentic loop   │
└───┬──────────────┬──────────────┬──────────────┘
    │              │              │
    ▼              ▼              ▼
┌─────────┐  ┌─────────┐  ┌──────────────────┐
│SubAgent │  │  Fork   │  │     Team         │
│独立 SP   │  │继承 SP  │  │  ┌──────────┐   │
│独立历史  │  │继承历史  │  │  │Teammate A│   │
│av() loop│  │av() loop│  │  └─────┬────┘   │
└────┬────┘  └────┬────┘  │        │        │
     │            │       │  SendMessage     │
     ▼            ▼       │        │        │
 tool_result  output_file │  ┌─────┴────┐   │
 (同步返回)   (异步通知)   │  │Teammate B│   │
                          │  └──────────┘   │
                          │  TaskList(共享)  │
                          └──────────────────┘
```

> **设计决策**：三层模型遵循"渐进式复杂度"原则 — 简单任务用 Sub-Agent（零配置），需要共享上下文时用 Fork（零额外成本），只有真正的多方协作才需要 Team（完整通信基础设施）。这避免了"为简单任务付出复杂代价"的反模式。

**小结**：多 Agent 协作解决的是单 Agent 的上下文膨胀、串行瓶颈和权限冲突问题。三层模型（Sub-Agent → Fork → Team）让用户按需选择复杂度，而不是一刀切地引入协作开销。

---

## 16.2 Agent 工具实现

Agent 工具是整个多 Agent 系统的入口 — 无论是创建 Sub-Agent、Fork 还是 Teammate，都通过同一个 `Agent` 工具触发，由内部路由逻辑决定走哪条路径。理解这个工具的 Schema 和路由机制是理解整个多 Agent 系统的基础。

### Agent 工具的 Schema 定义

Agent 工具注册在 `13_ui_rendering.js:69364`，工具名通过变量 `M7`（值为 `"Agent"`）引用：

```javascript
// 13_ui_rendering.js:69364-69393 — Agent tool definition
f_9 = {
    async prompt({ agents, tools, getToolPermissionContext, allowedAgentTypes }) {
        let T = tlH(H, O),           // mergeAgentDefinitions: merge built-in + custom agents
            z = neH(T, K, M7);       // filterByPermissions: exclude denied agent types
        return await A_9(z, false, $) // generatePromptDescription: build tool prompt text
    },
    name: M7,                         // "Agent"
    searchHint: "delegate work to a subagent",
    aliases: [ep],
    maxResultSizeChars: 1e5,           // 100KB result cap
    async description() { return "Launch a new agent" },
    get inputSchema() { return oo6() },   // getInputSchema
    get outputSchema() { return ag1() },  // getOutputSchema
    async call({ prompt, subagent_type, description, model,
                 run_in_background, name, team_name, mode,
                 isolation, cwd }, w, Y, D, j) {
        // ... core dispatch logic
    }
}
```

输入 Schema 定义于 `13_ui_rendering.js:69327-69349`，分为**基础参数**和**扩展参数**两层：

```javascript
// 13_ui_rendering.js:69327-69349 — Input schema (two-layer design)
// Layer 1: basic parameters (always available)
rg1 = pH(() => h.object({
    description: h.string().describe("A short (3-5 word) description"),
    prompt: h.string().describe("The task for the agent to perform"),
    subagent_type: h.string().optional(),
    model: h.enum(["sonnet", "opus", "haiku"]).optional(),
    run_in_background: h.boolean().optional()
}));

// Layer 2: team/isolation extensions (merged on top of base)
og1 = pH(() => {
    let H = h.object({
        name: h.string().optional(),
        team_name: h.string().optional(),
        mode: JX8().optional()        // getPermissionModeSchema
    });
    return rg1().merge(H).extend({
        isolation: h.enum(["worktree"]).optional(),
        cwd: h.string().optional()
    })
});
```

完整参数列表：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | `string` | 是 | 子 Agent 的任务指令 |
| `description` | `string` | 是 | 3-5 词的任务摘要 |
| `subagent_type` | `string?` | 否 | Agent 类型标识。省略时：fork 实验开启则 fork，否则 `general-purpose` |
| `model` | `enum` | 否 | 模型覆盖：`"sonnet"` / `"opus"` / `"haiku"` |
| `run_in_background` | `boolean?` | 否 | 是否后台运行，完成后自动通知 |
| `name` | `string?` | 否 | Agent 名称，使其可通过 `SendMessage({to: name})` 寻址 |
| `team_name` | `string?` | 否 | 团队名称，省略则使用当前团队上下文 |
| `mode` | `string?` | 否 | 权限模式（如 `"plan"` 要求计划审批） |
| `isolation` | `enum?` | 否 | 隔离模式，`"worktree"` 创建独立 git worktree |
| `cwd` | `string?` | 否 | 自定义工作目录，与 `isolation: "worktree"` 互斥 |

### 7 种 subagent_type

系统内置了多种 Agent 类型，每种类型有不同的工具集和权限：

| 类型 | 工具限制 | 模型 | 权限模式 | 说明 |
|------|----------|------|----------|------|
| `general-purpose` | 全部 `["*"]` | inherit | `acceptEdits` | 默认通用 Agent，完整工具集 |
| `Explore` | 只读（Read, Glob, Grep 等） | haiku | `acceptEdits` | 代码探索专用，**不能编辑** |
| `Plan` | 只读 | inherit | `acceptEdits` | 规划专用，**不能编辑** |
| `statusline-setup` | Read + Edit | sonnet | `acceptEdits` | 状态栏配置 |
| `fork` | 全部 `["*"]` | inherit | `bubble` | 继承上下文的子任务（特殊类型） |

每个内置类型以对象形式定义：

```javascript
// Built-in agent type structure
{
    agentType: string,              // type identifier
    whenToUse: string,              // usage scenario description
    tools: string[],                // available tools, ["*"] = all
    disallowedTools: string[],      // explicitly blocked tools
    maxTurns: number,               // max agentic loop iterations
    model: string,                  // "inherit" or specific model
    permissionMode: string,         // permission mode
    source: "built-in",
    baseDir: "built-in",
    getSystemPrompt: () => string   // system prompt generator
}
```

`Explore` 和 `Plan` 的只读限制通过工具集过滤实现：

```javascript
// 11_api_streaming.js:16291 — read-only vs write tool sets
lK1 = new Set(["Read", "Glob", "Grep", "ToolSearch", "LSP", "TaskGet", "TaskList"])
QK1 = new Set(["Edit", "Write", "NotebookEdit"])  // write tools excluded for Explore/Plan
```

### 权限模式继承（mode 参数）

Agent 工具的 `mode` 参数控制子 Agent 的权限级别。权限层次从高到低：

```
bypassPermissions  →  跳过所有检查（--dangerously-skip-permissions）
acceptEdits        →  自动接受文件编辑（SubAgent 默认）
auto               →  自动决策
default            →  标准权限检查
plan               →  计划模式，需要审批
bubble             →  冒泡到父 Agent（Fork 默认）
```

```javascript
// 13_ui_rendering.js:69545 — SubAgent permission setup
let i = {
    ...P.toolPermissionContext,
    mode: v.permissionMode ?? "acceptEdits"  // default: acceptEdits
};
```

> **设计决策**：Sub-Agent 默认使用 `acceptEdits` 而非 `default`，因为子 Agent 需要自主完成任务，频繁的权限弹窗会阻塞整个 agentic loop。`acceptEdits` 在安全性和自主性之间取得平衡 — 文件编辑自动放行，但危险的 Bash 命令仍需确认。

### Worktree 隔离（isolation 参数）

当多个 Agent 可能修改同一个代码库时，Git Worktree 提供了天然的文件系统隔离：

```javascript
// 13_ui_rendering.js:69550-69553 — create worktree for agent
if (S === "worktree") {
    let fH = `agent-${HH.slice(0,8)}`;  // HH = lx() generated UUID
    e = await reH(fH)                    // createAgentWorktree
}
```

Worktree 在 `{gitRoot}/.claude/worktrees/{agent-id}/` 下创建独立工作目录，分支名为 `worktree-{agent-id}`。这确保每个 Agent 在自己的分支上工作，不会产生文件冲突。

**小结**：Agent 工具是多 Agent 系统的统一入口，通过 `subagent_type`、`name`/`team_name`、`isolation` 三组参数分别控制 Agent 类型选择、团队协作模式和文件隔离策略。Schema 的两层设计（基础 + 扩展）确保简单场景不需要理解复杂参数。

---

## 16.3 Sub-Agent 执行引擎

Sub-Agent 的执行引擎是整个多 Agent 系统的核心 — 它管理 Agent 实例的创建、上下文构建、agentic loop 执行和结果返回。理解这个引擎的工作方式，才能理解 Fork 和 Team 在其基础上的扩展。

### Agent 类型路由

`Agent.call()` 方法（`13_ui_rendering.js:69394`）首先进行类型路由 — 根据输入参数决定创建 Sub-Agent、Fork 还是 Teammate：

```javascript
// 13_ui_rendering.js:69439-69460 — type routing inside call()
let Z = _ ?? (Hb() ? void 0 : Od.agentType);
// _ = subagent_type parameter
// Hb() = isForkExperimentEnabled (currently returns false)
// Od.agentType = "general-purpose" (default fallback)

let k = Z === void 0;  // true = fork mode

if (k) {
    // Fork path: check nested fork guard
    if (w.options.querySource === `agent:builtin:${KyH.agentType}` || O_9(w.messages))
        throw Error("Fork is not available inside a forked worker.");
    v = KyH  // use fork definition
} else {
    // SubAgent path: find matching type in active agents
    let fH = w.options.agentDefinitions.activeAgents;
    let n = KH.find((l) => l.agentType === Z);
    if (!n) throw Error(`Agent type '${Z}' not found. Available agents: ...`);
    v = n
}
```

路由决策树：

```
Agent.call() 被调用
    │
    ├─ 有 name + team_name? ──── yes ──→ Teammate 生成路径（见 16.4）
    │
    ├─ subagent_type 省略 + fork 实验开启?
    │   ├─ yes → Fork 路径（检查嵌套防护）
    │   └─ no  → 回退到 general-purpose
    │
    └─ subagent_type 指定? ──→ 查找匹配的 Agent 定义
```

### Agent 实例创建流程

整个 Sub-Agent 生命周期在 `Agent.call()` 中完成：

```
Agent.call() 被调用
    │
    ├─ 1. 参数校验（team_name 权限、嵌套限制）
    │
    ├─ 2. Agent 类型路由（fork vs subagent_type 查找）
    │
    ├─ 3. MCP Server 依赖检查（requiredMcpServers）
    │
    ├─ 4. 模型解析 LvH() (resolveModel)
    │     └─ 优先级：环境变量 > 调用参数 > Agent 定义 > 父 Agent 继承
    │
    ├─ 5. Worktree 创建（若 isolation === "worktree"）
    │
    ├─ 6. System Prompt 构建
    │     ├─ Fork：复用父 Agent 的 renderedSystemPrompt
    │     └─ SubAgent：调用 agent.getSystemPrompt() + 独立构建
    │
    ├─ 7. 消息构建
    │     ├─ Fork：继承父 Agent 消息历史 + fork 指令
    │     └─ SubAgent：仅包含用户 prompt 消息
    │
    ├─ 8. 分支：同步 vs 异步
    │     ├─ 异步（run_in_background=true）：注册任务后立即返回
    │     └─ 同步：阻塞等待 agentic loop 完成
    │
    └─ 9. 结果返回 / 异步通知
```

模型选择优先级由 `LvH()` (resolveModel) 函数决定：

```
1. CLAUDE_CODE_SUBAGENT_MODEL 环境变量  → 最高优先级
2. Agent.call() 中的 model 参数          → 用户指定
3. Agent 定义中的 model 字段             → frontmatter 定义
4. "inherit"（继承父级模型）              → 默认行为
```

### Context 隔离 vs 共享策略

Sub-Agent 和 Fork 在上下文处理上有根本差异：

**Sub-Agent 模式 — 完全隔离**：

```javascript
// 13_ui_rendering.js:69512-69530 — SubAgent independent context
else {
    // call agent definition's getSystemPrompt
    x = await EeH([vH], E, fH)   // buildAgentSystemPrompt
    // message history contains only the user prompt
    B = [d_({ content: H })]      // createUserMessage
}
```

**Fork 模式 — 继承共享**：

```javascript
// 13_ui_rendering.js:69497-69511 — Fork context inheritance
if (k) {
    // reuse parent agent's system prompt
    if (w.renderedSystemPrompt) I = w.renderedSystemPrompt;
    else { /* rebuild full system prompt */ }

    // inherit parent's message history + add fork instructions
    B = T_9(H, D)  // buildForkMessages
}
```

Fork 指令由 `$_9()` (generateForkWorkerRules) 函数生成，施加严格的行为约束：

```
STOP. READ THIS FIRST.
You are a forked worker process. You are NOT the main agent.
RULES (non-negotiable):
1. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. USE your tools directly: Bash, Read, Write, etc.
4. If you modify files, commit your changes before reporting
5. Keep your report under 500 words
6. Your response MUST begin with "Scope:"
...
```

隔离属性对比：

| 属性 | Sub-Agent | Fork |
|------|----------|------|
| System Prompt | 独立（Agent 定义生成） | 继承父 Agent |
| 消息历史 | 仅包含 prompt | 继承完整上下文 |
| 工具集 | 由 Agent 定义决定 | 与父 Agent 相同 |
| Prompt Cache | 独立 | 与父共享（核心优势） |
| 权限模式 | `acceptEdits`（默认） | `bubble`（冒泡到父 Agent UI） |

> **设计决策**：Fork 的核心价值是 **Prompt Cache 共享**。由于 Fork 继承父 Agent 的完整 system prompt 和消息历史，API 调用时可以复用已缓存的 KV 对，大幅降低首次 token 延迟和成本。这就是为什么 Fork 不允许指定不同 model — 不同模型无法复用父 Agent 的 cache。

### 子 Agent 的 System Prompt 构建

Sub-Agent 的 system prompt 通过 `EeH()` (buildAgentSystemPrompt) 独立构建，流程与主 Agent 类似但有简化：

```javascript
// 13_ui_rendering.js:65220 — context difference for Explore/Plan
e = H.agentType === "Explore" || H.agentType === "Plan" ? HH : C,
// HH = lightweight context (no gitStatus)
// C = full context (with gitStatus)
// Explore/Plan get simplified system context
```

### Agentic Loop 执行

子 Agent 通过 `av()` (runAgenticLoop) 进入独立的 agentic loop（`13_ui_rendering.js:65180`）：

```javascript
// 13_ui_rendering.js:65375-65390 — core agentic loop execution
for await (let RH of zC({        // coreAgenticLoop
    messages: I,
    systemPrompt: fH,
    userContext: i,
    systemContext: e,
    toolUseContext: jH,
    options: XH,
    ...
})) {
    // each RH is one API response turn
    yield RH
}
```

### 同步 vs 异步执行

**同步执行**（默认，`13_ui_rendering.js:69662`）：

```javascript
// Simplified pseudocode for synchronous agent execution
let NH = av({...qH, override: { agentId: fH }});  // runAgenticLoop
let KH = [];  // collect all messages

while (true) {
    // race: API response vs auto-background signal
    let yH = s ? await Promise.race([NH.next(), s]) : { result: await NH.next() };

    if (yH.type === "background") {
        // auto-backgrounded: switch to async continuation
        jH = true;
        Tg(vH, async () => { /* finish remaining turns in background */ });
        break
    }

    if (yH.result.done) break;
    KH.push(yH.result.value);
}

// build result
let JH = Ob_(KH, mH, p);  // buildAgentResult
return { data: { status: "completed", ...JH } }
```

**自动后台化**：当同步 Agent 运行时间超过 120 秒，系统自动将其转为后台执行：

```javascript
// 13_ui_rendering.js:69268 — auto-background threshold
function ng1() {       // getAutoBackgroundMs
    if (lH(process.env.CLAUDE_AUTO_BACKGROUND_TASKS) ||
        B_("tengu_auto_background_agents", false))
        return 120000;  // 120 seconds before auto-backgrounding
    return 0
}
```

**异步执行**（`run_in_background=true`，`13_ui_rendering.js:69603`）：

```javascript
// Simplified pseudocode for async agent execution
let vH = _y_({  // registerAsyncTask
    agentId: fH, description: q, prompt: H,
    selectedAgent: v, setAppState: R, toolUseId: w.toolUseId
});

// launch agentic loop in background
Tg(KH, () => $H(() => fb_({  // scheduleBackgroundTask
    taskId: vH.agentId,
    abortController: vH.abortController,
    makeStream: (l) => av({...qH}),  // create agentic loop stream
    metadata: p,
    ...
})));

// return immediately
return {
    data: {
        isAsync: true,
        status: "async_launched",
        agentId: vH.agentId,
        outputFile: I5(vH.agentId),    // getOutputFilePath
        canReadOutputFile: n
    }
}
```

### 结果返回与通知

异步 Agent 完成后通过 `S8H()` (sendTaskNotification, `11_api_streaming.js:17346`) 发送 XML 格式通知：

```xml
<task_notification>
    <task_id>{id}</task_id>
    <output_file>{path}</output_file>
    <status>completed</status>
    <description>Agent "xxx" completed</description>
    <result>{agent output}</result>
    <usage>
        <total_tokens>...</total_tokens>
        <tool_uses>...</tool_uses>
        <duration_ms>...</duration_ms>
    </usage>
</task_notification>
```

通知消息通过 `bw()` (injectMessage) 注入到用户消息流，父 Agent 在下一个 turn 处理它。

### 任务状态机

Agent 任务有三种终态：

```
                    ┌──────────┐
                    │ pending  │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │ running  │
                    └──┬───┬───┬─┘
                       │   │   │
              ┌────────┘   │   └────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │completed │ │  failed  │ │  killed  │
        └──────────┘ └──────────┘ └──────────┘
          eh_()        Hy_()        E8H()
```

```javascript
// 11_api_streaming.js:17470-17498 — task terminal states
function eh_(H, _) {   // markCompleted → "completed"
    Z4(q, _, ($) => ({ ...$, status: "completed", result: H }))
}

function Hy_(H, _, q) { // markFailed → "failed"
    Z4(H, q, ($) => ({ ...$, status: "failed", error: _ }))
}

function E8H(H, _) {    // killTask → "killed" (user abort or timeout)
    Z4(H, _, ($) => {
        $.abortController?.abort();
        return { ...$, status: "killed" }
    })
}
```

**小结**：Sub-Agent 执行引擎的核心在于类型路由（Fork vs Sub-Agent vs Teammate）、上下文策略（隔离 vs 继承）和执行模式（同步 vs 异步 + 自动后台化）。120 秒自动后台化机制确保同步 Agent 不会无限期阻塞用户交互，而 XML 通知格式则为异步结果提供了结构化的回传通道。

---

## 16.4 Team 协调系统

当任务复杂到需要多个 Agent 长期并行工作、彼此通信、共享任务列表时，Sub-Agent 和 Fork 的"完成即终止"模型就不够用了。Team 系统提供了完整的多 Agent 协作基础设施 — 包括团队生命周期管理、共享任务系统和结构化通信协议。

### TeamCreate / TeamDelete 生命周期

**TeamCreate**（`14_html_parser.js:22815-22895`）创建一个新团队：

```javascript
// 14_html_parser.js:22838-22843 — TeamCreate input schema
xl1 = pH(() => h.strictObject({
    team_name: h.string().describe("Name for the new team"),
    description: h.string().optional(),
    agent_type: h.string().optional().describe('Type/role of the team lead')
}));

// Tool registration
pl1 = {
    name: "TeamCreate",  // variable Qx
    searchHint: "create a multi-agent swarm team",
    shouldDefer: true,
    isEnabled() { return dq() },  // isTeamsFeatureEnabled
    ...
}
```

团队创建后的操作：

1. 创建 `~/.claude/teams/{team-name}/config.json`（包含 `members` 数组）
2. 创建 `~/.claude/tasks/{team-name}/` 任务目录
3. 设置当前 Agent 为 team lead

**TeamDelete**（变量 `OAH = "TeamDelete"`）负责清理：

- 删除 `~/.claude/teams/{team-name}/config.json`
- 清理任务目录
- 重置 `teamContext` 状态

### Team 配置文件结构

```
~/.claude/
├── teams/{team-name}/
│   └── config.json              # 团队配置
├── tasks/{team-name}/           # 共享任务列表
└── inbox/{agent-name}/          # 消息收件箱
```

`config.json` 中的 `members` 数组记录每个 Teammate 的元数据：

```javascript
// Member metadata stored in config.json
p.members.push({
    agentId: M,            // "name@teamName" format
    name: j,               // sanitized display name
    agentType: T,          // agent type definition
    model: f,              // model selection
    prompt: O,             // initial prompt
    color: R,              // UI display color
    tmuxPaneId: W,         // terminal pane identifier
    cwd: J,                // working directory
    backendType: P.backend.type  // "in-process" | "splitpane" | "tmux"
});
```

### Teammate 生成流程

Teammate 通过 `Agent` 工具携带 `name` + `team_name` 参数触发（`13_ui_rendering.js:69417-69438`）：

```javascript
// 13_ui_rendering.js:69417-69438 — teammate creation path
if (W && O) {  // W=teamName, O=name
    // teammate spawning path
    let vH = await __9({           // spawnTeammate
        name: O, prompt: H, description: q,
        team_name: W, use_splitpane: true,
        plan_mode_required: z === "plan",
        model: J ?? fH?.model,
        agent_type: _,
        invokingRequestId: D?.requestId
    }, w);
    return { data: { status: "teammate_spawned", ...vH.data } }
}
```

`__9()` (spawnTeammate) → `cg1()` (routeTeammateBackend) 实现三种后端：

```javascript
// 13_ui_rendering.js:68931-68940 — backend routing
async function cg1(H, _) {        // routeTeammateBackend
    if (Rm()) return aH9(H, _);   // forceInProcess → inProcessBackend
    try { await p7H() }           // detectPaneBackend
    catch ($) {
        // pane backend unavailable, fallback to in-process
        return _o6(), aH9(H, _)   // resetPaneState, inProcessBackend
    }
    if (H.use_splitpane !== false) return gg1(H, _);  // splitpaneBackend
    return dg1(H, _)              // tmuxBackend
}
```

三种后端对比：

| 后端 | 函数 | 进程模型 | 适用场景 |
|------|------|----------|----------|
| **in-process** | `aH9()` (inProcessBackend) | 父进程内 | 非终端环境、API 模式 |
| **splitpane** | `gg1()` (splitpaneBackend) | iTerm2 分屏面板 | macOS + iTerm2 |
| **tmux** | `dg1()` (tmuxBackend) | tmux 窗口 | Linux / tmux 环境 |

Splitpane 后端的启动流程（`gg1()`, `13_ui_rendering.js:68537`）：

```javascript
// Simplified pseudocode for splitpane teammate launch
async function gg1(H, _) {        // splitpaneBackend
    let D = await ha6(K, Y);       // deduplicateName
    let j = TeH(D);                // sanitizeName
    let M = ty(j, Y);              // generateAgentId: "name@teamName"

    // create iTerm2 split pane
    let { paneId, isFirstTeammate } = await ka7(j, R);  // createPane

    // build CLI command for the new pane
    let v = [
        `--agent-id ${M}`, `--agent-name ${j}`,
        `--team-name ${Y}`, `--agent-color ${R}`,
        `--parent-session-id ${v_()}`,
        A ? "--plan-mode-required" : "",
        T ? `--agent-type ${T}` : ""
    ];
    let x = `cd ${J} && env ${S} ${k} ${v}${E}`;
    await Na7(W, x, !X);  // sendCommandToPane

    // register in team config
    p.members.push({ agentId: M, name: j, ... });
    await g7H(Y, p);      // writeTeamConfig

    // send initial prompt to teammate inbox
    await RK(j, { from: x5, text: O, ... }, Y);  // writeToInbox
}
```

> **设计决策**：Teammate 使用独立进程（tmux/pane）而非线程，是因为每个 Teammate 需要运行完整的 Claude Code REPL 实例，拥有独立的 system prompt、工具注册表和权限上下文。进程级隔离天然避免了共享状态带来的并发问题。

### 安全约束

Teammate 有严格的安全限制，防止层级爆炸：

```javascript
// 13_ui_rendering.js:69415 — flat roster enforcement
if (Q5() && W && O)   // isTeammate() && teamName && name
    throw Error("Teammates cannot spawn other teammates — the team roster is flat.");

// 13_ui_rendering.js:69416 — in-process background restriction
if (QJ() && W && K === true)  // isInProcessTeammate() && background
    throw Error("In-process teammates cannot spawn background agents.");
```

### Task 系统（TaskCreate / TaskList / TaskUpdate / TaskGet）

Task 系统是 Team 协作的核心调度机制。任务存储在 `~/.claude/tasks/{team-name}/` 目录下，所有 Teammate 共享。

四个任务工具：

```javascript
// 13_ui_rendering.js:6929-6932 — task tool names
var yv = "TaskCreate";
var CqH = "TaskGet";
var bqH = "TaskList";
var gy = "TaskUpdate";
```

**TaskCreate**（`14_html_parser.js:21060-21212`）：

- 创建任务，包含 `subject`、`description`、`activeForm`、`metadata`
- 初始状态为 `pending`
- 支持 `blocks`/`blockedBy` 依赖关系

**TaskUpdate**（`14_html_parser.js:21346-21463`）：

- 更新状态：`pending` → `in_progress` → `completed`
- 设置 `owner` 分配任务给特定 Teammate
- 管理阻塞依赖关系

**TaskList**（`14_html_parser.js:21647-21714`）：

- 显示所有任务的摘要视图
- Teammate 协议：完成当前任务后调用 `TaskList` 寻找下一个可用任务

**TaskGet**：

- 获取单个任务的详细信息

### 任务依赖与阻塞

任务之间可以通过 `blocks`/`blockedBy` 建立依赖关系：

```
Task A (pending)
    │ blocks
    ▼
Task B (pending, blockedBy: [A])
    │ blocks
    ▼
Task C (pending, blockedBy: [B])
```

当 Task A 完成时，Task B 的 `blockedBy` 列表中移除 A，若列表清空则 Task B 变为可执行状态。这实现了简单的 DAG（有向无环图）调度。

任务状态机：

```
┌─────────┐    owner assigned     ┌─────────────┐    work done     ┌───────────┐
│ pending │ ──────────────────▶  │ in_progress │ ───────────────▶ │ completed │
└─────────┘                      └─────────────┘                  └───────────┘
     │                                  │
     │ (blockedBy not empty)            │ (abandoned)
     ▼                                  ▼
┌─────────┐                      ┌───────────┐
│ blocked │                      │  pending  │ (reassignable)
└─────────┘                      └───────────┘
```

**小结**：Team 系统通过 `TeamCreate`/`TeamDelete` 管理生命周期，通过 `config.json` 记录成员信息，通过 Task 系统（四个工具 + `blocks`/`blockedBy` 依赖）实现任务调度。三种后端（in-process/splitpane/tmux）适配不同的终端环境，而 flat roster 约束确保团队结构不会无限嵌套。

---

## 16.5 团队通信协议

Team 的 Teammate 之间需要可靠的通信机制 — 既要支持自由文本消息用于日常协调，又要支持结构化协议消息用于 shutdown 和 plan approval 等系统级操作。Claude Code 选择了基于文件系统的收件箱模型，简单、可靠且跨进程。

### SendMessage 工具实现

`SendMessage`（`14_html_parser.js:23562-23604`）是 Team 通信的唯一通道：

```javascript
// 14_html_parser.js:23562-23604 — SendMessage tool definition
// Input schema
Ql1 = pH(() => h.object({
    to: h.string().describe('Recipient: teammate name, or "*" for broadcast'),
    summary: h.string().optional().describe("5-10 word preview"),
    message: h.union([h.string(), Ul1()])  // free text or structured protocol
}));

// Tool registration
el1 = {
    name: TP,                // "SendMessage"
    searchHint: "send messages to agent teammates (swarm protocol)",
    isEnabled() { return dq() },      // isTeamsFeatureEnabled
    isConcurrencySafe() { return false },
    isReadOnly(H) { return typeof H.message === "string" },
    ...
}
```

### 消息路由

**单播**（by name）— `il1()` (sendDirectMessage, `14_html_parser.js:23343`)：

```javascript
async function il1(H, _, q, $) {   // sendDirectMessage
    // H = recipient name, _ = message text, q = summary
    let K = $.getAppState();
    let O = n4(K.teamContext);       // getTeamName
    let T = _K() || (Q5() ? "teammate" : x5);  // getSenderName

    await RK(H, {                    // writeToInbox
        from: T, text: _, summary: q,
        timestamp: new Date().toISOString(),
        color: z                     // sender color
    }, O);

    return { data: { success: true, message: `Message sent to ${H}'s inbox` } }
}
```

**广播**（`to: "*"`）— `nl1()` (broadcastMessage, `14_html_parser.js:23371`)：

```javascript
async function nl1(H, _, q) {      // broadcastMessage
    let $ = q.getAppState();
    let K = n4($.teamContext);       // getTeamName
    let O = await iC(K);            // readTeamConfig

    let A = [];
    for (let f of O.members) {
        if (f.name.toLowerCase() === T.toLowerCase()) continue;  // skip self
        A.push(f.name)
    }

    // send to each teammate individually
    for (let f of A) await RK(f, { from: T, text: H, ... }, K);

    return {
        data: {
            success: true,
            message: `Message broadcast to ${A.length} teammate(s)`,
            recipients: A
        }
    }
}
```

`RK()` (writeToInbox) 将消息写入文件系统的收件箱：`~/.claude/inbox/{agent-name}/`。

### 消息投递与轮询

消息投递遵循"写入 → 轮询 → 注入"的三步流程：

```
Agent A 的 agentic loop 正在执行（busy 状态）
    │
    ├── Agent B 调用 SendMessage → RK() 写入 A 的收件箱文件
    │
    ├── A 的当前 turn 结束
    │     ├── 系统检查收件箱（500ms 轮询间隔）
    │     └── 将未读消息作为 user-role 消息注入对话
    │
    └── A 在下一个 turn 处理消息
```

对于 in-process Teammate，消息通过内存队列传递：

```javascript
// 11_api_streaming.js:17322-17343 — in-process message queue
function sh_(H, _, q) {  // addPendingMessage
    Z4(H, q, ($) => ({
        ...$, pendingMessages: [...$.pendingMessages, _]
    }))
}

function dX7(H, _, q) {  // consumePendingMessages
    let $ = _().tasks[H];
    if (!pD($) || $.pendingMessages.length === 0) return [];
    let K = $.pendingMessages;
    Z4(H, q, (O) => ({ ...O, pendingMessages: [] }));
    return K
}
```

### 空闲检测与通知

Teammate 在每轮 turn 结束后自动进入 idle 状态。这是正常行为，不代表 Teammate 已完成工作：

```javascript
// System prompt explanation (14_html_parser.js:22762-22769)
// "Teammates go idle after every turn - this is completely normal and expected.
//  A teammate going idle immediately after sending you a message does NOT mean
//  they are done or unavailable. Idle simply means they are waiting for input."
```

Idle 状态通过 Hooks 系统触发 `TeammateIdle` 事件：

```javascript
// 04_git_operations.js:9100 — hooks including TeammateIdle
hooks: new Set(["PreToolUse", "PostToolUse", "Notification",
    "UserPromptSubmit", "SessionStart", "SessionEnd", "Stop",
    "SubagentStop", "PreCompact", "PostCompact",
    "TeammateIdle", "TaskCreated", "TaskCompleted"])
```

### 结构化协议消息

除了自由文本消息，SendMessage 还支持三种结构化协议消息：

```javascript
// 14_html_parser.js — structured message type schema
Ul1 = pH(() => h.discriminatedUnion("type", [
    h.object({
        type: h.literal("shutdown_request"),
        reason: h.string().optional()
    }),
    h.object({
        type: h.literal("shutdown_response"),
        request_id: h.string(),
        approve: xj(),               // booleanSchema
        reason: h.string().optional()
    }),
    h.object({
        type: h.literal("plan_approval_response"),
        request_id: h.string(),
        approve: xj(),
        feedback: h.string().optional()
    })
]));
```

| 消息类型 | 方向 | 说明 |
|----------|------|------|
| `shutdown_request` | lead → teammate | 请求关闭 Teammate |
| `shutdown_response` | teammate → lead | 确认/拒绝关闭 |
| `plan_approval_response` | lead → teammate | 审批/拒绝计划 |

**Shutdown 协议流程**：

```
team-lead                              teammate
    │                                      │
    ├── SendMessage({                      │
    │     to: "worker",                    │
    │     message: {                       │
    │       type: "shutdown_request"       │
    │     }                                │
    │   })                                 │
    │                                      │
    │                                      ├── receives shutdown_request
    │                                      ├── SendMessage({
    │                                      │     to: "team-lead",
    │                                      │     message: {
    │                                      │       type: "shutdown_response",
    │                                      │       request_id: "...",
    │                                      │       approve: true
    │                                      │     }
    │                                      │   })
    │                                      └── process terminates
    ├── receives shutdown confirmation
    └── cleans up team resources
```

Shutdown 审批逻辑（`ol1()`, `14_html_parser.js:23438-23491`）：

```javascript
async function ol1(H, _) {           // handleShutdownApproval
    let $ = uM();                     // getCurrentAgentId
    let K = _K() || "teammate";       // getAgentName

    // find teammate's pane info
    let f = A.members.find((w) => w.agentId === $);
    if (f) O = f.tmuxPaneId, T = f.backendType;

    // send shutdown confirmation message
    await RK(x5, { from: K, text: gH(z), ... }, q);  // writeToInbox

    // terminate teammate process
    if (T === "in-process") {
        let f = $F($, A.tasks);       // findInProcessTask
        if (f?.abortController) f.abortController.abort();
    } else {
        // external process: exit via exit code
        setImmediate(async () => { await k9(0, "other") });  // exitProcess
    }
}
```

**Plan Approval 协议**：

```javascript
// 14_html_parser.js:23514 — approve plan
async function sl1(H, _, q) {         // approvePlan
    if (!t0($.teamContext))            // isTeamLead
        throw Error("Only the team lead can approve plans.");

    let z = {
        type: "plan_approval_response",
        requestId: _, approved: true,
        timestamp: new Date().toISOString(),
        permissionMode: T              // elevated permission mode
    };
    await RK(H, { from: x5, text: gH(z), ... }, K);  // writeToInbox
}

// 14_html_parser.js:23539 — reject plan
async function tl1(H, _, q, $) {      // rejectPlan
    let T = {
        type: "plan_approval_response",
        requestId: _, approved: false,
        feedback: q,                   // rejection feedback
        timestamp: new Date().toISOString()
    };
    await RK(H, { from: x5, text: gH(T), ... }, O);
}
```

### Teammate 系统提示附录

所有 Teammate 会自动附加通信指南到 system prompt：

```javascript
// 13_ui_rendering.js:55007-55017 — teammate communication appendix
var br6 = `
# Agent Teammate Communication

IMPORTANT: You are running as an agent in a team. To communicate with anyone:
- Use the SendMessage tool with \`to: "<name>"\` to send messages to specific teammates
- Use the SendMessage tool with \`to: "*"\` sparingly for team-wide broadcasts

Just writing a response in text is not visible to others on your team -
you MUST use the SendMessage tool.

The user interacts primarily with the team lead. Your work is coordinated
through the task system and teammate messaging.
`;
```

> **设计决策**：消息收件箱基于文件系统而非 IPC（进程间通信），因为 Teammate 可能运行在不同的 tmux/pane 会话中，甚至是不同的 Claude Code 进程实例。文件系统是这些进程之间唯一可靠的共享媒介。这种设计牺牲了一些延迟（500ms 轮询间隔），换取了极高的可靠性和简单性。

**小结**：Team 通信协议分为两层 — 自由文本消息用于日常协调（单播 + 广播），结构化协议消息用于系统级操作（shutdown + plan approval）。基于文件系统的收件箱模型保证了跨进程通信的可靠性，而 500ms 轮询间隔在延迟和资源消耗之间取得平衡。

---

## 16.6 Agent 类型系统

Agent 类型系统决定了每个 Agent "能做什么" — 它控制工具集、权限模式、模型选择和 system prompt。除了内置类型外，用户还可以通过 `.claude/agents/` 目录定义自定义 Agent 类型。

### 预定义 Agent 类型的工具约束

工具集过滤由 `Er()` (resolveAgentTools, `13_ui_rendering.js:9185`) 函数实现：

```javascript
function Er(H, _, q = false, $ = false) {  // resolveAgentTools
    let { tools: K, disallowedTools: O, source: T, permissionMode: z } = H;

    // filter base tool set
    let A = $ ? _ : DF6({           // filterToolsByContext
        tools: _, isBuiltIn: T === "built-in",
        isAsync: q, permissionMode: z
    });

    // apply disallowedTools exclusion
    let f = new Set(O?.map((R) => Jf(R).toolName) ?? []);
    let w = A.filter((R) => !f.has(R.name));

    // tools: ["*"] → use all filtered tools
    if (K === undefined || (K.length === 1 && K[0] === "*"))
        return { hasWildcard: true, resolvedTools: w };

    // specific tool list → keep only matching
    // ...
}
```

`DF6()` (filterToolsByContext, `13_ui_rendering.js:9163`) 实现上下文感知的工具过滤链：

```
全部工具
  │
  ├─ MCP 工具 (mcp__*) ──────────────────────── 始终通过
  │
  ├─ 团队管理工具 (Agent, TeamCreate 等)
  │   └─ 非内置 Agent → 移除
  │
  ├─ 异步 Agent 工具过滤
  │   ├─ 基本：仅允许读写工具 (iC_ set)
  │   └─ 例外：in-process Teammate 可用团队工具 (ZC7 set)
  │
  └─ Agent 定义的 tools/disallowedTools ──── 最终过滤
```

被排除的元工具集：

```javascript
// 13_ui_rendering.js:7380 — meta tools excluded from sub-agents
GvH = new Set([nL, Vj, EqH, M7, dO, jI])
// nL = "EnterWorktree", Vj = "ExitWorktree", EqH = "AskUserQuestion"
// M7 = "Agent", dO = "EnterPlanMode", jI = "ExitPlanMode"
```

可用于异步 Agent 的工具集：

```javascript
// 13_ui_rendering.js:7380 — tools available to async agents
iC_ = new Set([
    cq, sk, yC, bK, FA, A5,  // Read, Glob, Grep, etc.
    ...Jn,                     // other read-only tools
    P7, z$, WG, Cw, iM, Sj, cC_, FC_  // Write, Edit, Bash, etc.
])

// Team-specific tools (available to in-process teammates)
ZC7 = new Set([
    yv, CqH, bqH, gy,  // TaskCreate, TaskGet, TaskList, TaskUpdate
    TP, Vv, hr, WvH     // SendMessage, CronCreate, CronDelete, CronList
])
```

### Fork 类型的特殊定义

Fork 不通过 `subagent_type` 选择，而是通过**省略** `subagent_type` 触发（需 fork 实验开启）：

```javascript
// 13_ui_rendering.js:69062-69072 — Fork type definition
KyH = {
    agentType: "fork",                  // Fg1 variable
    whenToUse: "Implicit fork - inherits full conversation context. " +
               "Not selectable via subagent_type; triggered by omitting " +
               "subagent_type when the fork experiment is active.",
    tools: ["*"],                       // all tools
    maxTurns: 200,
    model: "inherit",                   // inherit parent's model
    permissionMode: "bubble",           // bubble permissions to parent
    source: "built-in",
    baseDir: "built-in",
    getSystemPrompt: () => ""           // empty (uses parent's system prompt)
}
```

Fork 的嵌套防护 — 防止 Fork 中再 Fork：

```javascript
// 13_ui_rendering.js:69443 — nested fork guard
if (w.options.querySource === `agent:builtin:${KyH.agentType}` || O_9(w.messages))
    throw Error("Fork is not available inside a forked worker.");

// O_9() (hasForkInstructionTag) checks for fork instruction tag in messages
function O_9(H) {
    return H.some((_) => {
        let q = _.message.content;
        return q.some(($) => $.type === "text" && $.text.includes(`<${i4_}>`))
    })
}
```

> **设计决策**：Fork 不允许嵌套，因为 Fork 继承完整上下文，嵌套 Fork 会导致上下文爆炸（每层 Fork 都携带前一层的完整上下文），且 cache 无法跨层共享。通过 `O_9()` (hasForkInstructionTag) 检测消息中的 fork 指令标签来阻止。

### 自定义 Agent（.claude/agents/ 目录）

自定义 Agent 从 `.claude/agents/` 目录加载，支持项目级和用户级：

- **项目级**：`.claude/agents/*.md`
- **用户级**：`~/.claude/agents/*.md`

```javascript
// 09_data_processing.js:12743 — directories watched for agent definitions
return [...UI4.filter((H) => H !== ".git"), ".claude/commands", ".claude/agents"]
```

### Agent 定义文件格式

Agent 定义使用 Markdown frontmatter 格式：

```markdown
---
tools:
  - Read
  - Glob
  - Grep
  - Bash
disallowedTools:
  - Write
  - Edit
maxTurns: 50
model: sonnet
---

# My Custom Agent

You are a code review agent. Your job is to...

## Rules
1. Never modify files directly
2. Report findings in structured format
...
```

支持的 frontmatter 字段：

```javascript
// 13_ui_rendering.js:53828-53835 — agent definition schema
disallowedTools: h.array(h.string()).optional(),
maxTurns: h.number().int().positive().optional(),
// ... plus tools, model, permissionMode
```

加载流程：

1. `tlH()` (mergeAgentDefinitions) 合并内置 Agent 和自定义 Agent 定义
2. `neH()` (filterByPermissions) 根据权限规则过滤可用类型
3. 文件名（去掉 `.md` 后缀）即为 `subagent_type` 的值

**小结**：Agent 类型系统通过工具集限制（`tools` + `disallowedTools`）、权限模式和模型选择三个维度定义每种 Agent 的能力边界。自定义 Agent 定义文件使用 Markdown frontmatter 格式，存放在 `.claude/agents/` 目录下，让用户可以为特定场景定制专用 Agent。

---

## 16.7 设计启示

本节提炼 Claude Code 多 Agent 系统中可迁移到其他项目的设计经验。

### 进程级隔离 vs 线程级共享

Claude Code 为 Teammate 选择了**进程级隔离**（tmux/pane 独立进程），而非线程级共享。这个决策带来了几个关键优势：

- **故障隔离**：一个 Teammate 崩溃不会影响其他成员
- **状态隔离**：每个进程有独立的 system prompt、工具注册表和权限上下文，不存在共享状态竞争
- **环境隔离**：每个 Teammate 可以有不同的 CWD 和环境变量

代价是通信延迟（文件系统 500ms 轮询）和资源开销（每个进程一个完整 REPL 实例）。但对于 Agent 场景，正确性远比延迟重要。

### 任务驱动 vs 消息驱动协作

Team 系统同时实现了两种协作范式：

- **任务驱动**：通过 TaskList 共享任务，Teammate 完成一个任务后自动 pick 下一个。适合可分解为独立子任务的工作
- **消息驱动**：通过 SendMessage 自由通信，适合需要协调的复杂工作

两种范式并非互斥 — Teammate 可以在执行任务过程中通过消息请求协助，也可以通过消息协调任务的分配。

### 渐进式复杂度

三层模型（单 Agent → Sub-Agent → Team）遵循**按需引入复杂度**的原则：

| 场景 | 推荐模式 | 复杂度 |
|------|----------|--------|
| 简单的代码搜索委派 | `Explore` Sub-Agent | 零配置 |
| 需要父上下文的并行任务 | Fork | 共享 cache，零额外成本 |
| 多文件并行修改 | Sub-Agent + Worktree | 文件隔离 |
| 长期运行的多方协作 | Team | 完整通信基础设施 |

这种设计避免了"为了一个简单任务而引入整个 Team 基础设施"的过度工程化。

### Git Worktree 作为自然隔离单元

使用 Git Worktree 作为文件系统隔离的方案极为精妙：

1. **天然的版本控制**：每个 Agent 在独立分支上工作，变更可追踪
2. **零配置合并**：Agent 完成后，用户可以通过标准 Git 工作流合并结果
3. **自动清理**：无变更的 Worktree 自动删除，有变更的保留供用户审查
4. **Sparse Checkout 优化**：大型 monorepo 可以只检出相关目录

```javascript
// Worktree cleanup strategy (13_ui_rendering.js:69580-69602)
// No changes (HEAD commit unchanged) → auto-delete worktree and branch
// Has changes → keep worktree, return path and branch to parent agent
```

这种"按需保留"策略避免了 Agent 产生大量废弃 Worktree 的问题。

### 消息系统的简约设计

Team 的消息系统刻意保持简约 — 没有消息队列中间件、没有 gRPC、没有 WebSocket。仅使用文件系统 + 轮询：

- **写入**：将消息写入 `~/.claude/inbox/{agent-name}/`
- **读取**：500ms 轮询检查收件箱
- **投递**：将未读消息注入 Agent 的对话流

这种设计的可靠性来自文件系统的原子性保证，而非复杂的分布式协议。对于 Agent 场景（通信频率低、每条消息价值高），这是一个极好的工程权衡。

---

## 速查表

### 7 种 Agent 类型对比表

| 类型 | 工具限制 | 模型 | 权限模式 | maxTurns | 说明 |
|------|----------|------|----------|----------|------|
| `general-purpose` | 全部 `["*"]` | inherit | `acceptEdits` | - | 默认通用 Agent |
| `Explore` | 只读（Read/Glob/Grep） | haiku | `acceptEdits` | - | 代码探索，不能编辑 |
| `Plan` | 只读 | inherit | `acceptEdits` | - | 架构规划，不能编辑 |
| `statusline-setup` | Read + Edit | sonnet | `acceptEdits` | - | 状态栏配置 |
| `fork` | 全部 `["*"]` | inherit | `bubble` | 200 | 继承上下文，不可嵌套 |
| 自定义 Agent | frontmatter 定义 | frontmatter | frontmatter | frontmatter | `.claude/agents/*.md` |

### 关键函数索引

| 混淆名 | 推测英文名 | 文件:行号 | 功能描述 |
|--------|-----------|-----------|----------|
| `f_9` | agentToolDefinition | `13_ui_rendering.js:69364` | Agent 工具定义对象 |
| `A_9()` | generatePromptDescription | `13_ui_rendering.js:69100` | 生成 Agent 工具的 prompt 描述文本 |
| `oo6()` | getInputSchema | `13_ui_rendering.js:69327` | Agent 工具输入 Schema |
| `ag1()` | getOutputSchema | `13_ui_rendering.js:69350` | Agent 工具输出 Schema |
| `av()` | runAgenticLoop | `13_ui_rendering.js:65180` | 子 Agent agentic loop 入口 |
| `Er()` | resolveAgentTools | `13_ui_rendering.js:9185` | 解析 Agent 定义的工具限制 |
| `DF6()` | filterToolsByContext | `13_ui_rendering.js:9163` | 按上下文过滤可用工具集 |
| `KyH` | forkAgentDefinition | `13_ui_rendering.js:69062` | Fork Agent 类型定义对象 |
| `Od` | defaultAgentType | `13_ui_rendering.js` | 默认 Agent 类型 (`general-purpose`) |
| `T_9()` | buildForkMessages | `13_ui_rendering.js:68985` | 构建 Fork 指令消息 |
| `$_9()` | generateForkWorkerRules | `13_ui_rendering.js:69020` | 生成 Fork worker 规则文本 |
| `O_9()` | hasForkInstructionTag | `13_ui_rendering.js:69443` | 检查消息是否包含 fork 标签 |
| `LvH()` | resolveModel | `13_ui_rendering.js:69460` | 模型选择优先级解析 |
| `ng1()` | getAutoBackgroundMs | `13_ui_rendering.js:69268` | 获取自动后台化阈值（120s） |
| `__9()` | spawnTeammate | `13_ui_rendering.js:68942` | Teammate 生成入口 |
| `cg1()` | routeTeammateBackend | `13_ui_rendering.js:68931` | Teammate 后端路由 |
| `gg1()` | splitpaneBackend | `13_ui_rendering.js:68537` | Splitpane 后端 Teammate 生成 |
| `dg1()` | tmuxBackend | `13_ui_rendering.js:68659` | Tmux 后端 Teammate 生成 |
| `aH9()` | inProcessBackend | `13_ui_rendering.js:68806` | In-process Teammate 生成 |
| `_y_()` | registerAsyncTask | `11_api_streaming.js:17501` | 注册异步 Agent 任务 |
| `QX7()` | registerSyncTask | `11_api_streaming.js:17535` | 注册同步 Agent 任务 |
| `S8H()` | sendTaskNotification | `11_api_streaming.js:17346` | 发送任务完成通知 |
| `E8H()` | killTask | `11_api_streaming.js:17389` | 终止运行中的 Agent |
| `eh_()` | markCompleted | `11_api_streaming.js:17470` | 标记 Agent 完成 |
| `Hy_()` | markFailed | `11_api_streaming.js:17486` | 标记 Agent 失败 |
| `pl1` | teamCreateTool | `14_html_parser.js:22843` | TeamCreate 工具定义 |
| `el1` | sendMessageTool | `14_html_parser.js:23599` | SendMessage 工具定义 |
| `il1()` | sendDirectMessage | `14_html_parser.js:23343` | 单播消息发送 |
| `nl1()` | broadcastMessage | `14_html_parser.js:23371` | 广播消息发送 |
| `ol1()` | handleShutdownApproval | `14_html_parser.js:23438` | Shutdown 审批处理 |
| `sl1()` | approvePlan | `14_html_parser.js:23514` | Plan 审批处理 |
| `tl1()` | rejectPlan | `14_html_parser.js:23539` | Plan 拒绝处理 |
| `RK()` | writeToInbox | `14_html_parser.js` | 写入收件箱文件 |
| `v48()` | createGitWorktree | `17_system_prompt_full.js:2778` | Git Worktree 创建 |
| `reH()` | createAgentWorktree | `17_system_prompt_full.js:3128` | Agent Worktree 创建 |
| `a7H()` | deleteAgentWorktree | `17_system_prompt_full.js:3156` | Agent Worktree 删除 |
| `tlH()` | mergeAgentDefinitions | `13_ui_rendering.js` | 合并内置 + 自定义 Agent 定义 |
| `neH()` | filterByPermissions | `15_hooks_system.js:7129` | 按权限规则过滤 Agent 类型 |
| `EeH()` | buildAgentSystemPrompt | `13_ui_rendering.js:69512` | 构建 Sub-Agent 的 system prompt |
| `Rm1()` | bubblePermission | `13_ui_rendering.js:55019` | 权限冒泡处理函数 |

### Team 文件结构

```
~/.claude/
├── teams/{team-name}/
│   └── config.json              # 团队配置（members 数组）
│       {
│         "members": [
│           {
│             "agentId": "worker@my-team",
│             "name": "worker",
│             "agentType": "general-purpose",
│             "model": "sonnet",
│             "prompt": "initial task...",
│             "color": "#ff6b6b",
│             "tmuxPaneId": "%42",
│             "cwd": "/path/to/project",
│             "backendType": "splitpane"
│           }
│         ]
│       }
│
├── tasks/{team-name}/           # 共享任务列表
│   └── {task-id}.json           # 单个任务文件
│       {
│         "id": "task-abc123",
│         "subject": "Refactor error handling",
│         "description": "...",
│         "status": "in_progress",
│         "owner": "worker",
│         "blocks": ["task-def456"],
│         "blockedBy": []
│       }
│
└── inbox/{agent-name}/          # 消息收件箱
    └── {timestamp}.json         # 单条消息文件
```

### Task 状态机

```
                  ┌───────────────────────────────────────────┐
                  │                                           │
                  ▼                                           │
            ┌──────────┐                                      │
     ┌──────│ pending  │──────┐                               │
     │      └──────────┘      │                               │
     │           │            │                               │
     │  (blockedBy)    (owner assigned)                       │
     │           │            │                               │
     │      ┌────▼─────┐     │                          (abandoned)
     │      │ blocked  │     │                               │
     │      └────┬─────┘     │                               │
     │           │            │                               │
     │   (deps resolved)     │                               │
     │           │            │                               │
     │           ▼            ▼                               │
     │      ┌──────────────────┐                              │
     │      │   in_progress    │──────────────────────────────┘
     │      └────────┬─────────┘
     │               │
     │          (work done)
     │               │
     │          ┌────▼─────┐
     └─────────│ completed │
               └───────────┘
```

### 关键常量速查

| 常量 | 值 | 含义 |
|------|-----|------|
| 自动后台化阈值 | 120,000 ms (120s) | 同步 Agent 超时转后台 |
| 邮箱轮询间隔 | 500 ms | Teammate 收件箱检查频率 |
| Teammate 终止清理延迟 | 3,000 ms (3s) | 终止后等待清理 |
| 输出截断恢复重试 | 3 次 (Bo_ = 3) | maxOutputTokens 截断重试 |
| Fork maxTurns | 200 | Fork Agent 最大轮次 |
| Agent 结果上限 | 100,000 chars (100KB) | maxResultSizeChars |
| Cron 任务上限 | 50 | 最大定时任务数 |
| 重复任务过期 | 604,800,000 ms (7 days) | recurringMaxAgeMs |

### 权限模式层次

```
bypassPermissions  ──▶  跳过所有检查（--dangerously-skip-permissions）
        │
   acceptEdits     ──▶  自动接受文件编辑（SubAgent 默认）
        │
       auto        ──▶  自动决策（配置文件指定）
        │
      default      ──▶  标准权限检查（正常用户交互）
        │
       plan        ──▶  计划模式，需要 team lead 审批
        │
      bubble       ──▶  冒泡到父 Agent UI（Fork 默认）
```
