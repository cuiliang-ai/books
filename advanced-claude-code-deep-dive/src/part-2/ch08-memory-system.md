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

这套 Memory 系统将 Claude Code 从一个"无状态的 LLM 对话"提升为一个"有记忆的 Agent"——它能记住用户的偏好、项目的约定、工作的进展，并在需要时把这些记忆注入到 Agent 的 context 中。
