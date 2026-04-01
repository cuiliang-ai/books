
# 第 16 章：Hooks 系统 — 生命周期拦截

> **核心问题**：用户如何在 Agent 的关键生命周期节点（工具调用前后、会话开始/结束、权限请求等）注入自定义逻辑，而不需要修改 Claude Code 的源码？

Hooks 系统是 Claude Code 最强大的扩展机制之一。它允许用户在 Agent 的关键生命周期点注入**自定义 shell 命令、LLM prompt、HTTP 请求或 agentic 验证器**，实现代码审查、安全检查、审计日志等功能，同时通过 JSON 输出协议与 Claude Code 双向通信。

---

## 16.1 架构概览

```
                      Claude Code Agentic Loop
                              │
    ┌─────────────────────────┼─────────────────────────┐
    │                         │                         │
    ▼                         ▼                         ▼
SessionStart          PreToolUse / PostToolUse        Stop
UserPromptSubmit      PermissionRequest               SessionEnd
SubagentStart         PostToolUseFailure              SubagentStop
                      PermissionDenied                PreCompact/PostCompact
                      Notification                    TeammateIdle
                      TaskCreated/TaskCompleted
                      CwdChanged / FileChanged
    │                         │                         │
    ▼                         ▼                         ▼
┌──────────────────────────────────────────────────────────┐
│                    Hooks 执行引擎                          │
│  src/utils/hooks.ts                                       │
│                                                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ command  │  │ prompt   │  │ http     │  │ agent    │ │
│  │ (shell)  │  │ (LLM)   │  │ (webhook)│  │ (agentic)│ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │
│                                                           │
│  JSON 输出协议：decision / continue / updatedInput / ...  │
│  异步模式：{ async: true } → 后台执行                      │
└──────────────────────────────────────────────────────────┘
```

---

## 16.2 Hook 事件类型

Claude Code 定义了丰富的 Hook 事件，覆盖 Agent 生命周期的各个关键节点：

```typescript
// src/entrypoints/agentSdkTypes.ts (HOOK_EVENTS 常量)
// 归纳自 src/schemas/hooks.ts 和 src/types/hooks.ts

// 核心事件:
'PreToolUse'           // 工具调用前
'PostToolUse'          // 工具调用后
'PostToolUseFailure'   // 工具调用失败后
'Stop'                 // Agent 停止时
'SubagentStop'         // Sub-agent 停止时

// 会话生命周期:
'SessionStart'         // 会话开始
'SessionEnd'           // 会话结束
'UserPromptSubmit'     // 用户提交 prompt
'SubagentStart'        // Sub-agent 启动

// 权限相关:
'PermissionRequest'    // 权限请求
'PermissionDenied'     // 权限被拒绝

// 上下文变化:
'CwdChanged'           // 工作目录变化
'FileChanged'          // 文件变化
'PreCompact'           // 上下文压缩前
'PostCompact'          // 上下文压缩后

// 协作相关:
'Notification'         // 通知
'TeammateIdle'         // 队友空闲
'TaskCreated'          // 任务创建
'TaskCompleted'        // 任务完成
```

---

## 16.3 四种 Hook 类型

### Hook Schema 定义

在 `src/schemas/hooks.ts` 中用 Zod discriminated union 定义：

```typescript
// src/schemas/hooks.ts
export const HookCommandSchema = lazySchema(() => {
  return z.discriminatedUnion('type', [
    BashCommandHookSchema,   // type: 'command'
    PromptHookSchema,        // type: 'prompt'
    AgentHookSchema,         // type: 'agent'
    HttpHookSchema,          // type: 'http'
  ])
})
```

### 1. Command Hook — Shell 命令

```typescript
const BashCommandHookSchema = z.object({
  type: z.literal('command'),
  command: z.string(),              // 要执行的 shell 命令
  if: IfConditionSchema(),          // 条件过滤（如 "Bash(git *)"）
  shell: z.enum(SHELL_TYPES).optional(),  // 'bash' 或 'powershell'
  timeout: z.number().positive().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),      // 只运行一次
  async: z.boolean().optional(),     // 后台异步运行
  asyncRewake: z.boolean().optional(), // 后台运行，退出码 2 时唤醒模型
})
```

### 2. Prompt Hook — LLM 评估

```typescript
const PromptHookSchema = z.object({
  type: z.literal('prompt'),
  prompt: z.string(),    // LLM prompt，可用 $ARGUMENTS 占位符
  if: IfConditionSchema(),
  timeout: z.number().positive().optional(),
  model: z.string().optional(),    // 如 "claude-sonnet-4-6"
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```

### 3. Agent Hook — Agentic 验证器

```typescript
const AgentHookSchema = z.object({
  type: z.literal('agent'),
  prompt: z.string(),    // 验证任务描述
  if: IfConditionSchema(),
  timeout: z.number().positive().optional(),    // 默认 60 秒
  model: z.string().optional(),    // 默认用 Haiku
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```

### 4. HTTP Hook — Webhook

```typescript
const HttpHookSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),           // POST 目标 URL
  if: IfConditionSchema(),
  timeout: z.number().positive().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  allowedEnvVars: z.array(z.string()).optional(),  // 环境变量白名单
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```

### Matcher 配置

Hook 通过 matcher + hooks 数组组织：

```typescript
// src/schemas/hooks.ts
export const HookMatcherSchema = lazySchema(() =>
  z.object({
    matcher: z.string().optional(),   // 匹配模式（如工具名 "Write"）
    hooks: z.array(HookCommandSchema()),
  })
)

// 完整的 Hooks 配置结构
export const HooksSchema = lazySchema(() =>
  z.partialRecord(z.enum(HOOK_EVENTS), z.array(HookMatcherSchema()))
)
```

实际配置示例：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Bash tool about to be used'",
            "if": "Bash(rm *)"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npm test",
            "statusMessage": "Running tests..."
          }
        ]
      }
    ]
  }
}
```

---

## 16.4 Hook 执行引擎

### 信任检查

所有 Hook 执行前都需要检查工作区信任：

```typescript
// src/utils/hooks.ts
export function shouldSkipHookDueToTrust(): boolean {
  const isInteractive = !getIsNonInteractiveSession()
  if (!isInteractive) return false  // SDK 模式隐式信任
  return !checkHasTrustDialogAccepted()
}
```

> **设计决策**：ALL hooks require workspace trust. 这是纵深防御 — 即使大多数 hook 在信任建立后才会执行，这个检查防止了所有可能在信任对话框之前意外触发的 hook。历史漏洞包括 SessionEnd hook 在用户拒绝信任时执行。

### 基础输入构建

每个 Hook 接收标准化的输入：

```typescript
// src/utils/hooks.ts
export function createBaseHookInput(
  permissionMode?: string,
  sessionId?: string,
  agentInfo?: { agentId?: string; agentType?: string },
): {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} {
  const resolvedSessionId = sessionId ?? getSessionId()
  const resolvedAgentType = agentInfo?.agentType ?? getMainThreadAgentType()
  return {
    session_id: resolvedSessionId,
    transcript_path: getTranscriptPathForSession(resolvedSessionId),
    cwd: getCwd(),
    permission_mode: permissionMode,
    agent_id: agentInfo?.agentId,
    agent_type: resolvedAgentType,
  }
}
```

### `if` 条件过滤

Hook 可以通过 `if` 字段使用权限规则语法过滤：

```typescript
// 在 Hook 匹配逻辑中
const IfConditionSchema = lazySchema(() =>
  z.string().optional().describe(
    'Permission rule syntax to filter when this hook runs ' +
    '(e.g., "Bash(git *)"). Only runs if the tool call matches.'
  )
)
```

这避免了为不匹配的命令启动 hook 进程，显著减少开销。

---

## 16.5 JSON 输出协议

Hook 通过 stdout 输出 JSON 与 Claude Code 通信。支持两种响应模式：

### 同步响应

```typescript
// src/types/hooks.ts
export const syncHookResponseSchema = lazySchema(() =>
  z.object({
    continue: z.boolean().optional(),      // 是否继续（默认 true）
    suppressOutput: z.boolean().optional(), // 隐藏 stdout
    stopReason: z.string().optional(),      // continue=false 时的原因
    decision: z.enum(['approve', 'block']).optional(),
    reason: z.string().optional(),
    systemMessage: z.string().optional(),   // 显示给用户的警告
    hookSpecificOutput: z.union([
      // PreToolUse 专用
      z.object({
        hookEventName: z.literal('PreToolUse'),
        permissionDecision: z.enum(['allow', 'deny', 'ask']).optional(),
        updatedInput: z.record(z.string(), z.unknown()).optional(),
        additionalContext: z.string().optional(),
      }),
      // PostToolUse 专用
      z.object({
        hookEventName: z.literal('PostToolUse'),
        additionalContext: z.string().optional(),
        updatedMCPToolOutput: z.unknown().optional(),
      }),
      // PermissionRequest 专用
      z.object({
        hookEventName: z.literal('PermissionRequest'),
        decision: z.union([
          z.object({
            behavior: z.literal('allow'),
            updatedInput: z.record(z.string(), z.unknown()).optional(),
            updatedPermissions: z.array(permissionUpdateSchema()).optional(),
          }),
          z.object({
            behavior: z.literal('deny'),
            message: z.string().optional(),
            interrupt: z.boolean().optional(),
          }),
        ]),
      }),
      // ... 更多 event-specific outputs
    ]).optional(),
  })
)
```

### 异步响应

```typescript
const asyncHookResponseSchema = z.object({
  async: z.literal(true),
  asyncTimeout: z.number().optional(),
})
```

当 Hook 输出 `{"async": true}` 时，进入后台执行模式：

```typescript
// src/utils/hooks.ts
function executeInBackground({
  processId, hookId, shellCommand, asyncResponse,
  hookEvent, hookName, command, asyncRewake, pluginId,
}): boolean {
  if (asyncRewake) {
    // asyncRewake hook 不使用后台注册，而是监听完成事件
    // 退出码 2 = blocking error → 唤醒模型
    void shellCommand.result.then(async result => {
      await new Promise(resolve => setImmediate(resolve))
      if (result.code === 2) {
        enqueuePendingNotification({
          value: wrapInSystemReminder(`Stop hook blocking error...`),
          mode: 'task-notification',
        })
      }
    })
    return true
  }
  // 标准异步：注册到 AsyncHookRegistry
  if (!shellCommand.background(processId)) return false
  registerPendingAsyncHook({ processId, hookId, ... })
  return true
}
```

### 输出解析

```typescript
// src/utils/hooks.ts
function parseHookOutput(stdout: string): {
  json?: HookJSONOutput
  plainText?: string
  validationError?: string
} {
  const trimmed = stdout.trim()
  // 不以 { 开头 → 纯文本（显示给模型）
  if (!trimmed.startsWith('{'))
    return { plainText: stdout }
  // 尝试 JSON 解析和 Zod 验证
  const result = validateHookJson(trimmed)
  if ('json' in result) return result
  // 验证失败 → 作为纯文本处理 + 记录错误
  return { plainText: stdout, validationError: result.validationError }
}
```

---

## 16.6 Hook 配置快照

为防止运行时设置变更导致安全问题，Claude Code 在启动时捕获一个 Hook 配置快照：

```typescript
// src/utils/hooks/hooksConfigSnapshot.ts
let initialHooksConfig: HooksSettings | null = null

export function captureHooksConfigSnapshot(): void {
  initialHooksConfig = getHooksFromAllowedSources()
}

export function getHooksConfigFromSnapshot(): HooksSettings | null {
  if (initialHooksConfig === null) captureHooksConfigSnapshot()
  return initialHooksConfig
}
```

### 管理策略控制

```typescript
function getHooksFromAllowedSources(): HooksSettings {
  const policySettings = getSettingsForSource('policySettings')

  // 管理设置禁用所有 hooks
  if (policySettings?.disableAllHooks === true) return {}

  // 只允许管理 hooks
  if (policySettings?.allowManagedHooksOnly === true)
    return policySettings.hooks ?? {}

  // strictPluginOnlyCustomization 策略
  if (isRestrictedToPluginOnly('hooks'))
    return policySettings?.hooks ?? {}

  const mergedSettings = getSettings_DEPRECATED()

  // 非管理设置的 disableAllHooks 不能禁用管理 hooks
  if (mergedSettings.disableAllHooks === true)
    return policySettings?.hooks ?? {}

  return mergedSettings.hooks ?? {}
}
```

> **设计决策**：非管理设置的 `disableAllHooks` 无法禁用来自 policy 的 hooks — 企业管理员的安全 hooks 不能被用户关闭。

---

## 16.7 PreToolUse Hook 与权限集成

PreToolUse hook 是最强大的 hook 类型之一，可以影响权限决策：

```
工具调用
    │
    ▼
hasPermissionsToUseTool()
    │
    ├── deny 规则 → deny
    ├── ask 规则 → ask
    ├── tool.checkPermissions() → ...
    │
    ▼ (ask 结果)
PreToolUse Hook 执行
    │
    ├── permissionDecision: 'allow' → 允许（跳过用户确认）
    ├── permissionDecision: 'deny'  → 拒绝
    ├── permissionDecision: 'ask'   → 保持询问
    ├── updatedInput: {...}         → 修改工具输入
    └── additionalContext: "..."    → 注入额外上下文
```

Hook 的权限决策通过 `hookSpecificOutput` 传递：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Verified by CI lint hook",
    "updatedInput": {
      "command": "npm test -- --coverage"
    }
  }
}
```

---

## 16.8 Session 超时与 Hook 回调

### SessionEnd Hook 超时

```typescript
// src/utils/hooks.ts
const SESSION_END_HOOK_TIMEOUT_MS_DEFAULT = 1500

export function getSessionEndHookTimeoutMs(): number {
  const raw = process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0
    ? parsed : SESSION_END_HOOK_TIMEOUT_MS_DEFAULT
}
```

> **设计决策**：SessionEnd hooks 有极短的默认超时（1.5 秒），因为它们在关闭/清除时运行，用户期望快速退出。可通过环境变量覆盖。

### HookCallback 类型

除了基于配置的 hooks，系统还支持程序化注册的回调 hooks：

```typescript
// src/types/hooks.ts
export type HookCallback = {
  type: 'callback'
  callback: (
    input: HookInput,
    toolUseID: string | null,
    abort: AbortSignal | undefined,
    hookIndex?: number,
    context?: HookCallbackContext,
  ) => Promise<HookJSONOutput>
  timeout?: number
  internal?: boolean   // 内部 hooks 不计入指标
}
```

---

## 章末速查表

| 概念 | 文件 | 关键函数/类型 |
|------|------|-------------|
| Hook 事件类型 | `entrypoints/agentSdkTypes.ts` | `HOOK_EVENTS` |
| Hook Schema | `schemas/hooks.ts` | `HookCommandSchema` |
| Matcher Schema | `schemas/hooks.ts` | `HookMatcherSchema` |
| Hooks 配置 | `schemas/hooks.ts` | `HooksSchema` |
| 执行引擎 | `utils/hooks.ts` | 各种 `execute*Hooks()` |
| 信任检查 | `utils/hooks.ts` | `shouldSkipHookDueToTrust()` |
| 基础输入 | `utils/hooks.ts` | `createBaseHookInput()` |
| JSON 输出解析 | `utils/hooks.ts` | `parseHookOutput()` |
| 输出验证 | `types/hooks.ts` | `hookJSONOutputSchema` |
| 同步响应 | `types/hooks.ts` | `syncHookResponseSchema` |
| 配置快照 | `hooks/hooksConfigSnapshot.ts` | `captureHooksConfigSnapshot()` |
| 管理策略 | `hooks/hooksConfigSnapshot.ts` | `shouldAllowManagedHooksOnly()` |
| 后台执行 | `utils/hooks.ts` | `executeInBackground()` |
| 超时控制 | `utils/hooks.ts` | `getSessionEndHookTimeoutMs()` |
| 回调 Hook | `types/hooks.ts` | `HookCallback` |
