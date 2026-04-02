
# 第 9 章：工具系统总论 — Agent 的执行臂

> **核心问题**：LLM 只能生成文本，如何让它"动手"操作真实世界？一个可扩展、安全、高性能的工具系统需要什么样的架构？

LLM 本质上是一个文本到文本的函数 — 输入 tokens，输出 tokens。它不能读文件、不能执行命令、不能搜索代码、不能调用 API。**工具系统是连接 LLM 思维与真实世界的桥梁**，也是 Agent 架构中 Agentic Loop 的"执行臂"。

Claude Code 构建了一套精巧的工具系统：统一的 `Tool` 接口定义、智能的并发安全调度、分层权限控制、Hook 拦截点、以及通过 MCP 协议实现的开放式扩展。本章作为"第三篇 · 工具与能力"的开篇总论，将从源码层面完整解析这套系统的架构设计。

---

## 9.1 工具在 Agent 架构中的角色

### 从文本生成到现实操作

一个只能生成文本的 LLM，面对"帮我修复这个 bug"的请求，只能输出一段建议文字。而一个拥有工具的 Agent，可以：

```
纯 LLM                              Agent + 工具
├── "你可以试试修改第 42 行..."      ├── Read("src/app.ts")     → 看到代码
├── "建议使用 forEach 替代..."       ├── Grep("bug pattern")    → 定位问题
└── "希望这对你有帮助!"              ├── Edit("src/app.ts", ...)→ 修复 bug
                                     ├── Bash("npm test")       → 验证修复
                                     └── "Bug 已修复，测试通过。"
```

### Agentic Loop 中的工具调度

Claude Code 使用 Anthropic Messages API 的工具调用协议。LLM 在响应中生成 `tool_use` 块，Agentic Loop 捕获并分发给工具系统执行：

```
                    Agentic Loop
                    ┌──────────────────┐
                    │  LLM 生成响应     │
                    │  (可能包含        │
                    │   tool_use 块)    │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
            ┌───── │  有 tool_use?     │ ─────┐
            │      └──────────────────┘       │
            │ 是                              │ 否
    ┌───────▼────────┐               ┌────────▼───────┐
    │  工具系统        │               │  输出最终响应    │
    │                 │               │  循环结束       │
    │  validateInput  │               └────────────────┘
    │  → permissions  │
    │  → call         │
    │  → result       │
    └───────┬────────┘
            │ tool_result
    ┌───────▼────────┐
    │  追加到对话      │
    │  继续下一轮      │ ──→ 回到 LLM
    └────────────────┘
```

---

## 9.2 Tool 接口：统一的工具契约

### Tool 类型定义

所有工具都遵循同一个 TypeScript 接口，定义在 `src/Tool.ts` 中。这是 Claude Code 工具系统的核心契约：

```typescript
// src/Tool.ts — 核心 Tool 类型（简化版）
export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  readonly name: string
  aliases?: string[]
  searchHint?: string
  maxResultSizeChars: number

  // 核心方法
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>
  prompt(options): Promise<string>
  description(input, options): Promise<string>

  // Schema 定义
  readonly inputSchema: Input
  outputSchema?: z.ZodType<unknown>

  // 安全与调度
  isConcurrencySafe(input): boolean
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  isEnabled(): boolean
  checkPermissions(input, context): Promise<PermissionResult>
  validateInput?(input, context): Promise<ValidationResult>

  // UI 渲染
  renderToolUseMessage(input, options): React.ReactNode
  renderToolResultMessage?(content, progress, options): React.ReactNode
  mapToolResultToToolResultBlockParam(content, toolUseID): ToolResultBlockParam
  userFacingName(input): string

  // ...更多可选方法
}
```

这个接口的设计体现了几个关键原则：

| 属性/方法 | 用途 | 设计意图 |
|-----------|------|----------|
| `inputSchema` / `outputSchema` | Zod schema 定义输入输出 | 类型安全 + API schema 生成 |
| `isConcurrencySafe()` | 是否可以并行执行 | 并发调度的安全判断 |
| `isReadOnly()` | 是否只读操作 | 权限快速通道 |
| `checkPermissions()` | 工具特定的权限检查 | 分层安全控制 |
| `validateInput()` | 输入合法性验证 | 执行前拦截 |
| `maxResultSizeChars` | 结果大小上限 | 防止 context 爆炸 |

> **设计决策**：为什么用 Zod 而不是 JSON Schema？Zod 提供了运行时类型验证 + TypeScript 类型推断的双重能力。`inputSchema` 既用于生成发送给 API 的 JSON Schema（`z.infer<Input>`），又用于运行时验证工具输入。一个 schema 服务两个目的。

### buildTool：工具构建器

Claude Code 没有让每个工具直接实现完整的 `Tool` 接口，而是提供了 `buildTool()` 函数，它填充安全的默认值：

```typescript
// src/Tool.ts
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,   // 假设不安全
  isReadOnly: (_input?: unknown) => false,           // 假设有写入
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (input) =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}
```

> **设计决策**：默认值采用 fail-closed 策略 —— `isConcurrencySafe` 默认 `false`（假设并发不安全），`isReadOnly` 默认 `false`（假设有写操作）。这意味着新工具如果忘记设置这些属性，系统会自动采取最保守的行为。

### ToolDef：简化的工具定义

`ToolDef` 类型让工具作者只需定义必要的方法，其余由 `buildTool` 补全：

```typescript
export type ToolDef<Input, Output, P> =
  Omit<Tool<Input, Output, P>, DefaultableToolKeys> &
  Partial<Pick<Tool<Input, Output, P>, DefaultableToolKeys>>
```

这样每个工具文件只需要 `export const XxxTool = buildTool({ ... })` 即可。

---

## 9.3 工具注册与发现

### 工具注册中心：tools.ts

所有工具的注册集中在 `src/tools.ts` 文件中。`getAllBaseTools()` 是所有内置工具的唯一注册表：

```typescript
// src/tools.ts — 工具注册（简化）
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    // 条件性工具...
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
    // ...
  ]
}
```

注册机制的几个关键特点：

**1. 条件注册**：许多工具根据环境变量或 feature flag 有条件地加入：

```
工具                      条件
────────────────────────────────────────────
GlobTool / GrepTool      !hasEmbeddedSearchTools()
EnterWorktreeTool        isWorktreeModeEnabled()
ToolSearchTool           isToolSearchEnabledOptimistic()
PowerShellTool           isPowerShellToolEnabled()
ConfigTool               USER_TYPE === 'ant'
REPLTool                 USER_TYPE === 'ant'
```

**2. Dead Code Elimination（DCE）**：利用 Bun 的 `feature()` 函数实现编译时条件判断，不满足条件的工具代码在构建时就被移除：

```typescript
const SleepTool =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./tools/SleepTool/SleepTool.js').SleepTool
    : null
```

**3. 懒加载**：部分工具使用 `require()` 懒加载以打破循环依赖：

```typescript
const getTeamCreateTool = () =>
  require('./tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool
```

### 工具过滤流水线

从注册表到最终提供给 LLM 的工具列表，经过了多层过滤：

```
getAllBaseTools()           ← 全量注册
    │
    ▼
filterToolsByDenyRules()   ← 权限 deny 规则过滤
    │
    ▼
isEnabled() 检查            ← 运行时启用检查
    │
    ▼
REPL_ONLY_TOOLS 过滤        ← REPL 模式下隐藏原始工具
    │
    ▼
assembleToolPool()         ← 合并 MCP 工具
    │
    ▼
getTools() / getMergedTools()  ← 最终工具列表
```

`assembleToolPool()` 是合并内置工具和 MCP 工具的统一入口：

```typescript
// src/tools.ts
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // 排序以保证 prompt cache 稳定性
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',  // 内置工具优先于同名 MCP 工具
  )
}
```

> **设计决策**：内置工具和 MCP 工具分别排序后合并，内置工具作为前缀。这是为了保证 Anthropic API 的 prompt cache 稳定性 — cache breakpoint 在最后一个内置工具之后。如果将所有工具混合排序，每次 MCP 工具变化都会导致内置工具的 cache key 失效。

### ToolSearch：延迟加载机制

当工具数量过多（例如接入了大量 MCP 工具）时，Claude Code 使用 `ToolSearchTool` 实现延迟加载：

```typescript
// src/tools/ToolSearchTool/ToolSearchTool.ts
export const ToolSearchTool = buildTool({
  name: TOOL_SEARCH_TOOL_NAME,
  // ...
  async call(input, context) {
    // 使用 "select:<tool_name>" 直接选择，或关键词搜索
    const deferredTools = context.options.tools.filter(isDeferredTool)
    // 匹配 searchHint 和 name 进行搜索
    // ...
  }
})
```

工具可以通过 `shouldDefer: true` 声明自己可以延迟加载，而 `alwaysLoad: true` 则强制始终加载。每个工具的 `searchHint` 属性提供搜索关键词：

```typescript
// 示例：各工具的 searchHint
EnterWorktreeTool:   searchHint: 'create an isolated git worktree and switch into it'
FileEditTool:        searchHint: 'modify file contents in place'
GlobTool:            searchHint: 'find files by name pattern or wildcard'
GrepTool:            searchHint: 'search file contents with regex'
```

---

## 9.4 工具分类体系

### 只读 vs 写入 vs 破坏性

Claude Code 的工具分为三个安全级别：

```
                          安全级别
                ┌──────────────────────────┐
                │                          │
        ┌───────▼──────┐  ┌───────▼──────┐  ┌────────▼──────┐
        │  只读工具      │  │  写入工具     │  │  破坏性工具    │
        │  isReadOnly   │  │  !isReadOnly  │  │  isDestructive │
        │  = true       │  │              │  │  = true        │
        ├──────────────┤  ├──────────────┤  ├───────────────┤
        │ Read         │  │ Edit         │  │ rm -rf        │
        │ Glob         │  │ Write        │  │ git push -f   │
        │ Grep         │  │ Bash (写入)  │  │ 文件覆盖       │
        │ WebSearch    │  │ NotebookEdit │  │               │
        │ Bash (只读)  │  │              │  │               │
        └──────────────┘  └──────────────┘  └───────────────┘
             │                  │                   │
        无需权限确认         需要权限确认          额外警告
```

Bash 工具的 `isReadOnly` 是动态判断的 — 取决于具体命令：

```typescript
// BashTool.tsx 中的 isReadOnly 判断
isReadOnly(input) {
  // 只读命令（如 ls, cat, grep）返回 true
  // 写入命令（如 rm, mv, sed -i）返回 false
  return checkReadOnlyConstraints(input)
}
```

### 并发安全分类

`isConcurrencySafe` 属性决定了工具能否与其他工具并行执行：

```
并发安全的工具（可并行）        非并发安全的工具（串行）
─────────────────────         ─────────────────────
Read (isConcurrencySafe=true) Bash (isConcurrencySafe=false)
Glob (isConcurrencySafe=true) Edit (isConcurrencySafe=false)
Grep (isConcurrencySafe=true) Write (isConcurrencySafe=false)
WebSearch                     NotebookEdit
WebFetch                      Agent
```

> **设计决策**：文件写入工具（Edit/Write）标记为并发不安全，因为两个并发的文件编辑可能产生竞态条件。`buildTool` 的默认值 `isConcurrencySafe: false` 确保了新工具默认串行执行。

### Agent 子环境中的工具限制

子 Agent 和不同模式下可用的工具不同：

```typescript
// src/constants/tools.ts

// 所有 Agent 禁止的工具
export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  TASK_OUTPUT_TOOL_NAME,       // 防止递归
  EXIT_PLAN_MODE_V2_TOOL_NAME, // Plan 模式是主线程概念
  ENTER_PLAN_MODE_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME, // 子 Agent 不能直接问用户
  TASK_STOP_TOOL_NAME,
])

// Coordinator 模式仅允许调度工具
export const COORDINATOR_MODE_ALLOWED_TOOLS = new Set([
  AGENT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])

// 异步 Agent 允许的工具
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  // ...更多只读和文件操作工具
])
```

---

## 9.5 权限模型：多层防护

### 权限检查流水线

每个工具调用在执行前会经过多层权限检查：

```
tool_use 请求
    │
    ▼
┌──────────────────┐
│ 1. validateInput │  ← 工具内部输入验证
│    (if defined)  │     例：file_path 是否绝对路径
└────────┬─────────┘
         │ pass
         ▼
┌──────────────────┐
│ 2. deny rules    │  ← 全局拒绝规则
│    (permission   │     例：Bash(rm:*)
│     context)     │
└────────┬─────────┘
         │ not denied
         ▼
┌──────────────────┐
│ 3. allow rules   │  ← 自动允许规则
│    (always allow) │     例：Read(**)
└────────┬─────────┘
         │ not auto-allowed
         ▼
┌──────────────────┐
│ 4. tool-specific │  ← 工具特定权限
│    checkPerms    │     例：bashToolHasPermission
└────────┬─────────┘
         │ behavior = 'ask'
         ▼
┌──────────────────┐
│ 5. user prompt   │  ← 用户确认
│    (interactive) │     "允许执行 rm -rf /tmp/old？"
└────────┬─────────┘
         │ approved
         ▼
    执行 tool.call()
```

### ToolPermissionContext

权限上下文 `ToolPermissionContext` 携带了完整的权限配置：

```typescript
// src/Tool.ts
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode               // 'default' | 'plan' | 'bypassPermissions'
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource  // 自动允许
  alwaysDenyRules: ToolPermissionRulesBySource   // 永远拒绝
  alwaysAskRules: ToolPermissionRulesBySource    // 总是询问
  isBypassPermissionsModeAvailable: boolean
  shouldAvoidPermissionPrompts?: boolean  // 后台 Agent 禁止弹窗
}>
```

### 工具特定的权限检查

每个工具可以实现自己的 `checkPermissions` 方法。例如文件操作工具使用 `checkWritePermissionForTool` / `checkReadPermissionForTool`：

```typescript
// FileEditTool.ts
async checkPermissions(input, context): Promise<PermissionDecision> {
  const appState = context.getAppState()
  return checkWritePermissionForTool(
    FileEditTool,
    input,
    appState.toolPermissionContext,
  )
}
```

而 Bash 工具有最复杂的权限逻辑（`bashToolHasPermission`），涉及命令解析、路径验证、安全检查等多个步骤（详见第 10 章）。

### preparePermissionMatcher

工具可以实现 `preparePermissionMatcher` 方法，为 Hook 的 `if` 条件提供匹配逻辑：

```typescript
// FileEditTool.ts
async preparePermissionMatcher({ file_path }) {
  return pattern => matchWildcardPattern(pattern, file_path)
}
```

这允许用户在配置中写类似 `Edit(src/**/*.ts)` 的权限规则。

---

## 9.6 工具执行生命周期

### 从 tool_use 到 tool_result

一个完整的工具执行流程：

```
┌─────────────────────────────────────────────────────┐
│                    工具执行生命周期                    │
├─────────────────────────────────────────────────────┤
│                                                     │
│  1. 解析 tool_use 块                                │
│     ├── tool name → findToolByName()                │
│     └── tool input → z.parse(inputSchema)           │
│                                                     │
│  2. backfillObservableInput()                       │
│     └── 路径展开、遗留字段填充                        │
│                                                     │
│  3. PreToolUse Hook                                 │
│     └── 外部脚本可以 approve/reject/modify           │
│                                                     │
│  4. validateInput()                                 │
│     └── 工具内部校验                                  │
│                                                     │
│  5. 权限检查                                         │
│     ├── deny rules → reject                         │
│     ├── allow rules → pass                          │
│     ├── checkPermissions() → ask/allow/deny          │
│     └── user prompt (if needed)                     │
│                                                     │
│  6. tool.call()                                     │
│     ├── 实际执行操作                                  │
│     ├── onProgress → 进度回调                        │
│     └── 返回 ToolResult<Output>                     │
│                                                     │
│  7. PostToolUse Hook                                │
│     └── 外部脚本可以 reject 结果                      │
│                                                     │
│  8. mapToolResultToToolResultBlockParam()            │
│     └── 转换为 API 格式                              │
│                                                     │
│  9. 结果可能被持久化到磁盘                             │
│     └── 超过 maxResultSizeChars 时                   │
│                                                     │
│  10. 追加 tool_result 到对话                          │
│      └── 继续下一轮 Agentic Loop                     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### ToolResult 结构

工具执行后返回 `ToolResult<T>`：

```typescript
export type ToolResult<T> = {
  data: T                           // 工具输出数据
  newMessages?: (UserMessage | ...)[] // 附加消息（如 CLAUDE.md 注入）
  contextModifier?: (context) => context  // 上下文修改器
  mcpMeta?: {                        // MCP 协议元数据
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}
```

`contextModifier` 是一个强大的机制 — 工具可以修改后续执行的上下文。但只有非并发安全的工具（`isConcurrencySafe = false`）的 `contextModifier` 会被执行，避免并发修改。

### 大结果持久化

当工具输出超过 `maxResultSizeChars` 时，结果会被保存到磁盘，LLM 只看到预览：

```typescript
// 各工具的 maxResultSizeChars 设置
FileEditTool:      100_000
GlobTool:          100_000
GrepTool:          100_000
FileReadTool:      Infinity   // Read 永不持久化（会造成循环读取）
MCPTool:           100_000
```

> **设计决策**：`FileReadTool` 的 `maxResultSizeChars` 设为 `Infinity`。如果 Read 的结果被持久化到文件，LLM 收到"结果已保存到 /tmp/xxx"后会尝试 Read 那个文件，形成无限循环。Read 工具通过自己的 `limits` 系统控制输出大小。

---

## 9.7 工具全景图

### 内置工具清单

| 工具 | 文件位置 | 只读 | 并发安全 | 用途 |
|------|---------|------|---------|------|
| `Bash` | `tools/BashTool/BashTool.tsx` | 动态 | ✗ | 执行 shell 命令 |
| `Read` | `tools/FileReadTool/FileReadTool.ts` | ✓ | ✓ | 读取文件内容 |
| `Edit` | `tools/FileEditTool/FileEditTool.ts` | ✗ | ✗ | 字符串替换编辑 |
| `Write` | `tools/FileWriteTool/FileWriteTool.ts` | ✗ | ✗ | 写入/创建文件 |
| `Glob` | `tools/GlobTool/GlobTool.ts` | ✓ | ✓ | 文件名模式搜索 |
| `Grep` | `tools/GrepTool/GrepTool.ts` | ✓ | ✓ | 文件内容搜索 |
| `NotebookEdit` | `tools/NotebookEditTool/NotebookEditTool.ts` | ✗ | ✗ | Jupyter notebook 编辑 |
| `WebFetch` | `tools/WebFetchTool/WebFetchTool.ts` | ✓ | ✓ | URL 内容抓取 |
| `WebSearch` | `tools/WebSearchTool/WebSearchTool.ts` | ✓ | ✓ | 网络搜索 |
| `Agent` | `tools/AgentTool/AgentTool.ts` | ✗ | ✗ | 创建子 Agent |
| `EnterWorktree` | `tools/EnterWorktreeTool/EnterWorktreeTool.ts` | ✗ | ✗ | 创建 git worktree |
| `ExitWorktree` | `tools/ExitWorktreeTool/ExitWorktreeTool.ts` | ✗ | ✗ | 退出 worktree |
| `ToolSearch` | `tools/ToolSearchTool/ToolSearchTool.ts` | ✓ | ✓ | 搜索延迟加载的工具 |
| `TodoWrite` | `tools/TodoWriteTool/TodoWriteTool.ts` | ✗ | ✗ | 任务清单管理 |
| `Skill` | `tools/SkillTool/SkillTool.ts` | ✗ | ✗ | 调用预定义技能 |

### 工具目录结构

每个工具遵循统一的目录结构：

```
tools/
├── BashTool/
│   ├── BashTool.tsx         ← 主工具定义 + call 实现
│   ├── prompt.ts            ← system prompt 文本生成
│   ├── toolName.ts          ← 常量 BASH_TOOL_NAME
│   ├── bashPermissions.ts   ← 权限检查逻辑
│   ├── bashSecurity.ts      ← 安全验证
│   ├── commandSemantics.ts  ← 退出码语义
│   ├── readOnlyValidation.ts ← 只读命令判断
│   ├── shouldUseSandbox.ts  ← 沙箱决策
│   ├── utils.ts             ← 工具函数
│   └── UI.tsx               ← React 渲染组件
├── FileEditTool/
│   ├── FileEditTool.ts
│   ├── prompt.ts
│   ├── constants.ts
│   ├── types.ts             ← inputSchema/outputSchema
│   ├── utils.ts             ← findActualString 等
│   └── UI.tsx
├── shared/                  ← 跨工具共享代码
│   └── gitOperationTracking.ts
└── utils.ts                 ← 全局工具工具函数
```

---

## 9.8 Prompt 系统：教会 LLM 使用工具

### 工具的 System Prompt

每个工具通过 `prompt()` 方法生成提供给 LLM 的使用说明。这些说明会被包含在 system prompt 中，指导 LLM 正确使用工具。

以 Bash 工具为例，其 `prompt` 包含数千字的详细指令：

```typescript
// src/tools/BashTool/prompt.ts
export function getSimplePrompt(): string {
  return [
    'Executes a given bash command and returns its output.',
    '',
    "The working directory persists between commands, ...",
    '',
    'IMPORTANT: Avoid using this tool to run `find`, `grep`, ...',
    // ... 工具偏好指令
    '# Instructions',
    // ... 详细使用说明
    getSimpleSandboxSection(),  // 沙箱配置
    getCommitAndPRInstructions(),  // Git 操作指令
  ].join('\n')
}
```

Prompt 中的关键内容包括：
- **工具偏好引导**：引导 LLM 使用专用工具而非 Bash（如 `Use Glob (NOT find)`）
- **超时配置**：默认和最大超时时间
- **沙箱限制**：文件系统和网络访问规则
- **Git 操作规范**：commit、PR 的详细流程

### Dynamic Prompt

工具的 prompt 不是静态的 — 它根据运行时配置动态生成：

```typescript
// Bash 工具的 prompt 根据沙箱配置变化
function getSimpleSandboxSection(): string {
  if (!SandboxManager.isSandboxingEnabled()) {
    return ''  // 未启用沙箱则不生成沙箱部分
  }
  // 根据实际的 fs/network 配置生成说明
  const filesystemConfig = {
    read: { denyOnly: dedup(fsReadConfig.denyOnly) },
    write: { allowOnly: normalizeAllowOnly(fsWriteConfig.allowOnly) },
  }
  // ...
}
```

---

## 9.9 中断与取消

### interruptBehavior

工具可以声明当用户提交新消息时的行为：

```typescript
interruptBehavior?(): 'cancel' | 'block'
// 'cancel' — 停止工具执行，丢弃结果
// 'block'  — 继续执行，新消息等待
// 默认: 'block'
```

### 后台执行

Bash 工具支持 `run_in_background` 参数，将长时间命令放入后台：

```typescript
// BashTool inputSchema
run_in_background: z.boolean().optional()
  .describe("Set this to true to run the command in the background...")
```

后台任务在完成后通过通知机制告知 LLM。

---

## 9.10 工具结果的 UI 渲染

### 分层渲染

工具的渲染分为多个层次：

```
renderToolUseMessage()        ← 工具调用展示（如 "Running: npm test"）
renderToolUseProgressMessage()← 执行过程中的进度（如 bash 输出流）
renderToolResultMessage()     ← 执行结果展示（如文件差异）
renderToolUseRejectedMessage()← 被拒绝时展示（如 Edit 的被拒 diff）
renderToolUseErrorMessage()   ← 错误展示
renderGroupedToolUse()        ← 并行工具的分组展示
```

### 折叠显示

`isSearchOrReadCommand()` 方法标记可以折叠的操作：

```typescript
isSearchOrReadCommand?(input): { isSearch: boolean; isRead: boolean; isList?: boolean }
```

搜索和读取操作在 UI 中被折叠为紧凑的摘要，避免刷屏。

---

## 章末速查表

| 概念 | 定义位置 | 说明 |
|------|---------|------|
| `Tool` 接口 | `src/Tool.ts` | 所有工具的核心类型 |
| `buildTool()` | `src/Tool.ts` | 工具构建器，提供安全默认值 |
| `getAllBaseTools()` | `src/tools.ts` | 内置工具注册表 |
| `getTools()` | `src/tools.ts` | 过滤后的工具列表 |
| `assembleToolPool()` | `src/tools.ts` | 合并内置 + MCP 工具 |
| `ToolPermissionContext` | `src/Tool.ts` | 权限上下文 |
| `ToolUseContext` | `src/Tool.ts` | 工具执行上下文 |
| `ToolResult<T>` | `src/Tool.ts` | 工具返回类型 |
| `isConcurrencySafe` | `Tool` 接口 | 并发安全标记 |
| `isReadOnly` | `Tool` 接口 | 只读标记 |
| `maxResultSizeChars` | `Tool` 接口 | 结果大小上限 |
| `searchHint` | `Tool` 接口 | ToolSearch 关键词 |
| `shouldDefer` | `Tool` 接口 | 延迟加载标记 |
| `ALL_AGENT_DISALLOWED_TOOLS` | `src/constants/tools.ts` | 子 Agent 禁用工具 |
| `COORDINATOR_MODE_ALLOWED_TOOLS` | `src/constants/tools.ts` | Coordinator 允许工具 |
