
# 第 13 章：配置与权限系统 — 渐进式信任

> **核心问题**：一个拥有 Bash、文件读写、MCP 等强大工具的 Agent，如何做到"该做的自动做，不该做的绝不做"？配置从哪里来，权限由谁裁决，用户的一次 "Always allow" 又如何被记住？

一个 Coding Agent 面临的核心矛盾是：**能力越大，风险越大**。Agent 需要执行 shell 命令来运行测试、需要写文件来修 bug、需要访问 MCP 工具来与外部系统交互 — 但如果不加限制，一条 `rm -rf /` 就能造成灾难。

Claude Code 用一套 **5 层级联配置 + deny-first 权限引擎** 来解决这个矛盾。本章将完整解析这套系统的架构设计和实现细节。

---

## 13.1 架构概览：多层配置 + 声明式规则引擎

### 问题空间

传统 CLI 工具的权限模型很简单 — 用户执行命令，操作系统负责权限检查。但 Agent 的场景完全不同：

1. **自主决策**：Agent 决定调用什么工具、传什么参数，用户可能事先不知道
2. **多信任域**：用户偏好、团队项目规则、企业安全策略，各有不同的信任级别
3. **动态演进**：用户在使用过程中逐渐放开权限（"这个 git 命令总是 OK 的"）
4. **工具多样性**：Bash、文件操作、MCP 工具各有不同的风险等级

### 解决方案架构

```
                ┌──────────────────────────────────────┐
                │         权限决策引擎                   │
                │  hasPermissionsToUseTool()            │
                │                                      │
                │  deny → ask-rule → tool.check →      │
                │  bypass/mode → allow-rule → ask      │
                └────────────┬─────────────────────────┘
                             │
             ┌───────────────┼───────────────┐
             │               │               │
    ┌────────▼──────┐ ┌──────▼─────┐ ┌───────▼───────┐
    │  规则解析引擎  │ │ 规则收集器  │ │  权限模式系统  │
    │ permissionRule│ │ getAllow/  │ │ default/plan/ │
    │ ValueFromStr()│ │ getDeny/   │ │ acceptEdits/  │
    │ permissionRule│ │ getAsk     │ │ auto/bypass/  │
    │ ValueToStr()  │ │ Rules()    │ │ dontAsk       │
    └───────────────┘ └────────────┘ └───────────────┘
                             │
             ┌───────────────┼───────────────┐
             ▼               ▼               ▼
    ┌──────────────┐ ┌─────────────┐ ┌─────────────┐
    │ 5 层静态设置  │ │ 3 种运行时源 │ │  动态持久化   │
    │ user/project │ │ cliArg/     │ │ applyPerm    │
    │ /local/flag  │ │ command/    │ │ Update() /   │
    │ /policy      │ │ session     │ │ persist()    │
    └──────────────┘ └─────────────┘ └─────────────┘
```

> **设计决策**：Claude Code 没有采用 RBAC（基于角色的访问控制）或 ABAC（基于属性的访问控制），而是设计了一个**声明式规则引擎** — 用简单的字符串格式（`ToolName(pattern)`）表达权限规则。这使得规则可以直接写在 JSON 文件中，用户无需学习复杂的策略语言。

---

## 13.2 五层设置层级：user → project → local → flag → policy

### 层级定义

一个 Agent 工具可能被不同的人、在不同的项目、以不同的方式使用。Claude Code 用**分层配置，按优先级合并**来解决需求冲突。

```
优先级（低 → 高）:
userSettings → projectSettings → localSettings → flagSettings → policySettings
```

| 层级 | 源名称 | 文件路径 | 说明 | 典型使用者 |
|------|--------|----------|------|-----------|
| Layer 1 | `userSettings` | `~/.claude/settings.json` | 用户全局设置 | 个人开发者 |
| Layer 2 | `projectSettings` | `<project>/.claude/settings.json` | 项目级设置，提交 Git | 团队 |
| Layer 3 | `localSettings` | `<project>/.claude/settings.local.json` | 本地覆盖，gitignored | 个人 |
| Layer 4 | `flagSettings` | CLI 参数 `--settings` 传入 | 命令行注入 | 自动化脚本 |
| Layer 5 | `policySettings` | 企业管理策略文件/MDM/远程 | 不可覆盖 | 企业管理员 |

### 源码中的层级常量

在 `src/utils/settings/constants.ts` 中定义：

```typescript
// src/utils/settings/constants.ts
export const SETTING_SOURCES = [
  'userSettings',       // Layer 1
  'projectSettings',    // Layer 2
  'localSettings',      // Layer 3
  'flagSettings',       // Layer 4
  'policySettings',     // Layer 5
] as const

export type SettingSource = (typeof SETTING_SOURCES)[number]
```

权限系统在此基础上扩展了 3 种**运行时规则源**：

```typescript
// src/utils/permissions/permissions.ts
const PERMISSION_RULE_SOURCES = [
  ...SETTING_SOURCES,
  'cliArg',     // 命令行直接传入的规则
  'command',    // slash 命令设置的规则
  'session',    // 用户在权限对话框中动态添加的规则
] as const satisfies readonly PermissionRuleSource[]
```

### 文件路径解析

`settings.ts` 中的 `getSettingsFilePathForSource()` 将源名称映射到文件路径：

```typescript
// src/utils/settings/settings.ts
export function getSettingsFilePathForSource(
  source: SettingSource,
): string | undefined {
  switch (source) {
    case 'userSettings':
      return join(getSettingsRootPathForSource(source), getUserSettingsFilePath())
    case 'projectSettings':
    case 'localSettings':
      return join(
        getSettingsRootPathForSource(source),
        getRelativeSettingsFilePathForSource(source),
      )
    case 'policySettings':
      return getManagedSettingsFilePath()    // 平台特定
    case 'flagSettings':
      return getFlagSettingsPath()           // CLI --settings 参数
  }
}

export function getRelativeSettingsFilePathForSource(
  source: 'projectSettings' | 'localSettings',
): string {
  switch (source) {
    case 'projectSettings': return join('.claude', 'settings.json')
    case 'localSettings':   return join('.claude', 'settings.local.json')
  }
}
```

> **设计决策**：`projectSettings` 和 `localSettings` 都在项目 `.claude/` 目录下，但文件名不同：前者 `settings.json`（提交 Git），后者 `settings.local.json`（gitignored）。团队共享项目规则的同时，每个开发者可保留本地覆盖。

### 配置合并策略

合并使用 lodash `mergeWith` 并应用自定义规则：

```typescript
// src/utils/settings/settings.ts
export function settingsMergeCustomizer(
  objValue: unknown,
  srcValue: unknown,
): unknown {
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    return mergeArrays(objValue, srcValue)  // 数组去重合并
  }
  return undefined  // 其他类型使用 lodash 默认合并
}
```

关键点：**数组采用去重合并（而非替换）**。这意味着不同层级的 allow/deny 规则会累积，而不是低层级覆盖高层级。

### Policy Settings 的特殊优先级链

Policy settings 使用 "first source wins" 策略，有 4 个来源：

```
优先级（高 → 低）:
Remote API → MDM (HKLM/plist) → managed-settings.json + drop-ins → HKCU
```

```typescript
// src/utils/settings/settings.ts
function getSettingsForSourceUncached(source: SettingSource): SettingsJson | null {
  if (source === 'policySettings') {
    // 1. Remote (highest priority)
    const remoteSettings = getRemoteManagedSettingsSyncFromCache()
    if (remoteSettings && Object.keys(remoteSettings).length > 0)
      return remoteSettings

    // 2. Admin-only MDM (HKLM / macOS plist)
    const mdmResult = getMdmSettings()
    if (Object.keys(mdmResult.settings).length > 0)
      return mdmResult.settings

    // 3. managed-settings.json + managed-settings.d/*.json
    const { settings: fileSettings } = loadManagedFileSettings()
    if (fileSettings) return fileSettings

    // 4. HKCU (lowest — user-writable)
    const hkcu = getHkcuSettings()
    if (Object.keys(hkcu.settings).length > 0)
      return hkcu.settings

    return null
  }
  // ...
}
```

---

## 13.3 权限规则：声明式字符串格式

### 规则格式

权限规则采用 `ToolName(content)` 的字符串格式：

```
Bash                    → 整个 Bash 工具
Bash(git *)             → 以 git 开头的 Bash 命令
Edit(/src/**)           → /src/ 下的文件编辑
WebFetch(domain:*.com)  → 特定域名的网络请求
mcp__server1            → 整个 MCP server
Agent(Explore)          → 特定类型的 Agent
```

### 规则值的数据结构

```typescript
// src/types/permissions.ts
export type PermissionRuleValue = {
  toolName: string
  ruleContent?: string    // 可选的内容匹配模式
}

export type PermissionRule = {
  source: PermissionRuleSource      // 来自哪个配置源
  ruleBehavior: PermissionBehavior  // allow / deny / ask
  ruleValue: PermissionRuleValue
}
```

### 规则解析器

`permissionRuleParser.ts` 负责字符串与结构化对象之间的转换：

```typescript
// src/utils/permissions/permissionRuleParser.ts
export function permissionRuleValueFromString(
  ruleString: string,
): PermissionRuleValue {
  // 查找第一个未转义的左括号
  const openParenIndex = findFirstUnescapedChar(ruleString, '(')
  if (openParenIndex === -1) {
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  const closeParenIndex = findLastUnescapedChar(ruleString, ')')
  if (closeParenIndex === -1 || closeParenIndex <= openParenIndex)
    return { toolName: normalizeLegacyToolName(ruleString) }

  const toolName = ruleString.substring(0, openParenIndex)
  const rawContent = ruleString.substring(openParenIndex + 1, closeParenIndex)

  // 空内容 "Bash()" 或通配符 "Bash(*)" 视为工具级规则
  if (rawContent === '' || rawContent === '*')
    return { toolName: normalizeLegacyToolName(toolName) }

  return {
    toolName: normalizeLegacyToolName(toolName),
    ruleContent: unescapeRuleContent(rawContent)
  }
}
```

> **设计决策**：规则内容中的括号需要转义（`\(` / `\)`），这让规则可以匹配包含括号的命令，如 `Bash(python -c "print\(1\)")`。转义/反转义顺序在代码中有严格保证。

### 旧工具名兼容

工具重命名时，旧名字通过别名映射保持兼容：

```typescript
// src/utils/permissions/permissionRuleParser.ts
const LEGACY_TOOL_NAME_ALIASES: Record<string, string> = {
  Task: AGENT_TOOL_NAME,           // Task → Agent
  KillShell: TASK_STOP_TOOL_NAME,  // KillShell → TaskStop
  AgentOutputTool: TASK_OUTPUT_TOOL_NAME,
  BashOutputTool: TASK_OUTPUT_TOOL_NAME,
}
```

---

## 13.4 权限检查流程：7 步裁决管线

权限检查的核心函数是 `hasPermissionsToUseToolInner()`，实现了一个严格的 7 步裁决管线：

```
┌──────────────────────────────────────────────────────────┐
│                   权限裁决管线                             │
│                                                          │
│  ① denyRule 检查    ──→ 命中则 deny（不可覆盖）            │
│  ② askRule 检查     ──→ 命中则 ask（除非 sandbox 自动允许） │
│  ③ tool.checkPermissions() ──→ 工具自身的精细检查          │
│  ④ 工具级 deny/ask  ──→ content-specific 规则             │
│  ⑤ safetyCheck      ──→ .git/.claude/ 等受保护路径        │
│  ⑥ bypassPermissions ──→ 模式允许则通过                   │
│  ⑦ alwaysAllowRule  ──→ 工具级允许规则                    │
│  ⑧ passthrough → ask ──→ 默认询问用户                    │
└──────────────────────────────────────────────────────────┘
```

### 源码实现

```typescript
// src/utils/permissions/permissions.ts
async function hasPermissionsToUseToolInner(
  tool: Tool,
  input: { [key: string]: unknown },
  context: ToolUseContext,
): Promise<PermissionDecision> {
  let appState = context.getAppState()

  // 1a. 整个工具被 deny 规则拒绝
  const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
  if (denyRule) {
    return { behavior: 'deny', decisionReason: { type: 'rule', rule: denyRule },
             message: `Permission to use ${tool.name} has been denied.` }
  }

  // 1b. 整个工具有 ask 规则（除非 sandbox 可自动允许）
  const askRule = getAskRuleForTool(appState.toolPermissionContext, tool)
  if (askRule) {
    const canSandboxAutoAllow =
      tool.name === BASH_TOOL_NAME &&
      SandboxManager.isSandboxingEnabled() &&
      SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
      shouldUseSandbox(input)
    if (!canSandboxAutoAllow)
      return { behavior: 'ask', decisionReason: { type: 'rule', rule: askRule } }
  }

  // 1c. 调用工具自身的权限检查
  let toolPermissionResult: PermissionResult = { behavior: 'passthrough' }
  try {
    const parsedInput = tool.inputSchema.parse(input)
    toolPermissionResult = await tool.checkPermissions(parsedInput, context)
  } catch (e) { /* ... */ }

  // 1d. 工具实现返回 deny
  if (toolPermissionResult?.behavior === 'deny') return toolPermissionResult

  // 1e. 工具需要用户交互
  if (tool.requiresUserInteraction?.() && toolPermissionResult?.behavior === 'ask')
    return toolPermissionResult

  // 1f. Content-specific ask 规则（如 Bash(npm publish:*)）
  if (toolPermissionResult?.behavior === 'ask'
      && toolPermissionResult.decisionReason?.type === 'rule'
      && toolPermissionResult.decisionReason.rule.ruleBehavior === 'ask')
    return toolPermissionResult

  // 1g. 安全检查（.git/, .claude/, .vscode/ 等）— bypass 模式也不能跳过
  if (toolPermissionResult?.behavior === 'ask'
      && toolPermissionResult.decisionReason?.type === 'safetyCheck')
    return toolPermissionResult

  // 2a. bypassPermissions 模式允许通过
  appState = context.getAppState()
  const shouldBypassPermissions =
    appState.toolPermissionContext.mode === 'bypassPermissions' ||
    (appState.toolPermissionContext.mode === 'plan'
     && appState.toolPermissionContext.isBypassPermissionsModeAvailable)
  if (shouldBypassPermissions)
    return { behavior: 'allow', updatedInput: getUpdatedInputOrFallback(...) }

  // 2b. 整个工具被 allow 规则允许
  const alwaysAllowedRule = toolAlwaysAllowedRule(appState.toolPermissionContext, tool)
  if (alwaysAllowedRule)
    return { behavior: 'allow', updatedInput: getUpdatedInputOrFallback(...) }

  // 3. passthrough → ask
  return toolPermissionResult.behavior === 'passthrough'
    ? { ...toolPermissionResult, behavior: 'ask' }
    : toolPermissionResult
}
```

> **设计决策**：deny 规则在管线最前端检查，无法被任何后续规则覆盖 — 这是 "deny-first" 原则的体现。即使 bypass 模式也跳不过 deny 规则、content-specific ask 规则和 safety check。

---

## 13.5 六种权限模式

Claude Code 定义了 6 种权限模式，控制未匹配规则时的默认行为：

```typescript
// src/types/permissions.ts
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan',
] as const

// 内部模式（含 auto）
export type InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble'
```

| 模式 | 符号 | 行为 | 适用场景 |
|------|------|------|---------|
| `default` | — | 每次工具调用询问用户 | 首次使用，谨慎操作 |
| `plan` | ⏸ | 只规划不执行，展示后需批准 | 代码审查场景 |
| `acceptEdits` | ⏵⏵ | 自动允许文件编辑和安全操作 | 日常开发 |
| `bypassPermissions` | ⏵⏵ | 跳过所有权限检查（除 deny/safety） | 完全信任场景 |
| `dontAsk` | ⏵⏵ | 不询问，直接拒绝需要权限的操作 | 非交互脚本 |
| `auto` | ⏵⏵ | 用 AI 分类器决定是否允许 | Anthropic 内部 |

```typescript
// src/utils/permissions/PermissionMode.ts
const PERMISSION_MODE_CONFIG = {
  default:           { title: 'Default',            color: 'text'      },
  plan:              { title: 'Plan Mode',          color: 'planMode'  },
  acceptEdits:       { title: 'Accept edits',       color: 'autoAccept'},
  bypassPermissions: { title: 'Bypass Permissions', color: 'error'     },
  dontAsk:           { title: "Don't Ask",          color: 'error'     },
  auto:              { title: 'Auto mode',          color: 'warning'   },
}
```

### Auto Mode 的分类器流程

Auto mode 使用一个 AI 分类器来决定是否允许工具调用，实现了一个三级快速路径：

```
auto mode 请求
    │
    ├──→ acceptEdits 快速路径？──→ 模拟 acceptEdits 模式检查
    │                              ↓ allow → 跳过分类器
    │
    ├──→ 安全工具允许列表？────→ 直接允许
    │    (isAutoModeAllowlistedTool)
    │
    └──→ AI 分类器 ──→ classifyYoloAction()
              │
              ├── shouldBlock=false → allow
              └── shouldBlock=true  → deny + 拒绝消息
                      │
                      └── 连续拒绝超限 → 回退到用户交互
```

---

## 13.6 权限的运行时更新与持久化

当用户点击 "Always allow" 时，权限规则需要更新并持久化。

### PermissionUpdate 类型系统

```typescript
// src/types/permissions.ts
export type PermissionUpdate =
  | { type: 'addRules';    destination: PermissionUpdateDestination;
      rules: PermissionRuleValue[]; behavior: PermissionBehavior }
  | { type: 'replaceRules'; destination: PermissionUpdateDestination;
      rules: PermissionRuleValue[]; behavior: PermissionBehavior }
  | { type: 'removeRules';  destination: PermissionUpdateDestination;
      rules: PermissionRuleValue[]; behavior: PermissionBehavior }
  | { type: 'setMode';      destination: PermissionUpdateDestination;
      mode: ExternalPermissionMode }
  | { type: 'addDirectories'; destination: PermissionUpdateDestination;
      directories: string[] }
  | { type: 'removeDirectories'; destination: PermissionUpdateDestination;
      directories: string[] }
```

### 应用更新

`applyPermissionUpdate()` 根据更新类型修改 `ToolPermissionContext`：

```typescript
// src/utils/permissions/PermissionUpdate.ts
export function applyPermissionUpdate(
  context: ToolPermissionContext,
  update: PermissionUpdate,
): ToolPermissionContext {
  switch (update.type) {
    case 'addRules': {
      const ruleKind = update.behavior === 'allow' ? 'alwaysAllowRules'
        : update.behavior === 'deny' ? 'alwaysDenyRules' : 'alwaysAskRules'
      return {
        ...context,
        [ruleKind]: {
          ...context[ruleKind],
          [update.destination]: [
            ...(context[ruleKind][update.destination] || []),
            ...ruleStrings,
          ],
        },
      }
    }
    case 'replaceRules': { /* 替换特定源的所有规则 */ }
    case 'removeRules':  { /* 过滤移除特定规则 */ }
    case 'setMode':      { return { ...context, mode: update.mode } }
    case 'addDirectories': { /* 追加到 additionalWorkingDirectories Map */ }
    // ...
  }
}
```

### 持久化到磁盘

可持久化的目的地仅限于 `localSettings`、`userSettings`、`projectSettings`：

```typescript
// src/utils/permissions/PermissionUpdate.ts
export function supportsPersistence(
  destination: PermissionUpdateDestination,
): destination is EditableSettingSource {
  return destination === 'localSettings'
      || destination === 'userSettings'
      || destination === 'projectSettings'
}

export function persistPermissionUpdate(update: PermissionUpdate): void {
  if (!supportsPersistence(update.destination)) return
  switch (update.type) {
    case 'addRules':
      addPermissionRulesToSettings(
        { ruleValues: update.rules, ruleBehavior: update.behavior },
        update.destination,
      )
      break
    // ...
  }
}
```

> **设计决策**：`session` 和 `cliArg` 源的规则只存在于内存中，不会写入磁盘。这确保了临时性权限不会意外持久化。

---

## 13.7 企业管控：allowManagedPermissionRulesOnly

企业管理员可通过 policy settings 锁定权限规则，阻止用户自行添加：

```typescript
// src/utils/permissions/permissionsLoader.ts
export function shouldAllowManagedPermissionRulesOnly(): boolean {
  return getSettingsForSource('policySettings')
    ?.allowManagedPermissionRulesOnly === true
}

export function loadAllPermissionRulesFromDisk(): PermissionRule[] {
  // 如果设置了 allowManagedPermissionRulesOnly，只加载 policy 规则
  if (shouldAllowManagedPermissionRulesOnly()) {
    return getPermissionRulesForSource('policySettings')
  }
  // 否则从所有启用的源加载
  const rules: PermissionRule[] = []
  for (const source of getEnabledSettingSources()) {
    rules.push(...getPermissionRulesForSource(source))
  }
  return rules
}
```

当此选项启用时：
- 用户无法通过 settings.json 添加权限规则
- "Always allow" 选项在权限对话框中隐藏
- 运行时 syncPermissionRulesFromDisk 会清除所有非 policy 源的规则

---

## 13.8 ToolPermissionContext：权限的运行时快照

所有权限状态统一在 `ToolPermissionContext` 中：

```typescript
// src/types/permissions.ts
export type ToolPermissionContext = {
  readonly mode: PermissionMode
  readonly additionalWorkingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>
  readonly alwaysAllowRules: ToolPermissionRulesBySource
  readonly alwaysDenyRules: ToolPermissionRulesBySource
  readonly alwaysAskRules: ToolPermissionRulesBySource
  readonly isBypassPermissionsModeAvailable: boolean
  readonly strippedDangerousRules?: ToolPermissionRulesBySource
  readonly shouldAvoidPermissionPrompts?: boolean
  readonly awaitAutomatedChecksBeforeDialog?: boolean
  readonly prePlanMode?: PermissionMode
}
```

关键字段说明：
- `alwaysAllowRules/alwaysDenyRules/alwaysAskRules`：按源分组的规则映射
- `shouldAvoidPermissionPrompts`：headless/异步 agent 设为 true，自动拒绝需要交互的权限
- `isBypassPermissionsModeAvailable`：记录是否可使用 bypass 模式
- `prePlanMode`：进入 plan mode 前的原始模式

---

## 章末速查表

| 概念 | 文件 | 关键函数/类型 |
|------|------|-------------|
| 5 层设置源 | `settings/constants.ts` | `SETTING_SOURCES` |
| 设置文件路径 | `settings/settings.ts` | `getSettingsFilePathForSource()` |
| 设置合并 | `settings/settings.ts` | `settingsMergeCustomizer()` |
| Policy 优先级 | `settings/settings.ts` | `getSettingsForSourceUncached()` |
| 规则解析 | `permissionRuleParser.ts` | `permissionRuleValueFromString()` |
| 规则收集 | `permissions.ts` | `getAllowRules()`/`getDenyRules()` |
| 核心裁决 | `permissions.ts` | `hasPermissionsToUseToolInner()` |
| 权限模式 | `PermissionMode.ts` | `PERMISSION_MODE_CONFIG` |
| 运行时更新 | `PermissionUpdate.ts` | `applyPermissionUpdate()` |
| 持久化 | `PermissionUpdate.ts` | `persistPermissionUpdate()` |
| 规则加载 | `permissionsLoader.ts` | `loadAllPermissionRulesFromDisk()` |
| 企业管控 | `permissionsLoader.ts` | `shouldAllowManagedPermissionRulesOnly()` |
| 权限上下文 | `types/permissions.ts` | `ToolPermissionContext` |
