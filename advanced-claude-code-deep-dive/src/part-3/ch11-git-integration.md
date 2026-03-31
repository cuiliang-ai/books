
# 第 11 章：Git 集成 — 版本控制的深度融合

> **核心问题**：一个 AI 编程助手如何安全地操作 git？如何在自动化 commit、PR 创建的同时防止数据丢失？

Claude Code 与 Git 的集成不是简单的 `git` 命令封装。它深入到 Git 的内部结构中 — 直接读取 `.git` 目录、解析 refs、管理 worktree、追踪文件历史、生成智能 diff。这套集成跨越了工具层、Utils 层和 Prompt 层，共同构成了一个安全、高效的版本控制工作流。

---

## 11.1 Git 集成架构

### 文件分布

Git 相关代码分布在多个层次：

```
src/
├── utils/
│   ├── git.ts                    ← Git 核心操作（findGitRoot, getBranch...）
│   ├── gitDiff.ts                ← Diff 计算（fetchGitDiff, fetchSingleFileGitDiff）
│   ├── gitSettings.ts            ← Git 指令开关
│   ├── git/
│   │   ├── gitFilesystem.ts      ← 文件系统级 Git 操作（不执行 git 命令）
│   │   ├── gitConfigParser.ts    ← Git 配置解析
│   │   └── gitignore.ts          ← .gitignore 解析
│   ├── worktree.ts               ← Worktree 管理
│   ├── commitAttribution.ts      ← Commit 归属标记
│   └── fileHistory.ts            ← 文件修改历史
├── tools/
│   ├── EnterWorktreeTool/        ← 创建 worktree
│   ├── ExitWorktreeTool/         ← 退出 worktree
│   └── shared/
│       └── gitOperationTracking.ts ← Git 操作追踪
└── constants/
    └── github-app.ts             ← GitHub App 配置
```

### 分层架构

```
┌─────────────────────────────────────────────────────────┐
│                    Prompt 层                              │
│  Bash prompt 中的 Git Safety Protocol                    │
│  commit/PR 创建的详细步骤指南                             │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                    工具层                                  │
│  BashTool（执行 git 命令）                                │
│  EnterWorktreeTool / ExitWorktreeTool（worktree 管理）    │
│  gitOperationTracking（操作追踪）                         │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                    Utils 层                                │
│  git.ts（核心操作）    gitDiff.ts（diff 计算）            │
│  worktree.ts（worktree 实现）                             │
│  git/gitFilesystem.ts（文件系统级操作）                    │
│  fileHistory.ts（文件历史）                               │
│  commitAttribution.ts（归属标记）                         │
└─────────────────────────────────────────────────────────┘
```

---

## 11.2 Git 根目录发现

### findGitRoot

`findGitRoot` 是最基础的 Git 操作 — 从当前目录向上查找 `.git`：

```typescript
// src/utils/git.ts
const findGitRootImpl = memoizeWithLRU(
  (startPath: string): string | typeof GIT_ROOT_NOT_FOUND => {
    let current = resolve(startPath)
    const root = current.substring(0, current.indexOf(sep) + 1) || sep

    while (current !== root) {
      try {
        const gitPath = join(current, '.git')
        const stat = statSync(gitPath)
        // .git 可以是目录（普通仓库）或文件（worktree/submodule）
        if (stat.isDirectory() || stat.isFile()) {
          return current.normalize('NFC')
        }
      } catch {
        // .git 不存在，继续向上
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return GIT_ROOT_NOT_FOUND
  },
  path => path,
  50,  // LRU 缓存 50 个条目
)
```

关键设计点：

1. **LRU 缓存**：`memoizeWithLRU` 限制缓存大小为 50 个条目。`gitDiff` 对每个文件的 `dirname` 调用 `findGitRoot`，编辑多个目录的文件会积累大量条目。无界 memoize 会内存泄漏。

2. **NFC 规范化**：macOS 文件系统使用 NFD 编码（将 `é` 分解为 `e + ́`），但 Git 使用 NFC。`.normalize('NFC')` 确保一致性。

3. **支持 worktree 和 submodule**：`.git` 可以是文件（指向真正的 git 目录），而不只是目录。

### 文件系统级 Git 操作

`git/gitFilesystem.ts` 直接读取 `.git` 目录结构，**避免执行 git 命令**：

```typescript
// src/utils/git/gitFilesystem.ts

// 直接读取 .git/HEAD 获取当前分支
export function getCachedHead(gitDir: string): string | null

// 读取 .git/refs/heads/ 获取分支
export function getCachedBranch(gitDir: string): string | null

// 读取 .git/refs/remotes/origin/ 获取远程 URL
export function getCachedRemoteUrl(gitDir: string): string | null

// 检查 .git/shallow 判断浅克隆
export function isShallowClone(gitDir: string): boolean

// 解析 .git/worktrees/ 获取 worktree 计数
export function getWorktreeCountFromFs(gitDir: string): number

// 解析 .git 文件获取真正的 git 目录
export function resolveGitDir(dotGitPath: string): string | null

// 获取 commondir（多 worktree 共享的目录）
export function getCommonDir(gitDir: string): string

// 读取 worktree 的 HEAD SHA
export function readWorktreeHeadSha(gitDir: string): string | null

// 解析 ref（如 refs/heads/main → SHA）
export function resolveRef(gitDir: string, ref: string): string | null
```

> **设计决策**：为什么直接读取 `.git` 目录而不执行 `git` 命令？因为 `git status`、`git rev-parse` 等命令需要 fork 子进程，在高频调用场景（如每次工具执行后更新状态）中开销太大。直接读文件是 O(1) 的。

---

## 11.3 Git Diff 系统

### fetchGitDiff

`gitDiff.ts` 实现了高效的 diff 计算，用于系统提示中的上下文信息：

```typescript
// src/utils/gitDiff.ts

export type GitDiffResult = {
  stats: GitDiffStats           // 总体统计
  perFileStats: Map<string, PerFileStats>  // 每文件统计
  hunks: Map<string, StructuredPatchHunk[]>  // 每文件 diff hunks
}

// 性能保护常量
const GIT_TIMEOUT_MS = 5000           // git 命令 5秒超时
const MAX_FILES = 50                   // 最多处理 50 个文件
const MAX_DIFF_SIZE_BYTES = 1_000_000  // 跳过超过 1MB 的文件
const MAX_LINES_PER_FILE = 400         // 每文件最多 400 行 diff
const MAX_FILES_FOR_DETAILS = 500      // 超过 500 文件跳过详细信息
```

### 快速探测路径

```typescript
export async function fetchGitDiff(): Promise<GitDiffResult | null> {
  const isGit = await getIsGit()
  if (!isGit) return null

  // 跳过 merge/rebase/cherry-pick/revert 期间的 diff
  if (await isInTransientGitState()) return null

  // 快速探测：用 --shortstat 获取总数
  const { stdout: shortstatOut } = await execFileNoThrow(
    gitExe(), ['--no-optional-locks', 'diff', 'HEAD', '--shortstat'],
    { timeout: GIT_TIMEOUT_MS }
  )

  const quickStats = parseShortstat(shortstatOut)
  if (quickStats && quickStats.filesCount > MAX_FILES_FOR_DETAILS) {
    // 太多文件 — 返回准确总数但跳过逐文件详情
    return {
      stats: quickStats,
      perFileStats: new Map(),
      hunks: new Map(),
    }
  }
  // ... 详细 diff 计算
}
```

> **设计决策**：先用 `--shortstat`（O(1) 内存）探测文件数量。如果超过 500 个文件（如 jj workspace），直接返回总数统计而不加载数百 MB 的 diff 内容到内存中。

### 瞬态 Git 状态检测

```typescript
async function isInTransientGitState(): Promise<boolean> {
  // 检查 merge/rebase/cherry-pick/revert 状态
  // 这些状态下工作树包含的是传入的更改，不是用户主动做的修改
}
```

### 单文件 Git Diff

Edit/Write 工具在修改文件后调用：

```typescript
export async function fetchSingleFileGitDiff(
  filePath: string
): Promise<ToolUseDiff | null> {
  // 获取单个文件相对于 HEAD 的 diff
  // 用于 UI 展示编辑结果
}
```

---

## 11.4 Git 操作追踪

### gitOperationTracking

```typescript
// src/tools/shared/gitOperationTracking.ts
export function trackGitOperations(/* ... */) {
  // 追踪 Bash 工具中执行的 git 操作
  // 用于 commit 归属和分析
}
```

### Commit 归属

```typescript
// src/utils/commitAttribution.ts
export function getAttributionTexts(): {
  commit: string   // "Co-Authored-By: Claude ..."
  pr: string       // PR 底部的归属文本
}
```

Commit 消息末尾会自动添加 `Co-Authored-By` 标记，表明是 AI 辅助创建的。

### 文件历史

```typescript
// src/utils/fileHistory.ts
export type FileHistoryState = {
  // 追踪哪些文件被 Claude Code 修改过
  // 用于 diff 展示和归属
}

export function fileHistoryTrackEdit(
  state: FileHistoryState,
  filePath: string,
  editType: 'create' | 'edit' | 'write'
): FileHistoryState
```

---

## 11.5 Worktree 管理

### 为什么需要 Worktree？

Git worktree 允许在同一仓库中并行工作在不同分支：

```
主仓库 /project/
├── .git/
├── src/
└── 当前在 main 分支

Worktree /project/.claude/worktrees/feature-x/
├── .git (文件，指向主仓库)
├── src/
└── 在 feature-x 分支
```

Claude Code 利用 worktree 实现**会话隔离** — 每个 worktree session 在独立的目录和分支中工作，不影响主工作区。

### EnterWorktreeTool

```typescript
// src/tools/EnterWorktreeTool/EnterWorktreeTool.ts
export const EnterWorktreeTool: Tool = buildTool({
  name: ENTER_WORKTREE_TOOL_NAME,  // "EnterWorktree"
  searchHint: 'create an isolated git worktree and switch into it',
  shouldDefer: true,  // 延迟加载

  async call(input) {
    // 1. 验证不在已有 worktree 中
    if (getCurrentWorktreeSession()) {
      throw new Error('Already in a worktree session')
    }

    // 2. 创建 worktree
    const result = await createWorktreeForSession(input.name)

    // 3. 切换 CWD
    setCwd(result.worktreePath)
    setOriginalCwd(result.worktreePath)

    // 4. 清除缓存
    clearSystemPromptSections()  // system prompt 依赖 CWD
    clearMemoryFileCaches()      // CLAUDE.md 路径变了

    // 5. 保存 worktree 状态
    saveWorktreeState(...)

    return { data: { worktreePath, worktreeBranch, message } }
  }
})
```

### Worktree 创建流程

```typescript
// src/utils/worktree.ts
export async function createWorktreeForSession(name?: string) {
  // 1. 验证在 git 仓库中
  const gitRoot = findCanonicalGitRoot()

  // 2. 生成 worktree 路径
  //    .claude/worktrees/<slug>/
  const worktreeDir = join(gitRoot, '.claude', 'worktrees', slug)

  // 3. 获取当前 HEAD 作为基础
  const headSha = readWorktreeHeadSha(gitDir)

  // 4. 创建分支和 worktree
  //    可能通过 hook 或 git worktree add
  if (hasWorktreeCreateHook()) {
    await executeWorktreeCreateHook(worktreeDir, slug)
  } else {
    // git worktree add -b <branch> <path> HEAD
    await execFileNoThrow(gitExe(), [
      'worktree', 'add', '-b', branchName, worktreeDir, 'HEAD'
    ])
  }

  // 5. 复制配置文件
  //    .claude/ 目录下的设置需要复制到 worktree
}
```

### Slug 验证

```typescript
// src/utils/worktree.ts
const VALID_WORKTREE_SLUG_SEGMENT = /^[a-zA-Z0-9._-]+$/
const MAX_WORKTREE_SLUG_LENGTH = 64

export function validateWorktreeSlug(slug: string): void {
  if (slug.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new Error(`Invalid worktree name: must be ${MAX_WORKTREE_SLUG_LENGTH} characters or fewer`)
  }
  // 每个 "/" 分隔的段都必须匹配白名单
  for (const segment of slug.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(`must not contain "." or ".." path segments`)
    }
    if (!VALID_WORKTREE_SLUG_SEGMENT.test(segment)) {
      throw new Error(`contains invalid characters`)
    }
  }
}
```

> **设计决策**：Slug 通过 `path.join` 拼接到 `.claude/worktrees/` 下。`path.join` 会规范化 `..` 段，所以 `../../../target` 会逃逸出 worktrees 目录。严格的白名单验证防止了路径遍历攻击。

### ExitWorktreeTool

```typescript
// src/tools/ExitWorktreeTool/ExitWorktreeTool.ts
// action: 'keep' — 保留 worktree 和分支
// action: 'remove' — 删除 worktree 和分支
// discard_changes: true — 即使有未提交更改也删除
```

---

## 11.6 Git Safety Protocol

### Prompt 中的安全指令

Bash 工具的 system prompt 包含详细的 Git 安全协议（`src/tools/BashTool/prompt.ts`）：

```
Git Safety Protocol:
1. NEVER update the git config
2. NEVER run destructive git commands unless explicitly requested
   - push --force
   - reset --hard
   - checkout .
   - restore .
   - clean -f
   - branch -D
3. NEVER skip hooks (--no-verify, --no-gpg-sign)
4. NEVER run force push to main/master
5. Always create NEW commits rather than amending
6. Prefer adding specific files rather than "git add -A"
7. NEVER commit unless user explicitly asks
```

### 破坏性命令检测

```typescript
// src/tools/BashTool/destructiveCommandWarning.ts
// 检测并警告用户关于破坏性的 git 命令
```

### 只读 Git 命令

```typescript
// 从 readOnlyValidation.ts 引用
GIT_READ_ONLY_COMMANDS = {
  'git status': { safeFlags: { ... } },
  'git log': { safeFlags: { ... } },
  'git diff': { safeFlags: { ... } },
  'git show': { safeFlags: { ... } },
  'git branch': { safeFlags: { '-a': 'none', '-l': 'none', ... } },
  'git remote': { safeFlags: { '-v': 'none' } },
  'git rev-parse': { safeFlags: { ... } },
  // ...
}

GH_READ_ONLY_COMMANDS = {
  'gh pr view': { safeFlags: { ... } },
  'gh issue list': { safeFlags: { ... } },
  'gh run view': { safeFlags: { ... } },
  // ...
}
```

### Git 命令规范化

```typescript
// bashPermissions.ts
export function isNormalizedGitCommand(command: string): boolean {
  // 检查是否是规范化的 git 命令
  // 跳过环境变量前缀等
}
```

---

## 11.7 Commit 工作流

### Prompt 中的 Commit 指南

Bash 工具的 prompt 包含完整的 commit 创建流程：

```
1. 并行运行：
   - git status（查看未追踪文件）
   - git diff（查看变更）
   - git log（查看提交风格）

2. 分析变更，草拟提交消息

3. 并行运行：
   - git add <specific files>
   - git commit -m "$(cat <<'EOF'
     提交消息
     Co-Authored-By: Claude ...
     EOF
     )"
   - git status（验证提交成功）

4. 如果 pre-commit hook 失败：
   修复问题并创建 NEW commit（不要 amend）
```

### Commit 归属文本

```typescript
// src/utils/commitAttribution.ts (通过 prompt.ts)
const { commit: commitAttribution, pr: prAttribution } = getAttributionTexts()

// 生成类似：
// Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

### PR 创建指南

```
1. 并行运行：
   - git status
   - git diff
   - 检查远程分支
   - git log + git diff [base]...HEAD

2. 分析所有变更（所有 commit，不仅最新的）

3. 并行运行：
   - 创建分支
   - push -u
   - gh pr create --title "..." --body "$(cat <<'EOF'
     ## Summary
     ...
     ## Test plan
     ...
     EOF
     )"
```

---

## 11.8 .gitignore 集成

### 搜索工具中的 .gitignore

```typescript
// src/utils/git/gitignore.ts
// 解析 .gitignore 文件，用于文件搜索的排除规则
```

Grep 和 Glob 工具会自动尊重 `.gitignore` 中的排除模式。ripgrep 本身也内置了 gitignore 支持。

---

## 11.9 Git 配置解析

```typescript
// src/utils/git/gitConfigParser.ts
export function parseGitConfigValue(
  gitDir: string,
  section: string,
  key: string
): string | null
```

直接解析 `.git/config` 文件获取配置值，避免执行 `git config` 命令。

---

## 11.10 默认分支检测

```typescript
// src/utils/git.ts
export async function getDefaultBranch(): Promise<string> {
  // 尝试多种方式检测默认分支：
  // 1. git symbolic-ref refs/remotes/origin/HEAD
  // 2. 常见分支名探测 (main, master)
  // 3. 远程 HEAD 指向
}
```

### Branch 信息获取

```typescript
export async function getBranch(): Promise<string | null> {
  // 优先从文件系统缓存获取
  return getCachedBranch(gitDir)
}
```

---

## 章末速查表

| 概念 | 定义位置 | 说明 |
|------|---------|------|
| `findGitRoot()` | `utils/git.ts` | 向上查找 .git 目录 |
| `findCanonicalGitRoot()` | `utils/git.ts` | 查找规范 git root（解析符号链接） |
| `getIsGit()` | `utils/git.ts` | 是否在 git 仓库中 |
| `getBranch()` | `utils/git.ts` | 获取当前分支名 |
| `getDefaultBranch()` | `utils/git.ts` | 获取默认分支 |
| `gitExe()` | `utils/git.ts` | git 可执行文件路径 |
| `fetchGitDiff()` | `utils/gitDiff.ts` | 获取完整 diff 统计 |
| `fetchSingleFileGitDiff()` | `utils/gitDiff.ts` | 单文件 diff |
| `getCachedBranch()` | `git/gitFilesystem.ts` | 从文件系统读取分支 |
| `getCachedHead()` | `git/gitFilesystem.ts` | 从文件系统读取 HEAD |
| `resolveGitDir()` | `git/gitFilesystem.ts` | 解析 .git 文件 → 目录 |
| `getCommonDir()` | `git/gitFilesystem.ts` | 获取共享目录 |
| `parseGitConfigValue()` | `git/gitConfigParser.ts` | 解析 git 配置 |
| `createWorktreeForSession()` | `utils/worktree.ts` | 创建会话 worktree |
| `validateWorktreeSlug()` | `utils/worktree.ts` | 验证 worktree slug |
| `EnterWorktreeTool` | `tools/EnterWorktreeTool/` | 创建并进入 worktree |
| `ExitWorktreeTool` | `tools/ExitWorktreeTool/` | 退出 worktree |
| `trackGitOperations()` | `tools/shared/gitOperationTracking.ts` | 追踪 git 操作 |
| `getAttributionTexts()` | `utils/commitAttribution.ts` | 获取 commit 归属文本 |
| `fileHistoryTrackEdit()` | `utils/fileHistory.ts` | 追踪文件修改历史 |
| `GIT_TIMEOUT_MS` | `utils/gitDiff.ts` | Git 命令超时 (5000ms) |
| `MAX_FILES` | `utils/gitDiff.ts` | Diff 最大文件数 (50) |
| `MAX_DIFF_SIZE_BYTES` | `utils/gitDiff.ts` | Diff 文件大小上限 (1MB) |
