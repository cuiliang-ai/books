
# 第 8 章：工具系统总论 — Agent 的执行臂

> **核心问题**：LLM 只能生成文本，如何让它"动手"操作真实世界？一个可扩展、安全、高性能的工具系统需要什么样的架构？

LLM 本质上是一个文本到文本的函数 — 输入 tokens，输出 tokens。它不能读文件、不能执行命令、不能搜索代码、不能调用 API。**工具系统是连接 LLM 思维与真实世界的桥梁**，也是 Agent 架构中 Agentic Loop（第 4 章）的"执行臂"。

Claude Code 构建了一套精巧的工具系统：统一的工具定义接口、智能的并发安全调度、流式执行优化、Hook 拦截点、以及通过 MCP 协议实现的开放式扩展。本章作为"第三篇 · 工具与能力"的开篇总论，将解析这套系统的整体架构，为后续第 9-12 章（Bash/File IO/Git/MCP）的深入分析建立框架。

---

## 8.1 工具在 Agent 架构中的角色

### 为什么 Agent 需要工具

一个只能生成文本的 LLM，面对"帮我修复这个 bug"的请求，只能输出一段建议文字。而一个拥有工具的 Agent，可以：

```
纯 LLM                              Agent + 工具
├── "你可以试试修改第 42 行..."      ├── Read("src/app.ts")     → 看到代码
├── "建议使用 forEach 替代..."       ├── Grep("bug pattern")    → 定位问题
└── "希望这对你有帮助!"              ├── Edit("src/app.ts", ...)→ 修复 bug
                                     ├── Bash("npm test")       → 验证修复
                                     └── "Bug 已修复,测试通过."
```

工具让 LLM 从"顾问"变成了"执行者"。Claude Code 的 Agentic Loop 正是围绕这个能力构建的：

```
                    Agentic Loop (第 4 章)
                    ┌─────────────────┐
                    │  LLM 生成响应    │
                    │  (可能包含       │
                    │   tool_use 块)   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
            ┌───── │  有 tool_use?    │ ─────┐
            │      └─────────────────┘      │
            │ 是                             │ 否
    ┌───────▼───────┐               ┌───────▼───────┐
    │  工具系统      │               │  输出最终响应   │
    │  (本章)        │               │  循环结束      │
    │               │               └───────────────┘
    │  分发 → 调度   │
    │  → 执行 → 回注 │
    └───────┬───────┘
            │ tool_result
    ┌───────▼───────┐
    │  追加到对话    │
    │  继续下一轮    │ ──→ 回到 LLM
    └───────────────┘
```

### CC 的工具全景

Claude Code 的工具分为三大类：

| 类别 | 工具 | 能力范围 |
|------|------|----------|
| **内置工具** | Bash, Read, Write, Edit, Glob, Grep, NotebookEdit | 文件操作、命令执行、代码搜索 |
| **Agent 工具** | Agent, EnterWorktree, ExitWorktree, EnterPlanMode, ExitPlanMode | 子 Agent 调度、工作区隔离、规划模式 |
| **网络工具** | WebFetch, WebSearch | URL 抓取、网络搜索 |
| **MCP 工具** | 由 MCP 服务器动态提供 | 任意外部能力（数据库、API、IDE 集成等） |

完整的工具一览表见本章末尾"速查表"。

> **设计决策**：为什么不把所有能力都塞进 Bash？虽然 Bash 理论上可以做一切事情（`cat` 读文件、`sed` 编辑、`grep` 搜索），但专用工具有三个优势：**结构化输出**（Read 返回带行号的分类结果，而非纯文本）、**安全控制**（Edit 有先读后写保护，`sed` 没有）、**并发优化**（Read/Grep 可以并行，`cat`/`grep` 只能串行等待）。

### 工具与 API 的关系：tool_use → tool_result 闭环

Claude Code 使用 Anthropic Messages API 的工具调用协议。理解这个协议是理解整个工具系统的基础：

```
Claude Code                    Anthropic API                    LLM
    │                              │                             │
    │  messages + tools定义 ──────→ │                             │
    │                              │  ── prompt + tools ───────→ │
    │                              │                             │
    │                              │  ←── assistant response ─── │
    │  ←── tool_use blocks ─────── │    (含 tool_use blocks)     │
    │                              │                             │
    │  执行工具...                  │                             │
    │                              │                             │
    │  tool_result (user msg) ───→ │                             │
    │                              │  ── 含 tool_result ───────→ │
    │                              │                             │
    │                              │  ←── 继续生成 ──────────── │
    │  ←── 下一轮响应 ──────────── │                             │
```

**关键协议细节**：

1. **tools 参数**：在 API 请求中声明所有可用工具的 `name`、`description`、`input_schema`
2. **tool_use block**：LLM 在 assistant 消息中返回，包含 `id`、`name`、`input`
3. **tool_result block**：CC 执行工具后，将结果以 `user` 消息形式追加，包含 `tool_use_id`、`content`、`is_error`

```javascript
// tool_use block (LLM 输出)
{
    type: "tool_use",
    id: "toolu_01abc123",
    name: "Read",
    input: { file_path: "/src/app.ts" }
}

// tool_result block (CC 回注)
{
    type: "tool_result",
    tool_use_id: "toolu_01abc123",          // 对应 tool_use 的 id
    content: "     1→import express...",     // 执行结果
    is_error: false                          // 成功 or 失败
}
```

这个"LLM 发起调用 → CC 执行 → 结果回注 → LLM 继续"的闭环，是整个 Agentic Loop 的核心驱动力。LLM 每次看到 tool_result，都可以基于新信息决定下一步行动 — 继续调用工具或输出最终答案。

**小结**：工具系统是 Agent 架构的执行层，将 LLM 的文本输出转化为真实世界的操作。CC 通过 tool_use/tool_result 闭环实现 LLM 与工具的交互，通过专用工具（而非万能 Bash）获得结构化、安全、可并发的工具能力。

---

## 8.2 工具注册与定义 — toolDefinition 对象结构

每个工具在 CC 中都是一个统一的 `toolDefinition` 对象。这个统一接口是整个工具系统"一切皆工具"设计的基石 — 无论是内置的 Bash、外部的 MCP 工具，还是 Agent 子工具，都遵循相同的接口契约。

### 统一的工具定义接口

```javascript
// toolDefinition object structure (generalized from multiple tools)
{
    // ── Identity ──
    name: "Bash",                          // tool name (unique ID in API)
    userFacingName: () => "Bash",          // user-visible name (for UI display)

    // ── Description ──
    description: BE7(),                     // BE7() (buildBashPrompt): static description
    prompt: () => description,             // dynamic description (may vary by environment)

    // ── Input Schema ──
    inputSchema: UE7(),                     // UE7() (bashExternalSchema): external Zod Schema (exposed to API)
    internalInputSchema: FE7(),             // FE7() (bashInternalSchema): internal Zod Schema (with hidden params)

    // ── Capability declarations ──
    isConcurrencySafe: (input) => false,   // can this tool run in parallel?
    isReadOnly: () => false,               // is this tool read-only?
    requiresUserInteraction: () => false,  // does this tool need user interaction?

    // ── Execution ──
    call: async function*(input, ctx) {},  // execution function (async generator)
    validateInput: async (input, ctx) => {},// custom input validation
    checkPermissions: gc6,                 // gc6() (checkBashPermission): permission check

    // ── Result conversion ──
    mapToolResultToToolResultBlockParam:   // structured result → API format
        (result) => { ... }
}
```

每个属性服务于工具系统的不同环节：

| 属性 | 使用场景 | 使用方 |
|------|---------|--------|
| `name` | API 请求中的 `tools[].name` | Anthropic API |
| `prompt()` | API 请求中的 `tools[].description` | LLM |
| `inputSchema` | API 请求中的 `tools[].input_schema` | LLM + Zod 验证 |
| `isConcurrencySafe` | 并发分组调度 | 工具分发器 |
| `isReadOnly` | 权限判断、推测执行边界 | 权限系统 |
| `call` | 实际执行 | 工具执行器 |
| `validateInput` | 执行前的业务逻辑验证 | 执行生命周期 |

### 双 Schema 设计

一个精巧的设计是**每个工具可以有两个 Schema** — 外部的 `inputSchema` 和内部的 `internalInputSchema`：

```javascript
// Bash tool dual Schema example
// External Schema — parameters visible to LLM
UE7 = h.strictObject({   // UE7() (bashExternalSchema)
    command: h.string(),
    timeout: h.number().optional(),
    description: h.string().optional(),
    run_in_background: h.boolean().optional(),
    dangerouslyDisableSandbox: h.boolean().optional()
});

// Internal Schema — includes hidden parameters
FE7 = h.strictObject({   // FE7() (bashInternalSchema)
    ...UE7.shape,                          // includes all external params
    _simulatedSedEdit: h.object({          // hidden param: simulated sed edit
        filePath: h.string(),
        newContent: h.string()
    }).optional()
});
```

外部 Schema 通过 `omit` 移除内部参数后传给 API：

```javascript
// External Schema = Internal Schema - hidden params
UE7 = FE7().omit({ _simulatedSedEdit: true });
```

> **设计决策**：双 Schema 设计实现了"内外分离" — LLM 只看到它应该使用的参数，CC 内部可以通过隐藏参数实现额外功能（如 sed 命令的安全模拟）。这避免了 LLM 误用内部通道，同时保留了系统的扩展灵活性。

### 工具的动态注册

内置工具在 CC 启动时静态注册，但 MCP 工具是**运行时动态加入**的：

```
Tool registration timing
    │
    ├── At startup (static)
    │   ├── Bash, Read, Write, Edit, Glob, Grep, NotebookEdit
    │   ├── Agent, EnterWorktree, ExitWorktree
    │   ├── EnterPlanMode, ExitPlanMode
    │   └── WebFetch, WebSearch
    │
    └── At runtime (dynamic)
        └── MCP tools
            ├── MCP server connects → retrieve tool list
            ├── Each MCP tool wrapped as toolDefinition object
            │   ├── name: "mcp__serverName__toolName"
            │   ├── inputSchema: converted from MCP protocol to Zod
            │   └── call: remote invocation via MCP protocol
            └── Dynamically added to available tools list
```

MCP 工具的命名规则是 `mcp__<serverName>__<toolName>`，通过双下划线分隔服务器名和工具名，确保与内置工具不冲突。

### 工具搜索：B$() (findToolByName) 函数

当 LLM 返回一个 `tool_use` block 时，CC 需要根据工具名找到对应的 `toolDefinition`。这个查找由 `B$()` (findToolByName) 函数完成：

```javascript
// B$(): 在工具列表中按名称查找工具定义
function B$(tools, name) {
    return tools.find(tool => tool.name === name);
}
```

`B$()` (findToolByName) 在工具系统的多个环节被调用：
- **并发分组**（`uK1` (groupByConcurrencySafety)）：查找工具定义以确定并发安全性
- **工具执行**（`GnH` (executeSingleToolUse)）：查找工具定义以执行 `call` 方法
- **流式执行器**（`mH_` (StreamingToolExecutor)）：查找工具定义以决定调度策略

**小结**：toolDefinition 是工具系统的统一契约，每个工具通过同一接口声明自己的身份、能力、输入约束和执行逻辑。双 Schema 设计实现了 LLM 可见参数与内部参数的分离，动态注册让 MCP 工具无缝融入系统。

---

## 8.3 工具分发与调度 — 从 tool_use 到执行

当 LLM 在一次响应中返回多个 tool_use block 时，CC 不是简单地逐个执行 — 它会智能地分组，将可以并发的工具并行执行，将必须串行的工具逐一执行。这个分发调度逻辑是工具系统的"大脑"。

### 工具分发入口 xh_() (dispatchToolUseBlocks)

`xh_()` (dispatchToolUseBlocks) 是整个工具分发的入口函数。它接收 LLM 返回的所有 tool_use blocks，经过并发安全分组后，分别调用并行或串行执行器：

```javascript
// xh_() (dispatchToolUseBlocks): tool dispatch entry point
async function* xh_(H, _, q, $) {
    // H = tool_use blocks array (may contain multiple from one LLM response)
    // _ = corresponding assistant message
    // q = canUseTool callback (permission check)
    // $ = toolUseContext

    // Group by concurrency safety
    for (let { isConcurrencySafe: O, blocks: T } of uK1(H, $))
        if (O) {
            // Concurrency-safe group → mK1() parallel execution
            for await (let A of mK1(T, _, q, $)) { yield A; }
        } else {
            // Unsafe tool → xK1() sequential execution
            for await (let z of xK1(T, _, q, $)) { yield z; }
        }
}
```

注意 `xh_()` (dispatchToolUseBlocks) 也是一个 async generator — 它 `yield` 的是每个工具的执行结果和进度，调用方（Agentic Loop）通过 `for await...of` 消费这些结果。

### 并发安全分组 uK1() (groupByConcurrencySafety)

分组逻辑是工具调度的核心算法。它将 tool_use blocks 按顺序扫描，将**连续的**并发安全工具合并为一组：

```javascript
// uK1() (groupByConcurrencySafety): group tool_use blocks by concurrency safety
function uK1(H, _) {
    return H.reduce((q, $) => {
        // Find tool definition
        let K = B$(_.options.tools, $.name);

        // Validate input and check concurrency safety
        let O = K?.inputSchema.safeParse($.input);
        let T = O?.success
            ? Boolean(K?.isConcurrencySafe(O.data))  // judge based on parsed input
            : false;                                  // parse failed → treat as unsafe

        // Merge consecutive concurrency-safe tools into one group
        if (T && q[q.length - 1]?.isConcurrencySafe)
            q[q.length - 1].blocks.push($);           // append to current group
        else
            q.push({ isConcurrencySafe: T, blocks: [$] });  // start new group
        return q;
    }, []);
}
```

分组效果示意：

```
LLM 返回的 tool_use blocks 顺序：
  [Read, Grep, Read, Edit, Read, Glob]

分组结果：
  组1: { concurrent: true,  blocks: [Read, Grep, Read] }  → 并行执行
  组2: { concurrent: false, blocks: [Edit] }               → 串行执行
  组3: { concurrent: true,  blocks: [Read, Glob] }         → 并行执行

执行时间线：
  ├── Read ──────┐
  ├── Grep ──────┤ 并行
  ├── Read ──────┘
  │              ↓
  ├── Edit ──────── 串行（等上组完成）
  │              ↓
  ├── Read ──────┐
  └── Glob ──────┘ 并行
```

> **设计决策**：为什么分组要求"连续"？考虑序列 `[Read, Edit, Read]`：如果把两个 Read 合并并行，第二个 Read 可能读到 Edit 修改前的内容，导致 LLM 基于过期信息决策。**保持原始顺序**确保了 LLM 的意图被正确执行 — 它先读、再改、再读，是有因果关系的。

### 并行执行 mK1() (executeToolsConcurrently) vs 串行执行 xK1() (executeToolsSequentially)

```javascript
// mK1() (executeToolsConcurrently): parallel execution for concurrency-safe tools
async function* mK1(blocks, assistantMsg, canUseTool, context) {
    // Launch all tools simultaneously
    let promises = blocks.map(block =>
        executeAndCollect(GnH(block, assistantMsg, canUseTool, context))
    );

    // Wait for all to complete, collect results
    let results = await Promise.all(promises);
    for (let result of results) yield result;
}

// xK1() (executeToolsSequentially): sequential execution (one by one)
async function* xK1(blocks, assistantMsg, canUseTool, context) {
    for (let block of blocks) {
        // Execute one by one, each must complete before the next starts
        for await (let result of GnH(block, assistantMsg, canUseTool, context)) {
            yield result;
        }
    }
}
```

### 流式工具执行器 mH_ (StreamingToolExecutor) 类

`mH_` (StreamingToolExecutor) 是一个更高级的工具调度器，用于**流式场景** — 当 LLM 还在生成响应时，已经完成的 tool_use block 可以**立即开始执行**，不需要等整个响应生成完毕：

```
Traditional mode (wait for full response):
  LLM generates: [Read][Grep][Edit]........done
                                            ↓
                                          start tool execution
                                            ↓
  Execute: Read → Grep → Edit

Streaming mode (mH_ execute-as-received):
  LLM generates: [Read]...[Grep]...[Edit]...done
                     ↓        ↓        ↓
  Execute:        Read ──→  Grep ──→  Edit ──→
                  (started while LLM is still generating!)
```

`mH_` (StreamingToolExecutor) 类的核心实现：

```javascript
class mH_ { // StreamingToolExecutor
    toolDefinitions;       // all tool definitions
    canUseTool;            // permission check callback
    tools = [];            // tool queue
    toolUseContext;        // execution context
    hasErrored = false;    // whether any tool errored
    discarded = false;     // whether executor is discarded
    siblingAbortController;// abort controller for sibling tools

    // Called when LLM streaming completes a tool_use block
    addTool(block, assistantMsg) {
        let def = B$(this.toolDefinitions, block.name);
        let parsed = def?.inputSchema.safeParse(block.input);
        let isConcSafe = parsed?.success
            ? Boolean(def?.isConcurrencySafe(parsed.data))
            : false;

        this.tools.push({
            id: block.id,
            block: block,
            assistantMessage: assistantMsg,
            status: "queued",                  // initial status
            isConcurrencySafe: isConcSafe,
            pendingProgress: []
        });

        this.processQueue();                   // try to execute immediately
    }

    // Check whether a new tool can start executing
    canExecuteTool(isConcSafe) {
        let executing = this.tools.filter(t => t.status === "executing");
        // No tools executing → can execute
        // All executing are conc-safe + new tool is conc-safe → can execute
        return executing.length === 0
            || (isConcSafe && executing.every(t => t.isConcurrencySafe));
    }

    // Process the tool queue
    async processQueue() {
        for (let tool of this.tools) {
            if (tool.status !== "queued") continue;

            if (this.canExecuteTool(tool.isConcurrencySafe)) {
                await this.executeTool(tool);   // start execution
            } else if (!tool.isConcurrencySafe) {
                break;                          // non-conc-safe tool blocks queue
            }
            // conc-safe but blocked by non-conc-safe executing → skip, wait
        }
    }
}
```

`mH_` (StreamingToolExecutor) 的调度规则可以用一张决策表概括：

```
当前执行状态            新工具类型         决策
─────────────         ──────────       ─────
无工具在执行            任意             → 立即执行
有并发安全工具在执行     并发安全          → 立即并行执行
有并发安全工具在执行     非并发安全        → 等待所有完成
有非并发安全工具在执行   任意             → 等待完成
```

> **设计决策**：`mH_` (StreamingToolExecutor) 的流式执行在网络延迟较大时收益显著。假设 LLM 生成一个含 3 个 Read 的响应需要 2 秒，每个 Read 执行需要 100ms。传统模式总耗时 = 2s + 300ms = 2.3s；流式模式下，3 个 Read 在 LLM 还在生成时就已并行完成，总耗时 ≈ 2s。**减少了 300ms 的感知延迟**。对于更耗时的工具（如 Bash 命令），优化效果更明显。

**小结**：工具分发通过 `uK1()` (groupByConcurrencySafety) 将连续的并发安全工具合并为一组并行执行，通过 `xK1()` (executeToolsSequentially) 串行执行非安全工具。流式执行器 `mH_` (StreamingToolExecutor) 进一步优化了延迟 — 不等 LLM 完成就开始执行已就绪的工具。整个调度逻辑在保证**执行顺序正确性**的前提下，最大化了**执行并行度**。

---

## 8.4 单工具执行生命周期 — GnH() (executeSingleToolUse) → Mi1() (toolExecutionPipeline)

当一个 tool_use block 被调度执行时，它要经过一条完整的生命周期管线：从输入验证到权限协商，从实际执行到结果组装。这个管线的设计体现了"安全优先、执行可控"的工程理念。

### 完整执行链

```
tool_use block: { name: "Edit", id: "toolu_01x", input: {...} }
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  GnH() (executeSingleToolUse) — tool execution entry point     │
│  ├── B$() (findToolByName) find tool definition                │
│  ├── tool not found? → return <tool_use_error>                 │
│  ├── aborted? → return cancel message                          │
│  └── call Di1()/Mi1() to execute                               │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Mi1() (toolExecutionPipeline) — full execution pipeline        │
│                                                                 │
│  1. Input validation (Zod)                                      │
│     inputSchema.safeParse(input)                                │
│     → failed? return error                                      │
│                                                                 │
│  2. Custom validation (validateInput)                           │
│     validateInput(parsedInput, context)                         │
│     → failed? return error                                      │
│                                                                 │
│  3. PreToolUse Hook                                             │
│     → can modify input, allow/deny, prevent continuation        │
│                                                                 │
│  4. Permission decision                                         │
│     Hook allow → deny rule override check → final decision      │
│     Hook pending → user confirmation                            │
│                                                                 │
│  5. Permission denied?                                          │
│     → return rejection message                                  │
│                                                                 │
│  6. Execute call()                                              │
│     for await (result of tool.call(input, ctx)) {...}           │
│                                                                 │
│  7. PostToolUse Hook                                            │
│     → post-processing, audit logging                            │
│                                                                 │
│  8. Assemble tool_result                                        │
│     → d_() (buildToolResultMessage) construct user message      │
└─────────────────────────────────────────────────────────────────┘
```

### 输入验证：两层防线

第一层是 **Zod Schema 验证** — 检查输入是否符合工具定义的类型约束：

```javascript
// Mi1() (toolExecutionPipeline): Zod validation
let Y = H.inputSchema.safeParse(q);    // H = tool definition, q = input
if (!Y.success) {
    // Return Zod-formatted error message
    return [/* tool_result with is_error: true */];
}
```

第二层是 **validateInput 自定义验证** — 每个工具可以实现自己的业务逻辑验证：

```javascript
let D = await H.validateInput?.(Y.data, $);
if (D?.result === false) {
    // 返回工具特定的错误信息
    // 如 Edit 的 "Found N matches, need exactly 1"
    // 如 Write 的 "File has not been read yet"
    return [/* tool_result with error message */];
}
```

两层验证的分工：

| 验证层 | 职责 | 示例 |
|--------|------|------|
| Zod Schema | 类型和格式约束 | `file_path` 必须是 string，`timeout` 必须是 number |
| validateInput | 业务逻辑约束 | Edit 的唯一性匹配、Write 的先读后写、Bash 的直接通过 |

### 权限协商流程

权限决策是执行链中最复杂的环节，涉及 Hook、deny 规则和用户确认三方交互：

```javascript
// Mi1() (toolExecutionPipeline): permission negotiation (simplified)

// 3. PreToolUse Hook — external hooks can make permission decisions directly
for await (let C of r49($, H, M, _, ...)) {
    switch (C.type) {
        case "hookPermissionResult":
            X = C.hookPermissionResult;       // Hook returned allow/deny
            break;
        case "hookUpdatedInput":
            M = C.updatedInput;               // Hook can modify input!
            break;
        case "preventContinuation":
            J = C.shouldPreventContinuation;  // Hook prevents continuation
            break;
        case "stop":
            return j;                          // Hook terminates directly
    }
}

// 4. Final permission decision
if (X?.behavior === "allow" && !H.requiresUserInteraction?.()) {
    // Hook says allow → but still check deny rules
    let C = await Ye6(H, M, $);               // Ye6() (checkDenyRules)
    if (C === null)
        v = X;                                 // deny rule not matched → allow
    else if (C.behavior === "deny")
        v = C;                                 // deny rule overrides → reject
    else
        v = await K(H, M, $, O, _);           // needs user confirmation
} else {
    v = await K(H, M, $, O, _);               // Hook did not allow → user confirm
}

// 5. Permission denied
if (v.behavior !== "allow") {
    return [/* rejection message */];
}
```

权限协商的优先级：

```
权限决策优先级 (从高到低)
    │
    ├── deny 规则 — 最高优先级,无法被覆盖
    │   (用户在 settings 中配置的拒绝规则)
    │
    ├── PreToolUse Hook 决策
    │   ├── behavior: "allow" → 允许 (但 deny 仍可覆盖)
    │   ├── behavior: "deny"  → 拒绝
    │   └── 无决策 → 继续
    │
    └── 用户确认 (canUseTool 回调)
        ├── 用户按 Y → 允许
        └── 用户按 N → 拒绝
```

> **设计决策**：deny 规则的优先级高于 Hook 的 allow 决策。这是一个重要的安全设计 — 即使一个有 bug 的 Hook 错误地允许了危险操作，deny 规则仍然能阻止它。deny 规则是"最后一道防线"。

### 工具不存在的处理

当 LLM 请求一个不存在的工具（可能是幻觉产生的工具名）时，CC 返回一个特殊的错误消息：

```javascript
// GnH() (executeSingleToolUse): tool-not-found handling
if (!O) {
    yield {
        message: d_({
            content: [{
                type: "tool_result",
                content: `<tool_use_error>Error: No such tool available: ${K}</tool_use_error>`,
                is_error: true,
                tool_use_id: H.id
            }]
        })
    };
    return;
}
```

注意这里使用了 `<tool_use_error>` XML 标签包裹错误信息 — 这让 LLM 能清楚地识别这是一个工具错误（而非工具的正常输出），并据此调整行为（比如换用正确的工具名）。

**小结**：单工具执行经过"Zod 验证 → 自定义验证 → Hook → 权限决策 → 执行 → Hook → 结果组装"的完整管线。权限协商采用"deny 规则 > Hook > 用户确认"的优先级，确保安全策略不可被覆盖。错误信息用 `<tool_use_error>` 标签标记，帮助 LLM 区分工具错误和正常输出。

---

## 8.5 工具结果回注 — Agent 闭环的关键

工具执行完成后，结果需要以正确的格式"回注"到对话历史中，让 LLM 在下一轮看到执行结果。这个回注过程不是简单的追加 — 它涉及消息构造、内容替换和压缩优化。

### tool_result 以 user 消息形式追加

Anthropic Messages API 要求 tool_result 以 `user` 角色的消息提交。CC 通过 `d_()` (buildToolResultMessage) 函数构造这个消息：

```javascript
// d_() (buildToolResultMessage): construct tool_result user message
{
    type: "user",                              // message type
    message: {
        role: "user",                          // API role
        content: [{
            type: "tool_result",
            tool_use_id: "toolu_01abc123",     // correlate with tool_use
            content: "execution result...",     // result content
            is_error: false                     // success or failure
        }]
    },
    isMeta: false,                             // not a meta message
    toolUseResult: "execution result...",      // quick reference for result
    sourceToolAssistantUUID: "uuid-xxx"        // link to assistant message UUID
}
```

注意 `d_()` (buildToolResultMessage) 返回的对象不仅包含 API 需要的 `message`，还包含 CC 内部使用的元数据：
- `toolUseResult`：用于 UI 展示和日志记录
- `sourceToolAssistantUUID`：关联到触发此工具的 assistant 消息，用于消息链追踪

### 回注在对话流中的位置

```
对话历史 (messages 数组)
    │
    ├── [user]     "帮我修复 bug"
    ├── [assistant] "我来看看代码..." + tool_use: Read("src/app.ts")
    ├── [user]     tool_result: "     1→import..." ← d_() 构造
    ├── [assistant] "找到问题了..." + tool_use: Edit(...)
    ├── [user]     tool_result: "Changes applied." ← d_() 构造
    ├── [assistant] "Bug 已修复,我来运行测试..."+ tool_use: Bash("npm test")
    ├── [user]     tool_result: "All tests passed." ← d_() 构造
    └── [assistant] "修复完成!改动如下..."
```

每一对 `[assistant] tool_use` + `[user] tool_result` 构成一个**工具调用回合**。LLM 在下一轮看到 tool_result 后，可以决定继续调用工具或输出最终答案。

### Content Replacement：旧 tool_result 内容替换

随着对话进行，工具结果会不断积累。一个长对话可能有几十个 tool_result，其中大多数已经"过时" — LLM 不再需要看第一次读的文件内容了。CC 通过 **Content Replacement** 机制压缩旧的 tool_result：

```
Content Replacement 流程
    │
    ├── 新的 tool_result 产生时
    │   ├── 检查同一文件的旧 tool_result
    │   └── 如果旧结果已过期（文件已被修改）
    │       └── 将旧 tool_result 的内容替换为摘要
    │           "File was read earlier in the conversation.
    │            The content has since been updated."
    │
    └── Auto-Compaction 时（第 6 章）
        └── 所有旧 tool_result 可能被进一步压缩
```

### Microcompact：压缩旧 tool_result 文本

除了 Content Replacement，CC 还有 **Microcompact** 机制 — 对超过一定长度的旧 tool_result 进行文本压缩，去除冗余信息，保留关键摘要：

```
Microcompact 策略
    │
    ├── 保留:
    │   ├── 错误信息（is_error: true 的结果）
    │   ├── 最近 N 轮的完整结果
    │   └── 文件 diff（Edit/Write 的修改记录）
    │
    └── 压缩:
        ├── 大段文件内容 → "File content (N lines)"
        ├── 长命令输出 → 保留最后几行
        └── 搜索结果 → 保留匹配统计
```

> **设计决策**：结果回注不是"一次性写入后不管" — CC 持续维护 tool_result 的时效性。旧结果被压缩或替换，确保 context window 不被过时信息占满。这与第 6 章的 Auto-Compaction 机制协同工作，共同管理对话的 token 预算。

**小结**：工具结果通过 `d_()` 以 user 消息形式回注到对话历史。Content Replacement 和 Microcompact 两种机制持续压缩旧结果，确保 context window 的高效利用。回注是 Agentic Loop 闭环的关键一环 — 没有它，LLM 就无法看到工具执行的结果，也就无法做出下一步决策。

---

## 8.6 工具并发安全模型

并发安全是工具调度的核心约束。一个设计良好的并发模型既能最大化执行效率（多个只读工具并行），又能保证数据一致性（写入工具串行执行）。

### isConcurrencySafe 属性的设计

每个工具通过 `isConcurrencySafe` 方法声明自己是否可以与其他工具并行执行：

```javascript
// Different tools' isConcurrencySafe implementations

// Read — read-only operation, always safe
isConcurrencySafe: () => true

// Edit — write operation, never safe
isConcurrencySafe: () => false

// Bash — dynamic judgment (based on input)
isConcurrencySafe: (input) => {
    // Read-only commands (e.g. ls, cat) may be marked safe
    // Write commands (e.g. rm, mv) are marked unsafe
    return isReadOnlyCommand(input.command);
}
```

关键设计点：`isConcurrencySafe` 接收**解析后的输入** (`parsedInput`)，而非原始输入。这允许工具根据具体的输入内容做动态判断：

```javascript
// uK1() (groupByConcurrencySafety): invocation pattern
let O = K?.inputSchema.safeParse($.input);    // parse first
let T = O?.success
    ? Boolean(K?.isConcurrencySafe(O.data))   // pass parsed data
    : false;                                   // parse failed → treat as unsafe
```

### 只读工具集 vs 写入工具集

CC 将工具明确分为两组：

```javascript
// Read-only tool set — can be executed in parallel
lK1 = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", ...])

// Write tool set — must be executed sequentially
QK1 = new Set(["Edit", "Write", "NotebookEdit"])
```

这两个集合在多个场景中被使用：
- **并发分组**（`uK1()`）：决定工具是否可并行
- **推测执行**（第 10 章 10.9 节）：只读工具可以在推测中安全执行
- **权限判断**：只读工具的权限要求通常更宽松

### 并发安全的工程含义

```
为什么 Read/Glob/Grep 可以并行?
    │
    ├── 它们不修改文件系统状态
    ├── 多个 Read 同时读同一文件 → 结果相同 (幂等)
    ├── Grep 搜索不影响文件内容
    └── 没有竞态条件风险

为什么 Write/Edit 必须串行?
    │
    ├── 两个 Edit 同时修改同一文件 → 后一个可能覆盖前一个
    ├── Edit A 删除第 10 行,Edit B 修改第 10 行 → 冲突
    ├── Write 完全覆盖文件 → 与任何其他写入冲突
    └── 即使修改不同文件,mtime 检测也可能产生误判

为什么 Bash 要动态判断?
    │
    ├── "ls -la" 是只读的 → 可以并行
    ├── "rm -rf /tmp" 有副作用 → 必须串行
    └── 只有解析命令后才能判断
```

> **设计决策**：并发安全性不是全局属性而是**实例级属性** — `isConcurrencySafe(parsedInput)` 接收解析后的输入，允许同一工具根据不同输入做出不同的并发决策。这比简单的"只读工具可并行"更精细，也更正确。例如一个假想的 `Database` 工具，SELECT 查询可以并行，INSERT 必须串行 — 动态判断完美适配这种场景。

**小结**：CC 的并发安全模型通过 `isConcurrencySafe` 属性和 `lK1`/`QK1` 集合实现。只读工具标记为并发安全可以并行执行，写入工具必须串行。动态判断（基于解析后的输入）提供了比静态分类更精细的控制。这个模型在保证数据一致性的前提下最大化了执行效率。

---

## 8.7 工具输入校验与错误处理

工具系统需要优雅地处理各种异常情况：LLM 传了错误的参数、LLM 幻觉出了不存在的工具、工具执行过程中出错。这一节梳理 CC 的错误处理策略。

### Zod Schema 验证

第一道防线是 Zod Schema — CC 使用 [Zod](https://zod.dev/) 库定义工具输入的类型约束，在执行前自动验证：

```javascript
// Mi1() (toolExecutionPipeline): Zod validation
let Y = H.inputSchema.safeParse(q);
if (!Y.success) {
    // Zod provides structured error messages
    // e.g.: "Expected string, received number at 'file_path'"
    return [{
        type: "tool_result",
        content: formatZodError(Y.error),
        is_error: true,
        tool_use_id: _
    }];
}
```

Zod 的 `safeParse` 不会抛出异常 — 它返回一个包含 `success` 和 `error` 的结果对象。这让错误处理更可控：

```
safeParse result
    ├── { success: true, data: parsedInput }
    │   → continue execution
    └── { success: false, error: ZodError }
        → return formatted error message
        → is_error: true flag
```

### validateInput 自定义验证

通过 Zod 后，输入还要经过工具特定的 `validateInput` 检查。每个工具可以实现自己的验证逻辑：

| 工具 | validateInput 检查内容 |
|------|----------------------|
| **Bash** | 直接返回 `{ result: true }`（权限检查在别处） |
| **Read** | 二进制文件检测、设备文件阻止、权限 deny 规则 |
| **Write** | 先读后写检查、并发修改检测、机密检测 |
| **Edit** | 9 步验证（机密、唯一性、权限、模糊匹配...） |

`validateInput` 返回值的含义：

```javascript
// validateInput return value structure
{
    result: true              // validation passed
}
// or
{
    result: false,            // validation failed
    message: "error desc",    // error message (sent to LLM)
    errorCode: 2              // error code (CC internal use)
}
```

### 错误返回格式

工具执行中的各种错误统一使用 `<tool_use_error>` XML 标签包裹：

```javascript
// 工具不存在
`<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`

// Zod 验证失败
`<tool_use_error>Error: ${zodErrorMessage}</tool_use_error>`

// validateInput 失败
// 直接返回 message 文本（不额外包装）

// 工具执行异常
`<tool_use_error>Error: Tool execution failed: ${error.message}</tool_use_error>`
```

`is_error` 标记告诉 LLM 这是一个错误结果（而非正常输出）：

```javascript
// 错误结果
{
    type: "tool_result",
    tool_use_id: "toolu_01x",
    content: "<tool_use_error>...</tool_use_error>",
    is_error: true                 // ← LLM 看到这个标记
}

// 正常结果
{
    type: "tool_result",
    tool_use_id: "toolu_01x",
    content: "文件内容...",
    is_error: false                // ← 或省略
}
```

LLM 看到 `is_error: true` 后，通常会尝试纠正错误（使用正确的参数重试、换用其他工具等），而不是将错误当作正常结果继续推理。

### 工具不存在的处理

LLM 有时会幻觉出不存在的工具名（比如 `CreateFile` 而非 `Write`，或者 `RunCommand` 而非 `Bash`）。CC 的处理策略是：

```javascript
// GnH() (executeSingleToolUse): tool-not-found handling
let O = B$($.options.tools, K);     // findToolByName
if (!O) {
    // Return error — tell LLM this tool does not exist
    yield {
        message: d_({
            content: [{
                type: "tool_result",
                content: `<tool_use_error>Error: No such tool available: ${K}</tool_use_error>`,
                is_error: true,
                tool_use_id: H.id
            }]
        })
    };
    return;
}
```

这比直接崩溃或忽略要好得多 — LLM 收到错误后可以查看可用工具列表并选择正确的工具。

> **设计决策**：CC 的错误处理遵循"将错误转化为 LLM 可理解的反馈"原则。不抛异常、不崩溃、不静默忽略 — 始终返回一个 `tool_result`（可能带 `is_error: true`），让 LLM 有机会自我纠正。这是 Agent 系统健壮性的关键 — 在一个多轮交互中，一次工具错误不应该终止整个任务。

**小结**：CC 的工具错误处理分三层：Zod Schema 验证类型约束、validateInput 验证业务逻辑、执行时异常捕获。所有错误统一以 `tool_result + is_error: true` 返回，`<tool_use_error>` 标签帮助 LLM 识别和纠正错误。

---

## 8.8 设计启示：可扩展工具系统的设计模式

从 Claude Code 工具系统的实现中，可以提炼出以下可迁移到自建 Agent 的设计模式：

### 1. 统一接口 + 能力声明 = 调度灵活性

```javascript
// Each tool declares its capabilities
{
    isConcurrencySafe: (input) => ...,   // can it run in parallel?
    isReadOnly: () => ...,                // is it read-only?
    requiresUserInteraction: () => ...,   // needs user interaction?
}
```

调度器不需要了解每个工具的内部实现，只需要查询这些声明性属性就能做出正确的调度决策。**新增一个工具时，只要正确实现接口声明，就能自动获得并发优化、权限检查等系统级能力。** 这是面向接口编程在 Agent 工具系统中的完美体现。

### 2. Hook 拦截点 = 非侵入式扩展

```
工具执行前 → PreToolUse Hook → 可以修改输入、拒绝执行
工具执行后 → PostToolUse Hook → 可以后处理、审计
```

Hook 机制让外部系统（CI/CD 脚本、企业安全策略、自定义审计）可以介入工具执行流程，而**不需要修改工具本身的代码**。这是 AOP（面向切面编程）思想在 Agent 系统中的应用。

### 3. Zod Schema = 类型安全的输入验证

使用 Zod（或类似的 schema 验证库）定义工具输入，获得：
- **自动验证**：`safeParse` 在执行前自动检查
- **类型推导**：TypeScript 类型自动从 schema 推导
- **文档生成**：schema 可直接转为 JSON Schema 传给 API
- **错误格式化**：Zod 的错误信息对 LLM 友好

### 4. 双 Schema = 内外分离

```javascript
// External Schema (visible to LLM)
inputSchema = internalSchema.omit({ _internalParam: true });
```

这个模式适用于任何需要"公开接口 ≠ 内部实现"的场景。LLM 看到的是干净的公共 API，系统内部可以通过隐藏参数实现额外功能。

### 5. 流式执行 = 减少延迟

```
Traditional: wait for full LLM response → start executing all tools
Streaming:   LLM streaming output → each tool_use completed → start immediately
```

`mH_` 流式执行器将工具执行与 LLM 生成并行化，减少了用户感知的延迟。这个"边接收边执行"的模式适用于任何"输入流式到达、各项可独立处理"的场景。

### 6. MCP = 开放式工具扩展

```
Built-in tools → determined at compile time, non-extensible
MCP tools     → registered at runtime, arbitrarily extensible
```

MCP（Model Context Protocol）协议让 Claude Code 的工具系统成为一个**开放平台**。任何人都可以通过实现 MCP 服务器来扩展 CC 的能力 — 连接数据库、调用企业 API、集成 IDE 功能。MCP 工具被包装为标准的 `toolDefinition` 对象，从调度器的视角与内置工具完全一致。

### 7. 错误即反馈 — 永远给 LLM 一条出路

工具系统的错误处理理念是：**永远返回一个 tool_result**，即使是错误。这让 LLM 始终有机会自我纠正，而不是在错误中"卡死"。在多轮 Agent 交互中，一次工具失败只是一次学习机会，不应该是一个终止条件。

---

## 速查表

### 内置工具一览表

| 工具名 | 类型 | 并发安全 | 只读 | 核心功能 |
|--------|------|----------|------|----------|
| Bash | 命令执行 | ❌ | ❌ | Shell 命令执行，最强大也最危险 |
| Read | 文件读取 | ✅ | ✅ | 多模态文件读取（文本/图片/PDF/Notebook） |
| Write | 文件写入 | ❌ | ❌ | 创建或覆盖文件（先读后写保护） |
| Edit | 文件编辑 | ❌ | ❌ | 精确字符串替换（9 步验证） |
| Glob | 文件搜索 | ✅ | ✅ | 文件名模式搜索（基于 ripgrep） |
| Grep | 内容搜索 | ✅ | ✅ | 文件内容正则搜索（基于 ripgrep） |
| NotebookEdit | Notebook 编辑 | ❌ | ❌ | Jupyter Notebook 单元格编辑 |
| Agent | 子 Agent | ❌ | ❌ | 启动子 Agent 处理复杂子任务 |
| EnterWorktree | Worktree 管理 | ❌ | ❌ | 创建隔离的 git worktree 工作区 |
| ExitWorktree | Worktree 管理 | ❌ | ❌ | 退出并可选删除 worktree |
| EnterPlanMode | 规划模式 | ❌ | ❌ | 进入规划模式（只思考不执行） |
| ExitPlanMode | 规划模式 | ❌ | ❌ | 退出规划模式 |
| WebFetch | 网络读取 | ✅ | ✅ | 抓取 URL 内容并用 LLM 处理 |
| WebSearch | 网络搜索 | ✅ | ✅ | 网络搜索获取实时信息 |
| MCP 工具 | 外部扩展 | 视定义 | 视定义 | MCP 服务器提供的任意能力 |

### 关键函数索引

| 混淆名 | 推测英文名 | 文件:行号 | 功能描述 |
|--------|-----------|----------|---------|
| `xh_()` | dispatchToolUseBlocks | `11_api_streaming.js:15392` | 工具分发入口：接收 tool_use blocks → 分组 → 调度并行/串行执行 |
| `uK1()` | groupByConcurrencySafety | `11_api_streaming.js:15433` | 将连续的并发安全工具合并为一组，非安全工具独立成组 |
| `mK1()` | executeToolsConcurrently | `11_api_streaming.js:~15460` | 并行执行器：Promise.all 同时启动一组并发安全工具 |
| `xK1()` | executeToolsSequentially | `11_api_streaming.js:~15480` | 串行执行器：逐个执行非并发安全工具，等上一个完成 |
| `GnH()` | executeSingleToolUse | `14_html_parser.js:24498` | 单工具执行入口：查找定义 → 检查中止 → 调用 Mi1() |
| `Mi1()` | toolExecutionPipeline | `14_html_parser.js:24636` | 完整执行管线：Zod → validateInput → Hook → 权限 → call → Hook → 结果 |
| `Di1()` | toolExecutionWrapper | `14_html_parser.js:~24600` | Mi1() 的包装层，添加计时和错误捕获 |
| `B$()` | findToolByName | 工具注册模块 | 在工具列表中按 name 字段查找对应的 toolDefinition |
| `d_()` | buildToolResultMessage | 消息构造模块 | 构造 tool_result user 消息（含 toolUseResult 和 sourceToolAssistantUUID） |
| `mH_` (类) | StreamingToolExecutor | `14_html_parser.js:25202` | 流式工具执行器：LLM 边生成边执行已完成的 tool_use block |
| `r49()` | runPreToolUseHooks | Hook 模块 | 执行 PreToolUse Hook：可修改输入、允许/拒绝、阻止后续 |
| `Ye6()` | checkDenyRules | 权限模块 | 检查 deny 规则是否覆盖 Hook 的 allow 决策 |
| `lK1` | readOnlyToolSet | 工具注册模块 | 只读工具集合（Read/Glob/Grep/WebFetch/WebSearch），用于并发安全判断 |
| `QK1` | writeToolSet | 工具注册模块 | 写入工具集合（Edit/Write/NotebookEdit），必须串行执行 |

### 关键常量

| 常量 | 推测英文名 | 值 | 含义 |
|------|-----------|-----|------|
| `lK1` | readOnlyToolSet | `Set(["Read", "Glob", "Grep", ...])` | 只读工具集（并发安全，可并行执行） |
| `QK1` | writeToolSet | `Set(["Edit", "Write", "NotebookEdit"])` | 写入工具集（必须串行执行） |

### 工具执行生命周期速查

```
tool_use block
    │
    ├── 1. B$()        查找工具定义
    ├── 2. safeParse() Zod Schema 验证输入
    ├── 3. validateInput() 自定义业务验证
    ├── 4. PreToolUse Hook  外部拦截点
    ├── 5. 权限决策    deny > Hook > 用户确认
    ├── 6. call()      实际执行（async generator）
    ├── 7. PostToolUse Hook 后处理
    └── 8. d_()        组装 tool_result → 回注对话
```

### 并发调度决策速查

```
连续 tool_use blocks 分组规则：
    ├── 连续的并发安全工具 → 合并为一组,mK1() 并行执行
    ├── 非并发安全工具    → 独立一组,xK1() 串行执行
    └── 组间严格按顺序执行（保证因果关系）

流式调度 (mH_) 规则：
    ├── 无工具执行中      → 任何工具可立即执行
    ├── 并发安全工具执行中 + 新工具也并发安全 → 并行执行
    ├── 并发安全工具执行中 + 新工具非并发安全 → 等待
    └── 非并发安全工具执行中 → 所有新工具等待
```

---

## 附录：Anthropic tool_use 协议 vs OpenAI function calling 协议

> **官方文档参考**
>
> - Anthropic Tool Use 指南：https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
> - Anthropic Messages API 参考：https://platform.claude.com/docs/en/api/python/messages
> - OpenAI Function Calling 指南：https://developers.openai.com/docs/guides/function-calling
> - OpenAI Chat Completions API 参考：https://developers.openai.com/docs/api-reference/chat/create

Claude Code 的工具系统建立在 Anthropic Messages API 的 tool_use 协议之上。这个协议与 OpenAI 的 function calling 协议**不兼容** — 两者虽然目标相同（让 LLM 调用外部工具），但协议格式、消息结构、交互模式都有本质差异。理解这些差异有助于理解 CC 工具系统的设计选择，也为构建跨模型 Agent 框架提供参考。

### 协议格式对比

#### 1. 工具注册

```javascript
// ── Anthropic Messages API ──
{
  tools: [{
    name: "Bash",
    description: "Execute a bash command...",
    input_schema: {                    // ← input_schema
      type: "object",
      properties: {
        command: { type: "string" }
      },
      required: ["command"]
    }
  }]
}

// ── OpenAI Chat Completions API ──
{
  tools: [{
    type: "function",                  // ← 多一层 type 字段
    function: {                        // ← 多一层 function 嵌套
      name: "Bash",
      description: "Execute a bash command...",
      parameters: {                    // ← 叫 parameters，不是 input_schema
        type: "object",
        properties: {
          command: { type: "string" }
        },
        required: ["command"]
      }
    }
  }]
}
```

#### 2. LLM 返回工具调用

```javascript
// ── Anthropic：tool_use 是 content block，与 text/thinking 并列 ──
{
  role: "assistant",
  content: [
    { type: "thinking", thinking: "让我分析一下..." },        // 思考
    { type: "text", text: "我来帮你检查文件结构。" },           // 文字
    { type: "tool_use", id: "toolu_abc", name: "Bash",        // 工具调用
      input: { command: "ls -la" }                             // ← 已解析的对象
    },
    { type: "tool_use", id: "toolu_def", name: "Read",        // 又一个工具调用
      input: { file_path: "/src/app.ts" }
    }
  ]
}

// ── OpenAI：tool_calls 是独立字段，与 content 分离 ──
{
  role: "assistant",
  content: "我来帮你检查文件结构。",                            // text 在 content 里
  tool_calls: [                                                // ← 独立字段
    { id: "call_abc", type: "function",
      function: { name: "Bash",
        arguments: "{\"command\": \"ls -la\"}"                  // ← JSON 字符串！
      }
    },
    { id: "call_def", type: "function",
      function: { name: "Read",
        arguments: "{\"file_path\": \"/src/app.ts\"}"           // ← 需要 JSON.parse
      }
    }
  ]
}
```

#### 3. 返回工具结果

```javascript
// ── Anthropic：结果以 user 消息中的 tool_result content block 形式返回 ──
{
  role: "user",                        // ← user 角色
  content: [{
    type: "tool_result",               // ← content block 类型
    tool_use_id: "toolu_abc",
    content: [                         // ← 支持富内容（文本 + 图片 + 多 block）
      { type: "text", text: "file1.txt\nfile2.txt" },
      { type: "image", source: { type: "base64", data: "..." } }
    ],
    is_error: false                    // ← 原生错误标记
  }]
}

// ── OpenAI：结果以独立的 tool 角色消息形式返回 ──
{
  role: "tool",                        // ← 专用 tool 角色
  tool_call_id: "call_abc",
  content: "file1.txt\nfile2.txt"      // ← 纯字符串，不支持图片
}
```

### 关键差异总结

| 维度 | Anthropic tool_use | OpenAI function calling |
|------|-------------------|------------------------|
| **工具调用位置** | `content` 数组内的 block（与 text/thinking 并列） | 独立的 `tool_calls` 字段 |
| **工具输入格式** | **已解析的 JSON 对象** | **JSON 字符串**（需客户端 `JSON.parse`） |
| **结果消息角色** | `role: "user"`（tool_result 是 content block） | `role: "tool"`（专用角色） |
| **结果内容** | 支持富内容（text + image + 多 block） | 纯字符串 |
| **错误标记** | `is_error: true/false` 原生字段 | 无原生支持，需自行在 content 中标记 |
| **Schema 字段名** | `input_schema` | `parameters`（嵌套在 `function` 下） |
| **流式增量** | `content_block_delta` + `input_json_delta` | `tool_calls[].function.arguments` delta |

### 设计差异对 CC 的影响

**1. Content Block 统一模型 → 简化流式处理**

Anthropic 把 text、thinking、tool_use 都统一为 content block，CC 的 SSE 流处理器 `Ly9()` 用一个 `switch` 语句统一处理所有 block 类型，不需要为工具调用写单独的解析路径。

```javascript
// CC's stream processing (simplified) — one logic for three content types
switch (event.content_block.type) {
    case "text":     block.text += delta.text;           break;
    case "thinking": block.thinking += delta.thinking;   break;
    case "tool_use": block.input += delta.partial_json;  break;
    // ↑ All three types handled uniformly: content_block_start → delta accumulation → stop
}
```

如果用 OpenAI 协议，text 在 `content` delta 里，tool call 在 `tool_calls` delta 里，需要两套解析逻辑。

**2. 已解析对象 → 直接 Zod 验证**

```javascript
// Anthropic: input is already an object, pass directly to Zod
let result = inputSchema.safeParse(block.input);  // validate directly

// OpenAI: arguments is a string, needs parsing first
let parsed;
try { parsed = JSON.parse(toolCall.function.arguments); }
catch (e) { /* JSON parse failure error handling */ }
let result = inputSchema.safeParse(parsed);       // one extra step
```

CC 的 `Mi1()` 执行管线能直接 `inputSchema.safeParse(input)` 正是因为 Anthropic API 返回的是已解析对象。

**3. 富内容 tool_result → 多模态工具返回**

CC 利用 Anthropic 协议的富内容支持实现了多模态工具返回：

- **Read 工具**：读取图片文件时返回 `image` content block，Claude 直接"看到"图片
- **Bash 工具**：`boH()` 后处理函数检测 stdout 中的 base64 图片数据（如截图工具的输出），提取为 image block

这在 OpenAI 协议中无法原生实现（tool 角色的 content 只支持字符串）。

### 行业生态现状

OpenAI 的 function calling 协议凭借先发优势（2023 年 6 月）在开源生态中获得了广泛采纳——vLLM、Ollama 等推理引擎、开源模型的 tool calling 微调大多以 OpenAI 格式为默认。但头部商业 API 已经形成多协议并存的格局：

```
头部商业 API：各有协议，无统一标准
├── OpenAI     → tool_calls 字段 + function.arguments 字符串
├── Anthropic  → content block 模型 + 已解析 input 对象
├── Google     → Part/FunctionCall 格式
└── Mistral    → 类 OpenAI 但语义有差异

开源/推理引擎：OpenAI 格式仍是惯性"方言"
├── vLLM、TGI  → 默认提供 OpenAI 兼容 endpoint
└── Ollama     → OpenAI 兼容 API

框架层：已抽象为统一内部表示
├── LangChain  → BaseTool / ToolMessage 统一接口
├── LiteLLM    → OpenAI 格式输入 → 自动转换到各家 API
└── Vercel AI  → 统一的 tool 抽象
```

> **设计启示**：CC 选择直接使用 Anthropic 原生协议而非兼容 OpenAI 格式，是因为它只需要支持 Claude 模型。如果你在构建跨模型 Agent 框架，务实的策略是：**内部定义统一的工具调用表示（工具名 + 结构化输入 + 结构化输出），然后为每个 LLM 提供商写一个薄适配层**。核心差异点只有三个：Schema 字段名映射、input 的 JSON 解析、result 的角色和内容格式。但**流式传输的差异**（content_block_delta vs function.arguments delta）是最难统一的部分，需要特别注意。

> **MCP 的角色**：值得注意的是，MCP（Model Context Protocol）正在从另一个角度推动标准化——它定义了工具的**注册、发现和执行**标准（JSON Schema + JSON-RPC），但**不规定 LLM 如何在消息中表达 tool_use**。CC 正是这么做的：通过 MCP 与外部工具交互，但 LLM 调用侧完全用 Anthropic 原生协议。MCP 工具被转换为 `mcp__server__tool` 格式注册到 `tools` 参数中，对 Claude 来说和内置工具没有区别。
