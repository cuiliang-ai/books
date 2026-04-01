
# 第 23 章：插件系统与配置迁移

> **核心问题**：一个持续演进的 CLI 工具如何支持第三方扩展，同时保证版本升级时用户配置的兼容性？Claude Code 的插件架构和配置迁移系统是如何设计的？

当一个 CLI 工具从个人项目成长为被数十万开发者使用的基础设施时，它必须面对两个相互矛盾的工程挑战：

**扩展性** — 核心团队不可能预见所有使用场景，社区需要一种方式来扩展工具的能力（新的 slash commands、MCP servers、hooks、output styles）。

**稳定性** — 每次版本升级都可能改变模型名称、重命名配置字段、调整默认行为，但用户的配置必须无缝迁移，不能在某天升级后发现自己精心配置的工作流突然失效。

Claude Code 通过两个独立但互补的子系统来解决这对矛盾：**插件系统**（代号 Tengu）负责扩展性，**迁移系统**负责稳定性。同时，原本用 Rust NAPI 编写的性能关键模块也被移植为纯 TypeScript 实现，消除了安装时编译原生模块的痛点。本章将深入这三个子系统的源码设计。

---

## 23.1 插件架构概览

### 23.1.1 插件 = Skills + Hooks + MCP Servers 的组合

Claude Code 的插件不是简单的"一个函数加一个描述"。一个插件可以同时提供多种组件：

```
┌──────────────────────────────────────────────────────────────────┐
│                         Plugin                                    │
│                                                                   │
│  ┌─────────────┐  ┌──────────┐  ┌───────────────┐               │
│  │  Commands/   │  │  Hooks   │  │  MCP Servers  │               │
│  │  Skills      │  │          │  │               │               │
│  │  (.md files) │  │  (JSON)  │  │  (config)     │               │
│  └─────────────┘  └──────────┘  └───────────────┘               │
│                                                                   │
│  ┌─────────────┐  ┌──────────┐  ┌───────────────┐               │
│  │  Agents      │  │  Output  │  │  LSP Servers  │               │
│  │  (.md files) │  │  Styles  │  │  (config)     │               │
│  └─────────────┘  └──────────┘  └───────────────┘               │
│                                                                   │
│  plugin.json — manifest with metadata, versions, dependencies     │
└──────────────────────────────────────────────────────────────────┘
```

这一设计体现在 `LoadedPlugin` 类型中（`src/types/plugin.ts`）：

```typescript
export type LoadedPlugin = {
  name: string
  manifest: PluginManifest
  path: string
  source: string           // 例如 "my-plugin@my-marketplace"
  repository: string
  enabled?: boolean
  isBuiltin?: boolean      // 内置插件标记
  sha?: string             // Git commit SHA 用于版本锁定

  // 插件可以提供的所有组件：
  commandsPath?: string        // slash commands
  agentsPath?: string          // AI agents
  skillsPath?: string          // skills
  outputStylesPath?: string    // 自定义输出样式
  hooksConfig?: HooksSettings  // 生命周期钩子
  mcpServers?: Record<string, McpServerConfig>  // MCP 服务器
  lspServers?: Record<string, LspServerConfig>  // LSP 服务器
  settings?: Record<string, unknown>            // 插件配置
}
```

> **设计决策**：为什么不把插件拆成更细粒度的"命令插件"、"Hook 插件"、"MCP 插件"？因为现实中很多扩展需要多个组件协同工作 — 例如一个代码审查插件可能同时需要一个 `/review` 命令（skill）、一个 `PostToolUse` hook（自动检查）、和一个 MCP server（连接 GitHub API）。单一插件包含多组件避免了"管理 N 个相关微插件"的认知负担。

### 23.1.2 两种插件：内置 vs Marketplace

Claude Code 区分两种插件来源：

| 维度 | 内置插件 (Builtin) | Marketplace 插件 |
|------|-------------------|------------------|
| 标识格式 | `name@builtin` | `name@marketplace-name` |
| 存储位置 | 编译进 CLI 二进制 | Git 仓库 / 本地目录 / npm |
| 安装方式 | 随 CLI 自带 | `claude plugin install` |
| 启用控制 | 用户在 /plugin UI 切换 | settings.json 中声明 |
| 组件类型 | skills + hooks + MCP | 全部组件 |
| 典型用途 | 实验性功能渐进推出 | 第三方扩展 |

这两种插件在运行时被统一为 `LoadedPlugin` 对象，下游代码不需要区分来源。

### 23.1.3 插件组件类型

```typescript
export type PluginComponent =
  | 'commands'      // Slash 命令 (/build, /deploy, /review)
  | 'agents'        // AI 子代理定义
  | 'skills'        // Skill 工具（通过 Skill tool 调用）
  | 'hooks'         // 生命周期钩子
  | 'output-styles' // 自定义输出格式
```

加上配置级别的 `mcpServers` 和 `lspServers`，一个插件最多可以扩展七个维度。

---

## 23.2 内置插件注册表

### 23.2.1 架构设计

内置插件的实现分为两个文件：

```
src/plugins/
├── builtinPlugins.ts    ← 注册表引擎（通用）
└── bundled/
    └── index.ts         ← 具体注册（目前为空脚手架）
```

注册表使用一个简单的 `Map<string, BuiltinPluginDefinition>`：

```typescript
// src/plugins/builtinPlugins.ts
const BUILTIN_PLUGINS: Map<string, BuiltinPluginDefinition> = new Map()

export function registerBuiltinPlugin(
  definition: BuiltinPluginDefinition,
): void {
  BUILTIN_PLUGINS.set(definition.name, definition)
}
```

`BuiltinPluginDefinition` 定义了内置插件的结构：

```typescript
export type BuiltinPluginDefinition = {
  name: string
  description: string
  version?: string
  skills?: BundledSkillDefinition[]      // 技能定义
  hooks?: HooksSettings                   // 钩子配置
  mcpServers?: Record<string, McpServerConfig>  // MCP 服务器
  isAvailable?: () => boolean             // 动态可用性检查
  defaultEnabled?: boolean                // 默认启用状态
}
```

### 23.2.2 启用状态决策链

内置插件的启用状态遵循一个三级优先级链：

```
用户显式设置 > 插件默认值 > true
```

源码实现（`getBuiltinPlugins()`）：

```typescript
const userSetting = settings?.enabledPlugins?.[pluginId]
// Enabled state: user preference > plugin default > true
const isEnabled =
  userSetting !== undefined
    ? userSetting === true
    : (definition.defaultEnabled ?? true)
```

这意味着：
1. 如果用户在 settings 中设置了 `enabledPlugins["name@builtin"]`，以用户为准
2. 否则看插件定义的 `defaultEnabled`
3. 如果连 `defaultEnabled` 都没有，默认为启用

### 23.2.3 Skill 与 Command 的转换

内置插件的 Skills 最终被转换为 `Command` 对象，融入统一的命令系统：

```typescript
function skillDefinitionToCommand(definition: BundledSkillDefinition): Command {
  return {
    type: 'prompt',
    name: definition.name,
    // 'bundled' not 'builtin' — 'builtin' in Command.source means hardcoded
    // slash commands (/help, /clear). Using 'bundled' keeps these skills in
    // the Skill tool's listing, analytics name logging, and prompt-truncation
    // exemption.
    source: 'bundled',
    loadedFrom: 'bundled',
    // ...
  }
}
```

> **设计决策**：为什么 `source` 用 `'bundled'` 而不是 `'builtin'`？因为在 Command 系统中，`'builtin'` 有特殊含义 — 指的是 `/help`、`/clear` 这类硬编码的核心命令。用 `'bundled'` 让插件提供的 skill 进入 Skill tool 的可发现列表，而不被当作核心命令处理。这是语义精确性与命名历史包袱之间的权衡。

### 23.2.4 bundled/index.ts — 空脚手架的意义

```typescript
// src/plugins/bundled/index.ts
export function initBuiltinPlugins(): void {
  // No built-in plugins registered yet — this is the scaffolding for
  // migrating bundled skills that should be user-toggleable.
}
```

这个空函数并非多余。它代表了一个架构决策：将来 `src/skills/bundled/` 中的某些 skill（例如 claude-in-chrome）可以被迁移到内置插件系统，让用户获得开关控制。这个入口点在 CLI 启动时被调用，确保注册时机正确。

---

## 23.3 Marketplace 插件生态

### 23.3.1 Marketplace 来源类型

插件通过 Marketplace 分发。Marketplace 支持五种来源：

```typescript
// src/utils/plugins/schemas.ts
z.discriminatedUnion('source', [
  z.object({ source: z.literal('url'),    url: z.string().url() }),
  z.object({ source: z.literal('github'), repo: z.string() }),
  z.object({ source: z.literal('git'),    url: z.string() }),
  z.object({ source: z.literal('npm'),    package: z.string() }),
  z.object({ source: z.literal('local'),  path: z.string() }),
])
```

### 23.3.2 官方 Marketplace 保护

为防止第三方仿冒官方市场，系统实现了多层保护：

```typescript
// 1. 保留名称列表
export const ALLOWED_OFFICIAL_MARKETPLACE_NAMES = new Set([
  'claude-code-marketplace',
  'claude-code-plugins',
  'anthropic-marketplace',
  'agent-skills',
  // ...
])

// 2. 名称模式检测（防仿冒）
export const BLOCKED_OFFICIAL_NAME_PATTERN =
  /(?:official[^a-z0-9]*(anthropic|claude)|...)/i

// 3. 非 ASCII 字符检测（防同形异义攻击）
const NON_ASCII_PATTERN = /[^\u0020-\u007E]/

// 4. 来源验证 — 保留名称必须来自 anthropics 组织
export const OFFICIAL_GITHUB_ORG = 'anthropics'
```

> **设计决策**：为什么需要同形异义（homograph）攻击检测？因为攻击者可以用西里尔字母 `а`（U+0430）代替拉丁字母 `a`（U+0061）创建一个视觉上无法区分的 "аnthropics-marketplace"。非 ASCII 字符检测是阻止这类攻击最简洁的方式。

### 23.3.3 Plugin Manifest Schema

每个插件的 `plugin.json` 被一个组合 Schema 验证：

```typescript
export const PluginManifestSchema = lazySchema(() =>
  z.object({
    ...PluginManifestMetadataSchema().shape,     // name, description, version
    ...PluginManifestHooksSchema().partial().shape,
    ...PluginManifestCommandsSchema().partial().shape,
    ...PluginManifestAgentsSchema().partial().shape,
    ...PluginManifestSkillsSchema().partial().shape,
    ...PluginManifestOutputStylesSchema().partial().shape,
    ...PluginManifestChannelsSchema().partial().shape,
    ...PluginManifestMcpServerSchema().partial().shape,
    ...PluginManifestLspServerSchema().partial().shape,
    ...PluginManifestSettingsSchema().partial().shape,
    ...PluginManifestUserConfigSchema().partial().shape,
  }),
)
```

注意所有组件 Schema 都是 `.partial()` — 只有 Metadata（name、description）是必需的，其余组件全部可选。这让最简单的插件只需要一个名称和描述就能生效。

---

## 23.4 插件安装与管理

### 23.4.1 安装工作流

插件安装遵循 **settings-first** 原则 — 先声明意图，再物化资源：

```
                        installPluginOp()
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
    ① 搜索 Marketplace     ② 写入 Settings      ③ 缓存插件
    查找插件定义            声明 enabledPlugins    下载/拷贝到
    解析来源               (THE ACTION)           versioned cache
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
                        返回结果
```

核心函数 `installPluginOp()` 的关键路径（`src/services/plugins/pluginOperations.ts`）：

```typescript
export async function installPluginOp(
  plugin: string,
  scope: InstallableScope = 'user',
): Promise<PluginOperationResult> {
  // Step 1: 搜索已物化的 marketplace
  let foundPlugin: PluginMarketplaceEntry | undefined
  if (marketplaceName) {
    const pluginInfo = await getPluginById(plugin)
    foundPlugin = pluginInfo?.entry
  } else {
    // 搜索所有 marketplace
    for (const [mktName, mktConfig] of Object.entries(marketplaces)) {
      const marketplace = await getMarketplace(mktName)
      const pluginEntry = marketplace.plugins.find(p => p.name === pluginName)
      if (pluginEntry) { foundPlugin = pluginEntry; break }
    }
  }

  // Step 2+3: 写入 settings + 缓存（统一在 installResolvedPlugin 中）
  const result = await installResolvedPlugin({
    pluginId, entry, scope, marketplaceInstallLocation,
  })
}
```

### 23.4.2 作用域系统

插件安装支持三个作用域（scope）：

| Scope | 配置文件位置 | 影响范围 | 典型场景 |
|-------|------------|---------|---------|
| `user` | `~/.claude/settings.json` | 所有项目 | 个人常用工具 |
| `project` | `.claude/settings.json` | 当前项目（团队共享） | 项目级工具链 |
| `local` | `.claude/settings.local.json` | 当前项目（仅个人） | 个人调试插件 |

作用域的优先级是 `local > project > user`（最具体的优先）：

```typescript
function findPluginInSettings(plugin: string): { pluginId; scope } | null {
  const searchOrder: InstallableScope[] = ['local', 'project', 'user']
  for (const scope of searchOrder) {
    const enabledPlugins = getSettingsForSource(
      scopeToSettingSource(scope)
    )?.enabledPlugins
    // ... 查找匹配
  }
  return null
}
```

这允许一个有趣的模式：项目级别启用了某个插件（团队共享的 `.claude/settings.json`），但你个人想禁用它 — 在 `local` scope 设置 `false` 即可覆盖，而不需要修改共享配置。

### 23.4.3 卸载的安全处理

卸载插件时有一个微妙的问题：如果插件 A 依赖插件 B，直接卸载 B 会导致 A 运行异常。但 Claude Code 选择了"警告而非阻止"的策略：

```typescript
// Warn (don't block) if other enabled plugins depend on this one.
// Blocking creates tombstones — can't tear down a graph with a delisted
// plugin. Load-time verifyAndDemote catches the fallout.
const reverseDependents = findReverseDependents(pluginId, allPlugins)
const depWarn = formatReverseDependentsSuffix(reverseDependents)
```

> **设计决策**：为什么警告而不阻止？因为如果一个插件从 marketplace 下架（delisted），你就永远无法卸载它 — 因为依赖链中的其他插件会阻止操作。通过"警告 + 加载时降级"（load-time verifyAndDemote）组合，系统在安全性和可操作性之间取得了平衡。

### 23.4.4 后台 Marketplace 安装

CLI 启动时不会阻塞等待 marketplace 同步。`PluginInstallationManager` 在后台异步执行：

```typescript
// src/services/plugins/PluginInstallationManager.ts
export async function performBackgroundPluginInstallations(
  setAppState: SetAppState,
): Promise<void> {
  // 1. 计算差异
  const diff = diffMarketplaces(declared, materialized)

  // 2. 异步协调
  const result = await reconcileMarketplaces({ onProgress: ... })

  // 3. 新安装 → 自动刷新插件（修复首次使用时的 "not found" 错误）
  if (result.installed.length > 0) {
    await refreshActivePlugins(setAppState)
  }
  // 4. 更新 → 设置 needsRefresh，提示用户 /reload-plugins
  else if (result.updated.length > 0) {
    setAppState(prev => ({
      ...prev,
      plugins: { ...prev.plugins, needsRefresh: true },
    }))
  }
}
```

注意新安装和更新的处理策略不同：新安装自动刷新（修复用户体验），更新只通知用户手动刷新（尊重用户对中断时机的控制）。

---

## 23.5 插件 Hook 与 Output Style 加载

### 23.5.1 Plugin Hooks

插件可以声明 Hook 回调，覆盖所有可用的 Hook 事件：

```typescript
// src/utils/plugins/loadPluginHooks.ts
function convertPluginHooksToMatchers(
  plugin: LoadedPlugin,
): Record<HookEvent, PluginHookMatcher[]> {
  const pluginMatchers: Record<HookEvent, PluginHookMatcher[]> = {
    PreToolUse: [],
    PostToolUse: [],
    SessionStart: [],
    SessionEnd: [],
    Stop: [],
    SubagentStart: [],
    SubagentStop: [],
    FileChanged: [],
    // ... 总计 25+ 种事件
  }
  // 转换插件 Hook 配置为原生 matcher
}
```

系统支持热重载：当检测到 settings 中 `enabledPlugins` 变化时，自动重新加载插件 hooks。

### 23.5.2 Plugin Output Styles

自定义输出样式通过 Markdown 文件定义，从两个位置加载：

```typescript
// src/outputStyles/loadOutputStylesDir.ts
export const getOutputStyleDirStyles = memoize(
  async (cwd: string): Promise<OutputStyleConfig[]> => {
    const markdownFiles = await loadMarkdownFilesForSubdir(
      'output-styles', cwd
    )
    return markdownFiles.map(({ filePath, frontmatter, content, source }) => {
      const styleName = basename(filePath).replace(/\.md$/, '')
      const name = (frontmatter['name'] || styleName) as string
      const description = coerceDescriptionToString(frontmatter['description'])
      return { name, description, prompt: content.trim(), source }
    })
  }
)
```

目录结构：
```
~/.claude/output-styles/*.md        ← 用户级样式
.claude/output-styles/*.md          ← 项目级样式（覆盖用户级同名样式）
plugin/output-styles/*.md           ← 插件提供的样式
```

每个 `.md` 文件的 frontmatter 支持 `name`、`description`、`keep-coding-instructions`（是否保留编码指令）等字段。

---

## 23.6 错误处理：类型安全的 PluginError

### 23.6.1 联合类型替代字符串匹配

插件系统的错误处理使用了一个精心设计的 discriminated union：

```typescript
export type PluginError =
  | { type: 'path-not-found'; source: string; path: string; component: PluginComponent }
  | { type: 'git-auth-failed'; source: string; gitUrl: string; authType: 'ssh' | 'https' }
  | { type: 'git-timeout'; source: string; gitUrl: string; operation: 'clone' | 'pull' }
  | { type: 'manifest-parse-error'; source: string; parseError: string }
  | { type: 'plugin-not-found'; source: string; pluginId: string; marketplace: string }
  | { type: 'marketplace-blocked-by-policy'; source: string; marketplace: string }
  | { type: 'dependency-unsatisfied'; source: string; dependency: string; reason: 'not-enabled' | 'not-found' }
  | { type: 'mcp-server-suppressed-duplicate'; source: string; serverName: string; duplicateOf: string }
  | { type: 'generic-error'; source: string; error: string }
  // ... 总计 20+ 种具体错误类型
```

每种错误类型携带其特定的上下文数据。例如 `git-auth-failed` 包含 `authType`（ssh 还是 https），让 UI 可以给出精准的修复建议。

`getPluginErrorMessage()` 提供统一的错误消息生成：

```typescript
export function getPluginErrorMessage(error: PluginError): string {
  switch (error.type) {
    case 'mcp-server-suppressed-duplicate': {
      const dup = error.duplicateOf.startsWith('plugin:')
        ? `server provided by plugin "${error.duplicateOf.split(':')[1]}"`
        : `already-configured "${error.duplicateOf}"`
      return `MCP server "${error.serverName}" skipped — same command/URL as ${dup}`
    }
    // ...
  }
}
```

> **设计决策**：源码注释明确标注了"目前生产使用 2 种，计划未来使用 10 种"。预先定义但不立即全部使用的错误类型，让重构可以渐进进行（每次改一个 error creation site），同时保持 UI 层的格式化逻辑是类型完备的。

---

## 23.7 配置迁移系统

### 23.7.1 为什么需要迁移

Claude Code 的每次重大版本更新都可能引入破坏性变更：

| 变更类型 | 示例 | 影响 |
|---------|------|------|
| 模型重命名 | `fennec-latest` → `opus` | 用户 settings 中的 model 字段失效 |
| 模型升级 | Sonnet 4.5 → Sonnet 4.6 | `sonnet` 别名指向新模型，旧用户需要被迁移 |
| 配置字段移动 | `bypassPermissionsModeAccepted` → `skipDangerousModePermissionPrompt` | 旧字段在 globalConfig，新字段在 settings.json |
| 功能重命名 | `replBridgeEnabled` → `remoteControlAtStartup` | 实现细节泄露到了用户配置 |
| 行为变更 | autoUpdates 逻辑调整 | 需要将旧的禁用方式迁移到新方式 |

没有迁移系统，用户在升级后会遇到：模型名无法识别、配置不生效、旧设置残留等问题。

### 23.7.2 迁移函数的模式

所有 11 个迁移函数遵循统一的设计模式：

```
┌──────────────────────────────────────────────┐
│              迁移函数模板                       │
│                                              │
│  1. 前置条件检查（幂等性守卫）                  │
│     - 已完成标记？ return                      │
│     - 不适用的用户类型？ return                 │
│     - 旧值不存在？ return                      │
│                                              │
│  2. 读取旧值                                  │
│     - 只读 userSettings（不读 merged）          │
│     - 避免将 project scope 设置提升到全局        │
│                                              │
│  3. 计算新值                                  │
│     - 映射旧值到新值                           │
│     - 处理边界情况                             │
│                                              │
│  4. 写入新值                                  │
│     - updateSettingsForSource('userSettings')  │
│     - 可能同时清理旧值                         │
│                                              │
│  5. 标记完成                                  │
│     - saveGlobalConfig({ migrationComplete })  │
│     - 或依赖幂等性（新值 ≠ 旧值自然不再触发）    │
│                                              │
│  6. 遥测上报                                  │
│     - logEvent('tengu_xxx_migration', {...})   │
└──────────────────────────────────────────────┘
```

### 23.7.3 迁移案例深度解析

**案例 1：模型代号迁移 — `migrateFennecToOpus()`**

这是 Anthropic 内部人员（ant 用户）的模型代号变更：

```typescript
export function migrateFennecToOpus(): void {
  // 前置条件：仅限内部用户
  if (process.env.USER_TYPE !== 'ant') return

  const model = getSettingsForSource('userSettings')?.model
  if (typeof model === 'string') {
    if (model.startsWith('fennec-latest[1m]')) {
      updateSettingsForSource('userSettings', { model: 'opus[1m]' })
    } else if (model.startsWith('fennec-latest')) {
      updateSettingsForSource('userSettings', { model: 'opus' })
    } else if (model.startsWith('fennec-fast-latest') ||
               model.startsWith('opus-4-5-fast')) {
      // fennec-fast 和 opus-fast 都映射到 opus[1m] + 快速模式
      updateSettingsForSource('userSettings', {
        model: 'opus[1m]', fastMode: true,
      })
    }
  }
}
```

关键设计点：
- 只读 `userSettings`（不读 merged settings），避免将项目级别的设置意外提升到全局
- 不需要完成标记 — 幂等性通过"新旧值不同"自然保证
- `fennec-fast-latest` → `opus[1m]` + `fastMode: true`：一次迁移改变了两个字段

**案例 2：链式模型迁移 — Sonnet 4.5 → 4.6**

这是一个分两步完成的连环迁移：

```
步骤 1 (migrateSonnet1mToSonnet45):
  sonnet[1m] → sonnet-4-5-20250929[1m]    ← 锁定到具体版本

步骤 2 (migrateSonnet45ToSonnet46):
  sonnet-4-5-20250929[1m] → sonnet[1m]     ← 解除锁定，指向新版本
```

为什么需要两步？因为 Sonnet 4.6 1M 被提供给了不同的用户群。步骤 1 在 Sonnet 4.6 发布前锁定旧用户到 4.5 的明确版本号，步骤 2 在确认用户有权使用 4.6 1M 后再解除锁定。

```typescript
// 步骤 2: migrateSonnet45ToSonnet46
export function migrateSonnet45ToSonnet46(): void {
  if (getAPIProvider() !== 'firstParty') return
  // 仅限 Pro/Max/Team Premium 用户
  if (!isProSubscriber() && !isMaxSubscriber() && !isTeamPremiumSubscriber())
    return

  const model = getSettingsForSource('userSettings')?.model
  if (model !== 'claude-sonnet-4-5-20250929' &&
      model !== 'claude-sonnet-4-5-20250929[1m]' &&
      model !== 'sonnet-4-5-20250929' &&
      model !== 'sonnet-4-5-20250929[1m]') return

  const has1m = model.endsWith('[1m]')
  updateSettingsForSource('userSettings', {
    model: has1m ? 'sonnet[1m]' : 'sonnet',
  })

  // 新用户不需要通知
  const config = getGlobalConfig()
  if (config.numStartups > 1) {
    saveGlobalConfig(current => ({
      ...current,
      sonnet45To46MigrationTimestamp: Date.now(),  // 用于显示一次性通知
    }))
  }
}
```

**案例 3：配置结构迁移 — `migrateAutoUpdatesToSettings()`**

这是将配置从旧位置迁移到新位置的经典案例：

```typescript
export function migrateAutoUpdatesToSettings(): void {
  const globalConfig = getGlobalConfig()

  // 仅迁移用户主动禁用的情况（不迁移系统自动禁用的）
  if (globalConfig.autoUpdates !== false ||
      globalConfig.autoUpdatesProtectedForNative === true) return

  // 写入新位置
  updateSettingsForSource('userSettings', {
    env: { DISABLE_AUTOUPDATER: '1' },
  })
  process.env.DISABLE_AUTOUPDATER = '1'  // 立即生效

  // 清理旧位置
  saveGlobalConfig(current => {
    const { autoUpdates: _, autoUpdatesProtectedForNative: __, ...rest } = current
    return rest
  })
}
```

### 23.7.4 迁移执行机制

所有迁移在 `main.tsx` 的 `runMigrations()` 中同步执行：

```typescript
const CURRENT_MIGRATION_VERSION = 11

function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings()
    migrateBypassPermissionsAcceptedToSettings()
    migrateEnableAllProjectMcpServersToSettings()
    resetProToOpusDefault()
    migrateSonnet1mToSonnet45()
    migrateLegacyOpusToCurrent()
    migrateSonnet45ToSonnet46()
    migrateOpusToOpus1m()
    migrateReplBridgeEnabledToRemoteControlAtStartup()
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      resetAutoModeOptInForDefaultOffer()
    }
    if ("external" === 'ant') {
      migrateFennecToOpus()
    }
    saveGlobalConfig(prev => ({
      ...prev, migrationVersion: CURRENT_MIGRATION_VERSION
    }))
  }
}
```

关键设计特征：

1. **版本号守卫**：`migrationVersion !== CURRENT_MIGRATION_VERSION` — 只有版本不匹配时才执行全部迁移。新增迁移时 bump 版本号即可重新触发。

2. **全部重跑**：每次版本变更，所有迁移都重新执行。这依赖每个迁移函数的幂等性保证 — 已迁移的用户会在前置条件检查中被跳过。

3. **Feature gate**：某些迁移受 feature flag 保护（`feature('TRANSCRIPT_CLASSIFIER')`），只对特定用户群生效。

4. **用户类型门控**：`migrateFennecToOpus()` 只对 `ant` 用户执行（编译时常量检查）。

5. **异步迁移分离**：非关键的异步迁移（如 changelog 迁移）使用 fire-and-forget 模式，不阻塞启动。

```
┌─────────────────────────────────────────────────┐
│              迁移执行时序                          │
│                                                  │
│  CLI 启动                                        │
│    │                                             │
│    ├── 加载 GlobalConfig                          │
│    ├── 检查 migrationVersion ≠ 11 ?              │
│    │     │                                       │
│    │     ├── YES → 执行全部同步迁移               │
│    │     │         写入 migrationVersion = 11     │
│    │     │                                       │
│    │     └── NO → 跳过                            │
│    │                                             │
│    ├── fire-and-forget: migrateChangelogFromConfig│
│    │                                             │
│    └── 继续正常启动                               │
└─────────────────────────────────────────────────┘
```

### 23.7.5 迁移完整清单

| 迁移函数 | 类别 | 幂等策略 | 说明 |
|---------|------|---------|------|
| `migrateAutoUpdatesToSettings` | 配置移动 | 旧值检查 | autoUpdates 从 globalConfig 迁移到 settings.json env |
| `migrateBypassPermissionsAccepted` | 配置移动 | 旧值检查 | 权限绕过标记迁移到 settings |
| `migrateEnableAllProjectMcpServers` | 配置移动 | 旧值检查 | MCP 审批字段从 projectConfig 迁移到 localSettings |
| `resetProToOpusDefault` | 默认值变更 | 完成标记 | Pro 用户默认模型变为 Opus |
| `migrateSonnet1mToSonnet45` | 模型锁定 | 完成标记 | sonnet[1m] 锁定到 sonnet-4-5-20250929[1m] |
| `migrateLegacyOpusToCurrent` | 模型重命名 | 新旧值不同 | 清理 Opus 4.0/4.1 的显式字符串 |
| `migrateSonnet45ToSonnet46` | 模型升级 | 新旧值不同 | 解除 Sonnet 4.5 锁定，升级到 4.6 |
| `migrateOpusToOpus1m` | 模型合并 | 新旧值不同 | Opus 用户合并到 Opus 1M 体验 |
| `migrateReplBridgeEnabled` | 字段重命名 | 旧值检查 | 实现细节名 → 用户友好名 |
| `resetAutoModeOptIn` | 行为重置 | 完成标记 | 重置自动模式选择，显示新选项 |
| `migrateFennecToOpus` | 内部代号 | 新旧值不同 | Fennec 内部代号 → Opus 公开名 |

---

## 23.8 原生模块 TS 移植

### 23.8.1 为什么从 Rust NAPI 迁移到纯 TS

Claude Code 早期使用 Rust NAPI 模块实现三个性能敏感功能：语法高亮差异计算（color-diff）、模糊文件搜索（file-index）、和布局引擎（yoga-layout）。迁移到纯 TypeScript 的动机包括：

- **安装复杂性**：NAPI 模块需要为每个目标平台预编译二进制，或者用户机器上需要有 Rust 工具链。这在企业防火墙、无网络环境、ARM Linux 等场景下是重大摩擦源。
- **调试困难**：Rust 模块的错误堆栈不透明，崩溃时难以定位。
- **维护成本**：同时维护 Rust + TypeScript 两个生态的构建系统、CI、测试。

纯 TS 实现虽然理论上性能稍低，但在实际使用中足够快 — JavaScript 引擎（V8/JSC）对字符串操作和数组遍历有高度优化。

### 23.8.2 color-diff：语法高亮差异引擎

`src/native-ts/color-diff/index.ts` 是一个 900+ 行的精密移植，完整替换了原来的 Rust `syntect` + `similar` 实现。

**核心架构**：

```
┌──────────────────────────────────────────────────────────┐
│                     ColorDiff                             │
│                                                          │
│  Input: Hunk (unified diff) + file path                  │
│                                                          │
│  ┌──────────┐    ┌────────────┐    ┌──────────────┐     │
│  │ Language  │ →  │  Syntax    │ →  │  Word Diff   │     │
│  │ Detect    │    │  Highlight │    │  (diffArrays)│     │
│  └──────────┘    └────────────┘    └──────────────┘     │
│       │                │                  │              │
│       │         highlight.js         npm 'diff'          │
│       │         (lazy loaded)        package              │
│       │                                                  │
│  ┌──────────┐    ┌────────────┐    ┌──────────────┐     │
│  │  Theme   │ →  │  Line      │ →  │  ANSI        │     │
│  │  Colors  │    │  Wrapping   │    │  Escape      │     │
│  └──────────┘    └────────────┘    └──────────────┘     │
│                                                          │
│  Output: string[] (ANSI-colored terminal lines)          │
└──────────────────────────────────────────────────────────┘
```

**highlight.js 的惰性加载**：

highlight.js 注册 190+ 种语言语法，完整加载需要 ~50MB 内存和 100-200ms。Claude Code 使用延迟初始化避免启动时的性能惩罚：

```typescript
let cachedHljs: HLJSApi | null = null
function hljs(): HLJSApi {
  if (cachedHljs) return cachedHljs
  const mod = require('highlight.js')
  // highlight.js uses `export =` (CJS). Under bun/ESM the interop wraps it
  // in .default; under node CJS the module IS the API.
  cachedHljs = 'default' in mod && mod.default ? mod.default : mod
  return cachedHljs!
}
```

**syntect 色彩精确还原**：

TS 移植通过手工测量 Rust syntect 的输出颜色来映射 highlight.js 的 scope：

```typescript
// Monokai Extended 主题色值（从 Rust 输出精确测量）
const MONOKAI_SCOPES: Record<string, Color> = {
  keyword:            rgb(249, 38, 114),   // 粉红色关键字
  built_in:           rgb(166, 226, 46),   // 绿色内置函数
  number:             rgb(190, 132, 255),   // 紫色数字
  string:             rgb(230, 219, 116),   // 黄色字符串
  comment:            rgb(117, 113, 94),    // 灰色注释
  'title.function':   rgb(166, 226, 46),   // 绿色函数名
  params:             rgb(253, 151, 31),    // 橙色参数
  // ...
}
```

**256 色近似算法**：

当终端不支持 truecolor 时，需要将 RGB 映射到 xterm-256 调色板。TS 实现移植了 Rust `ansi_colours` crate 的算法：

```typescript
// 比较 6×6×6 色彩立方体和 24 级灰度，选择感知上最接近的索引
function ansi256FromRgb(r: number, g: number, b: number): number {
  const q = (c: number) =>
    c < 48 ? 0 : c < 115 ? 1 : c < 155 ? 2 : c < 195 ? 3 : c < 235 ? 4 : 5
  const qr = q(r), qg = q(g), qb = q(b)
  const cubeIdx = 16 + 36 * qr + 6 * qg + qb

  const grey = Math.round((r + g + b) / 3)
  const greyLevel = Math.max(0, Math.min(23, Math.round((grey - 8) / 10)))
  const greyIdx = 232 + greyLevel
  const greyRgb = 8 + greyLevel * 10

  // 比较两个候选的欧氏距离
  const dCube = (r - CUBE_LEVELS[qr]) ** 2 + (g - CUBE_LEVELS[qg]) ** 2 + ...
  const dGrey = (r - greyRgb) ** 2 + (g - greyRgb) ** 2 + (b - greyRgb) ** 2
  return dGrey < dCube ? greyIdx : cubeIdx
}
```

### 23.8.3 file-index：模糊文件搜索

`src/native-ts/file-index/index.ts` 替换了原来基于 `nucleo`（Helix 编辑器的模糊搜索引擎）的 Rust 实现。

**评分算法**：

采用 fzf-v2 风格的评分体系，五种加分/扣分：

```typescript
const SCORE_MATCH = 16           // 每个匹配字符的基础分
const BONUS_BOUNDARY = 8         // 匹配在单词边界处 (/, _, -, .)
const BONUS_CAMEL = 6            // 匹配在 camelCase 大写处
const BONUS_CONSECUTIVE = 4      // 连续匹配
const BONUS_FIRST_CHAR = 8       // 匹配在首字符
const PENALTY_GAP_START = 3      // 间隙开始
const PENALTY_GAP_EXTENSION = 1  // 间隙延续
```

**O(1) bitmap 预过滤**：

每个路径预计算一个 26-bit 的字母存在位图，搜索时用位运算快速排除不可能匹配的路径：

```typescript
// 索引阶段：构建 a-z 位图
private indexPath(i: number): void {
  const lp = this.paths[i]!.toLowerCase()
  let bits = 0
  for (let j = 0; j < lp.length; j++) {
    const c = lp.charCodeAt(j)
    if (c >= 97 && c <= 122) bits |= 1 << (c - 97)
  }
  this.charBits[i] = bits
}

// 搜索阶段：O(1) 排除
for (let i = 0; i < readyCount; i++) {
  if ((charBits[i]! & needleBitmap) !== needleBitmap) continue  // 快速跳过
  // ... 详细评分
}
```

对于宽泛查询（如 "test"），bitmap 可以过滤掉 10%+ 的路径；对于包含稀有字母的查询，过滤率可达 90%+。

**Top-K 优化**：

搜索结果使用维护排序的 top-k 数组而非全排序：

```typescript
// 提前计算分数上限，结合已知的间隙惩罚做剪枝
const scoreCeiling =
  nLen * (SCORE_MATCH + BONUS_BOUNDARY) + BONUS_FIRST_CHAR + 32

// 如果 best-case score ≤ 当前 top-k 的最低分，跳过详细评分
if (topK.length === limit &&
    scoreCeiling + consecBonus - gapPenalty <= threshold) continue
```

**异步构建**：

对于大型代码库（270k+ 文件），索引构建使用时间片让出事件循环：

```typescript
loadFromFileListAsync(fileList: string[]): {
  queryable: Promise<void>  // 第一批索引完成，可以开始查询
  done: Promise<void>       // 全部索引完成
}

// 时间片长度根据机器性能自适应
const CHUNK_MS = 4  // 每 4ms 让出一次
```

`queryable` 和 `done` 双 Promise 设计让 UI 可以在索引未完成时就显示部分结果。

### 23.8.4 yoga-layout

`src/native-ts/yoga-layout/` 包含两个文件（`enums.ts` + `index.ts`，共 ~89k 行），是 Facebook Yoga 布局引擎的 TypeScript 移植。Yoga 原本是 C++ 实现，用于计算 flexbox 布局。Claude Code 的终端 UI（基于 Ink/React）需要它来计算组件在终端中的位置和大小。

---

## 23.9 /plugin 命令界面

### 23.9.1 命令入口

```typescript
// src/commands/plugin/index.tsx
const plugin = {
  type: 'local-jsx',
  name: 'plugin',
  aliases: ['plugins', 'marketplace'],
  description: 'Manage Claude Code plugins',
  immediate: true,
  load: () => import('./plugin.js')
} satisfies Command
```

用户可以通过 `/plugin`、`/plugins` 或 `/marketplace` 进入插件管理界面。

### 23.9.2 CLI 子命令

通过 `pluginCliCommands.ts` 提供非交互式 CLI 命令：

```bash
claude plugin install <name>[@marketplace] [--scope user|project|local]
claude plugin uninstall <name> [--scope user]
claude plugin enable <name> [--scope user]
claude plugin disable <name>
claude plugin disable-all
claude plugin update <name> [--scope user|project|local|managed]
```

每个命令的实现模式一致：调用 `pluginOperations.ts` 中的纯函数 → 打印结果 → 记录遥测 → 退出。

```typescript
export async function installPlugin(
  plugin: string, scope: InstallableScope = 'user'
): Promise<void> {
  try {
    const result = await installPluginOp(plugin, scope)
    if (!result.success) throw new Error(result.message)
    console.log(`${figures.tick} ${result.message}`)
    logEvent('tengu_plugin_installed_cli', { ... })
    process.exit(0)
  } catch (error) {
    handlePluginCommandError(error, 'install', plugin)
  }
}
```

> **设计决策**：为什么 `pluginOperations.ts` 和 `pluginCliCommands.ts` 是分离的？前者提供不含副作用的纯库函数（不 console.log、不 process.exit），后者是薄包装层。这让交互式 UI（ManagePlugins.tsx）可以直接调用前者而不触发 process.exit。

---

## 23.10 章末速查

### 插件系统关键类型

| 类型 | 文件 | 用途 |
|------|------|------|
| `BuiltinPluginDefinition` | `types/plugin.ts` | 内置插件定义（skills + hooks + MCP） |
| `LoadedPlugin` | `types/plugin.ts` | 运行时加载后的统一插件对象 |
| `PluginManifest` | `utils/plugins/schemas.ts` | plugin.json 的验证 Schema |
| `PluginError` (20+ 种) | `types/plugin.ts` | 类型安全的错误联合 |
| `PluginComponent` | `types/plugin.ts` | 5 种组件类型标识 |

### 插件安装作用域

| Scope | 文件 | 团队共享 | 优先级 |
|-------|------|---------|-------|
| `user` | `~/.claude/settings.json` | 否 | 最低 |
| `project` | `.claude/settings.json` | 是 | 中 |
| `local` | `.claude/settings.local.json` | 否 | 最高 |

### 迁移系统速查

| 关键概念 | 说明 |
|---------|------|
| `CURRENT_MIGRATION_VERSION` | 当前版本号 = 11，bump 后重跑全部迁移 |
| 幂等性 | 三种策略：完成标记、旧值检查、新旧值不同 |
| 作用域隔离 | 只读/写 `userSettings`，不触碰 project/local |
| 遥测 | 每个迁移都上报 `logEvent('tengu_xxx_migration')` |
| Feature gate | 部分迁移受 feature flag 或用户类型门控 |

### 原生模块移植速查

| 模块 | Rust 原版 | TS 替代 | 关键技术 |
|------|-----------|---------|---------|
| color-diff | syntect + similar | highlight.js + diff | 惰性加载、色彩精确映射、256 色近似 |
| file-index | nucleo | 自研 fzf-v2 风格 | bitmap 预过滤、top-k 剪枝、异步构建 |
| yoga-layout | yoga-cpp NAPI | 纯 TS 移植 | flexbox 布局引擎 |

---

> **设计决策总结**：Claude Code 的扩展性设计遵循一个核心原则 — **声明优先，渐进物化**。插件通过 settings.json 声明启用意图，marketplace 后台异步物化；迁移通过版本号声明需要重跑，每个迁移函数自行保证幂等性。这种"意图与物化分离"的模式让系统在启动速度、错误恢复、和离线可用性之间找到了良好的平衡。
