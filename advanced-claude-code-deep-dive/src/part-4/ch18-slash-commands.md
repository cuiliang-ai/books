
# 第 18 章：Slash 命令与 Skill 系统 — 可编程的对话扩展

> **核心问题**：用户如何通过 `/commit`、`/review` 这样的斜杠命令扩展 Claude Code 的能力？模型如何在运行时发现并调用合适的 Skill？系统如何统一管理来自 80+ 内置命令、用户自定义 Skill、Plugin 和 Bundled Skill 等多种来源的命令？

Claude Code 的命令系统是一个分层可扩展的架构：底层是统一的 `Command` 类型系统，中间是多源命令加载与合并引擎，上层是面向用户的斜杠命令 UI 和面向模型的 Skill Tool 调用接口。本章深入解析这套命令与 Skill 系统的完整架构。

---

## 18.1 架构概览

```
┌──────────────────────────────────────────────────────────┐
│                     用户输入 / 模型调用                     │
│                                                            │
│  用户 → /command args          模型 → Skill("name", args)  │
│         │                              │                   │
│  ┌──────▼──────────────────────────────▼───────────────┐  │
│  │            getCommands(cwd): Command[]               │  │
│  │                                                      │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │          loadAllCommands(cwd) [memoized]       │  │  │
│  │  │                                                │  │  │
│  │  │  ┌──────────┐ ┌────────────┐ ┌────────────┐  │  │  │
│  │  │  │ Bundled  │ │ BuiltIn    │ │ Skill Dir  │  │  │  │
│  │  │  │ Skills   │ │ Plugin     │ │ Commands   │  │  │  │
│  │  │  │          │ │ Skills     │ │            │  │  │  │
│  │  │  └──────────┘ └────────────┘ └────────────┘  │  │  │
│  │  │  ┌──────────┐ ┌────────────┐ ┌────────────┐  │  │  │
│  │  │  │ Workflow │ │ Plugin     │ │ Built-in   │  │  │  │
│  │  │  │ Commands │ │ Commands   │ │ COMMANDS() │  │  │  │
│  │  │  └──────────┘ └────────────┘ └────────────┘  │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  │                                                      │  │
│  │  + getDynamicSkills()    ← 运行时动态发现             │  │
│  │  + getMcpSkillCommands() ← MCP 提供的 Skill           │  │
│  │                                                      │  │
│  │  过滤: meetsAvailabilityRequirement() × isEnabled()   │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  三种命令类型:                                              │
│  ┌────────────────┬────────────────┬─────────────────────┐ │
│  │ prompt         │ local          │ local-jsx            │ │
│  │ 文本扩展→模型  │ 同步执行       │ JSX UI 渲染          │ │
│  │ Skill 的载体   │ 返回文本结果   │ Ink 组件交互         │ │
│  └────────────────┴────────────────┴─────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

---

## 18.2 Command 类型系统

### CommandBase — 所有命令的公共属性

```typescript
// src/types/command.ts
export type CommandBase = {
  availability?: CommandAvailability[]  // 'claude-ai' | 'console'
  description: string
  hasUserSpecifiedDescription?: boolean
  isEnabled?: () => boolean            // 默认 true，条件启用
  isHidden?: boolean                   // 默认 false
  name: string
  aliases?: string[]
  argumentHint?: string               // 参数提示（如 "branch name"）
  whenToUse?: string                  // 详细使用场景描述
  version?: string
  disableModelInvocation?: boolean    // 禁止模型调用
  userInvocable?: boolean             // 用户可通过 /name 调用
  loadedFrom?: 'commands_DEPRECATED' | 'skills' | 'plugin'
    | 'managed' | 'bundled' | 'mcp'   // 来源标识
  kind?: 'workflow'                   // 工作流类型标记
  immediate?: boolean                 // 立即执行，不排队
  isSensitive?: boolean               // 参数脱敏
  userFacingName?: () => string       // 用户可见名称
}
```

### 三种命令实现类型

```typescript
// src/types/command.ts

// 1. Prompt 命令 — Skill 的载体
export type PromptCommand = {
  type: 'prompt'
  progressMessage: string
  contentLength: number          // 用于 token 估算
  argNames?: string[]            // 命名参数
  allowedTools?: string[]        // 允许的工具子集
  model?: string                 // 指定模型
  source: SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'
  hooks?: HooksSettings          // Skill 专属 hooks
  skillRoot?: string             // Skill 资源目录
  context?: 'inline' | 'fork'   // 执行上下文
  agent?: string                 // Fork 时使用的 agent 类型
  effort?: EffortValue
  paths?: string[]               // 条件激活路径
  getPromptForCommand(
    args: string, context: ToolUseContext
  ): Promise<ContentBlockParam[]>
}

// 2. Local 命令 — 同步执行
type LocalCommand = {
  type: 'local'
  supportsNonInteractive: boolean
  load: () => Promise<LocalCommandModule>  // 懒加载
}

// 3. Local-JSX 命令 — UI 交互
type LocalJSXCommand = {
  type: 'local-jsx'
  load: () => Promise<LocalJSXCommandModule>
}

// 最终类型 = 基础 + 三选一
export type Command = CommandBase &
  (PromptCommand | LocalCommand | LocalJSXCommand)
```

> **设计决策**：`load()` 使用懒加载模式 — 命令的实现模块在调用时才 `import()`。这对于有 80+ 命令的系统至关重要，因为很多命令（如 `/doctor`、`/config`）有大量依赖，但用户一次会话中可能只用到 3-5 个。

---

## 18.3 命令注册机制

### COMMANDS() — 内置命令注册表

内置命令通过一个 `memoize` 包装的函数注册：

```typescript
// src/commands.ts
const COMMANDS = memoize((): Command[] => [
  addDir,
  advisor,
  agents,
  branch,
  btw,
  chrome,
  clear,
  color,
  compact,
  config,
  // ... 80+ 内置命令 ...
  tasks,
  // Feature-gated 命令
  ...(proactive ? [proactive] : []),
  ...(bridge ? [bridge] : []),
  ...(voiceCommand ? [voiceCommand] : []),
  // ANT-ONLY 内部命令
  ...(process.env.USER_TYPE === 'ant' && !process.env.IS_DEMO
    ? INTERNAL_ONLY_COMMANDS
    : []),
])
```

> **设计决策**：`COMMANDS` 是一个 `memoize` 函数而非常量数组，因为底层函数（如 `isUsing3PServices()`）读取配置，而配置在模块初始化阶段尚不可用。延迟到首次调用时才执行确保了配置已就绪。

### Feature-Gated 命令

通过 `bun:bundle` 的 `feature()` 实现编译时死代码消除：

```typescript
// src/commands.ts
import { feature } from 'bun:bundle'

// 编译时条件导入 — 未启用的 feature 整个模块被消除
const proactive =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./commands/proactive.js').default
    : null

const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null
```

### 内部专用命令

```typescript
// src/commands.ts
export const INTERNAL_ONLY_COMMANDS = [
  backfillSessions,
  breakCache,
  bughunter,
  commit,
  commitPushPr,
  ctx_viz,
  goodClaude,
  issue,
  initVerifiers,
  mockLimits,
  // ... 只在 USER_TYPE=ant 时可用
].filter(Boolean)
```

### Availability 过滤

命令可以声明自己的可用性要求：

```typescript
// src/commands.ts
export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability) return true
  for (const a of cmd.availability) {
    switch (a) {
      case 'claude-ai':
        if (isClaudeAISubscriber()) return true
        break
      case 'console':
        // Console API key user = 直接 API 客户
        // 排除 3P (Bedrock/Vertex/Foundry)
        if (!isClaudeAISubscriber() && !isUsing3PServices()
            && isFirstPartyAnthropicBaseUrl())
          return true
        break
    }
  }
  return false
}
```

---

## 18.4 Skill 加载系统

### 加载源和优先级

Skill 从多个来源加载，按以下顺序合并：

```
loadAllCommands(cwd)
    │
    ├── 1. getBundledSkills()          ← 编译时内置
    ├── 2. getBuiltinPluginSkillCommands()  ← 内置 Plugin
    ├── 3. getSkillDirCommands(cwd)    ← 用户/项目 Skill 目录
    ├── 4. getWorkflowCommands(cwd)    ← Workflow 脚本
    ├── 5. getPluginCommands()         ← Plugin 命令
    ├── 6. getPluginSkills()           ← Plugin Skill
    └── 7. COMMANDS()                  ← 内置命令（最后）
```

> **设计决策**：Bundled Skills 排在最前面，内置命令排在最后。这意味着用户自定义的 Skill 可以覆盖内置命令的同名定义，实现个性化定制。

### Skill 目录格式

Skill 使用标准目录格式：

```
.claude/skills/
    └── my-skill/
        ├── SKILL.md         ← 必须存在
        └── helper-script.sh  ← 可选附件
```

`SKILL.md` 支持 YAML frontmatter：

```markdown
---
description: Deploy to production
allowed-tools: [Bash, Write]
argument-hint: <environment>
arguments: [environment, region]
when_to_use: When deploying to production
model: sonnet
disable-model-invocation: false
user-invocable: true
context: fork
agent: Bash
effort: high
paths: ["src/deploy/**"]
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: "echo safety check"
shell: bash
---

Deploy the application to the $ARGUMENTS environment.

Use `${CLAUDE_SKILL_DIR}/helper-script.sh` for setup.
```

### getSkillDirCommands() — 核心加载函数

```typescript
// src/skills/loadSkillsDir.ts
export const getSkillDirCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    const userSkillsDir = join(getClaudeConfigHomeDir(), 'skills')
    const managedSkillsDir = join(getManagedFilePath(), '.claude', 'skills')
    const projectSkillsDirs = getProjectDirsUpToHome('skills', cwd)

    // 策略锁定检查
    const skillsLocked = isRestrictedToPluginOnly('skills')
    const projectSettingsEnabled =
      isSettingSourceEnabled('projectSettings') && !skillsLocked

    // --bare 模式：跳过自动发现，仅加载 --add-dir
    if (isBareMode()) {
      // ...简化的加载逻辑
    }

    // 并行加载所有来源
    const [
      managedSkills,      // policy 托管的 skills
      userSkills,         // ~/.claude/skills/
      projectSkillsNested,// .claude/skills/ (向上遍历)
      additionalSkillsNested, // --add-dir 路径
      legacyCommands,     // 旧版 /commands/ 目录
    ] = await Promise.all([
      loadSkillsFromSkillsDir(managedSkillsDir, 'policySettings'),
      loadSkillsFromSkillsDir(userSkillsDir, 'userSettings'),
      // ... 项目和附加目录 ...
      loadSkillsFromCommandsDir(cwd),  // 旧版兼容
    ])

    // 通过 realpath 去重（处理符号链接和重复目录）
    // ...

    // 分离条件 Skill（有 paths frontmatter）
    const unconditionalSkills: Command[] = []
    const newConditionalSkills: Command[] = []
    for (const skill of deduplicatedSkills) {
      if (skill.paths && skill.paths.length > 0
          && !activatedConditionalSkillNames.has(skill.name)) {
        newConditionalSkills.push(skill)
      } else {
        unconditionalSkills.push(skill)
      }
    }

    return unconditionalSkills
  },
)
```

### getSkillsPath() — 来源路径映射

```typescript
// src/skills/loadSkillsDir.ts
export function getSkillsPath(
  source: SettingSource | 'plugin',
  dir: 'skills' | 'commands',
): string {
  switch (source) {
    case 'policySettings':
      return join(getManagedFilePath(), '.claude', dir)
    case 'userSettings':
      return join(getClaudeConfigHomeDir(), dir)
    case 'projectSettings':
      return `.claude/${dir}`
    case 'plugin':
      return 'plugin'
    default:
      return ''
  }
}
```

---

## 18.5 Skill Frontmatter 解析

### parseSkillFrontmatterFields()

所有 Skill 来源（文件、MCP）共用的 frontmatter 解析器：

```typescript
// src/skills/loadSkillsDir.ts
export function parseSkillFrontmatterFields(
  frontmatter: FrontmatterData,
  markdownContent: string,
  resolvedName: string,
  descriptionFallbackLabel: 'Skill' | 'Custom command' = 'Skill',
): {
  displayName: string | undefined
  description: string
  hasUserSpecifiedDescription: boolean
  allowedTools: string[]
  argumentHint: string | undefined
  argumentNames: string[]
  whenToUse: string | undefined
  version: string | undefined
  model: ... | undefined
  disableModelInvocation: boolean
  userInvocable: boolean
  hooks: HooksSettings | undefined
  executionContext: 'fork' | undefined
  agent: string | undefined
  effort: EffortValue | undefined
  shell: FrontmatterShell | undefined
} {
  // description 回退链：
  // 1. frontmatter.description（用户指定）
  // 2. extractDescriptionFromMarkdown()（从正文第一行提取）
  const validatedDescription = coerceDescriptionToString(
    frontmatter.description, resolvedName)
  const description = validatedDescription ??
    extractDescriptionFromMarkdown(markdownContent, descriptionFallbackLabel)

  // model 处理：'inherit' = 使用父级模型
  const model = frontmatter.model === 'inherit'
    ? undefined
    : frontmatter.model
      ? parseUserSpecifiedModel(frontmatter.model as string)
      : undefined

  // hooks 验证：通过 Zod schema 验证
  const hooks = parseHooksFromFrontmatter(frontmatter, resolvedName)

  // effort 验证
  const effort = effortRaw !== undefined
    ? parseEffortValue(effortRaw) : undefined

  return { displayName, description, allowedTools, ... }
}
```

### Skill Hooks 支持

每个 Skill 可以定义自己的 hooks，在 Skill 执行期间生效：

```typescript
// src/skills/loadSkillsDir.ts
function parseHooksFromFrontmatter(
  frontmatter: FrontmatterData,
  skillName: string,
): HooksSettings | undefined {
  if (!frontmatter.hooks) return undefined

  const result = HooksSchema().safeParse(frontmatter.hooks)
  if (!result.success) {
    logForDebugging(
      `Invalid hooks in skill '${skillName}': ${result.error.message}`)
    return undefined
  }
  return result.data
}
```

---

## 18.6 createSkillCommand() — Skill 到 Command 的转换

`createSkillCommand()` 是将解析后的 Skill 数据转化为统一 `Command` 对象的核心函数：

```typescript
// src/skills/loadSkillsDir.ts
export function createSkillCommand({
  skillName, displayName, description, markdownContent,
  allowedTools, source, baseDir, loadedFrom, hooks,
  executionContext, agent, paths, effort, shell,
  // ... 更多字段
}): Command {
  return {
    type: 'prompt',
    name: skillName,
    description,
    hasUserSpecifiedDescription,
    allowedTools,
    contentLength: markdownContent.length,
    source,
    loadedFrom,
    hooks,
    skillRoot: baseDir,
    context: executionContext,
    agent,
    paths,
    effort,

    async getPromptForCommand(args, toolUseContext) {
      let finalContent = baseDir
        ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
        : markdownContent

      // 1. 参数替换：$ARGUMENTS → 用户输入
      finalContent = substituteArguments(
        finalContent, args, true, argumentNames)

      // 2. ${CLAUDE_SKILL_DIR} → Skill 目录路径
      if (baseDir) {
        const skillDir = process.platform === 'win32'
          ? baseDir.replace(/\\/g, '/') : baseDir
        finalContent = finalContent.replace(
          /\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
      }

      // 3. ${CLAUDE_SESSION_ID} → 当前会话 ID
      finalContent = finalContent.replace(
        /\$\{CLAUDE_SESSION_ID\}/g, getSessionId())

      // 4. 执行内嵌 shell 命令（!`...` 语法）
      // 安全：MCP skills 禁止执行 shell 命令
      if (loadedFrom !== 'mcp') {
        finalContent = await executeShellCommandsInPrompt(
          finalContent, {
            ...toolUseContext,
            getAppState() {
              // 注入 Skill 的 allowedTools 到权限上下文
              return { ...appState,
                toolPermissionContext: {
                  ...appState.toolPermissionContext,
                  alwaysAllowRules: {
                    ...appState.toolPermissionContext.alwaysAllowRules,
                    command: allowedTools,
                  },
                },
              }
            },
          },
          `/${skillName}`, shell)
      }

      return [{ type: 'text', text: finalContent }]
    },
  } satisfies Command
}
```

> **设计决策**：MCP Skills 的 Markdown 内容中的 `!`...`` 内嵌 shell 命令会被跳过执行。这是因为 MCP Skills 来自远程且不受信任 — 允许它们执行 shell 命令将构成远程代码执行漏洞。`${CLAUDE_SKILL_DIR}` 对 MCP Skills 也无意义。

---

## 18.7 Bundled Skills — 编译时内置 Skill

### BundledSkillDefinition

```typescript
// src/skills/bundledSkills.ts
export type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string
  allowedTools?: string[]
  model?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  isEnabled?: () => boolean
  hooks?: HooksSettings
  context?: 'inline' | 'fork'
  agent?: string
  files?: Record<string, string>  // 附件文件
  getPromptForCommand: (
    args: string, context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}
```

### 注册与文件提取

```typescript
// src/skills/bundledSkills.ts
const bundledSkills: Command[] = []

export function registerBundledSkill(
  definition: BundledSkillDefinition
): void {
  const { files } = definition
  let skillRoot: string | undefined
  let getPromptForCommand = definition.getPromptForCommand

  if (files && Object.keys(files).length > 0) {
    skillRoot = getBundledSkillExtractDir(definition.name)
    // 懒提取：首次调用时解压文件到磁盘
    let extractionPromise: Promise<string | null> | undefined
    const inner = definition.getPromptForCommand
    getPromptForCommand = async (args, ctx) => {
      extractionPromise ??= extractBundledSkillFiles(
        definition.name, files)
      const extractedDir = await extractionPromise
      const blocks = await inner(args, ctx)
      if (extractedDir === null) return blocks
      return prependBaseDir(blocks, extractedDir)
    }
  }

  bundledSkills.push({
    type: 'prompt',
    name: definition.name,
    source: 'bundled',
    loadedFrom: 'bundled',
    skillRoot,
    getPromptForCommand,
    // ...
  } satisfies Command)
}
```

### 安全的文件写入

Bundled Skill 的附件文件使用安全写入策略：

```typescript
// src/skills/bundledSkills.ts
async function safeWriteFile(p: string, content: string): Promise<void> {
  // O_NOFOLLOW | O_EXCL：不跟随符号链接，文件已存在则失败
  const fh = await open(p, SAFE_WRITE_FLAGS, 0o600)
  try {
    await fh.writeFile(content, 'utf8')
  } finally {
    await fh.close()
  }
}

// 路径验证：防止路径遍历攻击
function resolveSkillFilePath(
  baseDir: string, relPath: string
): string {
  const normalized = normalize(relPath)
  if (isAbsolute(normalized)
      || normalized.split(pathSep).includes('..')
      || normalized.split('/').includes('..')) {
    throw new Error(
      `bundled skill file path escapes skill dir: ${relPath}`)
  }
  return join(baseDir, normalized)
}
```

> **设计决策**：`O_NOFOLLOW` + `O_EXCL` + `0o600` 权限 + 路径遍历检查 = 四重防护。`getBundledSkillsRoot()` 中的 per-process 随机 nonce 是主要防线（防止预先植入符号链接），显式的文件标志是纵深防御。

---

## 18.8 动态 Skill 发现

### 基于文件操作的发现

当 Agent 操作文件时，系统会检查文件路径附近是否有未知的 `.claude/skills/` 目录：

```typescript
// src/skills/loadSkillsDir.ts
export async function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
): Promise<string[]> {
  const resolvedCwd = cwd.endsWith(pathSep) ? cwd.slice(0, -1) : cwd
  const newDirs: string[] = []

  for (const filePath of filePaths) {
    let currentDir = dirname(filePath)

    // 向上遍历到 cwd（不含 cwd — cwd 级别的已在启动时加载）
    while (currentDir.startsWith(resolvedCwd + pathSep)) {
      const skillDir = join(currentDir, '.claude', 'skills')

      if (!dynamicSkillDirs.has(skillDir)) {
        dynamicSkillDirs.add(skillDir)  // 记录已检查（避免重复 stat）
        try {
          await fs.stat(skillDir)
          // 检查 gitignore — 阻止 node_modules 中的 skill 加载
          if (await isPathGitignored(currentDir, resolvedCwd)) continue
          newDirs.push(skillDir)
        } catch { /* 目录不存在 */ }
      }

      const parent = dirname(currentDir)
      if (parent === currentDir) break
      currentDir = parent
    }
  }

  // 深度优先排序（离文件最近的优先）
  return newDirs.sort(
    (a, b) => b.split(pathSep).length - a.split(pathSep).length)
}
```

### 条件 Skill 激活

带 `paths` frontmatter 的 Skill 只在匹配文件被触摸时激活：

```typescript
// src/skills/loadSkillsDir.ts
export function activateConditionalSkillsForPaths(
  filePaths: string[],
  cwd: string,
): string[] {
  if (conditionalSkills.size === 0) return []

  const activated: string[] = []

  for (const [name, skill] of conditionalSkills) {
    if (!skill.paths || skill.paths.length === 0) continue

    // 使用 gitignore 风格的匹配器
    const skillIgnore = ignore().add(skill.paths)
    for (const filePath of filePaths) {
      const relativePath = isAbsolute(filePath)
        ? relative(cwd, filePath) : filePath

      if (skillIgnore.ignores(relativePath)) {
        // 激活：从 conditional → dynamic
        dynamicSkills.set(name, skill)
        conditionalSkills.delete(name)
        activatedConditionalSkillNames.add(name)
        activated.push(name)
        break
      }
    }
  }

  if (activated.length > 0) {
    skillsLoaded.emit()  // 通知缓存失效
  }

  return activated
}
```

```
Skill 生命周期:
                              ┌────────────┐
                              │  SKILL.md  │
                              │  有 paths  │
                              └─────┬──────┘
                                    │
                              loadSkillsDir()
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
           无 paths frontmatter              有 paths frontmatter
                    │                               │
                    ▼                               ▼
           ┌────────────┐               ┌──────────────────┐
           │ 无条件加载 │               │ conditionalSkills │
           │ 立即可用   │               │ Map（待激活）    │
           └────────────┘               └────────┬─────────┘
                                                  │
                                        文件操作触发匹配
                                                  │
                                                  ▼
                                        ┌──────────────────┐
                                        │ dynamicSkills    │
                                        │ Map（已激活）    │
                                        └──────────────────┘
                                                  │
                                         skillsLoaded.emit()
                                                  │
                                          缓存失效 → 重新加载
```

---

## 18.9 命令合并与过滤

### getCommands() — 最终命令列表

```typescript
// src/commands.ts
export async function getCommands(cwd: string): Promise<Command[]> {
  // 1. 加载所有命令（memoized，避免重复 I/O）
  const allCommands = await loadAllCommands(cwd)

  // 2. 获取动态发现的 skills
  const dynamicSkills = getDynamicSkills()

  // 3. 过滤：availability + isEnabled
  const baseCommands = allCommands.filter(
    _ => meetsAvailabilityRequirement(_) && isCommandEnabled(_))

  // 4. 去重动态 skills
  if (dynamicSkills.length === 0) return baseCommands

  const baseCommandNames = new Set(baseCommands.map(c => c.name))
  const uniqueDynamicSkills = dynamicSkills.filter(
    s => !baseCommandNames.has(s.name)
      && meetsAvailabilityRequirement(s)
      && isCommandEnabled(s))

  // 5. 插入位置：plugin skills 之后，built-in 命令之前
  const builtInNames = new Set(COMMANDS().map(c => c.name))
  const insertIndex = baseCommands.findIndex(c => builtInNames.has(c.name))

  return [
    ...baseCommands.slice(0, insertIndex),
    ...uniqueDynamicSkills,
    ...baseCommands.slice(insertIndex),
  ]
}
```

### Skill Tool 过滤

模型通过 Skill Tool 调用 Skill 时，看到的是过滤后的列表：

```typescript
// src/commands.ts

// SkillTool 可调用的命令
export const getSkillToolCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    const allCommands = await getCommands(cwd)
    return allCommands.filter(cmd =>
      cmd.type === 'prompt' &&
      !cmd.disableModelInvocation &&
      cmd.source !== 'builtin' &&
      // 必须有描述或 whenToUse
      (cmd.loadedFrom === 'bundled' ||
       cmd.loadedFrom === 'skills' ||
       cmd.loadedFrom === 'commands_DEPRECATED' ||
       cmd.hasUserSpecifiedDescription ||
       cmd.whenToUse))
  },
)

// Slash 命令工具看到的 skills（包括 disableModelInvocation 的）
export const getSlashCommandToolSkills = memoize(
  async (cwd: string): Promise<Command[]> => {
    const allCommands = await getCommands(cwd)
    return allCommands.filter(cmd =>
      cmd.type === 'prompt' &&
      cmd.source !== 'builtin' &&
      (cmd.hasUserSpecifiedDescription || cmd.whenToUse) &&
      (cmd.loadedFrom === 'skills' ||
       cmd.loadedFrom === 'plugin' ||
       cmd.loadedFrom === 'bundled' ||
       cmd.disableModelInvocation))  // 仅用户可调用的
  },
)
```

| 过滤器 | `getSkillToolCommands` | `getSlashCommandToolSkills` |
|--------|----------------------|---------------------------|
| 命令类型 | `type === 'prompt'` | `type === 'prompt'` |
| 模型可调用 | `!disableModelInvocation` | 包含 `disableModelInvocation` |
| 来源限制 | 非 `builtin` | 非 `builtin` |
| 需要描述 | 是 | 是 |
| 用途 | 模型自主调用 | 用户 `/skill` 补全 |

---

## 18.10 缓存管理

命令系统使用多层 memoization 缓存，需要精确控制失效：

```typescript
// src/commands.ts

// 只清除命令合并缓存（保留 skill 缓存）
export function clearCommandMemoizationCaches(): void {
  loadAllCommands.cache?.clear?.()
  getSkillToolCommands.cache?.clear?.()
  getSlashCommandToolSkills.cache?.clear?.()
  // 清除 skill search 索引（独立的缓存层）
  clearSkillIndexCache?.()
}

// 清除所有缓存（包括 skill 目录扫描）
export function clearCommandsCache(): void {
  clearCommandMemoizationCaches()
  clearPluginCommandCache()
  clearPluginSkillsCache()
  clearSkillCaches()
}
```

```typescript
// src/skills/loadSkillsDir.ts
export function clearSkillCaches() {
  getSkillDirCommands.cache?.clear?.()
  loadMarkdownFilesForSubdir.cache?.clear?.()
  conditionalSkills.clear()
  activatedConditionalSkillNames.clear()
}
```

信号机制通知缓存失效：

```typescript
// src/skills/loadSkillsDir.ts
const skillsLoaded = createSignal()

export function onDynamicSkillsLoaded(callback: () => void): () => void {
  return skillsLoaded.subscribe(() => {
    try { callback() }
    catch (error) { logError(error) }
  })
}
```

---

## 18.11 旧版 /commands/ 目录兼容

Claude Code 保留了对旧版 `.claude/commands/` 目录的支持：

```typescript
// src/skills/loadSkillsDir.ts
async function loadSkillsFromCommandsDir(
  cwd: string,
): Promise<SkillWithPath[]> {
  // 从 loadMarkdownFilesForSubdir('commands', cwd) 加载
  const markdownFiles = await loadMarkdownFilesForSubdir('commands', cwd)
  const processedFiles = transformSkillFiles(markdownFiles)

  // transformSkillFiles: 如果目录中有 SKILL.md，
  // 只加载 SKILL.md（取目录名作为命令名）
  // 否则加载所有 .md 文件
  for (const { baseDir, filePath, frontmatter, content, source }
    of processedFiles) {
    const cmdName = getCommandName(file)
    // loadedFrom: 'commands_DEPRECATED'
    skills.push(createSkillCommand({
      ...parsed,
      skillName: cmdName,
      loadedFrom: 'commands_DEPRECATED',
    }))
  }
}
```

### 命名空间

嵌套目录使用 `:` 分隔创建命名空间：

```typescript
// src/skills/loadSkillsDir.ts
function buildNamespace(targetDir: string, baseDir: string): string {
  const relativePath = targetDir.slice(normalizedBaseDir.length + 1)
  return relativePath ? relativePath.split(pathSep).join(':') : ''
}

// 示例：
// .claude/commands/deploy/staging.md → /deploy:staging
// .claude/commands/db/migrate/SKILL.md → /db:migrate
```

---

## 18.12 远程与安全命令

### Remote-Safe 命令

`--remote` 模式下只暴露安全命令：

```typescript
// src/commands.ts
export const REMOTE_SAFE_COMMANDS: Set<Command> = new Set([
  session, exit, clear, help, theme, color,
  vim, cost, usage, copy, btw, feedback,
  plan, keybindings, statusline, stickers, mobile,
])

export function filterCommandsForRemoteMode(
  commands: Command[]
): Command[] {
  return commands.filter(cmd => REMOTE_SAFE_COMMANDS.has(cmd))
}
```

### Bridge-Safe 命令

移动端/Web 端只允许特定命令：

```typescript
// src/commands.ts
export function isBridgeSafeCommand(cmd: Command): boolean {
  if (cmd.type === 'local-jsx') return false   // Ink UI → 阻止
  if (cmd.type === 'prompt') return true        // Skill → 允许
  return BRIDGE_SAFE_COMMANDS.has(cmd)           // local → 白名单
}
```

---

## 18.13 命令描述格式化

用户界面中的命令描述需要标注来源：

```typescript
// src/commands.ts
export function formatDescriptionWithSource(cmd: Command): string {
  if (cmd.type !== 'prompt') return cmd.description

  if (cmd.kind === 'workflow')
    return `${cmd.description} (workflow)`

  if (cmd.source === 'plugin') {
    const pluginName = cmd.pluginInfo?.pluginManifest.name
    if (pluginName) return `(${pluginName}) ${cmd.description}`
    return `${cmd.description} (plugin)`
  }

  if (cmd.source === 'bundled')
    return `${cmd.description} (bundled)`

  // 其他来源用 setting source 名称标注
  return `${cmd.description} (${getSettingSourceName(cmd.source)})`
}
```

---

## 18.14 Skill 去重策略

多个目录可能包含相同 Skill（如通过符号链接），系统使用 `realpath` 去重：

```typescript
// src/skills/loadSkillsDir.ts
async function getFileIdentity(filePath: string): Promise<string | null> {
  try {
    return await realpath(filePath)  // 解析符号链接到真实路径
  } catch {
    return null
  }
}

// 在 getSkillDirCommands() 中:
// 1. 并行计算所有文件的 realpath
const fileIds = await Promise.all(
  allSkillsWithPaths.map(({ filePath }) => getFileIdentity(filePath)))

// 2. 先到先赢去重
const seenFileIds = new Map<string, SettingSource>()
for (let i = 0; i < allSkillsWithPaths.length; i++) {
  const fileId = fileIds[i]
  if (fileId && seenFileIds.has(fileId)) {
    // 跳过重复
    continue
  }
  seenFileIds.set(fileId, skill.source)
  deduplicatedSkills.push(skill)
}
```

> **设计决策**：使用 `realpath` 而非 inode 进行去重。这是因为某些文件系统（如 NFS、ExFAT、容器虚拟 FS）报告不可靠的 inode 值（如始终为 0），导致所有文件被误判为重复。参见 issue #13893。

---

## 章末速查表

| 概念 | 文件 | 关键函数/类型 |
|------|------|-------------|
| 命令类型定义 | `types/command.ts` | `Command`, `PromptCommand` |
| 内置命令注册 | `commands.ts` | `COMMANDS()` [memoized] |
| 命令合并入口 | `commands.ts` | `getCommands()`, `loadAllCommands()` |
| Availability 过滤 | `commands.ts` | `meetsAvailabilityRequirement()` |
| 描述格式化 | `commands.ts` | `formatDescriptionWithSource()` |
| Skill 加载入口 | `skills/loadSkillsDir.ts` | `getSkillDirCommands()` |
| Skill 目录加载 | `skills/loadSkillsDir.ts` | `loadSkillsFromSkillsDir()` |
| Frontmatter 解析 | `skills/loadSkillsDir.ts` | `parseSkillFrontmatterFields()` |
| Skill → Command | `skills/loadSkillsDir.ts` | `createSkillCommand()` |
| 来源路径 | `skills/loadSkillsDir.ts` | `getSkillsPath()` |
| 动态发现 | `skills/loadSkillsDir.ts` | `discoverSkillDirsForPaths()` |
| 条件激活 | `skills/loadSkillsDir.ts` | `activateConditionalSkillsForPaths()` |
| Bundled Skill | `skills/bundledSkills.ts` | `registerBundledSkill()` |
| 文件提取 | `skills/bundledSkills.ts` | `extractBundledSkillFiles()` |
| 安全写入 | `skills/bundledSkills.ts` | `safeWriteFile()` |
| 旧版兼容 | `skills/loadSkillsDir.ts` | `loadSkillsFromCommandsDir()` |
| Skill Tool 过滤 | `commands.ts` | `getSkillToolCommands()` |
| 缓存管理 | `commands.ts` | `clearCommandsCache()` |
| 远程安全 | `commands.ts` | `REMOTE_SAFE_COMMANDS` |
| 命名空间 | `skills/loadSkillsDir.ts` | `buildNamespace()` |
| 去重策略 | `skills/loadSkillsDir.ts` | `getFileIdentity()` (realpath) |
