# 第 8 章：Memory 系统 — 跨会话的持久记忆

> **核心问题**：Agent 的对话上下文在 compact 后会被摘要压缩，会话结束后更是完全消失。如何让 Agent "记住"用户的偏好、项目的约定、之前的工作进展？Claude Code 设计了一套多层次的 Memory 系统——从静态的 CLAUDE.md 指令文件到动态的 Session Memory 自动笔记——让 Agent 拥有跨会话的持久记忆。

---

## 8.1 Memory 的多层架构

Claude Code 的 Memory 系统是一个分层设计，从"谁写的"和"作用范围"两个维度组织：

```
优先级（由低到高）
  ┌──────────────────────────────────────────────┐
  │  Managed Memory                               │ ← 管理员/企业级策略
  │  /etc/claude-code/CLAUDE.md                   │
  ├──────────────────────────────────────────────┤
  │  User Memory                                  │ ← 用户全局偏好
  │  ~/.claude/CLAUDE.md                          │
  │  ~/.claude/rules/*.md                         │
  ├──────────────────────────────────────────────┤
  │  Project Memory                               │ ← 项目共享指令（checked in）
  │  CLAUDE.md, .claude/CLAUDE.md                 │
  │  .claude/rules/*.md                           │
  ├──────────────────────────────────────────────┤
  │  Local Memory                                 │ ← 个人项目指令（gitignored）
  │  CLAUDE.local.md                              │
  ├──────────────────────────────────────────────┤
  │  AutoMem / TeamMem                            │ ← 自动记忆 / 团队记忆
  │  MEMORY.md (实验性)                           │
  ├──────────────────────────────────────────────┤
  │  Session Memory                               │ ← 会话内自动笔记
  │  ~/.claude/session-memory/<id>/notes.md       │
  └──────────────────────────────────────────────┘
```

这些层次的类型定义在 `src/utils/memory/types.ts` 中：

```typescript
// src/utils/memory/types.ts
export const MEMORY_TYPE_VALUES = [
  'User',
  'Project',
  'Local',
  'Managed',
  'AutoMem',
  ...(feature('TEAMMEM') ? (['TeamMem'] as const) : []),
] as const

export type MemoryType = (typeof MEMORY_TYPE_VALUES)[number]
```

### 8.1.1 为什么需要多层

单一的"记忆文件"无法满足现实场景的需求：

| 层次 | 典型内容 | 写入者 | 生命周期 |
|------|---------|--------|---------|
| Managed | 企业安全策略、审计要求 | IT 管理员 | 永久，所有用户 |
| User | "我喜欢 2-space indent"、"用中文回答" | 用户自己 | 跨项目永久 |
| Project | "使用 Bun 运行测试"、"PR 标题格式" | 团队 | 随代码版本控制 |
| Local | "我的测试服 URL"、"我是新人，多解释" | 用户自己 | 仅本地，不提交 |
| Session Memory | 当前任务进展、文件结构记录 | Agent 自动 | 单次会话 |

### 8.1.2 加载顺序与优先级

文件按**反优先级顺序**加载——最后加载的优先级最高。模型会更关注出现在 prompt 靠后位置的内容。这是 `claudemd.ts` 文件头部注释明确记录的设计决策：

```typescript
// src/utils/claudemd.ts:1-26
/**
 * Files are loaded in the following order:
 *
 * 1. Managed memory (eg. /etc/claude-code/CLAUDE.md)
 * 2. User memory (~/.claude/CLAUDE.md)
 * 3. Project memory (CLAUDE.md, .claude/CLAUDE.md, and .claude/rules/*.md)
 * 4. Local memory (CLAUDE.local.md in project roots)
 *
 * Files are loaded in reverse order of priority, i.e. the latest files
 * are highest priority with the model paying more attention to them.
 *
 * File discovery:
 * - User memory is loaded from the user's home directory
 * - Project and Local files are discovered by traversing from the
 *   current directory up to root
 * - Files closer to the current directory have higher priority
 */
```

---

## 8.2 CLAUDE.md 加载引擎：claudemd.ts

`src/utils/claudemd.ts` 是整个 Memory 系统的核心加载引擎，负责发现、读取、解析和组装所有 Memory 文件。这个文件有 1480 行，是 Claude Code 中最大的工具模块之一。

### 8.2.1 文件发现：getMemoryFiles()

`getMemoryFiles()` 是主入口，用 `lodash.memoize` 缓存（一次会话内只加载一次，除非显式清缓存）：

```typescript
// src/utils/claudemd.ts:790-1075 (简化)
export const getMemoryFiles = memoize(
  async (forceIncludeExternal = false): Promise<MemoryFileInfo[]> => {
    const result: MemoryFileInfo[] = []
    const processedPaths = new Set<string>()

    // 1. Managed 文件 - 总是加载
    const managedClaudeMd = getMemoryPath('Managed')
    result.push(...(await processMemoryFile(
      managedClaudeMd, 'Managed', processedPaths, includeExternal
    )))

    // 2. User 文件 - 仅当 userSettings 启用
    if (isSettingSourceEnabled('userSettings')) {
      const userClaudeMd = getMemoryPath('User')
      result.push(...(await processMemoryFile(
        userClaudeMd, 'User', processedPaths, true // User 总是可以引用外部文件
      )))
    }

    // 3. Project + Local 文件 - 从 CWD 向上遍历到根
    const dirs: string[] = []
    let currentDir = getOriginalCwd()
    while (currentDir !== parse(currentDir).root) {
      dirs.push(currentDir)
      currentDir = dirname(currentDir)
    }

    // 从根向 CWD 方向处理 → CWD 最后加载 → 优先级最高
    for (const dir of dirs.reverse()) {
      // CLAUDE.md (Project)
      result.push(...(await processMemoryFile(
        join(dir, 'CLAUDE.md'), 'Project', processedPaths, includeExternal
      )))
      // .claude/CLAUDE.md (Project)
      result.push(...(await processMemoryFile(
        join(dir, '.claude', 'CLAUDE.md'), 'Project', processedPaths, includeExternal
      )))
      // .claude/rules/*.md (Project)
      result.push(...(await processMdRules({
        rulesDir: join(dir, '.claude', 'rules'),
        type: 'Project', processedPaths, includeExternal, conditionalRule: false,
      })))
      // CLAUDE.local.md (Local)
      result.push(...(await processMemoryFile(
        join(dir, 'CLAUDE.local.md'), 'Local', processedPaths, includeExternal
      )))
    }

    // 4. AutoMem entrypoint (MEMORY.md)
    if (isAutoMemoryEnabled()) { /* ... */ }

    // 5. TeamMem entrypoint (团队共享记忆)
    if (feature('TEAMMEM') && teamMemPaths!.isTeamMemoryEnabled()) { /* ... */ }

    return result
  }
)
```

关键设计点：

1. **向上遍历**：不只查看当前目录，还会查看所有祖先目录。这意味着 monorepo 中 `packages/foo/` 下工作时，既能加载 `packages/foo/CLAUDE.md`，也能加载根目录的 `CLAUDE.md`
2. **去重**：`processedPaths` Set 避免同一文件被加载两次
3. **路径归一化**：使用 `normalizePathForComparison()` 处理 Windows 驱动器字母大小写差异

### 8.2.2 Worktree 感知

当在 git worktree 中工作时（例如 `.claude/worktrees/<name>/`），向上遍历会经过 worktree 根和主仓库根，两者都有 `CLAUDE.md`。为避免重复加载，代码实现了专门的逻辑：

```typescript
// src/utils/claudemd.ts:867-884
const gitRoot = findGitRoot(originalCwd)
const canonicalRoot = findCanonicalGitRoot(originalCwd)
const isNestedWorktree =
  gitRoot !== null &&
  canonicalRoot !== null &&
  normalizePathForComparison(gitRoot) !==
    normalizePathForComparison(canonicalRoot) &&
  pathInWorkingPath(gitRoot, canonicalRoot)

// 在嵌套 worktree 中，跳过主仓库目录中的 checked-in 文件
const skipProject =
  isNestedWorktree &&
  pathInWorkingPath(dir, canonicalRoot) &&
  !pathInWorkingPath(dir, gitRoot)
```

规则很精巧：Project 类型文件（CLAUDE.md、.claude/rules/*.md）在主仓库目录中被跳过（worktree 有自己的 checkout），但 Local 类型（CLAUDE.local.md）不跳过（它只在主仓库中存在，因为被 gitignore 了）。

### 8.2.3 文件处理管线

每个发现的文件都经过 `processMemoryFile()` 处理管线：

```
文件路径 → safelyReadMemoryFileAsync() → parseMemoryFileContent()
               │                              │
               │                              ├─ 扩展名检查（过滤二进制文件）
               │                              ├─ parseFrontmatterPaths()（提取 paths 元数据）
               │                              ├─ stripHtmlComments()（去除 HTML 注释）
               │                              ├─ extractIncludePathsFromTokens()（提取 @include）
               │                              └─ truncateEntrypointContent()（AutoMem/TeamMem 截断）
               │
               └─ 递归处理 @include 引用 → processMemoryFile(depth + 1)
```

#### @include 指令

Memory 文件支持 `@` 前缀的文件引用语法：

```markdown
# CLAUDE.md
@docs/coding-standards.md
@./local-config.md
@~/personal-prefs.md
```

提取逻辑使用 marked 词法分析器，确保只从文本节点中提取 `@` 路径（不从代码块或行内代码中）：

```typescript
// src/utils/claudemd.ts:451-535 (简化)
function extractIncludePathsFromTokens(
  tokens: ReturnType<Lexer['lex']>,
  basePath: string,
): string[] {
  const absolutePaths = new Set<string>()

  function extractPathsFromText(textContent: string) {
    const includeRegex = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g
    let match
    while ((match = includeRegex.exec(textContent)) !== null) {
      let path = match[1]
      // 去除 #fragment 标识符
      const hashIndex = path.indexOf('#')
      if (hashIndex !== -1) path = path.substring(0, hashIndex)
      // 支持 @path, @./path, @~/path, @/path
      const resolvedPath = expandPath(path, dirname(basePath))
      absolutePaths.add(resolvedPath)
    }
  }

  // 递归遍历 token 树，跳过 code/codespan/html
  function processElements(elements: MarkdownToken[]) {
    for (const element of elements) {
      if (element.type === 'code' || element.type === 'codespan') continue
      if (element.type === 'html') {
        // 特殊处理：HTML 注释后的残留文本中可能有 @path
        // ...
        continue
      }
      if (element.type === 'text') extractPathsFromText(element.text || '')
      if (element.tokens) processElements(element.tokens)
      if (element.items) processElements(element.items)
    }
  }

  processElements(tokens as MarkdownToken[])
  return [...absolutePaths]
}
```

递归深度限制为 5 层（`MAX_INCLUDE_DEPTH = 5`），防止循环引用：

```typescript
const MAX_INCLUDE_DEPTH = 5

export async function processMemoryFile(
  filePath: string, type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
  depth: number = 0,
  parent?: string,
): Promise<MemoryFileInfo[]> {
  const normalizedPath = normalizePathForComparison(filePath)
  if (processedPaths.has(normalizedPath) || depth >= MAX_INCLUDE_DEPTH) {
    return []
  }
  // ...
}
```

#### HTML 注释剥离

Memory 文件中的 HTML 注释（`<!-- ... -->`）会被自动剥离，让作者可以写备注而不影响 prompt：

```typescript
// src/utils/claudemd.ts:292-334
export function stripHtmlComments(content: string): {
  content: string; stripped: boolean
} {
  if (!content.includes('<!--')) {
    return { content, stripped: false }
  }
  return stripHtmlCommentsFromTokens(new Lexer({ gfm: false }).lex(content))
}
```

使用 CommonMark 词法分析器（`gfm: false`）确保只处理块级注释，行内代码和代码块中的注释不受影响。

#### Frontmatter 条件规则

`.claude/rules/*.md` 文件支持 frontmatter 中的 `paths` 字段，实现路径条件规则：

```yaml
---
paths:
  - src/components/**
  - src/hooks/**
---
# React 组件规范
使用函数组件而非 class 组件...
```

当 Agent 操作的文件路径匹配 `paths` glob 模式时，该规则才会被加载。匹配逻辑使用 `ignore` 库（与 `.gitignore` 相同的语法）：

```typescript
// src/utils/claudemd.ts:1354-1397 (简化)
export async function processConditionedMdRules(
  targetPath: string, rulesDir: string,
  type: MemoryType, processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const conditionedRuleMdFiles = await processMdRules({
    rulesDir, type, processedPaths,
    includeExternal: false, conditionalRule: true, // 只获取有 paths 的文件
  })

  return conditionedRuleMdFiles.filter(file => {
    if (!file.globs || file.globs.length === 0) return false

    const baseDir = type === 'Project'
      ? dirname(dirname(rulesDir)) // .claude 的父目录
      : getOriginalCwd()
    const relativePath = relative(baseDir, targetPath)
    return ignore().add(file.globs).ignores(relativePath)
  })
}
```

### 8.2.4 文本文件白名单

为防止加载二进制文件（图片、PDF 等），`@include` 有一个扩展名白名单：

```typescript
// src/utils/claudemd.ts:96-227
const TEXT_FILE_EXTENSIONS = new Set([
  '.md', '.txt', '.text',           // 文档
  '.json', '.yaml', '.yml', '.toml', // 数据格式
  '.js', '.ts', '.tsx', '.jsx',      // JavaScript/TypeScript
  '.py', '.pyi',                     // Python
  '.go', '.rs', '.java', '.kt',     // 其他语言
  '.sh', '.bash', '.ps1',           // Shell
  '.sql', '.graphql',               // 查询语言
  '.vue', '.svelte', '.astro',      // 前端框架
  // ... 共 100+ 种扩展名
])
```

### 8.2.5 排除机制

用户可以通过 `claudeMdExcludes` 设置排除特定路径的 Memory 文件：

```typescript
// src/utils/claudemd.ts:547-573
function isClaudeMdExcluded(filePath: string, type: MemoryType): boolean {
  // Managed, AutoMem, TeamMem 永远不会被排除
  if (type !== 'User' && type !== 'Project' && type !== 'Local') {
    return false
  }

  const patterns = getInitialSettings().claudeMdExcludes
  if (!patterns || patterns.length === 0) return false

  const normalizedPath = filePath.replaceAll('\\', '/')
  const expandedPatterns = resolveExcludePatterns(patterns)
  return picomatch.isMatch(normalizedPath, expandedPatterns, { dot: true })
}
```

`resolveExcludePatterns()` 还会处理 macOS 上的符号链接问题（`/tmp` → `/private/tmp`），通过 `realpathSync` 解析符号链接前缀。

### 8.2.6 组装为 Prompt

所有加载的 Memory 文件最终通过 `getClaudeMds()` 组装为系统 prompt 的一部分：

```typescript
// src/utils/claudemd.ts:1153-1195 (简化)
export const getClaudeMds = (
  memoryFiles: MemoryFileInfo[],
  filter?: (type: MemoryType) => boolean,
): string => {
  const memories: string[] = []

  for (const file of memoryFiles) {
    if (filter && !filter(file.type)) continue

    const description =
      file.type === 'Project'
        ? ' (project instructions, checked into the codebase)'
        : file.type === 'Local'
          ? " (user's private project instructions, not checked in)"
          : file.type === 'TeamMem'
            ? ' (shared team memory, synced across the organization)'
            : file.type === 'AutoMem'
              ? " (user's auto-memory, persists across conversations)"
              : " (user's private global instructions for all projects)"

    memories.push(`Contents of ${file.path}${description}:\n\n${content}`)
  }

  return `${MEMORY_INSTRUCTION_PROMPT}\n\n${memories.join('\n\n')}`
}
```

其中 `MEMORY_INSTRUCTION_PROMPT` 是一条关键的前缀指令：

```typescript
const MEMORY_INSTRUCTION_PROMPT =
  'Codebase and user instructions are shown below. Be sure to adhere to ' +
  'these instructions. IMPORTANT: These instructions OVERRIDE any default ' +
  'behavior and you MUST follow them exactly as written.'
```

这条指令确保模型优先遵循 Memory 文件中的内容，覆盖默认行为。

### 8.2.7 注入到 Context

组装好的 Memory 内容通过 `context.ts` 中的 `getUserContext()` 注入到每次 API 调用：

```typescript
// src/context.ts:155-189
export const getUserContext = memoize(
  async (): Promise<{ [k: string]: string }> => {
    const shouldDisableClaudeMd =
      isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) ||
      (isBareMode() && getAdditionalDirectoriesForClaudeMd().length === 0)

    const claudeMd = shouldDisableClaudeMd
      ? null
      : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))

    setCachedClaudeMdContent(claudeMd || null)

    return {
      ...(claudeMd && { claudeMd }),
      currentDate: `Today's date is ${getLocalISODate()}.`,
    }
  }
)
```

`--bare` 模式会跳过自动发现（但仍尊重 `--add-dir` 显式指定），环境变量 `CLAUDE_CODE_DISABLE_CLAUDE_MDS` 则完全禁用。

### 8.2.8 缓存管理

`getMemoryFiles` 被 `memoize` 包裹，但有两种清缓存方式：

```typescript
// 清缓存但不触发 InstructionsLoaded hook
export function clearMemoryFileCaches(): void {
  getMemoryFiles.cache?.clear?.()
}

// 清缓存并触发 InstructionsLoaded hook（用于 compact 后重新加载）
export function resetGetMemoryFilesCache(
  reason: InstructionsLoadReason = 'session_start',
): void {
  nextEagerLoadReason = reason
  shouldFireHook = true
  clearMemoryFileCaches()
}
```

区分很重要：worktree 切换、settings 同步只需清缓存确保正确性；compact 后需要重新加载并通知 hook 系统。

---

## 8.3 Session Memory：会话内的自动笔记系统

Session Memory 是 Claude Code 的一个重要子系统，它在对话过程中自动提取关键信息并维护一个结构化的笔记文件。这个系统的代码位于 `src/services/SessionMemory/` 目录。

### 8.3.1 设计动机

传统的 context management（第 7 章）在 compact 时会丢失细节。虽然摘要保留了要点，但具体的文件路径、错误消息、工作进展等信息会在压缩中丢失。Session Memory 的设计目标是：

1. **在 compact 之前**持续维护一个笔记文件，记录关键细节
2. **在 compact 之后**用这个笔记文件替代传统的 LLM 摘要
3. **不打断主对话**——在后台异步执行

### 8.3.2 架构概览

```
主对话循环 (REPL)
    │
    ├─ 每次 sampling 完成后 ──→ executePostSamplingHooks()
    │                              │
    │                              └─ extractSessionMemory()
    │                                    │
    │                                    ├─ shouldExtractMemory()  // 是否满足阈值
    │                                    ├─ setupSessionMemoryFile()  // 创建/读取笔记文件
    │                                    ├─ buildSessionMemoryUpdatePrompt()  // 构建提取 prompt
    │                                    └─ runForkedAgent()  // 在隔离的 forked agent 中执行
    │                                          │
    │                                          └─ 使用 Edit 工具更新笔记文件
    │
    └─ compact 时 ──→ trySessionMemoryCompaction()
                         │
                         ├─ 读取 session memory 笔记
                         ├─ 确定保留消息范围
                         └─ 用笔记替代 LLM 摘要
```

### 8.3.3 功能门控与配置

Session Memory 由 feature flag `tengu_session_memory` 控制，通过 GrowthBook 远程配置：

```typescript
// src/services/SessionMemory/sessionMemory.ts:80-81
function isSessionMemoryGateEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_session_memory', false)
}
```

使用 `_CACHED_MAY_BE_STALE` 变体是为了不阻塞主线程——Gate 值从缓存中立即返回，可能不是最新的，但不会造成延迟。

配置参数从远程加载，带有本地默认值：

```typescript
// src/services/SessionMemory/sessionMemoryUtils.ts:32-36
export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10000,   // 至少 10K tokens 才开始记忆
  minimumTokensBetweenUpdate: 5000,    // 每次更新间至少 5K tokens 增长
  toolCallsBetweenUpdates: 3,          // 每次更新间至少 3 次工具调用
}
```

### 8.3.4 触发条件

`shouldExtractMemory()` 决定何时触发记忆提取：

```typescript
// src/services/SessionMemory/sessionMemory.ts:134-181 (简化)
export function shouldExtractMemory(messages: Message[]): boolean {
  const currentTokenCount = tokenCountWithEstimation(messages)

  // 初始化阈值检查
  if (!isSessionMemoryInitialized()) {
    if (!hasMetInitializationThreshold(currentTokenCount)) return false
    markSessionMemoryInitialized()
  }

  // 两个阈值
  const hasMetTokenThreshold = hasMetUpdateThreshold(currentTokenCount)
  const toolCallsSinceLastUpdate = countToolCallsSince(messages, lastMemoryMessageUuid)
  const hasMetToolCallThreshold =
    toolCallsSinceLastUpdate >= getToolCallsBetweenUpdates()

  // 最后一轮是否有工具调用
  const hasToolCallsInLastTurn = hasToolCallsInLastAssistantTurn(messages)

  // 触发条件：
  // 1. Token 阈值 AND 工具调用阈值都满足
  // 2. Token 阈值满足 AND 最后一轮没有工具调用（自然会话间歇）
  // 重点：Token 阈值是必要条件
  return (hasMetTokenThreshold && hasMetToolCallThreshold) ||
         (hasMetTokenThreshold && !hasToolCallsInLastTurn)
}
```

这个双阈值设计很巧妙：

- **Token 阈值是必要条件**——防止短时间内过度提取
- **工具调用阈值**确保有"实质工作"发生
- **会话间歇检测**（最后一轮没有工具调用）允许在自然停顿时提取，即使工具调用次数不够

Token 阈值测量的是"自上次提取以来的 context 增长量"，与 auto-compact 使用相同的度量方式：

```typescript
// src/services/SessionMemory/sessionMemoryUtils.ts:184-189
export function hasMetUpdateThreshold(currentTokenCount: number): boolean {
  const tokensSinceLastExtraction = currentTokenCount - tokensAtLastExtraction
  return tokensSinceLastExtraction >= sessionMemoryConfig.minimumTokensBetweenUpdate
}
```

### 8.3.5 笔记模板

Session Memory 的笔记文件遵循固定的 Markdown 模板结构：

```typescript
// src/services/SessionMemory/prompts.ts:11-41
export const DEFAULT_SESSION_MEMORY_TEMPLATE = `
# Session Title
_A short and distinctive 5-10 word descriptive title for the session._

# Current State
_What is actively being worked on right now? Pending tasks not yet completed._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid?_

# Key results
_If the user asked a specific output, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`
```

这个模板设计为"只更新内容，不改结构"——每个 section 的标题和斜体描述行必须保持不变。用户可以自定义模板，放在 `~/.claude/session-memory/config/template.md`。

### 8.3.6 更新 Prompt

用于指导 forked agent 更新笔记的 prompt 也经过精心设计：

```typescript
// src/services/SessionMemory/prompts.ts:43-81 (要点)
function getDefaultUpdatePrompt(): string {
  return `IMPORTANT: This message and these instructions are NOT part of the actual
user conversation. Do NOT include any references to "note-taking" ...

Based on the user conversation above, update the session notes file.
The file {{notesPath}} has already been read for you.

CRITICAL RULES FOR EDITING:
- The file must maintain its exact structure with all sections
- NEVER modify, delete, or add section headers
- NEVER modify or delete the italic _section description_ lines
- ONLY update the actual content BELOW the italic _section descriptions_
- Write DETAILED, INFO-DENSE content - include file paths, function names,
  error messages, exact commands, technical details
- Keep each section under ~${MAX_SECTION_LENGTH} tokens
- IMPORTANT: Always update "Current State" to reflect the most recent work

Use the Edit tool with file_path: {{notesPath}}`
}
```

关键约束：
- **不能改结构**——只能在斜体描述行之后添加/更新内容
- **信息密度要求**——包含具体路径、函数名、错误信息
- **每 section 限制 2000 tokens**——防止膨胀
- **总量限制 12000 tokens**——防止笔记文件本身消耗太多 context

### 8.3.7 Section 大小监控

每次更新时，系统会分析笔记文件的 section 大小并生成提醒：

```typescript
// src/services/SessionMemory/prompts.ts:134-196
function analyzeSectionSizes(content: string): Record<string, number> {
  // 按 # 标题分割，计算每个 section 的 token 数
  const sections: Record<string, number> = {}
  const lines = content.split('\n')
  // ...
  return sections
}

function generateSectionReminders(
  sectionSizes: Record<string, number>,
  totalTokens: number,
): string {
  const overBudget = totalTokens > MAX_TOTAL_SESSION_MEMORY_TOKENS // 12000
  const oversizedSections = Object.entries(sectionSizes)
    .filter(([_, tokens]) => tokens > MAX_SECTION_LENGTH) // 2000
    .sort(([, a], [, b]) => b - a)

  if (overBudget) {
    // "CRITICAL: 必须压缩..."
  }
  if (oversizedSections.length > 0) {
    // "以下 section 超出限制..."
  }
}
```

### 8.3.8 Forked Agent 执行

Session Memory 的提取在一个"forked agent"中执行——这是一个隔离的 LLM 查询循环，与主对话共享 prompt cache 但不污染主状态：

```typescript
// src/services/SessionMemory/sessionMemory.ts:316-325
await runForkedAgent({
  promptMessages: [createUserMessage({ content: userPrompt })],
  cacheSafeParams: createCacheSafeParams(context),
  canUseTool: createMemoryFileCanUseTool(memoryPath),
  querySource: 'session_memory',
  forkLabel: 'session_memory',
  overrides: { readFileState: setupContext.readFileState },
})
```

`CacheSafeParams` 是与主循环共享 prompt cache 的关键——forked agent 使用相同的 system prompt、user context、system context 和主消息历史作为前缀，确保 API 端的 prompt cache 命中：

```typescript
// src/utils/forkedAgent.ts:50-68
export type CacheSafeParams = {
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  forkContextMessages: Message[] // 主循环的完整消息历史
}
```

权限控制极其严格——forked agent 只被允许使用 `Edit` 工具，且只能编辑指定的笔记文件：

```typescript
// src/services/SessionMemory/sessionMemory.ts:460-482
export function createMemoryFileCanUseTool(memoryPath: string): CanUseToolFn {
  return async (tool: Tool, input: unknown) => {
    if (
      tool.name === FILE_EDIT_TOOL_NAME &&
      typeof input === 'object' && input !== null &&
      'file_path' in input &&
      (input as { file_path: string }).file_path === memoryPath
    ) {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    return {
      behavior: 'deny' as const,
      message: `only ${FILE_EDIT_TOOL_NAME} on ${memoryPath} is allowed`,
    }
  }
}
```

### 8.3.9 并发控制

提取过程使用 `sequential()` 包裹，确保同一时刻只有一个提取任务在运行：

```typescript
// src/services/SessionMemory/sessionMemory.ts:272
const extractSessionMemory = sequential(async function(context: REPLHookContext) {
  // ... 只在主 REPL 线程运行
  if (querySource !== 'repl_main_thread') return
  // ...
})
```

同时，提取状态（`extractionStartedAt`）有过期机制——如果一个提取超过 60 秒仍未完成，它会被视为"过时的"：

```typescript
// src/services/SessionMemory/sessionMemoryUtils.ts:89-105
export async function waitForSessionMemoryExtraction(): Promise<void> {
  const startTime = Date.now()
  while (extractionStartedAt) {
    const extractionAge = Date.now() - extractionStartedAt
    if (extractionAge > EXTRACTION_STALE_THRESHOLD_MS) { // 60000ms
      return // 提取过期，不再等待
    }
    if (Date.now() - startTime > EXTRACTION_WAIT_TIMEOUT_MS) { // 15000ms
      return // 等待超时
    }
    await sleep(1000)
  }
}
```

### 8.3.10 手动触发

用户可以通过 `/summary` 命令手动触发 session memory 提取：

```typescript
// src/services/SessionMemory/sessionMemory.ts:387-453
export async function manuallyExtractSessionMemory(
  messages: Message[],
  toolUseContext: ToolUseContext,
): Promise<ManualExtractionResult> {
  if (messages.length === 0) {
    return { success: false, error: 'No messages to summarize' }
  }
  // 跳过阈值检查，直接执行
  markExtractionStarted()
  // ... 与自动提取相同的流程
}
```

### 8.3.11 初始化

Session Memory 在启动时通过 `initSessionMemory()` 注册为 post-sampling hook：

```typescript
// src/services/SessionMemory/sessionMemory.ts:357-375
export function initSessionMemory(): void {
  if (getIsRemoteMode()) return  // 远程模式不启用
  const autoCompactEnabled = isAutoCompactEnabled()
  if (!autoCompactEnabled) return  // 依赖 auto-compact 设置

  // 无条件注册 hook，gate 检查在 hook 运行时延迟执行
  registerPostSamplingHook(extractSessionMemory)
}
```

延迟 gate 检查是关键设计——启动时不阻塞在 GrowthBook 初始化上，而是在 hook 首次执行时才检查 feature flag。

---

## 8.4 Session Memory Compact：用笔记替代摘要

Session Memory 与 Context Management 的深度集成体现在 `sessionMemoryCompact.ts` 中。当 auto-compact 触发时，系统可以用 Session Memory 的笔记替代传统的 LLM 摘要。

### 8.4.1 传统 Compact vs Session Memory Compact

| 维度 | 传统 Compact | SM Compact |
|------|-------------|------------|
| 摘要生成 | 调用 LLM 生成摘要（耗费 tokens） | 直接使用已有的笔记文件 |
| 保留消息 | 无（全部压缩） | 保留部分最新消息 |
| 延迟 | 高（需要 LLM 调用） | 低（文件读取） |
| 信息保留 | 摘要级别 | 结构化、详细 |
| 成本 | 额外的 API 调用 | 几乎为零 |

### 8.4.2 保留消息计算

SM Compact 不是简单地丢弃所有旧消息——它会智能地保留一部分：

```typescript
// src/services/compact/sessionMemoryCompact.ts:57-61
export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  minTokens: 10_000,        // 至少保留 10K tokens 的消息
  minTextBlockMessages: 5,  // 至少保留 5 条含文本的消息
  maxTokens: 40_000,        // 最多保留 40K tokens
}
```

计算逻辑从 `lastSummarizedMessageId`（Session Memory 已经总结到的位置）开始，然后向前扩展：

```typescript
// src/services/compact/sessionMemoryCompact.ts:323-397 (简化)
export function calculateMessagesToKeepIndex(
  messages: Message[],
  lastSummarizedIndex: number,
): number {
  let startIndex = lastSummarizedIndex >= 0
    ? lastSummarizedIndex + 1
    : messages.length

  // 从 startIndex 开始计算 tokens 和文本消息数
  let totalTokens = 0
  let textBlockMessageCount = 0
  for (let i = startIndex; i < messages.length; i++) {
    totalTokens += estimateMessageTokens([messages[i]!])
    if (hasTextBlocks(messages[i]!)) textBlockMessageCount++
  }

  // 如果已超过 maxTokens，直接返回
  if (totalTokens >= config.maxTokens) {
    return adjustIndexToPreserveAPIInvariants(messages, startIndex)
  }

  // 向前扩展直到满足两个最小值
  for (let i = startIndex - 1; i >= floor; i--) {
    totalTokens += estimateMessageTokens([messages[i]!])
    if (hasTextBlocks(messages[i]!)) textBlockMessageCount++
    startIndex = i

    if (totalTokens >= config.maxTokens) break
    if (totalTokens >= config.minTokens &&
        textBlockMessageCount >= config.minTextBlockMessages) break
  }

  return adjustIndexToPreserveAPIInvariants(messages, startIndex)
}
```

### 8.4.3 API 不变量保护

在确定切分点时，必须确保不会拆散 `tool_use`/`tool_result` 对，也不会丢失 thinking block。`adjustIndexToPreserveAPIInvariants()` 负责这个保护：

```typescript
// src/services/compact/sessionMemoryCompact.ts:232-314 (简化)
export function adjustIndexToPreserveAPIInvariants(
  messages: Message[],
  startIndex: number,
): number {
  let adjustedIndex = startIndex

  // 步骤 1：保护 tool_use/tool_result 对
  // 收集保留范围内所有 tool_result ID
  const allToolResultIds: string[] = []
  for (let i = startIndex; i < messages.length; i++) {
    allToolResultIds.push(...getToolResultIds(messages[i]!))
  }

  if (allToolResultIds.length > 0) {
    // 找到不在保留范围内的对应 tool_use
    const neededToolUseIds = new Set(
      allToolResultIds.filter(id => !toolUseIdsInKeptRange.has(id))
    )
    // 向前扩展以包含这些 tool_use 消息
    for (let i = adjustedIndex - 1; i >= 0 && neededToolUseIds.size > 0; i--) {
      if (hasToolUseWithIds(messages[i]!, neededToolUseIds)) {
        adjustedIndex = i
        // ...
      }
    }
  }

  // 步骤 2：保护 thinking blocks（共享相同 message.id）
  const messageIdsInKeptRange = new Set<string>()
  for (let i = adjustedIndex; i < messages.length; i++) {
    if (messages[i]!.type === 'assistant') {
      messageIdsInKeptRange.add(messages[i]!.message.id)
    }
  }

  for (let i = adjustedIndex - 1; i >= 0; i--) {
    if (messages[i]!.type === 'assistant' &&
        messageIdsInKeptRange.has(messages[i]!.message.id)) {
      adjustedIndex = i // 包含共享 message.id 的 thinking block
    }
  }

  return adjustedIndex
}
```

这段代码的注释中有一段精彩的 bug 分析，展示了这个函数解决的具体场景：streaming 产生的多个消息共享相同的 `message.id`，如果切分点落在中间，`normalizeMessagesForAPI` 合并时会产生孤立的 `tool_result`。

### 8.4.4 笔记截断保护

在将 Session Memory 插入 compact 摘要时，系统会截断超大的 section 以防止笔记本身消耗太多 token：

```typescript
// src/services/SessionMemory/prompts.ts:256-296
export function truncateSessionMemoryForCompact(content: string): {
  truncatedContent: string; wasTruncated: boolean
} {
  const maxCharsPerSection = MAX_SECTION_LENGTH * 4 // 2000 * 4 = 8000 chars
  // 按 # 标题分割，截断超大 section
  // ...
}
```

---

## 8.5 Away Summary：离开后的回忆

当用户离开一段时间后回来，Claude Code 会显示一个"While you were away"摘要卡片。这个功能利用了 Session Memory：

```typescript
// src/services/awaySummary.ts:18-23
function buildAwaySummaryPrompt(memory: string | null): string {
  const memoryBlock = memory
    ? `Session memory (broader context):\n${memory}\n\n`
    : ''
  return `${memoryBlock}The user stepped away and is coming back. Write exactly
1-3 short sentences. Start by stating the high-level task — what they are
building or debugging, not implementation details. Next: the concrete next step.
Skip status reports and commit recaps.`
}
```

这个功能：
1. 读取 Session Memory 笔记作为上下文
2. 取最近 30 条消息（~15 轮对话）
3. 使用小型快速模型（`getSmallFastModel()`）生成简短摘要
4. 整个过程支持 AbortSignal 取消

---

## 8.6 Post-Sampling Hook 机制

Session Memory 的自动提取依赖一个内部的 post-sampling hook 机制（不同于用户可配置的 hooks）：

```typescript
// src/utils/hooks/postSamplingHooks.ts
export type REPLHookContext = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  querySource?: QuerySource
}

export type PostSamplingHook = (
  context: REPLHookContext,
) => Promise<void> | void

const postSamplingHooks: PostSamplingHook[] = []

export function registerPostSamplingHook(hook: PostSamplingHook): void {
  postSamplingHooks.push(hook)
}

export async function executePostSamplingHooks(
  messages, systemPrompt, userContext, systemContext, toolUseContext, querySource,
): Promise<void> {
  const context: REPLHookContext = { /* ... */ }
  for (const hook of postSamplingHooks) {
    try {
      await hook(context)
    } catch (error) {
      logError(toError(error)) // 不中断主流程
    }
  }
}
```

关键特性：
- **内部 API**——不通过 settings.json 暴露给用户
- **fire-and-forget**——hook 错误不会中断主对话
- **在每次 LLM sampling 完成后执行**——包括工具调用后的响应

---

## 8.7 InstructionsLoaded Hook

当 Memory 文件被加载到 context 时，会触发 `InstructionsLoaded` hook。这是一个用户可配置的 hook 事件：

```typescript
// src/utils/claudemd.ts:1054-1071
if (!forceIncludeExternal) {
  const eagerLoadReason = consumeNextEagerLoadReason()
  if (eagerLoadReason !== undefined && hasInstructionsLoadedHook()) {
    for (const file of result) {
      if (!isInstructionsMemoryType(file.type)) continue
      const loadReason = file.parent ? 'include' : eagerLoadReason
      void executeInstructionsLoadedHooks(
        file.path, file.type, loadReason,
        { globs: file.globs, parentFilePath: file.parent }
      )
    }
  }
}
```

`loadReason` 区分了加载原因：
- `session_start`：会话启动时的初始加载
- `compact`：compact 后的重新加载
- `include`：被其他文件 `@include` 的

---

## 8.8 Memory 文件大小监控

系统会警告过大的 Memory 文件（超过 40000 字符）：

```typescript
// src/utils/claudemd.ts:93
export const MAX_MEMORY_CHARACTER_COUNT = 40000

export function getLargeMemoryFiles(files: MemoryFileInfo[]): MemoryFileInfo[] {
  return files.filter(f => f.content.length > MAX_MEMORY_CHARACTER_COUNT)
}
```

这个阈值对应大约 10000 tokens。过大的 Memory 文件会浪费 context 空间，并可能被模型忽略。

---

## 8.9 MemoryFileInfo 数据结构

每个加载的 Memory 文件都表示为一个 `MemoryFileInfo` 对象：

```typescript
// src/utils/claudemd.ts:229-243
export type MemoryFileInfo = {
  path: string          // 文件绝对路径
  type: MemoryType      // User | Project | Local | Managed | AutoMem | TeamMem
  content: string       // 处理后的内容（去注释、去 frontmatter、可能截断）
  parent?: string       // @include 的父文件路径
  globs?: string[]      // frontmatter 中的 paths 模式（条件规则）
  contentDiffersFromDisk?: boolean  // 内容是否与磁盘不同（经过处理）
  rawContent?: string   // 原始磁盘内容（仅当 contentDiffersFromDisk 时存在）
}
```

`contentDiffersFromDisk` 标志用于 `readFileState` 缓存——当文件被自动处理（去注释、截断）后，缓存的条目标记为 `isPartialView`，确保 Edit/Write 工具在操作前仍然需要显式 Read。

---

## 8.10 设计总结

Claude Code 的 Memory 系统体现了几个重要的设计原则：

### 8.10.1 分层而非扁平

不同层次的 Memory 服务不同的利益相关者：管理员（Managed）、用户（User/Local）、团队（Project/TeamMem）。每层有独立的权限和生命周期。

### 8.10.2 惰性而非急切

- Gate 检查延迟到 hook 执行时
- 配置从缓存中非阻塞读取
- 文件加载用 `memoize` 缓存
- Session Memory 提取有阈值控制

### 8.10.3 隔离而非共享

Session Memory 的 forked agent 与主循环完全隔离：
- 独立的 `ToolUseContext`（通过 `createSubagentContext`）
- 独立的 `readFileState`（克隆而非共享）
- 严格的权限限制（只能 Edit 指定文件）
- 共享 prompt cache 但不共享可变状态

### 8.10.4 渐进而非一次性

- Session Memory 不是一次性生成，而是随对话进展增量更新
- 每次更新只需关注新增的对话内容
- Section 大小有上限和压缩机制
- Compact 时保留最近消息与笔记互补

### 8.10.5 容错而非脆弱

- Hook 错误不中断主对话
- 提取超时有过期机制
- 文件读取失败静默跳过
- Gate 检查使用缓存值而非阻塞
- Session Memory 不可用时回退到传统 compact

---

## 8.11 Auto Memory：跨会话的持久记忆目录

前面介绍的 CLAUDE.md 是**人工编写**的指令文件，Session Memory 是**单次会话内**的自动笔记。但有一类知识既不适合让用户手写，又需要跨会话持久化——比如用户的角色偏好、项目的非显式约定、失败教训等。这就是 Auto Memory（`memdir/`）子系统的职责。

### 8.11.1 记忆目录结构

Auto Memory 以文件目录的形式组织记忆，每条记忆是一个独立的 Markdown 文件：

```
~/.claude/projects/<sanitized-git-root>/memory/
├── MEMORY.md                 ← 索引入口（< 200 行，< 25KB）
├── user_role.md              ← topic 文件：用户是数据科学家
├── testing_patterns.md       ← topic 文件：项目测试约定
├── api_design_feedback.md    ← topic 文件：API 设计偏好
├── logs/                     ← KAIROS 模式的 daily logs
│   └── 2026/03/
│       └── 2026-03-31.md
└── .consolidate-lock         ← Dream 锁文件
```

路径解析逻辑在 `memdir/paths.ts` 中，有一条精心设计的优先级链：

```typescript
// src/memdir/paths.ts:223-235
export const getAutoMemPath = memoize((): string => {
  // 1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE（SDK/Cowork 全路径覆盖）
  // 2. autoMemoryDirectory（settings.json 配置，支持 ~/）
  // 3. 默认：~/.claude/projects/<sanitized-git-root>/memory/
  const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
  if (override) return override

  const projectsDir = join(getMemoryBaseDir(), 'projects')
  return (
    join(projectsDir, sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME) + sep
  ).normalize('NFC')
})
```

关键安全设计：`getAutoMemPathSetting()` 故意**排除 projectSettings**（即 `.claude/settings.json`）——如果允许仓库代码设置记忆路径，恶意仓库就可以把记忆目录指向 `~/.ssh` 并通过 filesystem 的写入豁免获得敏感目录的写权限。这是一个典型的"最小信任"设计：

```typescript
// src/memdir/paths.ts:178-186
function getAutoMemPathSetting(): string | undefined {
  // SECURITY: projectSettings 被排除 — 恶意仓库不能设置 autoMemoryDirectory
  const dir =
    getSettingsForSource('policySettings')?.autoMemoryDirectory ??
    getSettingsForSource('flagSettings')?.autoMemoryDirectory ??
    getSettingsForSource('localSettings')?.autoMemoryDirectory ??
    getSettingsForSource('userSettings')?.autoMemoryDirectory
  return validateMemoryPath(dir, true)
}
```

路径验证同样严格——拒绝相对路径、根路径、UNC 路径、null byte 注入，并且 worktree 共享同一个 canonical git root 的记忆目录。

### 8.11.2 记忆类型分类学

Auto Memory 定义了四种记忆类型，核心原则是**只存储不可从项目当前状态推导的信息**：

```typescript
// src/memdir/memoryTypes.ts:14-19
export const MEMORY_TYPES = [
  'user',       // 用户角色、偏好、知识水平
  'feedback',   // 用户对工作方式的反馈（纠正 + 认可）
  'project',    // 项目动态：谁在做什么、为什么、截止日期
  'reference',  // 外部系统指针：Linear 项目、Grafana 面板
] as const
```

每种类型都有精确的保存和使用指导。以 `feedback` 类型为例——这是最精巧的设计：

```xml
<type>
  <name>feedback</name>
  <description>
    记录用户对工作方式的指导——既包括要避免的，也包括要保持的。
    从失败和成功中记录：如果只保存纠正，你会避免过去的错误，
    但会偏离用户已经验证的方法，并可能变得过度谨慎。
  </description>
  <when_to_save>
    任何时候用户纠正你的方法（"不要那样"、"别"、"停止做 X"）
    或确认一个非显而易见的方法有效（"对、就这样"、"完美"）。
    纠正容易注意到；确认更安静——要留意它们。
  </when_to_save>
  <body_structure>
    先写规则本身，然后 **Why:** 行（原因），
    然后 **How to apply:** 行（在何时何处应用）。
    知道"为什么"能让你判断边界情况。
  </body_structure>
</type>
```

**"记录成功而非只记录失败"**是一个深思熟虑的设计决策。如果 Agent 只记住被纠正的事情，它会逐渐变得过度保守——避免了错误但也避免了所有大胆尝试。记住成功让 Agent 保持平衡。

### 8.11.3 什么不应该保存

同样重要的是**排除规则**——防止记忆系统被噪声淹没：

```typescript
// src/memdir/memoryTypes.ts:183-195
export const WHAT_NOT_TO_SAVE_SECTION: readonly string[] = [
  '## What NOT to save in memory',
  '',
  '- Code patterns, conventions, architecture, file paths, or project structure' +
    ' — these can be derived by reading the current project state.',
  '- Git history, recent changes, or who-changed-what — git log / git blame are authoritative.',
  '- Debugging solutions or fix recipes — the fix is in the code.',
  '- Anything already documented in CLAUDE.md files.',
  '- Ephemeral task details: in-progress work, temporary state.',
  '',
  // 关键：即使用户明确要求保存也拒绝
  'These exclusions apply even when the user explicitly asks you to save.',
]
```

最后一条规则尤为大胆：**即使用户要求保存 PR 列表或活动摘要，也不保存**——而是反问"这里面哪些是出人意料或不显而易见的？"。这是通过 eval 验证的设计（注释引用了 `memory-prompt-iteration case 3, 0/2 → 3/3`）。

### 8.11.4 MEMORY.md 索引与截断

`MEMORY.md` 不是记忆本身，而是一个**索引**——每条记忆对应一行，格式为 `- [Title](file.md) — one-line hook`。它被注入到每次会话的 system prompt 中，因此有严格的大小限制：

```typescript
// src/memdir/memdir.ts:34-38
export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200    // 行数限制
export const MAX_ENTRYPOINT_BYTES = 25_000 // 字节限制（~25KB）
```

截断逻辑先按行截断（自然边界），再按字节截断（在最后一个换行符处切割，不会切断半行）：

```typescript
// src/memdir/memdir.ts:57-102
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const contentLines = trimmed.split('\n')
  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  // 先按行截断
  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  // 再按字节截断（在行边界处）
  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  // 附加警告消息
  return {
    content: truncated + `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}...`,
    // ...
  }
}
```

### 8.11.5 记忆的回忆与信任

从记忆中回忆信息时，系统内置了一套"怀疑机制"——不盲目信任旧记忆：

```typescript
// src/memdir/memoryTypes.ts:240-256
export const TRUSTING_RECALL_SECTION: readonly string[] = [
  '## Before recommending from memory',
  '',
  'A memory that names a specific function, file, or flag is a claim that ' +
  'it existed *when the memory was written*. It may have been renamed, ' +
  'removed, or never merged. Before recommending it:',
  '',
  '- If the memory names a file path: check the file exists.',
  '- If the memory names a function or flag: grep for it.',
  '- If the user is about to act on your recommendation, verify first.',
  '',
  '"The memory says X exists" is not the same as "X exists now."',
]
```

这段 prompt 的注释记录了 eval 验证过程：标题从抽象的 "Trusting what you recall" 改为行动导向的 "Before recommending from memory"，eval 结果从 0/3 变为 3/3——**措辞对 LLM 行为的影响远超直觉**。

---

## 8.12 extractMemories：每轮结束的记忆提取 Agent

如果说 Auto Memory 是记忆的"仓库"，那 `extractMemories` 就是"搬运工"——它在每轮对话结束时自动运行，从对话内容中提取值得长期保存的信息。

### 8.12.1 架构位置

```
用户提问 → 主 Agent 回答 → stop hooks 触发
                               │
                               ├─ promptSuggestion（输入建议）
                               ├─ confidenceRating（置信度评估）
                               ├─ extractMemories ←── 这里
                               └─ autoDream（记忆整理）
```

`extractMemories` 在 `stopHooks.ts` 的 `handleStopHooks()` 中被调用，是一个 fire-and-forget 的异步操作。

### 8.12.2 闭包作用域状态模式

`extractMemories.ts` 使用了一个独特的**闭包作用域状态**模式——所有可变状态都封装在 `initExtractMemories()` 创建的闭包中：

```typescript
// src/services/extractMemories/extractMemories.ts:296-587 (结构)
export function initExtractMemories(): void {
  // --- 闭包作用域的可变状态 ---
  const inFlightExtractions = new Set<Promise<void>>()
  let lastMemoryMessageUuid: string | undefined  // 游标：上次处理到哪
  let hasLoggedGateFailure = false                 // 一次性日志标记
  let inProgress = false                           // 重叠保护
  let turnsSinceLastExtraction = 0                 // 轮次节流
  let pendingContext: { context, appendSystemMessage? } | undefined  // 待处理上下文

  async function runExtraction({ context, appendSystemMessage, isTrailingRun }) {
    // ... 核心提取逻辑
  }

  async function executeExtractMemoriesImpl(context, appendSystemMessage?) {
    // ... 入口逻辑
  }

  extractor = async (context, appendSystemMessage) => { /* ... */ }
  drainer = async (timeoutMs) => { /* ... */ }
}
```

这个模式的优势：
1. **测试友好**——每次 `beforeEach` 调用 `initExtractMemories()` 获得全新闭包
2. **无全局副作用**——状态完全隔离在闭包内
3. **生命周期清晰**——`init` 时创建，`drain` 时等待完成

### 8.12.3 主 Agent 互斥

一个微妙但关键的设计：主 Agent 的 system prompt 中已经包含了记忆保存指令，它可能在对话中直接写入记忆文件。当这发生时，后台提取 agent 必须跳过，避免重复：

```typescript
// src/services/extractMemories/extractMemories.ts:121-148
function hasMemoryWritesSince(
  messages: Message[], sinceUuid: string | undefined
): boolean {
  // 扫描 sinceUuid 之后的 assistant 消息
  // 检查是否有 Edit/Write tool_use 的目标路径在 auto-memory 目录内
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    for (const block of message.message.content) {
      const filePath = getWrittenFilePath(block)
      if (filePath !== undefined && isAutoMemPath(filePath)) {
        return true  // 主 Agent 已经写了，跳过
      }
    }
  }
  return false
}
```

在 `runExtraction` 中：

```typescript
if (hasMemoryWritesSince(messages, lastMemoryMessageUuid)) {
  // 主 Agent 已写入记忆，推进游标但不执行提取
  lastMemoryMessageUuid = messages.at(-1)?.uuid
  return
}
```

这实现了主 Agent 和后台 Agent 的**互斥**：谁先写谁负责，不会重复保存。

### 8.12.4 合并与尾部追踪

当提取正在进行时收到新的触发请求，系统使用"暂存 + 尾部追踪"模式：

```typescript
// 如果正在运行，暂存最新上下文（覆盖之前暂存的）
if (inProgress) {
  pendingContext = { context, appendSystemMessage }
  return  // 不等待，立即返回
}

// 在 runExtraction 的 finally 中：
finally {
  inProgress = false
  const trailing = pendingContext
  pendingContext = undefined
  if (trailing) {
    // 运行尾部提取，只处理两次调用之间新增的消息
    await runExtraction({
      context: trailing.context,
      isTrailingRun: true,
    })
  }
}
```

只保留**最新的**暂存上下文（因为它包含最完整的消息历史），尾部运行的 `newMessageCount` 基于已推进的游标计算，只处理增量。

### 8.12.5 工具权限沙箱

提取 agent 的权限通过 `createAutoMemCanUseTool()` 严格限制：

```typescript
// src/services/extractMemories/extractMemories.ts:171-222
export function createAutoMemCanUseTool(memoryDir: string): CanUseToolFn {
  return async (tool, input) => {
    // ✅ Read/Grep/Glob：无限制（只读）
    if ([FILE_READ_TOOL_NAME, GREP_TOOL_NAME, GLOB_TOOL_NAME].includes(tool.name))
      return { behavior: 'allow' }

    // ✅ Bash：仅只读命令（ls, find, grep, cat, stat, wc, head, tail）
    if (tool.name === BASH_TOOL_NAME) {
      if (tool.isReadOnly(parsed.data))
        return { behavior: 'allow' }
      return denyAutoMemTool(tool, 'Only read-only shell commands are permitted')
    }

    // ✅ Edit/Write：仅 memory 目录内的路径
    if ((tool.name === FILE_EDIT_TOOL_NAME || tool.name === FILE_WRITE_TOOL_NAME)
        && isAutoMemPath(input.file_path))
      return { behavior: 'allow' }

    // ❌ 其他所有工具（MCP、Agent、写入 Bash 等）
    return denyAutoMemTool(tool, '...')
  }
}
```

一个有趣的边界情况：当 REPL 模式启用时（Anthropic 内部默认），原始工具被隐藏，forked agent 通过 REPL 工具间接调用。REPL 的内部 `createToolWrapper` 会对每个实际操作重新检查 `canUseTool`，所以安全约束仍然生效。允许 REPL 的原因是**不能修改工具列表**——工具列表是 prompt cache key 的一部分，修改会破坏缓存共享。

### 8.12.6 Prompt 设计

提取 prompt 的结构经过仔细设计以最小化轮次消耗：

```typescript
// src/services/extractMemories/prompts.ts:29-44 (要点)
function opener(newMessageCount: number, existingMemories: string): string {
  return [
    `You are now acting as the memory extraction subagent.`,
    `Analyze the most recent ~${newMessageCount} messages above...`,
    '',
    // 明确列出可用工具——避免试探被拒绝的工具浪费轮次
    `Available tools: Read, Grep, Glob, read-only Bash, and Edit/Write for memory only.`,
    '',
    // 高效策略指导——Read 要求先读后改，所以明确两轮策略
    `You have a limited turn budget. The efficient strategy is:`,
    `turn 1 — issue all Read calls in parallel;`,
    `turn 2 — issue all Write/Edit calls in parallel.`,
    '',
    // 禁止验证——不要浪费轮次去确认记忆内容
    `You MUST only use content from the last ~${newMessageCount} messages.`,
    `Do not waste turns attempting to investigate or verify.`,
    // 预注入已有记忆清单——避免浪费轮次执行 ls
  ].join('\n')
}
```

`maxTurns: 5` 硬限制防止 agent 陷入"验证兔子洞"——一个良好的提取通常只需要 2-4 轮（读取 → 写入）。

### 8.12.7 完成通知

当记忆成功写入后，系统会在主对话中插入一条系统消息通知用户：

```typescript
if (memoryPaths.length > 0) {
  const msg = createMemorySavedMessage(memoryPaths)
  appendSystemMessage?.(msg)  // "Saved N memories" 通知
}
```

索引文件（MEMORY.md）的更新被排除在通知之外——它是机械性的指针更新，用户真正关心的是 topic 文件。

---

## 8.13 AutoDream：后台记忆整理（"做梦"）

AutoDream 是 Claude Code 中最具创意的子系统之一。它的比喻来自人类神经科学：白天学习新知识（extractMemories），夜晚在睡眠中整理、合并、清理记忆（Dream）。

### 8.13.1 为什么需要 Dream

extractMemories 解决了"写入"问题，但随着时间推移会产生新的问题：

1. **记忆碎片化**——多个会话中学到的相关知识分散在不同文件中
2. **记忆过时**——项目演进后旧记忆不再准确
3. **记忆膨胀**——MEMORY.md 索引逐渐超出限制
4. **记忆矛盾**——不同时期写入的记忆互相冲突

Dream 的工作就是定期"清醒地回顾"，执行人类大脑在睡眠中做的事情。

### 8.13.2 三级门控设计

Dream 的触发使用了精心设计的三级门控，**从最便宜的检查到最贵的检查**排列：

```typescript
// src/services/autoDream/autoDream.ts (门控顺序)

// Gate 0: 前置条件（几乎零成本）
if (getKairosActive()) return false  // KAIROS 模式用磁盘 skill dream
if (getIsRemoteMode()) return false
if (!isAutoMemoryEnabled()) return false
if (!isAutoDreamEnabled()) return false

// Gate 1: 时间门控 — 1 次 stat 调用
const lastAt = await readLastConsolidatedAt()  // 读锁文件 mtime
const hoursSince = (Date.now() - lastAt) / 3_600_000
if (hoursSince < cfg.minHours) return  // 默认 24 小时

// Gate 1.5: 扫描节流 — 无 I/O
if (Date.now() - lastSessionScanAt < SESSION_SCAN_INTERVAL_MS) return  // 10 分钟

// Gate 2: 会话数门控 — 目录扫描
const sessionIds = await listSessionsTouchedSince(lastAt)
sessionIds = sessionIds.filter(id => id !== currentSession)  // 排除当前会话
if (sessionIds.length < cfg.minSessions) return  // 默认 5 个会话

// Gate 3: 锁 — 文件写入 + 读取验证
const priorMtime = await tryAcquireConsolidationLock()
if (priorMtime === null) return  // 其他进程正在整理
```

这个设计的巧妙之处在于成本递增：

| 门控 | 成本 | 频率 |
|------|------|------|
| Gate 0: 前置条件 | ~0（内存读取） | 每轮 |
| Gate 1: 时间门控 | 1 次 stat | 每轮 |
| Gate 1.5: 扫描节流 | 0（时间戳比较） | 时间门控通过后 |
| Gate 2: 会话扫描 | 目录遍历 + N 次 stat | 每 10 分钟最多 1 次 |
| Gate 3: 文件锁 | 1 次写入 + 1 次读取 | 会话数满足后 |

大多数轮次在 Gate 1 就会退出（不到 24 小时），成本仅为一次 `stat` 系统调用。

### 8.13.3 锁机制：文件 mtime 即时间戳

`consolidationLock.ts` 实现了一个极简但健壮的分布式锁，核心技巧是**复用锁文件的 mtime 作为 `lastConsolidatedAt` 时间戳**：

```typescript
// src/services/autoDream/consolidationLock.ts

// 锁文件路径：<memory-dir>/.consolidate-lock
// 文件内容：持有者的 PID（用于活锁检测）
// 文件 mtime：上次整理完成的时间

export async function readLastConsolidatedAt(): Promise<number> {
  try {
    const s = await stat(lockPath())
    return s.mtimeMs  // mtime 就是时间戳
  } catch {
    return 0  // 文件不存在 = 从未整理过
  }
}

export async function tryAcquireConsolidationLock(): Promise<number | null> {
  // 检查现有锁
  const [s, raw] = await Promise.all([stat(path), readFile(path, 'utf8')])
  const mtimeMs = s.mtimeMs
  const holderPid = parseInt(raw.trim(), 10)

  // 如果锁未过期且持有者 PID 仍在运行 → 锁定中
  if (Date.now() - mtimeMs < HOLDER_STALE_MS) {  // 1 小时过期
    if (isProcessRunning(holderPid)) return null
    // PID 已死 → 回收锁
  }

  // 获取锁：写入自己的 PID → mtime 变为 now
  await writeFile(path, String(process.pid))

  // 竞态检测：两个进程同时写 → 最后一个赢
  const verify = await readFile(path, 'utf8')
  if (parseInt(verify.trim(), 10) !== process.pid) return null  // 输了

  return mtimeMs ?? 0  // 返回之前的 mtime（用于回滚）
}
```

回滚机制同样优雅：

```typescript
export async function rollbackConsolidationLock(priorMtime: number): Promise<void> {
  if (priorMtime === 0) {
    await unlink(path)  // 恢复到"从未整理"状态
    return
  }
  await writeFile(path, '')     // 清空 PID（避免自己的 PID 被误认为仍在持有）
  await utimes(path, t, t)      // 用 utimes 恢复 mtime
}
```

**为什么不用 advisory lock（flock）？** 因为 `flock` 在进程退出时自动释放，无法保留 `lastConsolidatedAt` 信息。文件 mtime 方案用一个文件同时承载两个语义——"谁在持有锁"和"上次完成时间"。

### 8.13.4 Dream 的四阶段 Prompt

Dream prompt 是一个精心编排的四阶段工作流：

```typescript
// src/services/autoDream/consolidationPrompt.ts:15-64
export function buildConsolidationPrompt(
  memoryRoot: string, transcriptDir: string, extra: string
): string {
  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files.

## Phase 1 — Orient
- ls 记忆目录
- 读 MEMORY.md 了解当前索引
- 浏览已有 topic 文件（避免创建重复）

## Phase 2 — Gather recent signal
- 优先看 daily logs（logs/YYYY/MM/YYYY-MM-DD.md）
- 检查与当前代码矛盾的旧记忆
- 必要时窄范围 grep JSONL transcript（不要通读）

## Phase 3 — Consolidate
- 合并新信号到已有 topic 文件（不是创建新的）
- 将相对日期转为绝对日期（"昨天" → "2026-03-30"）
- 删除已被推翻的旧事实

## Phase 4 — Prune and index
- MEMORY.md < 200 行 且 < 25KB
- 每条索引一行，< 150 字符
- 删除过时指针，精简冗长条目
- 解决矛盾——两个文件不一致时修正错误的那个

${extra}`  // extra 包含 tool 约束和会话列表
}
```

注意 Phase 2 的 transcript 访问指导：**"Don't exhaustively read transcripts. Look only for things you already suspect matter."** 这防止 Dream agent 浪费大量 token 通读完整的 JSONL 日志。

### 8.13.5 工具约束与安全

Dream agent 的工具约束通过 `extra` 参数注入（而不是放在共享 prompt 中），因为手动 `/dream` 命令在主循环中运行，有正常的完整权限：

```typescript
const extra = `
**Tool constraints for this run:** Bash is restricted to read-only commands
(ls, find, grep, cat, stat, wc, head, tail, and similar). Anything that writes,
redirects to a file, or modifies state will be denied.

Sessions since last consolidation (${sessionIds.length}):
${sessionIds.map(id => `- ${id}`).join('\n')}`
```

权限复用 `extractMemories` 的 `createAutoMemCanUseTool()`——读操作无限制，写操作仅限 memory 目录。

### 8.13.6 DreamTask：后台任务 UI

Dream 通过 `DreamTask.ts` 在终端底部状态条中可视化：

```typescript
// src/tasks/DreamTask/DreamTask.ts
export type DreamTaskState = TaskStateBase & {
  type: 'dream'
  phase: DreamPhase           // 'starting' | 'updating'
  sessionsReviewing: number   // 正在审查几个会话
  filesTouched: string[]      // 修改了哪些文件（不完整——只捕获 Edit/Write）
  turns: DreamTurn[]          // agent 文本响应 + 工具调用计数
  abortController?: AbortController
  priorMtime: number          // 用于 kill 时回滚锁
}
```

Phase 从 `starting` 切换到 `updating` 的时机很简洁——第一次观察到 Edit/Write tool_use 时自动切换：

```typescript
export function addDreamTurn(taskId, turn, touchedPaths, setAppState): void {
  updateTaskState<DreamTaskState>(taskId, setAppState, task => ({
    ...task,
    phase: newTouched.length > 0 ? 'updating' : task.phase,
    filesTouched: newTouched.length > 0
      ? [...task.filesTouched, ...newTouched]
      : task.filesTouched,
    turns: task.turns.slice(-(MAX_TURNS - 1)).concat(turn),  // 保留最近 30 轮
  }))
}
```

用户可以通过 `Shift+Down` 打开后台任务面板查看 Dream 进展，也可以 kill 终止。Kill 操作会回滚锁的 mtime——确保下次会话仍会重试：

```typescript
export const DreamTask: Task = {
  async kill(taskId, setAppState) {
    let priorMtime: number | undefined
    updateTaskState<DreamTaskState>(taskId, setAppState, task => {
      task.abortController?.abort()
      priorMtime = task.priorMtime
      return { ...task, status: 'killed', endTime: Date.now() }
    })
    if (priorMtime !== undefined) {
      await rollbackConsolidationLock(priorMtime)  // 回滚 → 下次重试
    }
  },
}
```

---

## 8.14 三层记忆系统的协作全景

回顾全章，Claude Code 的完整记忆系统可以理解为三个协作层次，对应人类认知的三个阶段：

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Claude Code 记忆系统全景                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────┐   ┌──────────────────┐   ┌─────────────────┐  │
│  │   CLAUDE.md     │   │  Session Memory  │   │   Auto Memory   │  │
│  │   静态指令文件    │   │  会话内自动笔记    │   │  跨会话持久记忆   │  │
│  ├─────────────────┤   ├──────────────────┤   ├─────────────────┤  │
│  │ 类比：教科书/手册 │   │ 类比：工作日志     │   │ 类比：长期记忆    │  │
│  │ 作者：人类       │   │ 作者：后台 Agent   │   │ 作者：后台 Agent  │  │
│  │ 生命周期：永久    │   │ 生命周期：单次会话  │   │ 生命周期：跨会话   │  │
│  │ 大小：≤40K 字符  │   │ 大小：≤12K tokens │   │ 索引≤200行       │  │
│  │ 注入方式：系统提示 │   │ 注入方式：Compact时│   │ 注入方式：系统提示 │  │
│  │ 触发：启动加载    │   │ 触发：post-sampling│   │ 触发：stop hooks │  │
│  └────────┬────────┘   └────────┬─────────┘   └────────┬────────┘  │
│           │                     │                       │           │
│           └─────────────────────┼───────────────────────┘           │
│                                 │                                   │
│                     ┌───────────┴───────────┐                       │
│                     │     AutoDream         │                       │
│                     │   "做梦"记忆整理       │                       │
│                     │  类比：睡眠中的记忆整合 │                       │
│                     │  触发：24h + 5个会话   │                       │
│                     │  工作：合并/清理/修剪   │                       │
│                     └───────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────┘
```

### 8.14.1 数据流

```
用户对话
  ├─→ Session Memory（post-sampling hook，每 5K tokens + 3 次工具调用）
  │     └─→ 更新 notes.md（结构化笔记，用于 compact 替代摘要）
  │
  ├─→ extractMemories（stop hook，每轮结束）
  │     └─→ 写入 memory/*.md（持久记忆文件 + MEMORY.md 索引）
  │
  └─→ autoDream（stop hook，每 24 小时 + 5 个会话）
        └─→ 整理 memory/*.md（合并/清理/修剪索引）
```

### 8.14.2 互斥与协调

三个后台 Agent 之间有精密的协调机制：

| 协调点 | 机制 |
|--------|------|
| Session Memory vs 主循环 | `sequential()` 串行化 + 只在主 REPL 线程运行 |
| extractMemories vs 主 Agent | `hasMemoryWritesSince()` 互斥检测 |
| extractMemories vs 自身 | `inProgress` 标志 + `pendingContext` 合并 |
| autoDream vs 其他进程 | 文件锁（PID + mtime） |
| autoDream vs extractMemories | 不同触发条件（stop hook vs post-sampling hook） |

---

## 8.15 设计启示：构建你自己的 Agent 记忆系统

Claude Code 的记忆系统为 Agent 记忆设计提供了丰富的可借鉴模式。

### 8.15.1 "学习-做梦"双循环

这是整个系统最核心的架构创新。传统做法是在对话中直接保存记忆，但 Claude Code 将其分为两个独立的循环：

- **学习循环**（extractMemories）：每轮结束时增量提取新记忆
- **整理循环**（autoDream）：定期回顾、合并、清理已有记忆

这对应人类认知科学中的"编码-巩固"模型——新信息先快速存储（海马体），然后在睡眠中整合到长期记忆（皮层）。对 Agent 系统的启示是：**不要试图在写入时就完美组织记忆——先快速存储，再异步整理。**

### 8.15.2 门控成本分层

AutoDream 的三级门控设计是一个通用模式：将检查按成本排序，让最便宜的检查先执行以快速短路。对于任何"可能需要做但通常不需要做"的后台任务，这个模式都适用：

```
检查缓存标志 → 检查时间戳 → 扫描目录 → 获取锁 → 执行任务
   O(1)          O(1)         O(n)        O(1)      O(expensive)
```

大多数调用在第一步就返回，只有极少数到达最后一步。

### 8.15.3 记忆分类学

四种类型（user/feedback/project/reference）的分类不是随意的。它基于一个清晰的原则：**只保存不可从项目当前状态推导的信息**。代码模式可以 grep，git 历史可以 `log`，但"用户是新手"和"不要 mock 数据库"这类知识无法从代码推导。

设计你自己的记忆分类时，问自己：**这条信息能通过工具从当前状态获取吗？** 如果能，不要保存——保存会产生过时风险。

### 8.15.4 "记住成功"原则

`feedback` 类型的 prompt 明确要求**同时记录纠正和确认**。这解决了一个微妙的偏差：如果只记录错误，Agent 会学会避免所有大胆尝试。这是一个可迁移到任何学习系统的原则——强化学习中的 reward 不能只有 negative signal。

### 8.15.5 锁文件复用 mtime

`consolidationLock.ts` 的设计展示了系统编程中"一个机制服务多个语义"的思维方式。用 `flock` 需要额外的文件或数据库记录时间戳；用 mtime 一个文件就解决了两个问题。这种设计适用于任何需要"上次执行时间"+ "互斥执行"组合的场景。

### 8.15.6 Forked Agent 的 Prompt Cache 共享

所有后台 Agent（Session Memory、extractMemories、autoDream）都通过 `CacheSafeParams` 共享主循环的 prompt cache。这意味着即使后台 Agent 的 API 调用也有极高的缓存命中率，大幅降低成本。设计原则是：**后台任务的 system prompt + 消息前缀必须与主循环完全相同**——任何差异都会导致缓存未命中。这也是为什么 Dream 的工具约束放在 `extra` 参数而不是修改共享 prompt 的原因。

### 8.15.7 "怀疑旧记忆"原则

"Before recommending from memory" 的验证要求（grep 函数名、检查文件是否存在）是所有记忆系统都应该实现的。记忆越老越可能过时。在推荐之前花几次工具调用验证，远好过给出过时的建议。

这套 Memory 系统将 Claude Code 从一个"无状态的 LLM 对话"提升为一个"有记忆的 Agent"——它能记住用户的偏好、项目的约定、工作的进展，并在需要时把这些记忆注入到 Agent 的 context 中。更重要的是，它展示了一个完整的 Agent 记忆架构：静态指令、会话笔记、持久记忆、定期整理——四个层次协作，构成了一个从认知科学中汲取灵感的工程系统。
