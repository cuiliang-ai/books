
# 第 15 章：Hooks 系统 — 生命周期拦截

> **核心问题**：当 AI Agent 自主决定调用哪些工具、如何处理结果时，用户和企业如何在不修改 Agent 核心代码的前提下，对每一步操作进行审计、拦截和定制？

权限系统（第 13 章）通过静态规则允许或拒绝工具调用，沙箱（第 14 章）在操作系统层限制命令能做什么。但在实际工作流中，我们经常需要更灵活的控制：在编辑文件后自动运行格式化工具、在执行 `rm` 命令前检查目标文件是否重要、在 Agent 停止时验证任务是否真正完成。这些需求无法通过静态规则表达 — 它们需要**可编程的生命周期拦截**。

Claude Code 的 Hooks 系统提供了一套完整的生命周期回调机制。用户可以在 Agent 执行的关键节点注入自定义逻辑：shell 命令、HTTP 请求、LLM 判断、甚至子 Agent 验证。Hook 可以观察事件、阻断操作、修改工具输入/输出、影响权限决策 — 从而将一个通用 Agent 转变为符合团队规范的定制化工作流。

---

## 15.1 概述：为什么 Agent 需要 Hooks

### 15.1.1 LLM-in-the-loop vs Hooks-around-the-loop

传统的 Agent 架构中，所有"智能"都封装在 LLM 内部 — LLM 决定做什么、怎么做、何时停止。这是 **LLM-in-the-loop** 模式：

```
User → LLM → Tool → LLM → Tool → LLM → Response
```

但 LLM 不应该也不能承担所有责任。格式化检查、安全审计、合规验证、CI 触发 — 这些是确定性逻辑，交给 LLM 处理既浪费 token 又不可靠。Claude Code 的 Hooks 系统引入了 **Hooks-around-the-loop** 模式：

```
User → [SessionStart Hooks] → LLM
         ↓
       [PreToolUse Hooks] → Tool → [PostToolUse Hooks]
         ↓
       LLM → [Stop Hooks] → Response
```

每个关键节点都有 Hook 拦截点。Hook 在 LLM 的推理循环之外运行，不消耗 token，不受提示注入影响，执行确定性逻辑。

### 15.1.2 核心架构图

```
┌──────────────────────────────────────────────────────────┐
│                  Settings Configuration                   │
│  .claude/settings.json / settings.local.json / ~/.claude/ │
│  policySettings / pluginHooks / sessionHooks              │
└──────────────┬───────────────────────────────────────────┘
               │ load & merge
               ▼
┌──────────────────────┐     ┌───────────────────────────┐
│  Hook Config Store   │────▶│  G48(): getMatchingHooks   │
│  Bd() / lV()         │     │  + kYK() matcher filtering │
└──────────────────────┘     └───────────┬───────────────┘
                                         │ matched hooks
                                         ▼
                              ┌─────────────────────────┐
                              │  Sb() (runHookPipeline)  │
                              │  async generator engine  │
                              │  - parallel execution    │
                              │  - yield results         │
                              └──────┬──────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
              ┌──────────┐   ┌──────────┐    ┌──────────┐
              │ command   │   │  http    │    │ prompt/  │
              │ pi_()     │   │  P48()   │    │ agent    │
              └──────────┘   └──────────┘    └──────────┘
```

### 15.1.3 配置格式总览

Hook 配置嵌套在 settings 的 `hooks` 字段中。Schema 定义位于 `04_git_operations.js:7321-7386`：

```typescript
// Top-level structure (04_git_operations.js:7382-7385)
type HooksConfig = Partial<Record<HookEventName, HookMatcher[]>>

interface HookMatcher {
  matcher?: string;   // tool name pattern, e.g. "Bash" or "Edit|Write"
  hooks: Hook[];      // hooks to execute when matched
}
```

一个典型的配置示例：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 scripts/validate_command.py",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "prettier --write $FILE_PATH"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "agent",
            "prompt": "Verify all tests pass and code compiles"
          }
        ]
      }
    ]
  }
}
```

> **设计决策**：Hook 配置采用 `事件名 → Matcher 数组 → Hook 数组` 的三层嵌套结构。这种设计使得一个事件可以有多个 Matcher（按工具名分组），每个 Matcher 又可以绑定多个 Hook（并行执行）。相比扁平列表，这种结构让配置更具组织性，也便于合并多个配置源。

**小结**：Hooks 系统是围绕 Agentic Loop 的可编程拦截层。它让用户在不修改 Agent 核心逻辑的前提下，通过配置文件注入自定义行为 — 从简单的 shell 命令到 LLM 驱动的验证 Agent。

---

## 15.2 Hook 类型与触发时机

Claude Code 内部定义了多达 26 个生命周期事件（`04_git_operations.js:7309`），但**并非所有事件都开放给用户配置**。用户可配置的事件是一个子集：

```javascript
// User-configurable hook events (04_git_operations.js:9100)
hooks: new Set([
  "PreToolUse", "PostToolUse", "Notification",
  "UserPromptSubmit", "SessionStart", "SessionEnd",
  "Stop", "SubagentStop",
  "PreCompact", "PostCompact",
  "TeammateIdle", "TaskCreated", "TaskCompleted"
])
```

下面聚焦最核心的 4 个 Hook 类型。

### 15.2.1 PreToolUse — 工具调用前

**触发时机**：每个工具调用执行之前，权限检查之前。

**入口函数** — `ze6()` (executePreToolHooks)，`17_system_prompt_full.js:1873`：

```javascript
// 17_system_prompt_full.js:1873-1895
async function* executePreToolHooks(toolName, toolUseID, toolInput,
    toolUseContext, permissionMode, signal, timeoutMs,
    requestPrompt, toolInputSummary) {
  // Quick check: skip if no PreToolUse hooks registered
  if (!hasHooksRegistered("PreToolUse", appState, agentId)) return;

  let hookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: "PreToolUse",
    tool_name: toolName,      // e.g. "Bash", "Edit", "Write"
    tool_input: toolInput,    // tool input parameters
    tool_use_id: toolUseID    // tool call ID
  };
  yield* runHookPipeline({
    hookInput, toolUseID, matchQuery: toolName,
    signal, timeoutMs, toolUseContext, requestPrompt, toolInputSummary
  });
}
```

**输入数据结构**（通过 stdin 传入 hook 进程）：

```json
{
  "session_id": "uuid",
  "cwd": "/path/to/project",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" },
  "tool_use_id": "toolu_xxx"
}
```

**核心能力**：
- **阻断工具执行**：exit code 2 或 JSON `decision: "block"` 阻止工具运行
- **修改工具输入**：通过 `hookSpecificOutput.updatedInput` 替换工具参数
- **权限决策**：通过 `hookSpecificOutput.permissionDecision` 影响权限（allow/deny/ask）
- **附加上下文**：通过 `hookSpecificOutput.additionalContext` 向 LLM 注入额外信息

### 15.2.2 PostToolUse — 工具调用后

**触发时机**：工具执行成功后。

**入口函数** — `Ae6()` (executePostToolHooks)，`17_system_prompt_full.js:1896`：

```javascript
// 17_system_prompt_full.js:1896-1913
async function* executePostToolHooks(toolName, toolUseID, toolInput,
    toolResponse, toolUseContext, permissionMode, signal, timeoutMs) {
  let hookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,  // tool execution result
    tool_use_id: toolUseID
  };
  yield* runHookPipeline({
    hookInput, toolUseID, matchQuery: toolName, signal, timeoutMs, toolUseContext
  });
}
```

**输入数据结构**（比 PreToolUse 多一个 `tool_response` 字段）：

```json
{
  "hook_event_name": "PostToolUse",
  "tool_name": "Edit",
  "tool_input": { "file_path": "/src/main.ts", "old_string": "...", "new_string": "..." },
  "tool_response": "File edited successfully",
  "tool_use_id": "toolu_xxx"
}
```

**核心能力**：
- **附加上下文**：典型用法是 edit 后自动格式化，将格式化结果注入上下文
- **替换 MCP 工具输出**：通过 `hookSpecificOutput.updatedMCPToolOutput` 修改输出
- 不能真正"阻断"（工具已执行完成），但可通过 `decision: "block"` 产生 blocking error

### 15.2.3 Stop — Agent 停止前

**触发时机**：Agent turn 结束时，当 Agent 决定停止（没有更多工具调用）。

**入口函数** — `ve6()` (executeStopHooks)，`17_system_prompt_full.js:1975`：

```javascript
// 17_system_prompt_full.js:1975-2006
async function* executeStopHooks(permissionMode, signal, timeoutMs,
    isStopHookActive, subagentId, toolUseContext,
    lastMessage, agentType, requestPrompt) {
  let eventName = subagentId ? "SubagentStop" : "Stop";

  let hookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: eventName,
    stop_hook_active: isStopHookActive,
    last_assistant_message: lastAssistantContent
  };

  yield* runHookPipeline({
    hookInput, toolUseID: randomUUID(), signal, timeoutMs,
    toolUseContext, messages: lastMessage, requestPrompt
  });
}
```

**核心能力**：
- **阻止 Agent 停止**：通过 blocking error 强制 Agent 继续工作
- **preventContinuation**：JSON 输出 `continue: false` 可以阻止继续
- **stopReason**：提供停止原因，注入到后续消息中

### 15.2.4 Notification — 通知触发时

**触发时机**：系统通知事件（终端通知、权限提示等）。

**入口函数** — `rd()` (executeNotificationHooks)，`17_system_prompt_full.js:1936`：

```javascript
// 17_system_prompt_full.js:1936-1953
async function executeNotificationHooks({ message, title, notificationType },
    timeoutMs) {
  let hookInput = {
    ...createBaseHookInput(),
    hook_event_name: "Notification",
    message: message,
    title: title,
    notification_type: notificationType  // used as matcher query
  };
  await executeHooksOutsideREPL({
    hookInput, timeoutMs, matchQuery: notificationType
  });
}
```

Notification hook 使用 `Eb()` (executeHooksOutsideREPL) 而非 `Sb()` — 因为通知是"即发即忘"的，不需要 async generator 的逐步消费模式。

### 15.2.5 其他重要事件

除了核心 4 种，以下事件在特定场景中非常有用：

| 事件 | 入口函数 | 触发时机 | 典型用途 |
|------|----------|----------|----------|
| `SessionStart` | `Ma6()` | 会话启动后 | 初始化环境、注入上下文 |
| `SessionEnd` | `F__()` | 会话结束时 | 清理资源、保存日志 |
| `UserPromptSubmit` | `Z48()` | 用户提交 prompt 后 | 过滤输入、注入系统上下文 |
| `SubagentStop` | `ve6()` | 子 Agent 停止时 | 验证子任务完成度 |
| `PreCompact` / `PostCompact` | `iyH()` / `Rc_()` | 上下文压缩前后 | 保留关键信息 |

### 15.2.6 与权限系统的交互关系

PreToolUse hook 在权限检查**之前**执行。这意味着 hook 可以：
1. **替代权限提示**：返回 `permissionDecision: "allow"` 自动批准工具调用
2. **强化安全控制**：返回 `permissionDecision: "deny"` 拒绝即使权限规则允许的操作
3. **动态调整**：返回 `permissionDecision: "ask"` 强制弹出用户确认

```
Tool Call Request
     │
     ▼
PreToolUse Hooks ──── deny ──→ Block (skip permission check)
     │                 allow ──→ Bypass permission prompt
     │                 ask ──→ Force user confirmation
     │ (no decision)
     ▼
Permission Rules ──── allow/deny/ask ──→ ...
     │ (ask)
     ▼
PermissionRequest Hooks ──→ auto-approve / auto-deny
     │ (no decision)
     ▼
User Confirmation Prompt
```

**小结**：Claude Code 的 Hook 系统覆盖了 Agent 生命周期的所有关键节点。四个核心 Hook（PreToolUse、PostToolUse、Stop、Notification）提供了从"调用前拦截"到"结果后处理"的完整控制链。Hook 在权限系统之前执行，可以增强、替代甚至覆盖权限决策。

---

## 15.3 Hook 匹配引擎

当一个生命周期事件被触发时，系统需要从所有已注册的 Hook 中找出匹配当前事件和工具的那些。这个过程由匹配引擎完成。

### 15.3.1 Matcher 语法

匹配逻辑由 `kYK()` (matchesToolName) 实现，定义在 `17_system_prompt_full.js:804-819`：

```javascript
// 17_system_prompt_full.js:804-819
function matchesToolName(query, matcher) {
  // 1. Empty matcher or "*" → match all
  if (!matcher || matcher === "*") return true;

  // 2. Pure alphanumeric + pipe → exact match or pipe-separated list
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    if (matcher.includes("|")) {
      // "Edit|Write" → split and match each
      return matcher.split("|")
        .map(s => canonicalize(s.trim()))
        .includes(query);
    }
    // "Bash" → exact match
    return query === canonicalize(matcher);
  }

  // 3. Contains special chars → regex match
  try {
    let regex = new RegExp(matcher);
    if (regex.test(query)) return true;
    // Also test tool name variants (e.g. MCP server:tool format)
    for (let variant of getToolNameVariants(query)) {
      if (regex.test(variant)) return true;
    }
    return false;
  } catch {
    log("Invalid regex pattern in hook matcher: " + matcher);
    return false;
  }
}
```

三种匹配模式总结：

| 模式 | 示例 | 说明 |
|------|------|------|
| 空 / `*` | `""`, `"*"` | 匹配所有工具 |
| 精确匹配 | `"Bash"` | 匹配单个工具名 |
| 管道分隔 | `"Edit\|Write"` | 匹配多个工具名之一 |
| 正则表达式 | `"Bash\|Edit.*"` | 正则匹配（含特殊字符时自动启用） |

> **设计决策**：匹配器的切换逻辑非常巧妙 — 通过检查 matcher 字符串是否只包含字母数字和管道符来区分"简单匹配"和"正则匹配"。这意味着 `"Edit|Write"` 被当作精确匹配列表（因为只含字母和 `|`），而 `"Edit.*"` 被当作正则表达式（因为含 `.` 和 `*`）。大多数用户使用简单模式，避免了正则的性能开销和错误风险。

### 15.3.2 条件过滤器 — `if` 字段

`kYK()` 按工具名匹配，但有时需要更精细的过滤 — 例如"只拦截 `git push` 但不拦截 `git status`"。这由 `vYK()` (evaluateIfCondition) 提供，定义在 `17_system_prompt_full.js:821-832`：

```javascript
// 17_system_prompt_full.js:821-832
function evaluateIfCondition(ifPattern, hookInput, tools) {
  if (!ifPattern) return true;  // no condition → always match

  let parsed = parsePermissionRule(ifPattern);  // parse "Bash(git *)"

  // Only applicable to tool-related events
  if (!["PreToolUse","PostToolUse","PostToolUseFailure","PermissionRequest"]
      .includes(hookInput.hook_event_name)) {
    log("if condition cannot be evaluated for non-tool event");
    return false;
  }

  // Tool name must match
  if (canonicalize(parsed.toolName) !== canonicalize(hookInput.tool_name))
    return false;

  // If ruleContent exists (e.g. "git *"), match against tool input
  if (!parsed.ruleContent) return true;

  let toolDef = tools && findTool(tools, hookInput.tool_name);
  if (!toolDef?.matchesPermissionPattern) return false;

  let parsedInput = toolDef.inputSchema.safeParse(hookInput.tool_input);
  if (!parsedInput.success) return false;

  return toolDef.matchesPermissionPattern(parsed.ruleContent, parsedInput.data);
}
```

`if` 字段复用了权限系统的规则语法。例如：
- `"if": "Bash(git push *)"` — 仅当 Bash 命令以 `git push` 开头时触发
- `"if": "Edit(/etc/*)"` — 仅当编辑 `/etc/` 目录下的文件时触发

### 15.3.3 Hook 发现流程 — `G48()` (getMatchingHooks)

`G48()` 是匹配引擎的核心函数，协调整个发现流程。定义在 `17_system_prompt_full.js:889-984`：

```
G48() (getMatchingHooks) flow:
  │
  ├─ 1. NYK(): Collect matchers from ALL sources
  │       settings + plugins + session hooks
  │
  ├─ 2. Determine match query by event type
  │       PreToolUse → tool_name ("Bash")
  │       SessionStart → source ("cli")
  │       Notification → notification_type
  │       SessionEnd → reason
  │
  ├─ 3. kYK(): Filter matchers by query
  │       exact / pipe-separated / regex
  │
  ├─ 4. Flatten & deduplicate
  │       by (type + command + if) tuple
  │
  ├─ 5. vYK(): Apply if-condition filter
  │       e.g. "Bash(git push *)"
  │
  └─ 6. Skip HTTP hooks for SessionStart/Setup
         (network may not be ready)
```

### 15.3.4 Hook 源收集 — `NYK()` (getHookMatchers)

Hook 配置来自多个源，由 `NYK()` 统一收集（`17_system_prompt_full.js:860-878`）：

```javascript
// 17_system_prompt_full.js:860-878
function getHookMatchers(appState, agentId, eventName) {
  // 1. From settings (may be managed/merged)
  let matchers = [...(Bd()?.[eventName] ?? [])];

  // 2. From registered hooks (plugins, runtime)
  let isManagedOnly = fC();
  let registeredHooks = lV()?.[eventName];
  if (registeredHooks) {
    for (let hook of registeredHooks) {
      // Skip plugin hooks in managed mode
      if (isManagedOnly && "pluginRoot" in hook) continue;
      matchers.push(hook);
    }
  }

  // 3. From session hooks (dynamically registered)
  if (!isManagedOnly && appState !== undefined) {
    let sessionHooks = getSessionHooks(appState, agentId, eventName);
    if (sessionHooks) matchers.push(...sessionHooks);
    let skillHooks = getSkillHooks(appState, agentId, eventName);
    if (skillHooks) matchers.push(...skillHooks);
  }

  return matchers;
}
```

配置来源按优先级排列：

1. **Enterprise Policy** (`policySettings`) — 最高优先级，可强制启用/禁用全部 Hooks
2. **User Settings** (`~/.claude/settings.json`) — 用户全局设置
3. **Project Settings** (`.claude/settings.json`) — 项目级设置
4. **Local Settings** (`.claude/settings.local.json`) — 本地覆盖（不提交 Git）
5. **Plugin Hooks** — 通过插件注册的动态 Hooks（`lV()`, `01_runtime_bootstrap.js:2751`）
6. **Session Hooks** — 运行时通过 SDK/代码注册的 Hooks

### 15.3.5 快速跳过优化 — `C8_()` (hasHooksRegistered)

为避免不必要的开销，每个事件入口函数首先调用 `C8_()` 检查是否有注册的 Hooks（`17_system_prompt_full.js:880-887`）：

```javascript
// 17_system_prompt_full.js:880-887
function hasHooksRegistered(eventName, appState, agentId) {
  // Check settings hooks
  let settingsHooks = Bd()?.[eventName];
  if (settingsHooks && settingsHooks.length > 0) return true;

  // Check registered hooks (plugins)
  let registeredHooks = lV()?.[eventName];
  if (registeredHooks && registeredHooks.length > 0) return true;

  // Check session hooks
  if (appState?.sessionHooks.get(agentId)?.hooks[eventName]) return true;

  return false;
}
```

这个检查非常轻量 — 不需要 JSON 序列化、不需要匹配器过滤。在大多数情况下（用户没有配置 Hooks），这个快速路径避免了所有后续开销。

> **设计决策**：快速跳过优化体现了性能敏感的设计思维。在 Agentic Loop 中，每个工具调用都会触发 PreToolUse 和 PostToolUse 事件。如果没有注册任何 Hook，这两个事件应该零开销 — 连 hookInput 的 JSON 序列化都不应该发生。`C8_()` 的三级检查（settings → plugins → session）确保了这一点。

**小结**：Hook 匹配引擎通过三层过滤（工具名匹配 → 条件过滤 → 去重）精确定位需要执行的 Hooks。配置来自 6 个源（从企业策略到运行时注册），按优先级合并。快速跳过优化确保在无 Hook 配置时的零开销。

---

## 15.4 Hook 执行引擎

匹配引擎找到了需要执行的 Hooks 之后，执行引擎负责实际运行它们。Claude Code 支持 4 种 Hook 执行方式（command、http、prompt、agent），每种方式由独立的 handler 实现。

### 15.4.1 四种 Hook 类型的 Schema

**Command Hook** — 最核心的类型，通过子进程执行 shell 命令（`04_git_operations.js:7322-7331`）：

```typescript
interface CommandHook {
  type: "command";
  command: string;              // shell command to execute
  if?: string;                  // permission rule syntax filter
  shell?: "bash" | "powershell"; // shell type, default "bash"
  timeout?: number;             // timeout in seconds
  statusMessage?: string;       // custom spinner message
  once?: boolean;               // execute only once per session
  async?: boolean;              // run in background
  asyncRewake?: boolean;        // background run, rewake model on exit code 2
}
```

**HTTP Hook** — 发送 POST 请求到指定 URL（`04_git_operations.js:7342-7351`）：

```typescript
interface HttpHook {
  type: "http";
  url: string;                  // POST target URL
  if?: string;
  timeout?: number;
  headers?: Record<string, string>;  // supports $VAR_NAME interpolation
  allowedEnvVars?: string[];         // env var whitelist for header interpolation
  statusMessage?: string;
  once?: boolean;
}
```

**Prompt Hook** — 用 LLM 评估条件（`04_git_operations.js:7333-7341`）：

```typescript
interface PromptHook {
  type: "prompt";
  prompt: string;               // LLM prompt, $ARGUMENTS placeholder
  if?: string;
  timeout?: number;
  model?: string;               // e.g. "claude-sonnet-4-6"
  statusMessage?: string;
  once?: boolean;
}
```

**Agent Hook** — 启动子 Agent 进行验证（`04_git_operations.js:7352-7360`）：

```typescript
interface AgentHook {
  type: "agent";
  prompt: string;               // verification task description
  if?: string;
  timeout?: number;             // default 60s
  model?: string;               // default uses Haiku
  statusMessage?: string;
  once?: boolean;
}
```

### 15.4.2 主执行引擎 — `Sb()` (runHookPipeline)

`Sb()` 是 Hooks 系统的核心执行引擎，以 async generator 形式实现，定义在 `17_system_prompt_full.js:1014-1680`。async generator 模式允许调用方逐步消费执行结果 — 一个 hook 完成就可以立即处理，而不必等待所有 hook 完成。

执行流程：

```
Sb() (runHookPipeline):
  │
  ├─ 1. Guard checks
  │     - isAllHooksDisabled() → return
  │     - isSimpleMode() → return
  │     - shouldSkipDueToTrust() → return
  │
  ├─ 2. G48(): Discover matching hooks
  │     - Empty results → return (fast path)
  │     - Signal aborted → return
  │
  ├─ 3. Telemetry: report hook discovery
  │
  ├─ 4. Yield progress messages (UI spinners)
  │     for each matched hook:
  │       yield { type: "hook_progress", hookEvent, command, statusMessage }
  │
  ├─ 5. Serialize hookInput to JSON
  │
  ├─ 6. Parallel execution
  │     generators = matchedHooks.map(async function*(hook) {
  │       switch (hook.type) {
  │         case "command" → pi_()
  │         case "http"    → P48()
  │         case "prompt"  → yh9()
  │         case "agent"   → Sh9()
  │       }
  │     })
  │
  ├─ 7. Merge results from parallel generators
  │     for await (result of Ih_(generators)):
  │       - blockingError → yield { blockingError }
  │       - permissionBehavior → aggregate (deny > ask > allow)
  │       - additionalContext → yield { additionalContexts }
  │       - updatedInput → yield { updatedInput }
  │       - preventContinuation → yield { preventContinuation }
  │       - systemMessage → yield { message }
  │
  └─ 8. Telemetry: report completion stats
```

关键代码片段 — 并行执行与结果合并：

```javascript
// 17_system_prompt_full.js:1106 - parallel generator creation
let generators = matchedHooks.map(async function*({ hook }, index) {
  switch (hook.type) {
    case "command":  /* spawn child process via pi_() */; return;
    case "http":     /* POST request via P48() */; return;
    case "prompt":   yield await yh9(/*...*/); return;
    case "agent":    yield await Sh9(/*...*/); return;
  }
});

// 17_system_prompt_full.js:1572 - merge and consume
for await (let result of Ih_(generators)) {
  stats[result.outcome]++;
  // ... process each result
}
```

> **设计决策**：所有匹配的 Hooks **并行执行**。`Sb()` 将每个 Hook 封装为独立的 async generator，然后通过 `Ih_()` (mergeAsyncGenerators) 合并迭代 — 结果按完成顺序 yield，而非注册顺序。这意味着一个快速完成的 Hook 不会被慢速 Hook 阻塞。但权限决策的聚合遵循"最严格优先"原则（deny > ask > allow），确保安全性不受并行顺序影响。

### 15.4.3 Command Handler — `pi_()` (executeCommandHook)

Command handler 是最常用的 Hook 类型，通过子进程执行 shell 命令。定义在 `17_system_prompt_full.js:562-802`。

**执行流程**：

```
pi_() (executeCommandHook):
  │
  ├─ 1. Determine shell type
  │     Windows + non-PS → path conversion via AX()
  │     PowerShell → use pwsh
  │     Default → bash
  │
  ├─ 2. Process plugin path substitution
  │     Replace ${CLAUDE_PLUGIN_ROOT} in command
  │
  ├─ 3. Construct environment variables
  │     CLAUDE_PROJECT_DIR, CLAUDE_PLUGIN_ROOT, etc.
  │
  ├─ 4. Spawn child process
  │     stdin: hookInput JSON + "\n"
  │     stdout/stderr: collected via buffers
  │
  ├─ 5. Handle async mode
  │     async: true → background, don't block
  │     asyncRewake: true → background, rewake on exit code 2
  │
  └─ 6. Return { stdout, stderr, status, aborted, backgrounded }
```

**环境变量注入**（`17_system_prompt_full.js:584-596`）：

```javascript
// 17_system_prompt_full.js:584-596
let env = {
  ...getBaseEnv(),
  CLAUDE_PROJECT_DIR: projectDir
};
if (pluginRoot) {
  env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  env.CLAUDE_PLUGIN_DATA = getPluginDataDir(pluginId);
}
// SessionStart/Setup/CwdChanged/FileChanged also write CLAUDE_ENV_FILE
```

**stdin 传输**：Hook 的输入 JSON 通过 stdin 传入子进程（`17_system_prompt_full.js:627, 744`）：

```javascript
// Write hookInput as JSON to child process stdin
process.stdin.write(hookInputJSON + "\n", "utf8");
process.stdin.end();
```

**退出码语义**（`17_system_prompt_full.js:1462-1534`）：

| Exit Code | Meaning | Behavior |
|-----------|---------|----------|
| 0 | Success | `hook_success`, stdout as content |
| 2 | Block | `blocking` — prevent tool execution or emit blocking error |
| Other | Non-blocking error | `hook_non_blocking_error`, does not affect main flow |

### 15.4.4 HTTP Handler — `P48()` (executeHttpHook)

HTTP handler 通过 POST 请求发送 hookInput JSON 到指定 URL。定义在 `17_system_prompt_full.js:174-239`。

**关键安全机制**：

```javascript
// 17_system_prompt_full.js:175-187 - URL whitelist check
let config = getHttpHookConfig();
if (config.allowedUrls !== undefined) {
  if (!config.allowedUrls.some(pattern => matchUrlPattern(hook.url, pattern))) {
    return { ok: false, error: "HTTP hook blocked: URL not in allowlist" };
  }
}

// 17_system_prompt_full.js:197-201 - header env var interpolation
// Only variables listed in allowedEnvVars are interpolated
let allowedVars = hook.allowedEnvVars ?? [];
// If policy also sets allowedEnvVars, take intersection
let effectiveVars = policyAllowedVars !== undefined
  ? allowedVars.filter(v => policyAllowedVars.includes(v))
  : allowedVars;
```

**请求配置**：

```javascript
let response = await axios.post(hook.url, hookInputJSON, {
  headers: { "Content-Type": "application/json", ...customHeaders },
  signal: combinedSignal,
  responseType: "text",
  maxRedirects: 0,                    // no redirect following
  proxy: sandboxProxy ?? false,        // sandbox proxy if enabled
});
```

**限制**：HTTP hooks 在 `SessionStart` 和 `Setup` 事件中被跳过（`17_system_prompt_full.js:976-978`）— 因为网络可能尚未就绪。

### 15.4.5 Prompt Handler — `yh9()` (executePromptHook)

Prompt handler 调用 LLM 评估条件，返回 `{ok: true}` 或 `{ok: false, reason: "..."}` 格式的判断。定义在 `16_commands_slash.js:39670-39818`。

```
yh9() (executePromptHook):
  │
  ├─ 1. Replace $ARGUMENTS placeholder in prompt
  ├─ 2. Construct message list (optional history + hook prompt)
  ├─ 3. Call LLM (default: small fast model like Haiku)
  │     System prompt:
  │       "You are evaluating a hook in Claude Code.
  │        Return JSON: {ok: true} or {ok: false, reason: '...'}"
  ├─ 4. Parse structured output
  │     ok: true  → success, no block
  │     ok: false → block, reason becomes blockingError
  └─ 5. Return result
```

**默认超时**：30 秒。**仅在 REPL 上下文中可用**，在 `executeHooksOutsideREPL`（如 SessionEnd）中返回 "not yet supported" 错误。

### 15.4.6 Agent Handler — `Sh9()` (executeAgentHook)

Agent handler 启动一个子 Agent 来验证条件，子 Agent 可以使用工具进行实际检查。定义在 `16_commands_slash.js:39819-39950+`。

```
Sh9() (executeAgentHook):
  │
  ├─ 1. Create sub-agent (hook-agent-{uuid})
  ├─ 2. Provide filtered tool set
  ├─ 3. Set permission mode to "dontAsk" (auto-approve)
  ├─ 4. Run agentic loop (zC), max 50 turns
  ├─ 5. Await structured output: { ok: boolean, reason?: string }
  └─ 6. Parse result (same as prompt handler)
```

Agent hook 的系统提示（`16_commands_slash.js:39842-39850`）：

```
You are verifying a stop condition in Claude Code.
The conversation transcript is available at: {transcript_path}
You can read this file to analyze the conversation history if needed.

Use the available tools to inspect the codebase and verify the condition.
Use as few steps as possible - be efficient and direct.
```

**默认超时**：60 秒。**默认模型**：Haiku（最快、最便宜的模型）。

### 15.4.7 超时控制

超时通过 `AbortSignal` 组合实现（`LN()` = `combineSignals()`）：

```javascript
let hookTimeout = hook.timeout ? hook.timeout * 1000 : defaultTimeout;
let { signal: combinedSignal, cleanup } = combineSignals(
  AbortSignal.timeout(hookTimeout),  // hook's own timeout
  parentSignal                        // parent cancellation signal
);
```

**默认超时值一览**：

| Scenario | Variable | Value | Note |
|----------|----------|-------|------|
| Global default | `hz` | 600,000 ms (10 min) | Most hooks |
| SessionEnd | `LYK` | 1,500 ms (1.5 s) | Must finish quickly at exit |
| HTTP default | `PYK` | 600,000 ms (10 min) | HTTP requests |
| Prompt hook | hardcoded | 30,000 ms (30 s) | LLM call |
| Agent hook | hardcoded | 60,000 ms (60 s) | Sub-agent run |

SessionEnd 的超时值特别值得注意 — 仅 1.5 秒。这是因为用户退出时不应该被长时间阻塞。可通过环境变量 `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` 调整。

### 15.4.8 REPL 外执行 — `Eb()` (executeHooksOutsideREPL)

并非所有 Hook 都在 Agentic Loop 内执行。Notification、SessionEnd、CompactHooks 等使用 `Eb()` — 一个简化版的执行器（`17_system_prompt_full.js:1686-1872`）。

与 `Sb()` 的关键区别：

| 方面 | `Sb()` (runHookPipeline) | `Eb()` (executeHooksOutsideREPL) |
|------|--------------------------|-----------------------------------|
| 返回类型 | async generator | `Promise<Result[]>` |
| 消费模式 | 逐步 yield | 一次性返回 |
| prompt/agent hooks | 支持 | 不支持（返回 "not yet supported"） |
| 权限决策 yield | 支持 | 不支持 |
| 并行方式 | `Ih_()` merge generators | `Promise.all()` |

**小结**：Hook 执行引擎支持 4 种 handler（command/http/prompt/agent），通过 async generator 实现并行执行和逐步消费。Command hook 通过 stdin/stdout 与子进程通信；HTTP hook 受 URL 白名单和环境变量白名单保护；Prompt/Agent hook 利用 LLM 进行智能判断。超时机制通过 AbortSignal 组合实现，不同场景有不同默认值。

---

## 15.5 Hook 结果处理

Hook 执行完成后，其输出需要被解析、验证，并转化为系统可以理解的行动指令。这个过程涉及输出解析、JSON schema 验证、决策映射和错误降级。

### 15.5.1 输出解析 — `Fh9()` (parseHookOutput)

Command hook 的 stdout 输出首先经过 `Fh9()` 解析（`17_system_prompt_full.js:375-396`）：

```javascript
// 17_system_prompt_full.js:375-396
function parseHookOutput(stdout) {
  let trimmed = stdout.trim();

  // Doesn't start with "{" → plain text
  if (!trimmed.startsWith("{")) return { plainText: stdout };

  // Try JSON parse and schema validation
  try {
    let parsed = parseAndValidate(trimmed);
    if ("json" in parsed) return parsed;
    // Validation failed → return plainText + validationError
    return { plainText: stdout, validationError: parsed.validationError };
  } catch {
    return { plainText: stdout };
  }
}
```

解析策略非常宽容：
- 不以 `{` 开头 → 视为纯文本，作为 hook 输出显示
- 以 `{` 开头但 JSON 解析失败 → 同样视为纯文本
- JSON 解析成功但 schema 验证失败 → 返回纯文本 + 验证错误
- JSON 解析和 schema 验证均成功 → 返回结构化数据

### 15.5.2 JSON 响应格式

Hook 可以输出符合以下 schema 的 JSON（`16_commands_slash.js:39527-39593`）：

```typescript
interface HookOutput {
  // === Universal fields ===
  continue?: boolean;           // false → prevent Agent from continuing
  suppressOutput?: boolean;     // true → hide stdout from display
  stopReason?: string;          // reason when continue=false
  decision?: "approve" | "block";  // permission decision
  reason?: string;              // decision reason
  systemMessage?: string;       // warning message shown to user

  // === Event-specific output ===
  hookSpecificOutput?: {
    hookEventName: string;

    // PreToolUse specific
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;

    // PostToolUse specific
    updatedMCPToolOutput?: unknown;

    // SessionStart specific
    initialUserMessage?: string;
    watchPaths?: string[];
  };
}
```

### 15.5.3 四种返回决策

Hook 的执行结果映射为 4 种决策类型：

```
Hook Execution
     │
     ├─ Exit 0 + no JSON / plain text
     │   → "continue": pass-through, output as context
     │
     ├─ Exit 0 + JSON { decision: "approve" }
     │   → "continue" + permission: allow
     │
     ├─ Exit 2 / JSON { decision: "block" }
     │   → "block": prevent tool execution
     │
     ├─ Exit 0 + JSON { hookSpecificOutput: { updatedInput: {...} } }
     │   → "modify": replace tool input parameters
     │
     └─ Exit non-0 (except 2) / timeout / crash
         → "error": non-blocking, logged but doesn't stop main flow
```

### 15.5.4 决策映射 — `W48()` (mapJsonToResult)

JSON 输出到 Hook 结果的映射由 `W48()` 完成（`17_system_prompt_full.js:424-500`）：

```javascript
// 17_system_prompt_full.js:441-489 (simplified)
function mapJsonToResult(json, hookCommand) {
  let result = {};

  // decision field → permission behavior
  if (json.decision) {
    switch (json.decision) {
      case "approve":
        result.permissionBehavior = "allow";
        break;
      case "block":
        result.permissionBehavior = "deny";
        result.blockingError = {
          blockingError: json.reason || "Blocked by hook",
          command: hookCommand
        };
        break;
    }
  }

  // hookSpecificOutput → event-specific processing
  if (json.hookSpecificOutput?.hookEventName === "PreToolUse") {
    switch (json.hookSpecificOutput.permissionDecision) {
      case "allow": result.permissionBehavior = "allow"; break;
      case "deny":
        result.permissionBehavior = "deny";
        result.blockingError = { /* ... */ };
        break;
      case "ask":   result.permissionBehavior = "ask"; break;
    }

    if (json.hookSpecificOutput.updatedInput)
      result.updatedInput = json.hookSpecificOutput.updatedInput;

    if (json.hookSpecificOutput.additionalContext)
      result.additionalContext = json.hookSpecificOutput.additionalContext;
  }

  // continue: false → prevent Agent continuation
  if (json.continue === false) {
    result.preventContinuation = true;
    result.stopReason = json.stopReason;
  }

  return result;
}
```

### 15.5.5 PreToolUse 的输入修改能力

PreToolUse hook 可以通过 `updatedInput` 修改工具的输入参数。这在调度包装器 `r49()` (executePreToolHookWrapper) 中处理（`14_html_parser.js:24266`）：

```javascript
// When hook returns updatedInput with permission decision
if (result.permissionBehavior !== undefined) {
  yield { type: "hookPermissionResult", hookPermissionResult: {
    behavior: result.permissionBehavior,
    updatedInput: result.updatedInput,  // modified tool input
    decisionReason: { type: "hook", hookName: `PreToolUse:${tool.name}` }
  }};
}

// When hook returns updatedInput WITHOUT permission decision
if (result.updatedInput && result.permissionBehavior === undefined) {
  yield { type: "hookUpdatedInput", updatedInput: result.updatedInput };
}
```

典型用例：一个 PreToolUse hook 检测到 Bash 命令缺少 `--dry-run` 参数，自动将其添加。

### 15.5.6 PostToolUse 的输出修改能力

PostToolUse hook 可以通过 `updatedMCPToolOutput` 替换 MCP 工具的输出。处理逻辑在 `i49()` (executePostToolHookWrapper) 中（`14_html_parser.js:24110`）：

```javascript
// Update MCP tool output if hook provides replacement
if (result.updatedMCPToolOutput && isMcpTool(tool)) {
  currentOutput = result.updatedMCPToolOutput;
  yield { updatedMCPToolOutput: currentOutput };
}
```

注意：输出修改仅对 MCP 工具生效。内置工具（Bash、Edit 等）的输出不可修改。

### 15.5.7 权限决策聚合

当多个 Hooks 并行执行时，它们的权限决策按 **最严格优先** 原则聚合（`17_system_prompt_full.js:1604-1616`）：

```javascript
// Priority: deny > ask > allow > passthrough
switch (result.permissionBehavior) {
  case "deny":
    aggregatedDecision = "deny";       // highest priority, overrides all
    break;
  case "ask":
    if (aggregatedDecision !== "deny")
      aggregatedDecision = "ask";      // only if no deny
    break;
  case "allow":
    if (!aggregatedDecision)
      aggregatedDecision = "allow";    // only if no other decision
    break;
  case "passthrough":
    break;                             // does not affect decision
}
```

这确保了安全性：只要有一个 Hook 认为操作危险（deny），无论其他 Hook 是否批准，操作都会被拒绝。

### 15.5.8 错误处理与降级策略

Hook 的错误处理遵循"优雅降级"原则：

| 错误类型 | 行为 | 对主流程影响 |
|----------|------|-------------|
| Exit code 0 | 成功 | 无（正常通过） |
| Exit code 2 | 阻断 | 阻止工具执行 |
| Exit code 其他 | 非阻断错误 | 记录日志，不影响主流程 |
| 超时 | 取消 | 记录 `hook_cancelled`，不影响主流程 |
| 进程崩溃 | 错误 | 记录错误，不影响主流程 |
| JSON 解析失败 | 降级为纯文本 | stdout 内容作为文本输出 |
| Schema 验证失败 | 降级为纯文本 | stdout 内容作为文本输出 + 验证错误 |

> **设计决策**：Hook 执行失败默认不阻断主流程。只有**显式阻断**（exit code 2 或 `decision: "block"`）才会阻止操作。这种设计确保了 Hook 系统的健壮性 — 一个有 bug 的 Hook 脚本不会导致整个 Agent 瘫痪。但这也意味着 Hook 开发者需要明确使用 exit code 2 来表达"必须阻止"的意图。

Hook 消息在消息历史中的记录类型（`15_hooks_system.js:3440`）：

```javascript
// Hook message types in conversation history
"hook_blocking_error"           // exit code 2 or decision: "block"
"hook_cancelled"                // timeout or abort
"hook_error_during_execution"   // process crash
"hook_non_blocking_error"       // non-zero exit (except 2)
"hook_success"                  // exit code 0
"hook_system_message"           // systemMessage field
"hook_additional_context"       // additionalContext field
"hook_stopped_continuation"     // preventContinuation
```

**小结**：Hook 结果处理支持 4 种决策（continue/block/modify/error）。输出解析采用宽容策略 — JSON 失败则降级为纯文本。PreToolUse 可以修改工具输入，PostToolUse 可以修改 MCP 工具输出。多个 Hook 的权限决策按"最严格优先"聚合。错误默认非阻断，确保系统健壮性。

---

## 15.6 Hook 与权限系统的协同

权限系统（第 13 章）和 Hook 系统是两套独立但互补的控制机制。理解它们的协同关系是正确使用 Hooks 的前提。

### 15.6.1 Hook 在权限决策链中的位置

在工具执行流程中，Hook 和权限检查的顺序如下（`14_html_parser.js:24724-24779`）：

```
┌─────────────────────────────────────────────────────────┐
│              Tool Execution Pipeline                     │
│                                                          │
│  1. Agent requests tool_use                              │
│     ↓                                                    │
│  2. r49(): Pre-tool processing                           │
│     └── ze6() → executePreToolHooks                      │
│         ├── deny  → BLOCK (skip permission entirely)     │
│         ├── allow → BYPASS permission prompt              │
│         ├── ask   → FORCE user confirmation               │
│         └── (none)→ fall through to permission rules      │
│     ↓                                                    │
│  3. Permission check (if hook didn't decide)             │
│     ├── allow → proceed                                  │
│     ├── deny  → BLOCK                                    │
│     └── ask   → PermissionRequest hooks → user prompt    │
│     ↓                                                    │
│  4. Tool execution (tool.call())                         │
│     ↓                                                    │
│  5. i49(): Post-tool processing                          │
│     └── Ae6() → executePostToolHooks                     │
│         ├── additionalContext → inject into conversation  │
│         ├── preventContinuation → stop Agent              │
│         └── updatedMCPToolOutput → replace output         │
│     ↓                                                    │
│  6. Result returned to Agent                             │
└─────────────────────────────────────────────────────────┘
```

关键观察：PreToolUse hook 在权限规则之前执行。这意味着 Hook 拥有"第一决策权"。

### 15.6.2 Hook 可以替代手动审批

PreToolUse hook 的 `permissionDecision: "allow"` 可以绕过权限系统的交互式确认（`14_html_parser.js:24776-24779`）：

```javascript
// 14_html_parser.js:24776-24779
// If hook approves and tool doesn't require user interaction
if (hookResult.behavior === "allow"
    && !tool.requiresUserInteraction?.()
    && !context.requireCanUseTool) {
  // Update input if hook modified it
  if (hookResult.updatedInput) toolInput = hookResult.updatedInput;
  // Final safety check
  let safetyCheck = await validateToolSafety(tool, toolInput, context);
  if (safetyCheck === null) {
    // Completely bypass permission prompt!
    log("Hook approved tool use, bypassing permission prompt");
    permissionResult = hookResult;
  }
}
```

注意安全约束：hook 的 `allow` 绕过了交互式确认，但仍然受到 `validateToolSafety()` 的最终检查。

### 15.6.3 PermissionRequest Hook — 自动化权限提示

当权限规则匹配结果为 `ask` 时，系统会显示用户确认提示。但在此之前，`NwH()` (executePermissionRequestHooks) 提供了一个自动化决策的机会（`17_system_prompt_full.js:2203-2222`）：

```javascript
// 17_system_prompt_full.js:2203-2222
async function* executePermissionRequestHooks(toolName, toolUseID, toolInput,
    toolUseContext, permissionMode, suggestions, signal, timeoutMs) {
  let hookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: "PermissionRequest",
    tool_name: toolName,
    tool_input: toolInput,
    permission_suggestions: suggestions  // system-suggested permission rules
  };
  yield* runHookPipeline({
    hookInput, toolUseID, matchQuery: toolName, signal, timeoutMs, toolUseContext
  });
}
```

PermissionRequest hook 在权限提示流程中的使用（`18_sdk_examples.js:6265-6288`）：

```javascript
async runHooks(permissionMode, suggestions, updatedInput, startTimeMs) {
  for await (let result of executePermissionRequestHooks(
    tool.name, toolUseID, input, context, permissionMode, suggestions, signal
  )) {
    if (result.permissionRequestResult) {
      let decision = result.permissionRequestResult;
      if (decision.behavior === "allow") {
        // Auto-approve: skip user confirmation entirely
        return await this.handleHookAllow(
          decision.updatedInput ?? updatedInput ?? input,
          decision.updatedPermissions ?? [], startTimeMs
        );
      } else if (decision.behavior === "deny") {
        // Auto-deny: optionally interrupt (abort) the Agent
        if (decision.interrupt) context.abortController.abort();
        return this.buildDeny(decision.message || "Permission denied by hook",
          { type: "hook", hookName: "PermissionRequest" });
      }
    }
  }
  return null;  // no hook decision, continue normal permission flow
}
```

### 15.6.4 自动化工作流场景

在 CI/CD 场景中，Hooks 提供了一种比 `--dangerously-skip-permissions` 更精细的自动化方案：

| 方案 | 安全性 | 灵活性 | 适用场景 |
|------|--------|--------|----------|
| `--dangerously-skip-permissions` | 极低 | 无 | 完全受控的沙箱环境 |
| 权限规则 `allow` | 中 | 静态 | 已知安全的工具 + 参数模式 |
| PreToolUse hook + `allow` | 高 | 动态 | 需要运行时逻辑判断的场景 |
| PermissionRequest hook | 高 | 动态 | 需要在权限提示时自动决策 |

典型的 CI/CD Hook 配置：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "python3 ci/validate_command.py",
          "if": "Bash(npm *)"
        }]
      }
    ]
  }
}
```

### 15.6.5 Hook Block vs 权限系统 Deny 的区别

| 方面 | Hook Block | 权限系统 Deny |
|------|-----------|--------------|
| 触发时机 | PreToolUse 阶段（权限检查之前） | 权限规则匹配阶段 |
| 配置位置 | `hooks` 字段 | `permissions.deny` 字段 |
| 粒度 | 可运行自定义逻辑判断 | 基于工具名+规则模式的静态匹配 |
| 用户提示 | 显示 hook error 信息 | 显示 "Permission denied" |
| 可修改输入 | 是（`updatedInput`） | 否 |
| 日志记录 | `hook_blocking_error` attachment | `tengu_tool_use_cancelled` |
| 可覆盖性 | deny 不可被其他 hook 覆盖 | 不可被 hook 覆盖 |

**小结**：Hook 系统与权限系统深度协同。PreToolUse hook 在权限检查之前执行，拥有"第一决策权"；PermissionRequest hook 在权限提示之前执行，可以自动化交互式确认。这种两层 Hook 拦截 + 权限规则的三层架构，提供了从静态规则到动态逻辑的完整控制链。

---

## 15.7 设计启示

Hooks 系统的设计体现了几个值得借鉴的通用模式。

### 15.7.1 生命周期拦截模式的通用价值

Claude Code 的 Hook 系统本质上是一个 **Lifecycle Interception Pattern** — 在系统的关键执行节点提供拦截机会。这个模式在软件工程中有广泛应用：

- **Git Hooks**：pre-commit、pre-push、post-merge
- **Webpack Plugins**：compiler.hooks.compilation、compiler.hooks.emit
- **React Lifecycle**：componentDidMount、componentWillUnmount
- **Kubernetes Admission Controllers**：ValidatingWebhookConfiguration

Claude Code 的独特之处在于它将这个模式应用到了 **AI Agent 的推理循环**中。PreToolUse 对应 Git 的 pre-commit（可以阻止操作），PostToolUse 对应 post-commit（只能观察和附加），Stop 对应 pre-push（最后一次确认机会）。

### 15.7.2 外部进程 vs 内置插件的权衡

Claude Code 选择通过 **外部子进程** 而非内置插件系统来执行 Hooks：

| 方面 | 外部进程（Claude Code） | 内置插件 |
|------|--------------------------|----------|
| 隔离性 | 完全隔离，子进程崩溃不影响主进程 | 共享进程空间，插件 bug 可能崩溃主进程 |
| 语言支持 | 任何语言（Python、Go、Bash...） | 限制为主进程语言（JavaScript） |
| 通信开销 | 进程启动 + stdin/stdout 传输 | 函数调用，几乎零开销 |
| 调试体验 | 独立进程可单独调试 | 需要在主进程上下文中调试 |
| 安全性 | 子进程可被沙箱化 | 插件可访问主进程所有资源 |

> **设计决策**：外部进程的通信开销（通常 50-200ms 的进程启动时间）对于 Hook 场景是可接受的 — Hook 不在性能关键路径上（LLM API 调用本身就需要数秒）。而外部进程带来的隔离性、语言无关性和安全性优势，远超其开销。

### 15.7.3 stdin/stdout 协议的简洁性

Hook 与主进程之间的通信协议极其简洁：

```
主进程 ──stdin──→ Hook 进程 (JSON)
主进程 ←──stdout── Hook 进程 (JSON or plain text)
主进程 ←──stderr── Hook 进程 (error info for exit code 2)
主进程 ←──exit code── Hook 进程 (0=ok, 2=block, other=error)
```

这种设计的优点：
1. **无需 SDK**：任何能读 stdin、写 stdout 的程序都可以作为 Hook
2. **易于测试**：`echo '{"tool_name":"Bash"}' | python3 my_hook.py` 即可测试
3. **可组合**：Hook 命令可以使用管道组合多个程序
4. **兼容性**：适用于所有操作系统和所有编程语言

### 15.7.4 超时保护的必要性

Hook 系统对超时的处理体现了"防御性编程"的思想：

1. **每个 Hook 都有超时**：无论用户是否配置，都有默认超时（10 分钟）
2. **不同场景不同超时**：SessionEnd 仅 1.5 秒（不阻塞退出），Agent hook 60 秒（允许多轮推理）
3. **超时组合**：Hook 自身超时与父级取消信号通过 `combineSignals()` 组合
4. **超时非阻断**：超时产生 `hook_cancelled`，不阻止主流程

这种层层保护确保了一个挂起的 Hook 脚本不会导致整个 Agent 卡住 — 这在生产环境中至关重要。

### 15.7.5 并行执行与安全聚合

多个 Hooks 并行执行提高了吞吐量，但也引入了决策冲突的可能。Claude Code 通过"最严格优先"的聚合策略解决：

```
deny > ask > allow > passthrough
```

这种策略的安全属性：
- **零信任默认**：没有 Hook 做出决策时，回退到权限系统
- **否决权**：任何一个 Hook 都可以通过 `deny` 阻止操作
- **无法绕过**：即使 9 个 Hook 返回 `allow`，第 10 个返回 `deny` 仍然会阻止操作

**小结**：Hooks 系统的设计启示包括：生命周期拦截是一种通用的可扩展性模式；外部进程提供了隔离性和语言无关性；stdin/stdout 是最简洁的 IPC 协议；超时保护是生产系统的必需品；并行执行需要安全的决策聚合策略。这些模式不仅适用于 AI Agent，也适用于任何需要可扩展拦截机制的系统。

---

## 速查表

### Hook 类型对比表

| 特性 | command | http | prompt | agent |
|------|---------|------|--------|-------|
| 执行方式 | 子进程 (spawn) | POST 请求 | LLM 调用 | 子 Agent |
| 可阻断工具 | ✅ (exit 2) | ✅ (JSON) | ✅ (ok:false) | ✅ (ok:false) |
| 可修改输入 | ✅ (JSON) | ✅ (JSON) | ❌ | ❌ |
| 可附加上下文 | ✅ (JSON) | ✅ (JSON) | ❌ | ❌ |
| 可影响权限 | ✅ (JSON) | ✅ (JSON) | ❌ | ❌ |
| 异步执行 | ✅ | ❌ | ❌ | ❌ |
| REPL 外执行 | ✅ | ✅ | ❌ | ❌ |
| SessionStart 支持 | ✅ | ❌ | ✅ | ✅ |
| SessionEnd 支持 | ✅ | ✅ | ❌ | ❌ |
| 自定义模型 | ❌ | ❌ | ✅ | ✅ |
| 使用工具 | ❌ | ❌ | ❌ | ✅ |
| PowerShell | ✅ | ❌ | ❌ | ❌ |
| 默认超时 | 10 min | 10 min | 30 s | 60 s |

### 关键函数索引

#### 配置与加载

| 混淆名 | 推测英文名 | 文件:行号 | 功能描述 |
|--------|-----------|-----------|----------|
| `vW7()` | getHooksConfig | `11_api_streaming.js:19400` | 从 settings 加载 hooks 配置 |
| `Bd()` | getCachedHooks | `11_api_streaming.js:19429` | 获取缓存的 settings hooks |
| `lV()` | getRegisteredHooks | `01_runtime_bootstrap.js:2751` | 获取注册的 hooks (plugins) |
| `fC()` | isManagedHooksOnly | `11_api_streaming.js:19410` | 检查是否仅托管模式 |
| `inH()` | isAllHooksDisabled | `11_api_streaming.js:19417` | 检查是否完全禁用 hooks |
| `Iz$()` | hookTypeSchema | `04_git_operations.js:7321` | 定义 hook 类型 schema |
| `eV()` | hooksConfigSchema | `04_git_operations.js:7385` | 定义完整 hooks 配置 schema |

#### 事件入口

| 混淆名 | 推测英文名 | 文件:行号 | 功能描述 |
|--------|-----------|-----------|----------|
| `ze6()` | executePreToolHooks | `17_system_prompt_full.js:1873` | PreToolUse 事件入口 |
| `Ae6()` | executePostToolHooks | `17_system_prompt_full.js:1896` | PostToolUse 事件入口 |
| `fe6()` | executePostToolFailureHooks | `17_system_prompt_full.js:1914` | PostToolUseFailure 事件入口 |
| `ve6()` | executeStopHooks | `17_system_prompt_full.js:1975` | Stop / SubagentStop 事件入口 |
| `Ma6()` | executeSessionStartHooks | `17_system_prompt_full.js:2075` | SessionStart 事件入口 |
| `F__()` | executeSessionEndHooks | `17_system_prompt_full.js:2178` | SessionEnd 事件入口 |
| `rd()` | executeNotificationHooks | `17_system_prompt_full.js:1936` | Notification 事件入口 |
| `Z48()` | executeUserPromptSubmitHooks | `17_system_prompt_full.js:2057` | UserPromptSubmit 事件入口 |
| `NwH()` | executePermissionRequestHooks | `17_system_prompt_full.js:2203` | PermissionRequest 事件入口 |
| `Ja6()` | executeSetupHooks | `17_system_prompt_full.js:2092` | Setup 事件入口 |
| `Ka6()` | executeSubagentStartHooks | `17_system_prompt_full.js:2107` | SubagentStart 事件入口 |
| `iyH()` | executePreCompactHooks | `17_system_prompt_full.js:2122` | PreCompact 事件入口 |
| `Rc_()` | executePostCompactHooks | `17_system_prompt_full.js:2152` | PostCompact 事件入口 |
| `Ne6()` | executeTeammateIdleHooks | `17_system_prompt_full.js:2007` | TeammateIdle 事件入口 |
| `Qt6()` | executeTaskCreatedHooks | `17_system_prompt_full.js:2021` | TaskCreated 事件入口 |
| `VH_()` | executeTaskCompletedHooks | `17_system_prompt_full.js:2039` | TaskCompleted 事件入口 |

#### 核心执行引擎

| 混淆名 | 推测英文名 | 文件:行号 | 功能描述 |
|--------|-----------|-----------|----------|
| `Sb()` | runHookPipeline | `17_system_prompt_full.js:1014` | 主 hook 执行引擎 (async generator) |
| `Eb()` | executeHooksOutsideREPL | `17_system_prompt_full.js:1686` | REPL 外 hook 执行器 |
| `G48()` | getMatchingHooks | `17_system_prompt_full.js:889` | 获取匹配的 hooks |
| `NYK()` | getHookMatchers | `17_system_prompt_full.js:860` | 收集所有来源的 hook matchers |
| `C8_()` | hasHooksRegistered | `17_system_prompt_full.js:880` | 快速检查是否有注册的 hooks |
| `Ih_()` | mergeAsyncGenerators | — | 合并多个 async generator 的输出 |

#### 匹配器

| 混淆名 | 推测英文名 | 文件:行号 | 功能描述 |
|--------|-----------|-----------|----------|
| `kYK()` | matchesToolName | `17_system_prompt_full.js:804` | 工具名匹配（精确/管道/正则） |
| `vYK()` | evaluateIfCondition | `17_system_prompt_full.js:821` | `if` 条件过滤 |

#### Handler 实现

| 混淆名 | 推测英文名 | 文件:行号 | 功能描述 |
|--------|-----------|-----------|----------|
| `pi_()` | executeCommandHook | `17_system_prompt_full.js:562` | Command hook (spawn 子进程) |
| `P48()` | executeHttpHook | `17_system_prompt_full.js:174` | HTTP hook (POST 请求) |
| `yh9()` | executePromptHook | `16_commands_slash.js:39670` | Prompt hook (LLM 评估) |
| `Sh9()` | executeAgentHook | `16_commands_slash.js:39819` | Agent hook (子 Agent 验证) |

#### 输出解析

| 混淆名 | 推测英文名 | 文件:行号 | 功能描述 |
|--------|-----------|-----------|----------|
| `Fh9()` | parseHookOutput | `17_system_prompt_full.js:375` | 解析 command hook stdout |
| `Uh9()` | parseHttpResponse | `17_system_prompt_full.js:398` | 解析 HTTP hook 响应 body |
| `W48()` | mapJsonToResult | `17_system_prompt_full.js:424` | JSON 输出映射到 hook 结果 |
| `ch9()` | parseAndValidateJson | `17_system_prompt_full.js:360` | JSON 解析 + schema 验证 |
| `iO()` | createBaseHookInput | `17_system_prompt_full.js:347` | 构造基础 hook 输入 |

#### 工具集成

| 混淆名 | 推测英文名 | 文件:行号 | 功能描述 |
|--------|-----------|-----------|----------|
| `r49()` | executePreToolHookWrapper | `14_html_parser.js:24266` | PreToolUse hook 调度包装器 |
| `i49()` | executePostToolHookWrapper | `14_html_parser.js:24110` | PostToolUse hook 调度包装器 |
| `k__()` | isHookMessage | `15_hooks_system.js:3439` | 判断消息是否为 hook 消息 |
| `G39()` | buildToolHookLookup | `15_hooks_system.js:3443` | 构建工具+hook 关联查找表 |
| `Z19()` | createStopHookSummary | `15_hooks_system.js:5183` | 创建 Stop hook 摘要消息 |

### 环境变量列表

| 环境变量 | 说明 | 注入时机 |
|----------|------|----------|
| `CLAUDE_PROJECT_DIR` | 项目根目录路径 | 所有 command hooks |
| `CLAUDE_PLUGIN_ROOT` | 插件根目录路径 | 插件来源的 hooks |
| `CLAUDE_PLUGIN_DATA` | 插件数据目录路径 | 插件来源的 hooks |
| `CLAUDE_ENV_FILE` | 环境变量文件路径 | SessionStart/Setup/CwdChanged/FileChanged |
| `CLAUDE_CODE_SIMPLE` | 设为任意值禁用所有 hooks | 全局 |
| `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` | SessionEnd hooks 超时（毫秒） | SessionEnd |

### 返回值格式速查

**Command Hook 退出码**：

| Exit Code | 含义 | 系统行为 |
|-----------|------|----------|
| `0` | 成功 | `hook_success`，stdout 作为内容 |
| `2` | 阻断 | `blocking`，stderr 作为阻断原因 |
| 其他 | 错误 | `hook_non_blocking_error`，不影响主流程 |

**JSON 输出快速参考**：

```json
// Approve tool execution
{ "decision": "approve" }

// Block tool execution
{ "decision": "block", "reason": "Dangerous operation detected" }

// Modify tool input (PreToolUse only)
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "updatedInput": { "command": "npm test --dry-run" }
  }
}

// Grant permission (PreToolUse only)
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow"
  }
}

// Add context for LLM
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "Note: this file is auto-generated, be careful"
  }
}

// Prevent Agent from continuing (Stop hook)
{ "continue": false, "stopReason": "Tests failed, please fix before continuing" }

// Suppress hook output from display
{ "suppressOutput": true }
```

### 超时常量速查

| 变量 | 值 | 场景 |
|------|------|------|
| `hz` | 600,000 ms (10 min) | 全局默认超时 |
| `LYK` | 1,500 ms (1.5 s) | SessionEnd 超时 |
| `PYK` | 600,000 ms (10 min) | HTTP hook 默认超时 |
| — | 30,000 ms (30 s) | Prompt hook 超时 (硬编码) |
| — | 60,000 ms (60 s) | Agent hook 超时 (硬编码) |
