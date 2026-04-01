
# 第 11 章：File I/O 工具族 — 精确的文件操作

> **核心问题**：为什么不用 `cat` 读文件、`sed` 编辑、`grep` 搜索？专用文件工具比 Bash 命令行等价物好在哪里？

Claude Code 提供了一整套文件操作工具：`Read`（读取）、`Write`（写入）、`Edit`（编辑）、`Glob`（文件搜索）、`Grep`（内容搜索）、`NotebookEdit`（Jupyter 编辑）。这些工具看起来只是 shell 命令的封装，但实际上它们在**结构化输出、安全控制、并发优化、权限精细化**方面远超 Bash 等价物。

---

## 11.1 工具族全景

### 六个核心文件工具

```
                          File I/O 工具族
    ┌──────────────────────────────────────────────────────┐
    │                                                      │
    │  只读工具（isConcurrencySafe = true）                  │
    │  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
    │  │  Read     │  │  Glob    │  │  Grep    │           │
    │  │ 文件读取   │  │ 文件搜索  │  │ 内容搜索  │           │
    │  │ 图片/PDF  │  │ 模式匹配  │  │ ripgrep  │           │
    │  └──────────┘  └──────────┘  └──────────┘           │
    │                                                      │
    │  写入工具（isConcurrencySafe = false）                 │
    │  ┌──────────┐  ┌──────────┐  ┌──────────────┐       │
    │  │  Write    │  │  Edit    │  │ NotebookEdit  │       │
    │  │ 文件覆写   │  │ 字符串替换 │  │ Jupyter 编辑  │       │
    │  │ 新建文件   │  │ 原地修改  │  │ Cell 操作     │       │
    │  └──────────┘  └──────────┘  └──────────────┘       │
    │                                                      │
    └──────────────────────────────────────────────────────┘
```

### 对比表：专用工具 vs Bash

| 维度 | 专用工具 | Bash 等价物 | 优势 |
|------|---------|-------------|------|
| **输出格式** | 带行号的结构化数据 | 纯文本 | LLM 更容易定位代码 |
| **安全** | 先读后写保护 | 无 | 防止并发写入冲突 |
| **权限** | 按文件路径精细控制 | 按命令匹配 | 更精确的权限边界 |
| **并发** | 只读工具可并行 | 全部串行 | 显著提升搜索速度 |
| **错误处理** | 结构化错误 + 建议 | 退出码 + stderr | LLM 更容易理解和恢复 |
| **大小控制** | 内置 token 限制 | 无限制 | 防止 context 溢出 |

---

## 11.2 FileReadTool — 智能文件读取

### 核心特性

`FileReadTool` 不只是 `cat` 的封装。它是一个支持**文本、图片、PDF、Jupyter notebook** 的多格式读取工具。

```typescript
// src/tools/FileReadTool/FileReadTool.ts
export const FileReadTool = buildTool({
  name: FILE_READ_TOOL_NAME,     // "Read"
  maxResultSizeChars: Infinity,   // 永不持久化（防循环）
  isConcurrencySafe() { return true },
  isReadOnly() { return true },
  // ...
})
```

### 输入参数

```typescript
const inputSchema = z.strictObject({
  file_path: z.string()
    .describe('The absolute path to the file to read'),
  offset: z.number().optional()
    .describe('Line number to start reading from'),
  limit: z.number().optional()
    .describe('Number of lines to read'),
  pages: z.string().optional()
    .describe('Page range for PDF files (e.g., "1-5")'),
})
```

### 多格式检测与处理

```
FileReadTool.call(input)
    │
    ├── 路径扩展 & 规范化
    │
    ├── 检查阻止的设备路径
    │   └── /dev/zero, /dev/random, /dev/urandom...
    │
    ├── 文件类型检测
    │   ├── .ipynb → readNotebook() → 结构化 cell 输出
    │   ├── .pdf  → readPDF() / extractPDFPages()
    │   ├── 图片  → detectImageFormatFromBuffer() → base64
    │   ├── 二进制 → hasBinaryExtension() 检查
    │   └── 文本  → readFileInRange() 带行号
    │
    └── 输出格式化
        └── addLineNumbers() → "1\t第一行\n2\t第二行\n..."
```

### 阻止的设备路径

```typescript
// 会导致进程挂起的设备文件
const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero',      // 无限输出 — 永不到 EOF
  '/dev/random',    // 阻塞等待熵
  '/dev/urandom',   // 无限输出
  '/dev/stdin',     // 阻塞等待输入
  '/dev/fd/0',      // 同上
  '/dev/tty',       // 终端设备
])
```

### 读取限制

```typescript
// src/tools/FileReadTool/limits.ts
export function getDefaultFileReadingLimits() {
  return {
    maxTokens: number,      // 基于模型 context 的 token 限制
    maxSizeBytes: number,   // 文件大小上限
  }
}
```

`maxResultSizeChars` 设为 `Infinity` 是一个关键设计：

> **设计决策**：Read 工具的结果永远不被持久化到磁盘文件。如果结果被保存到 `/tmp/tool-result-xxx`，LLM 收到"结果已保存到文件"后会尝试 `Read("/tmp/tool-result-xxx")`，造成无限循环。Read 工具通过自身的 `limits` 系统（行数限制、token 限制）控制输出大小。

### 图片处理

读取图片文件时，自动检测格式并进行压缩/缩放：

```typescript
import {
  compressImageBufferWithTokenLimit,
  maybeResizeAndDownsampleImageBuffer,
  detectImageFormatFromBuffer,
} from '../../utils/imageResizer.js'
```

### PDF 处理

```typescript
// PDF 相关常量
PDF_MAX_PAGES_PER_READ    // 每次最多读取 20 页
PDF_AT_MENTION_INLINE_THRESHOLD  // 小 PDF 内联阈值
PDF_EXTRACT_SIZE_THRESHOLD       // 大 PDF 需要指定页码范围
```

### 文件状态缓存与重复读取优化

Read 工具会检查文件是否已被读取过且内容未变：

```typescript
// ToolUseContext 中的 readFileState
readFileState: FileStateCache
```

如果文件自上次读取以来未被修改（通过 mtime 检查），可以返回 `FILE_UNCHANGED_STUB` 存根而非完整内容，节省 context。

---

## 11.3 FileEditTool — 精确的字符串替换

### 核心设计理念

FileEditTool 采用**字符串匹配替换**而非行号/偏移量编辑。这看似简单的设计选择有深刻的原因：

```
传统编辑器方式               Claude Code Edit 方式
────────────────             ─────────────────────
"将第 42 行改为..."          "将 'old_string' 替换为 'new_string'"

问题：行号不稳定             优势：字符串匹配与行号无关
- 其他编辑会改变行号         - 多次编辑不冲突
- 并发编辑时行号失效         - 自然语言描述即定位
- LLM 行号计算容易出错       - 隐含验证：必须匹配才能替换
```

### Input Schema

```typescript
// src/tools/FileEditTool/types.ts
const inputSchema = z.strictObject({
  file_path: z.string()
    .describe('The absolute path to the file to modify'),
  old_string: z.string()
    .describe('The text to replace'),
  new_string: z.string()
    .describe('The text to replace it with (must be different)'),
  replace_all: z.boolean().default(false)
    .describe('Replace all occurrences (default false)'),
})
```

### 匹配与替换流程

```
Edit({file_path, old_string, new_string, replace_all})
    │
    ├── 1. expandPath(file_path) 路径规范化
    │
    ├── 2. validateInput()
    │     ├── old_string === new_string → 拒绝
    │     ├── 检查文件修改时间戳 → 防并发冲突
    │     └── 检查 team memory 机密
    │
    ├── 3. readFileSyncWithMetadata()
    │     └── 读取文件内容 + 行尾符类型
    │
    ├── 4. findActualString(fileContent, old_string)
    │     ├── 精确匹配 → 使用原始字符串
    │     └── 引号规范化后匹配 → 保留文件的引号风格
    │
    ├── 5. 执行替换
    │     ├── replace_all = true  → replaceAll()
    │     └── replace_all = false → 验证唯一性 → replace()
    │
    ├── 6. preserveQuoteStyle(old, new)
    │     └── 保持文件原有的弯引号风格
    │
    ├── 7. writeTextContent(fullFilePath, newContent)
    │     └── 保留原始行尾符类型（CRLF/LF/CR）
    │
    └── 8. 生成 diff + 通知
          ├── fetchSingleFileGitDiff()
          └── notifyVscodeFileUpdated()
```

### findActualString：智能字符串匹配

```typescript
// src/tools/FileEditTool/utils.ts
export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  // 首先尝试精确匹配
  if (fileContent.includes(searchString)) {
    return searchString
  }

  // 尝试引号规范化后匹配
  // 弯引号 → 直引号的规范化
  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)

  const searchIndex = normalizedFile.indexOf(normalizedSearch)
  if (searchIndex !== -1) {
    // 返回文件中的原始字符串（保留弯引号）
    return fileContent.substring(searchIndex, searchIndex + searchString.length)
  }

  return null
}
```

> **设计决策**：LLM 无法输出弯引号（curly quotes），但用户的文件中可能包含弯引号。`normalizeQuotes` 将 `''""`  四种弯引号规范化为直引号进行匹配，然后 `preserveQuoteStyle()` 将替换文本中的直引号转回弯引号，保持文件风格一致。

### 引号风格保持

```typescript
// src/tools/FileEditTool/utils.ts
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")    // ' → '
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")   // ' → '
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')     // " → "
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')    // " → "
}
```

### 并发冲突检测

Edit 工具检查文件在读取后是否被外部修改：

```typescript
// FileEditTool.ts — validateInput 中的时间戳检查
const cachedModTime = toolUseContext.readFileState.get(fullFilePath)
const currentModTime = getFileModificationTime(fullFilePath)

if (cachedModTime && currentModTime > cachedModTime) {
  return {
    result: false,
    message: FILE_UNEXPECTEDLY_MODIFIED_ERROR,
    errorCode: 0,
  }
}
```

`FILE_UNEXPECTEDLY_MODIFIED_ERROR` 告诉 LLM 文件已被外部修改，需要重新读取。

### 文件大小限制

```typescript
// FileEditTool.ts
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024  // 1 GiB
```

> **设计决策**：1 GiB 限制基于 V8/Bun 的字符串长度限制（约 2^30 字符）。对于 ASCII/Latin-1 文件，1 字节 ≈ 1 字符，所以 1 GiB 文件大小 ≈ 字符串长度上限。

### Diff 生成

编辑完成后生成结构化 diff：

```typescript
import { getPatchForDisplay, getPatchFromContents } from '../../utils/diff.js'

// diff 超时保护
const DIFF_TIMEOUT_MS = 5000  // 5秒超时
```

---

## 11.4 FileWriteTool — 文件创建与覆写

### 与 Edit 的区别

| 场景 | Edit | Write |
|------|------|-------|
| 修改现有文件的部分内容 | ✓ 首选 | ✗ |
| 创建新文件 | ✗ | ✓ 首选 |
| 完全重写文件 | ✗ | ✓ |
| 需要先读取文件 | ✓（隐含验证） | ✓（强制要求） |

### Input Schema

```typescript
const inputSchema = z.strictObject({
  file_path: z.string()
    .describe('The absolute path to the file to write (must be absolute)'),
  content: z.string()
    .describe('The content to write to the file'),
})
```

### 安全保护

Write 工具有几层保护机制：

1. **先读后写**：prompt 明确要求 LLM 先使用 Read 工具读取文件，然后才能 Write
2. **并发冲突检测**：与 Edit 相同的 mtime 检查
3. **机密检查**：`checkTeamMemSecrets()` 检测写入内容是否包含敏感信息
4. **权限检查**：`checkWritePermissionForTool()` 基于路径的细粒度权限

### Diff 生成

Write 工具也生成 diff 用于 UI 展示：

```typescript
// FileWriteTool.ts
const outputSchema = z.object({
  type: z.enum(['create', 'update']),
  filePath: z.string(),
  content: z.string(),
  structuredPatch: z.array(hunkSchema()),
  originalFile: z.string().nullable(),  // null 表示新建
})
```

---

## 11.5 GlobTool — 文件名搜索

### 核心实现

```typescript
// src/tools/GlobTool/GlobTool.ts
export const GlobTool = buildTool({
  name: GLOB_TOOL_NAME,        // "Glob"
  searchHint: 'find files by name pattern or wildcard',
  isConcurrencySafe() { return true },
  isReadOnly() { return true },
  // ...
})
```

### Input Schema

```typescript
const inputSchema = z.strictObject({
  pattern: z.string()
    .describe('The glob pattern to match files against'),
  path: z.string().optional()
    .describe('The directory to search in (defaults to cwd)'),
})
```

### 搜索引擎

GlobTool 使用内部的 `glob()` 函数（`src/utils/glob.ts`），而非 shell 的 glob 展开：

```typescript
import { glob } from '../../utils/glob.js'
```

### 输出结构

```typescript
const outputSchema = z.object({
  durationMs: z.number(),     // 搜索耗时
  numFiles: z.number(),        // 匹配文件数
  filenames: z.array(z.string()),  // 文件路径列表
  truncated: z.boolean(),     // 是否截断
})
```

### 结果限制

```typescript
// 来自 ToolUseContext
globLimits?: {
  maxResults?: number  // 限制返回文件数量
}
```

### 路径安全

```typescript
// GlobTool.ts — validateInput
async validateInput({ path }): Promise<ValidationResult> {
  if (path) {
    const absolutePath = expandPath(path)
    // SECURITY: 跳过 UNC 路径以防止 NTLM 凭据泄露
    // 检查路径存在且为目录
  }
}
```

---

## 11.6 GrepTool — 内容搜索

### ripgrep 集成

GrepTool 不使用 shell 的 `grep`，而是直接调用 ripgrep（`rg`）：

```typescript
// src/tools/GrepTool/GrepTool.ts
import { ripGrep } from '../../utils/ripgrep.js'
```

这带来了性能优势和更丰富的搜索选项。

### Input Schema — 丰富的搜索参数

```typescript
const inputSchema = z.strictObject({
  pattern: z.string()                    // 正则表达式模式
    .describe('The regular expression pattern to search for'),
  path: z.string().optional(),           // 搜索路径
  glob: z.string().optional(),           // 文件过滤 (*.js, *.{ts,tsx})
  output_mode: z.enum([
    'content',              // 显示匹配行
    'files_with_matches',   // 仅显示文件路径（默认）
    'count',                // 显示匹配计数
  ]).optional(),
  '-B': z.number().optional(),  // 前文行数
  '-A': z.number().optional(),  // 后文行数
  '-C': z.number().optional(),  // 上下文行数
  '-n': z.boolean().optional(), // 行号（默认 true）
  '-i': z.boolean().optional(), // 大小写不敏感
  type: z.string().optional(),  // 文件类型 (js, py, rust...)
  head_limit: z.number().optional(),  // 结果限制（默认 250）
  offset: z.number().optional(),      // 跳过前 N 条
  multiline: z.boolean().optional(),  // 多行模式
})
```

### 排除目录

搜索自动排除版本控制目录：

```typescript
const VCS_DIRECTORIES_TO_EXCLUDE = [
  '.git', '.svn', '.hg', '.bzr', '.jj',
]
```

### 文件读取忽略模式

```typescript
import {
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} from '../../utils/permissions/filesystem.js'
```

来自 `.gitignore` 和用户配置的忽略模式也会应用到 Grep 搜索中。

### 输出模式对比

```
output_mode: 'files_with_matches'    output_mode: 'content'
────────────────────────────         ────────────────────────
src/tools.ts                         src/tools.ts
src/Tool.ts                          42: export type Tool = {
src/utils/ripgrep.ts                 43:   name: string
                                     --
                                     src/Tool.ts
                                     362: export type Tool<
```

---

## 11.7 NotebookEditTool — Jupyter 编辑

### 核心能力

NotebookEditTool 支持对 Jupyter notebook（.ipynb）文件进行 cell 级操作：

```typescript
// src/tools/NotebookEditTool/NotebookEditTool.ts
const inputSchema = z.strictObject({
  notebook_path: z.string()
    .describe('The absolute path to the Jupyter notebook file'),
  cell_id: z.string().optional()
    .describe('The ID of the cell to edit'),
  new_source: z.string()
    .describe('The new source for the cell'),
  cell_type: z.enum(['code', 'markdown']).optional()
    .describe('The type of the cell'),
  edit_mode: z.enum(['replace', 'insert', 'delete']).optional()
    .describe('The type of edit to make (default: replace)'),
})
```

### 三种编辑模式

```
edit_mode: 'replace'     edit_mode: 'insert'      edit_mode: 'delete'
─────────────────       ─────────────────         ─────────────────
替换指定 cell 的内容    在指定 cell 后插入新 cell    删除指定 cell
需要 cell_id           需要 cell_id (或开头)       需要 cell_id
需要 new_source        需要 new_source + cell_type
```

### Cell ID 解析

```typescript
import { parseCellId } from '../../utils/notebook.js'
```

Notebook 的每个 cell 有唯一 ID，工具通过 ID 定位要操作的 cell。

---

## 11.8 权限模型：文件操作的统一权限

### 读写权限检查

所有文件操作工具使用统一的权限检查函数：

```typescript
// src/utils/permissions/filesystem.ts
export function checkReadPermissionForTool(tool, input, permCtx): PermissionDecision
export function checkWritePermissionForTool(tool, input, permCtx): PermissionDecision
```

### 路径匹配

```typescript
// 权限规则支持通配符
async preparePermissionMatcher({ file_path }) {
  return pattern => matchWildcardPattern(pattern, file_path)
}
```

用户可以设置类似 `Edit(src/**/*.ts)` 的规则，只允许编辑特定路径。

### matchingRuleForInput

```typescript
// 找到与输入匹配的权限规则
import { matchingRuleForInput } from '../../utils/permissions/filesystem.js'
```

---

## 11.9 共享基础设施

### 路径处理

所有工具共享统一的路径处理：

```typescript
// src/utils/path.ts
export function expandPath(filePath: string): string
// ~ 展开、相对路径转绝对路径

// src/utils/file.ts
export function addLineNumbers(content: string): string
// 添加 "行号\t内容" 格式
```

### 文件系统抽象

```typescript
// src/utils/fsOperations.ts
export function getFsImplementation(): FsOperations
// 可替换的文件系统实现（用于测试和覆盖层）
```

### 文件历史追踪

写入操作会记录到文件历史中：

```typescript
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
```

### Git Diff 集成

编辑操作完成后自动获取 git diff：

```typescript
import { fetchSingleFileGitDiff } from '../../utils/gitDiff.js'
```

### LSP 通知

文件修改后通知 LSP 服务器更新诊断：

```typescript
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
```

### VS Code 通知

```typescript
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
```

### Skill 目录发现

文件操作可以触发 skill 目录的发现：

```typescript
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
```

---

## 11.10 嵌入式搜索工具

### 条件性工具移除

在 Anthropic 内部构建中，Glob 和 Grep 工具可能被内置的搜索工具替代：

```typescript
// src/tools.ts
...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
```

当 `hasEmbeddedSearchTools()` 返回 `true` 时，`bfs`（替代 `find`）和 `ugrep`（替代 `grep`）被嵌入到 Bun binary 中，Claude 的 shell 里 `find`/`grep` 被 alias 到这些快速工具。此时专用的 Glob/Grep 工具变得冗余。

---

## 章末速查表

| 工具 | 源码位置 | 只读 | 并发安全 | maxResultSizeChars |
|------|---------|------|---------|-------------------|
| `Read` | `tools/FileReadTool/FileReadTool.ts` | ✓ | ✓ | `Infinity` |
| `Edit` | `tools/FileEditTool/FileEditTool.ts` | ✗ | ✗ | `100_000` |
| `Write` | `tools/FileWriteTool/FileWriteTool.ts` | ✗ | ✗ | `100_000` |
| `Glob` | `tools/GlobTool/GlobTool.ts` | ✓ | ✓ | `100_000` |
| `Grep` | `tools/GrepTool/GrepTool.ts` | ✓ | ✓ | `100_000` |
| `NotebookEdit` | `tools/NotebookEditTool/NotebookEditTool.ts` | ✗ | ✗ | `100_000` |

| 概念 | 位置 | 说明 |
|------|------|------|
| `findActualString()` | `FileEditTool/utils.ts` | 引号规范化字符串匹配 |
| `normalizeQuotes()` | `FileEditTool/utils.ts` | 弯引号 → 直引号 |
| `preserveQuoteStyle()` | `FileEditTool/utils.ts` | 保持文件引号风格 |
| `stripTrailingWhitespace()` | `FileEditTool/utils.ts` | 去除行尾空白 |
| `MAX_EDIT_FILE_SIZE` | `FileEditTool.ts` | 1 GiB 文件大小上限 |
| `BLOCKED_DEVICE_PATHS` | `FileReadTool.ts` | 禁止读取的设备路径 |
| `FILE_UNEXPECTEDLY_MODIFIED_ERROR` | `FileEditTool/constants.ts` | 并发修改错误 |
| `checkWritePermissionForTool()` | `utils/permissions/filesystem.ts` | 写权限检查 |
| `checkReadPermissionForTool()` | `utils/permissions/filesystem.ts` | 读权限检查 |
| `ripGrep()` | `utils/ripgrep.ts` | ripgrep 调用封装 |
| `VCS_DIRECTORIES_TO_EXCLUDE` | `GrepTool.ts` | 排除的版本控制目录 |
| `fileHistoryTrackEdit()` | `utils/fileHistory.ts` | 文件修改历史追踪 |
| `fetchSingleFileGitDiff()` | `utils/gitDiff.ts` | 单文件 git diff |
