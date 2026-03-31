
# 第 10 章：File I/O 工具族 — 让 Agent 安全地操作文件

> **核心问题**：一个 Coding Agent 如何在拥有完整文件读写能力的同时，不会误删用户代码、不会覆盖并发修改、不会读取恶意文件？

文件操作是 Coding Agent 最基础也最关键的能力。没有文件操作，Agent 无法理解代码结构、无法修改 bug、无法创建新功能。但文件操作也是风险最高的能力之一 — 一次错误的覆盖写入，就可能毁掉用户数小时的工作。

Claude Code 为此设计了一套精巧的文件工具族，在**能力**与**安全**之间取得平衡。本章将完整解析这套系统的架构设计和实现细节。

---

## 10.1 概述：6 个工具构成的文件操作体系

Claude Code 的文件操作由 6 个专用工具组成，覆盖读取、写入、搜索三个维度：

| 工具 | 功能 | 读/写 | 并发安全 | 典型场景 |
|------|------|-------|----------|---------|
| **Read** | 读取文件内容 | 只读 | ✅ | 阅读源代码、查看配置 |
| **Write** | 创建或完全重写文件 | 写入 | ❌ | 创建新文件、完整替换 |
| **Edit** | 精确替换文件中的字符串 | 写入 | ❌ | 修改函数、修复 bug |
| **Glob** | 按文件名模式搜索 | 只读 | ✅ | 找到 `**/*.tsx` 文件 |
| **Grep** | 按内容正则搜索 | 只读 | ✅ | 搜索函数调用、查找关键字 |
| **NotebookEdit** | 编辑 Jupyter Notebook | 写入 | ❌ | 修改 `.ipynb` 单元格 |

> **注**：WebFetch 虽然在 CC 内部被归入只读工具集（`isConcurrencySafe: true`），但它读取的是 URL 而非本地文件，严格来说不属于 File I/O 工具族，将在网络工具章节中讨论。

### 并发安全分组

这 6 个工具被明确分为两组，决定了 Agentic Loop 中的调度策略：

```javascript
// 写入工具集 — 必须串行执行
QK1 = new Set(["Edit", "Write", "NotebookEdit"])

// 只读工具集 — 可以并行执行
lK1 = new Set(["Read", "Glob", "Grep", ...])
```

> **设计决策**：只读工具标记为 `isConcurrencySafe: true`，允许主循环同时执行多个 Read/Glob/Grep 调用。写入工具标记为 `false`，强制串行执行。这在保证安全的前提下最大化了执行效率 — Agent 可以同时读取 5 个文件，但修改操作必须逐一进行。

### 工具选择决策树

从 Agent 视角看，工具选择遵循这样的决策路径：

```
需要读取文件？
├── 文本文件 ─────────→ Read（cat -n 格式输出）
├── 图片文件 ─────────→ Read（base64 image block）
├── PDF 文件 ─────────→ Read（原生文档 / 分页提取）
└── Jupyter Notebook ─→ Read（cells 解析）

需要修改文件？
├── 局部修改 ─────────→ Edit（只发送 diff，节省 token）
├── 完全重写 / 新建 ──→ Write（先 Read 再 Write）
└── Notebook 单元格 ──→ NotebookEdit（replace/insert/delete）

需要搜索文件？
├── 按文件名搜索 ─────→ Glob（rg --files --glob）
└── 按内容搜索 ───────→ Grep（rg + 正则）
```

**小结**：6 个工具的分工清晰 — Read 负责"看"，Write/Edit/NotebookEdit 负责"改"，Glob/Grep 负责"找"。并发安全分组确保了只读操作可以并行加速，而写入操作不会互相干扰。

---

## 10.2 Read — 多模态的文件读取

Read 是使用频率最高的文件工具。它不仅能读取普通文本，还支持图片、PDF、Jupyter Notebook 等多种格式 — 这是一个**多模态**的文件读取器。

### 6 种输出类型

Read 工具使用 **discriminated union**（判别联合类型）返回 6 种不同格式的结果：

```
Read 输出类型 (discriminated union)
├── text            普通文本文件（行号 + 内容）
├── image           图片文件（base64 编码 + 尺寸信息）
├── notebook        Jupyter Notebook（cells 数组）
├── pdf             PDF 整个文件（base64，需多模态模型支持）
├── parts           PDF 分页提取（每页转为 JPEG 图片）
└── file_unchanged  文件未变化（去重优化，节省 token）
```

> **设计决策**：使用 discriminated union 而非统一格式，是因为不同文件类型需要完全不同的处理方式。图片需要 base64 编码后作为 vision content block 传递给 LLM，文本需要行号标注方便 Edit 定位，PDF 分页需要转为图片才能让 LLM "看见"。统一格式会丢失这些类型特定的语义。

### 文件类型分发

Read 的核心是一个文件类型分发器 `dK9`，根据文件扩展名路由到不同的处理逻辑：

```
Read 调用流程
    │
    ▼
输入验证（validateInput）
├── 二进制文件检测 → 拒绝
├── 设备文件检测（/dev/zero 等）→ 拒绝
├── 权限 deny 检查 → 拒绝
└── 通过 → 继续
    │
    ▼
文件去重检测
├── readFileState 有缓存 + mtime 未变 → 返回 file_unchanged
└── 不满足 → 继续读取
    │
    ▼
类型分发（dK9）
├── .ipynb → 解析 notebook cells
├── .png/.jpg/.gif/.webp → base64 编码 + 可能压缩
├── .pdf
│   ├── 指定 pages 参数 → poppler 分页提取为 JPEG
│   └── 未指定 → 整个 PDF 作为 document block
└── 其他 → 文本读取 + cat -n 行号格式化
```

### 文本文件读取

对于最常见的文本文件，Read 工具的输出带有行号标注。核心读取函数是 `Hr1`（混淆名 `Gj6`），负责按 offset/limit 从文件中提取指定范围的行：

```javascript
function Hr1(content, mtimeMs, startLine, lineLimit, byteLimit) {
    // 跳过 BOM（Byte Order Mark）
    const text = content.charCodeAt(0) === 65279 ? content.slice(1) : content;

    const lines = [];
    let lineNum = 0, pos = 0;

    // 逐行扫描，支持 offset（从第 N 行开始）和 limit（最多读 M 行）
    while ((newlinePos = text.indexOf('\n', pos)) !== -1) {
        if (lineNum >= startLine && lineNum < maxLine && !truncated) {
            let line = text.slice(pos, newlinePos);
            if (line.endsWith('\r')) line = line.slice(0, -1);  // CRLF → LF
            lines.push(line);
        }
        lineNum++;
        pos = newlinePos + 1;
    }

    return { content: lines.join('\n'), lineCount: lines.length, totalLines: lineNum };
}
```

注意 `Hr1` 返回的是**纯文本内容，不含行号**。行号是在后续的 `mapToolResultToToolResultBlockParam` 阶段才被添加的。

### 行号格式化：两层分离设计

Read 工具的返回值经过了**两层处理**，分别服务于不同的消费者：

```
Read 工具执行（call 方法）
    │  返回结构化 JavaScript 对象（不含行号）
    │  { type: "text", file: { content: "原始文本", startLine: 1, ... } }
    │
    ▼
mapToolResultToToolResultBlockParam（格式转换层）
    │  把结构化对象 → 转成 Anthropic API 的 tool_result 格式
    │  ⭐ 行号在这一步添加
    │
    │  case "text":
    │    content = S4z(q)           // session memory 时间戳（如果有）
    │              + E4z(q.file)    // → ZD8()：行号格式化
    │              + (h4z()?L4z:"") // malware 检测 system-reminder
    │
    ▼
Anthropic Messages API
    │  tool_result content = "     1→const x = 1;\n     2→..."
    ▼
LLM 看到带行号的文本
```

| 层 | 消费者 | 内容 |
|---|--------|------|
| `call()` 返回值 | **Agent 内部**（UI、缓存、去重、token 估算） | 结构化对象，不含行号 |
| `mapToolResultToToolResultBlockParam()` | **LLM**（通过 API 的 tool_result） | 带行号的纯文本字符串 |

这就是为什么 UI 能显示 "Read 42 lines" 而不是一堆带行号的文本 — UI 用的是结构化数据，LLM 看到的是格式化后的带行号版本。

> **设计决策**：两层分离使同一份数据能服务于两个完全不同的消费者。如果 `call()` 直接返回带行号的文本，UI 展示和文件去重缓存都会变得复杂。反之如果不加行号，LLM 在使用 Edit 工具时就难以精确定位代码位置。

### 行号格式化函数 ZD8 — 新旧两种格式

行号格式化由 `ZD8` 函数（分析文档中的 `Rr1`）实现。v2.1.86 引入了新格式，通过 feature flag 控制切换：

```javascript
function ZD8({content, startLine}) {
  if (!content) return "";
  var lines = content.split(/\r?\n/);

  // feature flag 控制格式选择
  if (kf1()) {
    // ⭐ 新格式：行号 + Tab 分隔（更紧凑，节省 token）
    return lines.map((line, i) => `${i + startLine}\t${line}`).join("\n");
  }

  // 旧格式：6 位右对齐 + → 分隔（cat -n 风格）
  return lines.map((line, i) => {
    let num = String(i + startLine);
    if (num.length >= 6) return `${num}→${line}`;      // 超大文件不 pad
    return `${num.padStart(6, " ")}→${line}`;           // 右对齐到 6 位
  }).join("\n");
}

// feature flag 读取
function kf1() {
  return !F8("tengu_compact_line_prefix_killswitch", false);
}
```

两种格式的对比：

| 格式 | 分隔符 | 对齐 | 示例 | 状态 |
|------|--------|------|------|------|
| **新格式** | `\t`（Tab） | 无 | `1\tconst x = 1;` | 当前默认 |
| **旧格式** | `→`（U+2192） | padStart(6) 右对齐 | `     1→const x = 1;` | 可通过 flag 切换回 |

新格式用 Tab 替代 Unicode 箭头和空格 padding，更节省 token — Tab 在 tokenizer 中通常是单独 1 个 token，而旧格式的 6 个空格 + `→` 需要多个 token。

`kf1()` 通过内部配置系统（`F8` 即 LaunchDarkly 或类似的 feature flag 服务）读取开关值。Anthropic 可以在**服务端**控制格式切换，不需要发布新版本。

与 `ZD8` 配对的还有一个**反向解析函数** `dp4`，用于从带行号的文本中剥离行号前缀：

```javascript
function dp4(line) {
  // 匹配：可选前导空格 + 数字 + (→ 或 \t) + 内容
  return line.match(/^\s*\d+[\u2192\t](.*)$/)?.[1] ?? line;
}
```

这个函数被 Edit 工具使用 — 当 LLM 在 `old_string` 中不小心包含了行号前缀时，`dp4` 剥掉行号还原纯内容，提高匹配成功率。它同时兼容 `→` 和 `\t` 两种格式。

### Malware 检测提示注入

`mapToolResultToToolResultBlockParam` 中的 `h4z()` 控制是否在读取内容末尾注入一段 malware 检测提示：

```javascript
content = S4z(q) + E4z(q.file) + (h4z() ? L4z : "");
//                                 ↑ 非 opus-4-6 模型时注入
```

`L4z` 的内容是一段 `<system-reminder>`，提醒 LLM 判断读取的文件是否为恶意代码。Opus 4.6 被排除在外（通过 `R4z` 集合），因为该模型已内置了足够的安全意识。

### 图片文件处理

Read 支持直接"读取"图片文件。背后的实现是将图片转为 base64 编码，作为 vision content block 传递给 LLM：

```javascript
async function PH8(filePath, maxTokens) {
    const bytes = await fs.readFileBytes(filePath);
    const mimeType = IiH(bytes);       // 通过魔数检测 MIME 类型

    // 通过图片处理器处理（可能用 sharp 或 native image-processor）
    const processed = await Zy(bytes, bytes.length, subType);
    let result = gc_(processed.buffer, processed.mediaType, originalSize, processed.dimensions);

    // 如果 base64 太大，超出 token 限制，尝试压缩
    if (Math.ceil(result.file.base64.length * 0.125) > maxTokens) {
        const compressed = await EO7(bytes, maxTokens, mimeType);
        return { type: "image", file: { base64: compressed.base64, type: compressed.mediaType } };
    }
    return result;
}
```

> **设计决策**：图片超过 token 限制时会自动压缩（降级到 400×400 JPEG quality=20），而不是直接报错。这体现了"渐进降级"的设计理念 — 宁可给 LLM 一张模糊的图，也比什么都看不到好。

### PDF 处理的两条路径

PDF 处理根据是否指定 `pages` 参数分为两条路径：

- **指定 pages**（如 `pages: "1-5"`）：使用 poppler-utils 的 `pdftoppm` 将每页转为 JPEG 图片，然后作为 image content block 传递。单次最多 20 页。
- **不指定 pages**：将整个 PDF 作为 document content block 原生传递（需要模型支持，Sonnet 3.5 v2+）。文件不能超过 10 页。

### 文件去重优化

Read 工具的一个巧妙优化是**文件去重** — 如果同一个文件在同一轮对话中已经读取过，且文件没有被修改，就直接返回 `file_unchanged` 而非重新读取：

```javascript
const cached = readFileState.get(resolvedPath);
if (cached && !cached.isPartialView
    && cached.offset === offset && cached.limit === limit) {
    if (await getModTimeMs(resolvedPath) === cached.timestamp) {
        // 文件未变化，返回简短消息而非完整内容
        return { data: { type: "file_unchanged", file: { filePath } } };
    }
}
```

返回的消息是：*"File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current."*

这个优化的价值在于：一个 1000 行的文件大约消耗 5K-10K tokens。如果 Agent 在修改过程中反复读取同一文件确认结果，去重可以**节省大量 context 空间**。

### 输入验证

Read 的输入验证覆盖了多种边界情况：

```
Read 输入验证链
├── PDF pages 参数格式验证（"1-5" 解析）
├── 路径解析（sq 函数，支持 ~ 展开、Windows 路径转换）
├── 权限 deny 规则检查
├── UNC 路径（\\server\share）放行
├── 二进制文件检测（扩展名 + 字节内容双重检查）
└── 特殊设备文件检测（/dev/zero, /dev/random 等 → 拒绝）
```

特别值得注意的是**设备文件保护** — 如果 Agent 试图读取 `/dev/zero` 或 `/dev/random`，会导致无限阻塞。CC 维护了一个阻止列表：

```javascript
const BLOCKED_DEVICES = new Set([
    "/dev/zero", "/dev/random", "/dev/urandom", "/dev/full",
    "/dev/stdin", "/dev/tty", "/dev/console",
    "/dev/stdout", "/dev/stderr",
    "/dev/fd/0", "/dev/fd/1", "/dev/fd/2"
]);
```

**小结**：Read 工具是一个多模态文件读取器，通过 discriminated union 支持 6 种输出类型，通过文件去重节省 token，通过多层输入验证防止危险操作。其设计核心是**让 LLM 能"看见"各种格式的文件**，同时**保护系统不被恶意文件攻击**。

---

## 10.3 Write — 安全的文件写入

Write 工具负责创建新文件或完全重写已有文件。它是文件修改中"重量级"的那个 — 当 Edit 的局部替换不够用时（比如创建全新文件或大范围重写），才使用 Write。

### Read-Before-Write 保护与 readFileState 机制

Write 工具实现了严格的**"先读后写"保护** — 对于已存在的文件，如果 Agent 没有先 Read 过该文件，Write 会拒绝执行。

这套保护的核心是一个内存中的 `Map<string, ReadState>`，以文件的解析后绝对路径为 key：

```typescript
// readFileState: Map<string, ReadState>
{
    content: string,              // 读取到的文件内容
    timestamp: number,            // Math.floor(mtimeMs)，文件修改时间戳
    offset: number | undefined,   // 读取偏移（部分读取时）
    limit: number | undefined,    // 读取行数限制
    isPartialView: boolean        // 是否只加载了部分内容
}
```

**写入来源**：`readFileState` 有两个写入入口：

```
readFileState 的写入时机
    │
    ├── 1. Read 工具的 call() ── 用户/Agent 显式读取文件
    │   readFileState.set(resolved, {
    │       content,
    │       timestamp: Math.floor(mtimeMs),
    │       offset, limit
    │   });
    │
    └── 2. 嵌套内存文件加载（ie1 函数）── 系统自动加载 CLAUDE.md 等
        readFileState.set(path, {
            content,
            timestamp: Date.now(),
            offset: undefined,
            limit: undefined,
            isPartialView: contentDiffersFromDisk  // ⭐ 关键标记
        });
```

第二个来源是 CC 启动时自动加载的配置文件（`CLAUDE.md`、`.claude/settings.json` 等）。如果加载的内容与磁盘不一致（比如 Auto-Compaction 后恢复的精简版），会标记 `isPartialView: true`。

**验证逻辑**：Write 的 `validateInput` 基于这个 Map 做三级判断：

```javascript
async validateInput({ file_path, content }, context) {
    // 检查文件是否存在
    try {
        mtimeMs = (await fs.stat(resolved)).mtimeMs;
    } catch (e) {
        if (isENOENT(e)) return { result: true };  // 新文件，直接允许
        throw e;
    }

    // ① 是否读过？
    const readState = readFileState.get(resolved);
    if (!readState || readState.isPartialView) return {
        result: false,
        message: "File has not been read yet. Read it first before writing to it.",
        errorCode: 2
    };

    // ② 读后是否被外部修改？
    if (Math.floor(mtimeMs) > readState.timestamp) return {
        result: false,
        message: "File has been modified since read, either by the user or by a linter.",
        errorCode: 3
    };
}
```

判断流程用一张图概括：

```
readFileState.get(resolved) 返回值？
    ├── undefined ──────────────────── 从未读过 → 拒绝 ❌
    ├── { isPartialView: true } ────── 系统加载的不完整版本 → 视为未读 ❌
    └── { isPartialView: false }
         │
         └── mtime > readState.timestamp ?
              ├── 是 → 文件已被外部修改 → 拒绝 ❌
              └── 否 → 允许写入 ✓
```

**`isPartialView` 的安全价值**：系统自动加载的 CLAUDE.md 可能只是一个摘要版本，如果允许基于这个不完整的"读取"来写入，可能导致内容被意外覆盖。`isPartialView: true` 确保了只有**完整读取**才能解锁写入权限。

**"读过就行" — 不检查 LLM 是否看到内容**：

一个重要的实现细节：这个检查是**纯粹的 Map 键存在性检查**，不关心 LLM 是否"看到了"文件内容：

- 只要 Read 工具的 `call()` 执行过 → `readFileState` 有记录 → 允许写入
- 不关心内容是否仍在 LLM 的 context window 中（可能已被 Auto-Compaction 压缩掉）
- 不关心 LLM 是否"理解"了文件内容
- 不关心 Read 是用户触发还是 Agent 自动触发

> **设计决策**：为什么不做"内容验证"而只做"流程合规"？因为验证 LLM 是否真正理解了文件内容是不可能的。CC 的务实选择是：确保**至少走过一次完整读取流程**，让系统记录文件的基线状态（mtime），用于后续的并发修改检测。这既挡住了"凭记忆盲写"的风险，又不会过度限制 Agent 的自主性。

### mtime 并发修改检测

Write 工具实现了**双重并发检测** — 在 `validateInput` 和 `call` 两个阶段都检查文件修改时间：

```
写入流程时间线
    │
    ├─ validateInput 阶段 ────────── 检查 mtime ≤ readState.timestamp
    │   │
    │   │  （中间可能经过权限确认、用户审批等步骤）
    │   │  （这段时间内，用户或 linter 可能修改了文件）
    │   │
    ├─ call 阶段 ─────────────────── 再次检查 mtime
    │   │
    │   └─ 如果 mtime 变化 → 抛出 "File has been unexpectedly modified."
```

这种双重检查的原因是：`validateInput` 和 `call` 之间可能存在时间间隔（比如用户在审批权限请求时，后台的 linter 自动格式化了文件）。

### 完整写入流程

```
Write 执行流程 (call 方法)
    │
    ├── 1. 动态 Skill 触发检测
    ├── 2. Hook: beforeFileEdited
    ├── 3. 自动创建目录（mkdir -p）
    ├── 4. 读取原始内容（用于 diff 和并发检查）
    ├── 5. 二次并发修改检测
    ├── 6. 创建 Checkpoint 备份
    ├── 7. 写入文件（T_H 函数，处理编码和行尾）
    ├── 8. 通知 LSP 服务器（didChange + didSave）
    ├── 9. 更新 readFileState 缓存
    ├── 10. CLAUDE.md 写入追踪
    └── 11. 生成并返回 diff
```

第 6 步的 Checkpoint 备份确保了即使写入出错，也可以回滚到修改前的状态（详见 10.8 节）。

第 8 步的 LSP 通知使得 VS Code 等编辑器能**实时看到** Claude Code 的文件修改，不需要用户手动刷新。

第 11 步生成 diff 是为了让用户（和 LLM 自身）清楚地看到"改了什么"：

```javascript
if (original) {
    // 更新已有文件 → 返回 diff
    const patch = Xv({ filePath, fileContents: original.content,
                       edits: [{ old_string: original.content, new_string: content }] });
    return { data: { type: "update", filePath, content, structuredPatch: patch } };
}
// 创建新文件
return { data: { type: "create", filePath, content } };
```

### 机密检测

Write 在写入前会检查内容是否包含机密信息：

```javascript
const secretWarning = dE_(resolved, content);
if (secretWarning) return { result: false, message: secretWarning };
```

如果检测到 `.env` 文件或内容中包含 API Key 格式的字符串，会拒绝写入并警告用户。

**小结**：Write 工具的核心设计理念是**"写入是危险的操作"** — 通过先读后写保护、双重并发检测、Checkpoint 备份三层防护，确保 Agent 的文件写入不会造成数据丢失。

---

## 10.4 Edit — 精确的文本替换

Edit 工具是 Claude Code 中**验证逻辑最复杂**的工具。它的工作原理很简单 — 在文件中找到 `old_string`，替换为 `new_string` — 但围绕这个简单操作构建了 9 步验证流程，处理了大量边界情况。

### 为什么用 Edit 而不是 Write？

```
Write 工具：传递整个文件内容（可能几千行，消耗大量 token）
Edit 工具：只传递要修改的片段（通常几行到几十行，节省 token）
```

对于修改一个 500 行文件中的 3 行代码，Edit 只需要传递修改的部分（~100 tokens），而 Write 需要传递全部 500 行（~2000 tokens）。**在 token 就是金钱的 LLM 世界，这是重大的成本优化。**

### 9 步验证流程

Edit 的 `validateInput` 是所有工具中最复杂的，包含 9 个检查步骤：

```
Edit 验证流程 (validateInput)
    │
    ├── 1. 机密检测（new_string 是否包含 API Key 等）
    ├── 2. 无变化检测（old_string === new_string → 拒绝）
    ├── 3. 权限 deny 规则检查
    ├── 4. 文件内容读取（支持 UTF-8 和 UTF-16LE）
    ├── 5. 文件不存在处理
    │       ├── old_string 为空 → 视为创建新文件
    │       └── old_string 非空 → 报错 + 模糊路径建议
    ├── 6. .ipynb 文件 → 拒绝，引导使用 NotebookEdit
    ├── 7. 先读后写检查（readState 是否存在）
    ├── 8. 并发修改检测（mtime 比较）
    └── 9. 字符串查找
            ├── 精确匹配 → 继续
            ├── 智能引号 fuzzy 匹配 → 继续（使用匹配到的实际字符串）
            ├── 找不到 → 报错
            ├── 找到多个
            │   ├── replace_all = true → 继续
            │   └── replace_all = false → 报错 "Found N matches"
            └── 试执行替换 → 检查是否产生有效 diff
```

### 智能引号 Fuzzy Matching

Edit 工具的一个精巧设计是**智能引号匹配**。LLM 输出时，有时会将直引号（`"`、`'`）替换为 Unicode 弯引号（`"`、`"`、`'`、`'`）。如果严格匹配，Edit 就会报"找不到"错误。

CC 通过 `PzH` 函数解决了这个问题：

```javascript
function KR7(str) {
    // 将"弯引号"标准化为"直引号"
    return str
        .replaceAll('\u2018', "'")   // ' → '
        .replaceAll('\u2019', "'")   // ' → '
        .replaceAll('\u201C', '"')   // " → "
        .replaceAll('\u201D', '"');   // " → "
}

function PzH(fileContent, searchString) {
    // 1. 精确匹配
    if (fileContent.includes(searchString)) return searchString;

    // 2. 标准化引号后再搜索
    const normalizedSearch = KR7(searchString);
    const normalizedContent = KR7(fileContent);
    const index = normalizedContent.indexOf(normalizedSearch);

    if (index !== -1) {
        // 返回文件中的原始字符串（而非标准化后的）
        return fileContent.substring(index, index + searchString.length);
    }
    return null;  // 真的找不到
}
```

> **设计决策**：这是一个典型的"为 LLM 的不完美做补偿"的工程实践。LLM 不是完美的文本复制器，它可能引入微小的字符变化。与其把这种情况当错误处理，不如在工程层面自动修正。

同样，`yLH` 函数会将 `new_string` 中的引号风格自动适配为文件中的原始风格，确保替换后的文本风格一致。

### 尾部换行符处理

另一个精巧的细节是删除操作时的换行符处理：

```javascript
function LT1(content, oldString, newString, replaceAll = false) {
    if (newString !== "") return content.replace(oldString, newString);

    // 删除操作：如果 old_string 不以换行结尾，但后面紧跟换行，一并删除
    if (!oldString.endsWith('\n') && content.includes(oldString + '\n'))
        return content.replace(oldString + '\n', newString);

    return content.replace(oldString, newString);
}
```

这解决了一个常见问题：当 LLM 删除一行代码时，通常不会在 `old_string` 中包含尾部换行符，但如果不一起删除，会留下一个空行。CC 自动处理了这种情况。

### 循环替换防护

Edit 还防止了一种微妙的错误 — 循环替换：

```javascript
// 如果 old_string 是某个之前的 new_string 的子串，拒绝执行
for (const prev of previousNewStrings) {
    if (trimmedOld !== "" && prev.includes(trimmedOld))
        throw Error("Cannot edit: old_string is a substring of a previous new_string.");
}
```

这防止了"在一次多编辑操作中，后一个编辑撤销前一个编辑"的情况。

**小结**：Edit 工具是 CC 中验证最严格的工具，9 步验证流程覆盖了从权限检查到模糊匹配的各种边界情况。智能引号匹配和换行符处理体现了"为 LLM 的不完美做工程补偿"的设计哲学。

---

## 10.5 NotebookEdit — Jupyter Notebook 专用编辑器

NotebookEdit 是专门针对 `.ipynb` 文件设计的编辑工具。Jupyter Notebook 的底层格式是 JSON（包含 cells 数组），用 Edit 做文本替换容易破坏 JSON 结构，因此 CC 为它设计了独立的工具。

### 三种编辑模式

| 模式 | 行为 | 必填参数 |
|------|------|---------|
| `replace` | 替换指定 cell 的内容 | `cell_id`, `new_source` |
| `insert` | 在指定 cell **之后**插入新 cell | `cell_id`(可选), `new_source`, `cell_type` |
| `delete` | 删除指定 cell | `cell_id` |

### 输入参数

```javascript
{
    notebook_path: string,       // .ipynb 文件的绝对路径（必填）
    cell_id: string?,            // cell ID 或数字索引（0-based）
    new_source: string,          // 新的 cell 内容（必填）
    cell_type: "code" | "markdown",  // insert 时必填
    edit_mode: "replace" | "insert" | "delete"  // 默认 replace
}
```

`cell_id` 支持两种寻址方式：
- **cell ID 字符串** — notebook 中每个 cell 的 `id` 字段（nbformat ≥ 4.5）
- **数字索引** — 从 0 开始的 cell 位置（如 `"3"` 表示第 4 个 cell）

### 验证与执行

NotebookEdit 的验证逻辑比 Edit 简单，但有几个特有检查：

```
NotebookEdit 验证流程
    │
    ├── 1. 扩展名必须是 .ipynb
    ├── 2. edit_mode 合法性检查
    ├── 3. insert 模式必须指定 cell_type
    ├── 4. 解析并验证 notebook JSON 格式
    └── 5. cell_id 查找（先按 ID，再按数字索引）
```

执行流程与 Write 类似 — Checkpoint 备份 → 修改 cells 数组 → JSON 序列化 → 写入文件 → 更新 readFileState：

```javascript
// call 方法核心逻辑（简化）
if (BO()) await b8H(updateFileHistoryState, resolved, uuid);  // Checkpoint

const notebook = JSON.parse(content);
// 定位 cellIndex，执行 replace/insert/delete
// ...

T_H(resolved, JSON.stringify(notebook, null, 1), encoding, lineEndings);
readFileState.set(resolved, { content: updatedContent, timestamp: Qh(resolved) });
```

一个巧妙的降级处理：如果 `replace` 的目标索引恰好等于 cells 数组长度（即指向末尾之后），会自动降级为 `insert` 操作，默认 `cell_type` 为 `"code"`。这让 LLM 可以用 replace 模式"追加" cell，降低了使用门槛。

> **设计决策**：Edit 工具的 `.ipynb` 检测会主动引导使用 NotebookEdit（`errorCode: 5`），形成了工具间的**分流机制** — 文本文件走 Edit，Notebook 走 NotebookEdit，各走各的验证路径，互不干扰。

---

## 10.6 Glob 与 Grep — 基于 ripgrep 的高性能搜索

Coding Agent 在修改代码之前，通常需要先"找到"相关文件和代码。Glob（按文件名搜索）和 Grep（按内容搜索）是这个"找"的过程的核心工具。

### ripgrep 复用策略

一个重要的实现选择是：**Glob 和 Grep 都使用 ripgrep（rg）作为底层引擎**，而不是 Node.js 的原生 glob 库或正则搜索。

```
Claude Code 自带的 ripgrep 二进制
├── vendor/ripgrep/arm64-darwin/rg    (macOS Apple Silicon)
├── vendor/ripgrep/x64-darwin/rg      (macOS Intel)
├── vendor/ripgrep/x64-linux/rg       (Linux x64)
└── vendor/ripgrep/x64-windows/rg.exe (Windows x64)
```

ripgrep 的优势：
- **性能**：比 Node.js glob 库快 10-100 倍，尤其在大型仓库中
- **智能排除**：自动尊重 `.gitignore` 规则
- **统一接口**：Glob 用 `rg --files --glob`，Grep 用 `rg pattern` — 同一个二进制，两种用法

> **设计决策**：自带 vendor ripgrep 而非依赖系统安装，确保了在任何环境下都有一致的搜索体验。代价是增加了几 MB 包大小，但换来的是免安装和跨平台一致性。

### Glob — 按文件名搜索

Glob 的核心调用逻辑：

```javascript
async function lS7(pattern, basePath, { limit, offset }, abortSignal, permCtx) {
    // 构建 ripgrep 参数
    const args = [
        "--files",               // 只列出文件名（不搜索内容）
        "--glob", glob,          // glob 模式匹配
        "--sort=modified",       // 按修改时间排序（最新优先）
        "--no-ignore",           // 不受 .gitignore 限制（默认）
        "--hidden"               // 包含隐藏文件
    ];

    // 添加权限拒绝路径排除
    for (const denied of deniedPaths) args.push("--glob", `!${denied}`);

    // 执行 ripgrep
    const files = await Bg(args, dir, abortSignal);

    // 结果限制：默认最多 100 个文件
    const truncated = files.length > offset + limit;
    return { files: files.slice(offset, offset + limit), truncated };
}
```

关键设计点：
- **`--sort=modified`** — 按修改时间排序，最近修改的文件排在前面。这让 Agent 更容易找到"当前正在开发的"文件。
- **默认限制 100 个文件** — 防止 `**/*` 这样的宽泛 pattern 返回成千上万的结果，淹没 context。
- **结果截断提示** — 超过限制时返回 `"(Results are truncated. Consider using a more specific path or pattern.)"`，引导 Agent 缩小搜索范围。

### Grep — 按内容搜索

Grep 是输入参数最丰富的工具，支持 14 个参数：

```javascript
{
    pattern: string,             // 正则表达式（必填）
    path: string?,               // 搜索路径
    glob: string?,               // 文件类型过滤（如 "*.ts"）
    type: string?,               // ripgrep 内置类型过滤（如 "js"）
    output_mode: "content" | "files_with_matches" | "count",
    "-B": number?,               // Before context（前置行数）
    "-A": number?,               // After context（后置行数）
    "-C": number?,               // Context（前后行数）
    "-n": boolean?,              // 显示行号（默认 true）
    "-i": boolean?,              // 大小写不敏感
    head_limit: number?,         // 结果数量限制（默认 250）
    offset: number?,             // 分页偏移
    multiline: boolean?          // 多行匹配模式
}
```

#### 三种输出模式

| 模式 | ripgrep 参数 | 输出内容 | 适用场景 |
|------|------------|---------|---------|
| `files_with_matches` | `-l` | 只返回文件路径列表 | "哪些文件包含这个函数？" |
| `content` | （默认） | 匹配行 + 上下文 | "这个函数的具体代码是什么？" |
| `count` | `-c` | 每个文件的匹配数 | "这个 API 被调用了多少次？" |

`files_with_matches` 模式还有一个额外优化 — 结果按**文件修改时间降序排列**，最近修改的文件排在最前：

```javascript
const sorted = results.map((file, i) => {
    const stat = stats[i];
    return [file, stat.mtimeMs ?? 0];
}).sort((a, b) => b[1] - a[1]);  // 降序 = 最新优先
```

#### VCS 目录排除

Grep 自动排除常见版本控制系统的元数据目录：

```javascript
const VCS_DIRS = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];
for (const dir of VCS_DIRS) args.push("--glob", `!${dir}`);
```

注意 `.jj`（Jujutsu）和 `.sl`（Sapling）是较新的 VCS 系统，CC 也做了兼容。

#### EAGAIN 错误重试

在高负载系统上，ripgrep 可能遇到 `EAGAIN`（Resource temporarily unavailable）错误。CC 实现了自动降级重试：

```javascript
if (GI4(stderr)) {  // 检测 "os error 11" / "Resource temporarily unavailable"
    log("rg EAGAIN error detected, retrying with single-threaded mode (-j 1)");
    daq(args, path, signal, callback, true);  // 重试时强制单线程
}
```

> **设计决策**：多线程 ripgrep 性能更好，但在文件描述符紧张时可能失败。CC 的策略是"先尝试多线程，失败后降级到单线程" — 优先性能，但保证可用性。

### ripgrep 进程管理

ripgrep 的执行有完善的超时和进程管理：

```javascript
function daq(args, searchPath, abortSignal, callback) {
    // 超时设置：WSL 环境 60 秒，其他 20 秒
    const baseTimeout = process.platform === "wsl" ? 60000 : 20000;

    const child = child_process.spawn(rgPath, fullArgs, {
        argv0: "rg",  // 进程名显示为 rg 而非完整路径
        signal: abortSignal,
        windowsHide: true
    });

    // 超时处理：先 SIGTERM，5 秒后 SIGKILL
    const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(c => c.kill("SIGKILL"), 5000, child);
    }, timeout);
}
```

**小结**：Glob 和 Grep 都基于 vendor ripgrep 实现，兼顾了性能和跨平台一致性。Grep 的 14 个参数提供了灵活的搜索能力，三种输出模式适配不同场景。EAGAIN 重试和超时管理确保了在各种环境下的可靠性。

---

## 10.7 共享基础设施

6 个文件工具共享一套基础设施，包括路径解析、编码处理、权限检查和 Hook 集成。这些"看不见"的基础设施是整个文件操作体系可靠性的根基。

### 路径解析：sq() 函数

所有文件工具都通过 `sq()` 函数解析输入路径。它处理了众多平台差异和安全问题：

```javascript
function sq(inputPath, basePath) {
    const base = basePath ?? X_() ?? fs.cwd();

    // 空字节注入防护（防止 C 风格字符串截断攻击）
    if (inputPath.includes("\x00") || base.includes("\x00"))
        throw Error("Path contains null bytes");

    const trimmed = inputPath.trim();

    // Home 目录展开
    if (trimmed === "~") return os.homedir().normalize("NFC");
    if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2)).normalize("NFC");

    // Windows Unix-style 路径转换（/c/... → C:\...）
    if (platform === "windows" && trimmed.match(/^\/[a-z]\//i)) {
        normalized = F4H(trimmed);
    }

    // 绝对路径直接返回，相对路径基于 base 解析
    if (path.isAbsolute(normalized)) return path.normalize(normalized).normalize("NFC");
    return path.resolve(base, normalized).normalize("NFC");
}
```

关键设计点：

- **NFC Unicode 标准化** — macOS 的 HFS+ 文件系统使用 NFD 编码文件名，而大多数程序期望 NFC。`normalize("NFC")` 确保了跨平台一致性。
- **空字节防护** — 在 C 语言中，`\x00` 是字符串终止符。如果 LLM 输出的路径包含空字节（如 `/etc/passwd\x00.txt`），底层 C 库可能只读取 `/etc/passwd`。这是一个经典的路径注入攻击向量。
- **Windows 路径兼容** — 自动将 Git Bash 风格的 `/c/Users/...` 转换为 Windows 原生的 `C:\Users\...`。

### 编码透明

CC 的文件操作对编码是"透明"的 — 读取时自动检测编码，写入时保持原始编码：

```
读取时                                   写入时
  │                                       │
  ├── BOM 检测（FF FE → UTF-16LE）        ├── 按原始 encoding 编码
  ├── 默认 UTF-8                          ├── 按原始 lineEndings 转换
  ├── CRLF → LF 统一                      │   ├── "CRLF" → \r\n
  └── 返回 { content, encoding,           │   └── "LF"   → \n (不变)
              lineEndings }               └── 原子写入（writeFileSync）
```

```javascript
// 写入函数
function T_H(filePath, content, encoding, lineEndings) {
    let output = content;
    if (lineEndings === "CRLF") output = content.split("\n").join("\r\n");
    KMH(filePath, output, { encoding });  // 原子写入
}
```

> **设计决策**：内部统一使用 LF，写入时恢复原始行尾。这避免了 Edit 工具在 Windows 文件上意外将 CRLF 改为 LF 的问题。

### 权限检查体系

文件工具使用两套权限检查函数，分别对应只读和写入操作：

```
权限检查决策链

读取操作 (vqH)                    写入操作 (szH)
    │                                │
    ├── UNC 路径？─→ 需确认          ├── (同左)
    ├── 可疑 Windows 路径？─→ 需确认  ├── (同左)
    ├── deny 规则匹配？─→ 拒绝       ├── deny 规则（edit 类型）
    ├── ask 规则匹配？─→ 需确认      ├── ask 规则（edit 类型）
    ├── 工作目录内？─→ 允许           ├── 工作目录内？
    ├── allow 规则匹配？─→ 允许      ├── allow 规则
    └── 默认 ─→ 需确认              └── 默认 ─→ 需确认
```

权限规则使用 gitignore 风格的路径匹配（通过 `ignore` 库），支持通配符：

```javascript
// 规则示例
// 允许读取整个项目目录
{ path: "src/**", type: "allow", action: "read" }
// 禁止修改配置文件
{ path: "*.config.js", type: "deny", action: "edit" }
```

### 二进制文件检测

CC 使用**双重检测**策略判断文件是否为二进制：

1. **扩展名检测**（`V4_` 函数）— 检查已知二进制扩展名集合（60+ 种，涵盖图片/视频/音频/压缩包/可执行文件等）
2. **字节内容检测**（`oY8` 函数）— 检查文件前 8KB，如果包含 NULL 字节或超过 10% 的不可打印字符，判定为二进制

```javascript
function oY8(buffer) {
    const sampleSize = Math.min(buffer.length, 8192);
    let suspiciousBytes = 0;
    for (let i = 0; i < sampleSize; i++) {
        const byte = buffer[i];
        if (byte === 0) return true;                              // NULL 字节 → 一定是二进制
        if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)
            suspiciousBytes++;                                    // 排除 Tab/LF/CR
    }
    return suspiciousBytes / sampleSize > 0.1;                   // >10% 可疑字节 → 二进制
}
```

### Hook 集成

文件工具在关键操作点触发 Hook，允许外部系统介入：

| Hook 事件 | 触发时机 | 使用场景 |
|-----------|---------|---------|
| `PreToolUse` | 工具执行前 | 权限拦截、审计日志 |
| `PostToolUse` | 工具执行后 | 后处理、通知 |
| `beforeFileEdited` | Write/Edit 实际修改文件前 | LSP 集成、编辑器同步 |

```javascript
// Edit/Write 工具中的 Hook 调用顺序
await Mr.beforeFileEdited(resolved);              // 1. 通知即将修改
await fs.mkdir(path.dirname(resolved));            // 2. 创建目录
if (BO()) await b8H(updateFileHistoryState, ...);  // 3. Checkpoint 备份
T_H(resolved, content, encoding, lineEndings);     // 4. 实际写入
```

**小结**：共享基础设施处理了路径标准化、编码透明、权限控制和 Hook 集成等"横切关注点"。NFC 标准化和空字节防护等细节，体现了在跨平台文件操作中需要考虑的安全和兼容性问题。

---

## 10.8 Checkpoint 系统 — 可回滚的文件修改

Checkpoint 是 Claude Code 的**文件修改安全网** — 在每次 Write、Edit、NotebookEdit 操作之前，自动创建文件备份。如果 Agent 的修改有误，用户可以回滚到修改前的状态。

### 启用与配置

```javascript
function BO() {
    if (o8()) return n51();  // SDK 模式：默认禁用，需显式启用
    return z_().fileCheckpointingEnabled !== false
        && !lH(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING);
}
```

| 场景 | 默认状态 | 控制方式 |
|------|---------|---------|
| 正常交互模式 | **启用** | `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` 禁用 |
| SDK 模式 | **禁用** | `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` 启用 |

### 备份流程

```
文件修改前的 Checkpoint 流程 (b8H)
    │
    ├── 1. 检查 Checkpoint 是否启用 (BO())
    ├── 2. 获取当前快照列表
    ├── 3. 检查最近快照中是否已有此文件的备份
    │       ├── 已有 → 跳过（避免重复备份）
    │       └── 没有 → 继续
    ├── 4. 创建物理备份 (DW7)
    │       ├── 文件存在 → 复制到备份目录 + 保持权限
    │       └── 文件不存在（新文件）→ 记录 null 备份
    └── 5. 更新快照状态
```

物理备份创建的核心代码：

```javascript
async function DW7(filePath, version) {
    // 新文件 → 记录 null（回滚时删除文件）
    if (filePath === null)
        return { backupFileName: null, version, backupTime: new Date() };

    let stat;
    try { stat = await fs.stat(filePath); }
    catch (e) {
        if (isENOENT(e))
            return { backupFileName: null, version, backupTime: new Date() };
        throw e;
    }

    // 复制文件到备份目录
    const backupDir = HzH(backupPath);
    await fs.copyFile(filePath, backupDir);
    await fs.chmod(backupDir, stat.mode);   // 保持原始权限

    return { backupFileName: backupPath, version, backupTime: new Date() };
}
```

### 滑动窗口快照

Checkpoint 使用**滑动窗口**管理快照数量 — 每次 Agent 发送新消息时创建一个快照，超过上限 `AW7` 后丢弃最旧的快照：

```javascript
const snapshots = [...state.snapshots, newSnapshot];
const trimmed = snapshots.length > AW7 ? snapshots.slice(-AW7) : snapshots;
```

每个快照记录了该消息期间修改的所有文件及其备份引用，使得回滚可以精确到"某条消息之前的状态"。

> **设计决策**：Checkpoint 的粒度是"消息级"而非"操作级"。一条消息中 Agent 可能执行多次 Edit，这些 Edit 共享同一个快照。回滚时，一条消息中的所有修改一起撤销。这比操作级粒度简单得多，且符合用户的心理模型 — "撤销 Agent 最近的一轮操作"。

**小结**：Checkpoint 通过"修改前自动备份"为文件操作提供了安全网。滑动窗口快照控制了存储开销，消息级粒度简化了回滚逻辑。

---

## 10.9 推测性执行 — 性能与安全的平衡

推测性执行（Speculative Execution）是 Claude Code 的一个**性能优化机制** — 在等待用户确认权限时，预先在**隔离环境**中执行后续操作。如果用户批准，直接合并结果；如果用户拒绝，丢弃预执行的结果。

### 问题背景

在正常流程中，每次写入操作都需要用户确认权限：

```
Agent 调用 Edit → 等待用户确认 → 用户按 Y → 执行 → Agent 调用下一个 Edit → 等待...
```

如果 Agent 需要连续修改 5 个文件，用户需要等待 5 次确认之间的 LLM 思考时间。推测性执行优化了这个流程：

```
Agent 调用 Edit → 等待用户确认
                    ↓ 同时
              在 overlay 中预执行后续操作
                    ↓
              用户按 Y → 直接合并结果（跳过等待）
              用户按 N → 丢弃预执行结果
```

### overlay 目录隔离

推测执行时，所有文件操作被重定向到一个临时目录：

```javascript
function Bh_(speculationId) {
    return path.join(hE(), "speculation", String(process.pid), speculationId);
}
```

#### 写入重定向

当推测执行中遇到写入工具（Edit/Write/NotebookEdit），文件操作被重定向到 overlay：

```javascript
if (isWriteTool) {
    const relativePath = path.relative(cwd, filePath);

    // 首次写入：先复制原文件到 overlay
    if (!writtenPaths.current.has(relativePath)) {
        const overlayPath = path.join(overlayDir, relativePath);
        await fs.mkdir(path.dirname(overlayPath), { recursive: true });
        await fs.copyFile(path.join(cwd, relativePath), overlayPath);
        writtenPaths.current.add(relativePath);
    }

    // 将工具输入的路径重写到 overlay 目录
    input = { ...input, [pathKey]: path.join(overlayDir, relativePath) };
}
```

#### 读取智能路由

读取操作会检查文件是否已在推测中被修改。如果是，从 overlay 读取（确保读到推测修改后的内容）：

```javascript
if (isReadTool && writtenPaths.current.has(relativePath)) {
    // 从 overlay 读取推测修改后的内容
    input = { ...input, [pathKey]: path.join(overlayDir, relativePath) };
}
```

### 推测边界

推测执行不会无限进行，遇到以下"边界"时停止：

| 边界类型 | 触发条件 | 说明 |
|---------|---------|------|
| `edit` | 写入工具需要权限确认 | 非 acceptEdits 模式下的修改 |
| `bash` | Bash 命令非只读 | 命令不在安全列表中 |
| `denied_tool` | 不支持推测的工具 | 非文件 I/O 工具（如 Agent、WebSearch） |
| `complete` | 推测完成 | 所有工具都执行完毕 |

### 成功合并

当用户批准权限请求后，overlay 中的文件被合并到真实文件系统：

```javascript
async function iK1(overlayDir, writtenPaths, mainDir) {
    let allSuccess = true;
    for (const relPath of writtenPaths) {
        const src = path.join(overlayDir, relPath);
        const dst = path.join(mainDir, relPath);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
    }
    return allSuccess;
}
```

### 失败丢弃

当用户拒绝权限请求，或推测超时时，overlay 中的预执行结果被完全丢弃：

```
推测执行结果处理
    │
    ├── outcome = "accepted" ─── iK1() 合并 overlay → 真实文件系统
    │
    ├── outcome = "rejected" ─── abort() 中止 → 丢弃 overlay
    │
    └── outcome = "timeout"  ─── 超时 → 丢弃 overlay
```

丢弃的实现很简单 — **什么都不做**。推测执行启动时会调用 `abort()` 回调中止进行中的 API 请求，overlay 目录中的文件被留在原地，由操作系统的临时文件清理或进程退出时回收。因为所有推测写入都在 overlay 目录中（`<tmpdir>/speculation/<pid>/<id>/`），真实文件系统**从未被修改**，无需任何回滚操作。

遥测系统记录了每次推测的结果：

```javascript
Q("tengu_speculation", {
    speculation_id: id,
    outcome: outcome,                  // "accepted" | "rejected" | "timeout"
    duration_ms: Date.now() - startTime,
    tools_executed: countToolResults(messages),
    boundary_type: boundary?.type,     // "edit" | "bash" | "denied_tool" | "complete"
});
```

这与 Checkpoint 形成了互补 — Checkpoint 保护的是**已提交**的写入（用户批准后执行的），推测性执行保护的是**未提交**的写入（用户还没批准的）。两者一起，覆盖了文件修改生命周期的全部阶段。

> **设计决策**：推测性执行是一个典型的"乐观执行"策略 — 假设用户会批准（大多数情况下确实如此），先做再说。通过 overlay 目录隔离确保了失败时的安全回退。这个设计在保证安全的前提下，显著减少了用户的等待时间。

**小结**：推测性执行通过 overlay 目录实现了文件操作隔离，在等待用户确认的同时预先执行后续操作。写入重定向和读取智能路由确保了隔离环境的一致性。这是性能优化与安全保障平衡的典范。

---

## 10.10 设计启示：文件操作的工程智慧

从 Claude Code 的 File I/O 实现中，可以提炼出以下可迁移到自建 Agent 的工程经验：

### 1. 先读后写是刚需

**永远不要让 Agent 盲写文件。** LLM 的"记忆"不可靠，它可能基于过时的上下文生成文件内容。强制先读取、再修改，确保 Agent 基于文件的真实状态做决策。

### 2. 并发修改检测不可省略

在 Agent 修改文件的过程中，用户可能在编辑器中手动修改同一文件，linter/formatter 可能自动修改文件。**mtime 检测**是最简单有效的并发保护 — 不需要文件锁，只需比较时间戳。

### 3. 为 LLM 的不完美做工程补偿

LLM 不是完美的文本处理器。它可能：
- 将直引号变成弯引号 → 智能引号 fuzzy matching
- 删除代码时漏掉换行符 → 尾部换行符自动处理
- 基于部分内容做修改 → Read-Before-Write 保护

**在工程层面自动修正这些小问题，比让 LLM 学会"完美复制"更实际。**

### 4. Checkpoint 比事务更实用

数据库用事务保证原子性，但文件系统的事务支持很弱。Checkpoint（修改前备份）是更实用的方案：
- 实现简单（`copyFile` 即可）
- 不需要文件系统事务支持
- 滑动窗口控制存储开销
- 支持消息级粒度的回滚

### 5. 复用成熟工具，不要重新发明轮子

CC 用 ripgrep 而非自己实现搜索引擎，用 poppler-utils 处理 PDF 而非自己解析。**Coding Agent 的核心价值在于"编排 LLM 与工具的交互"，不在于重写底层工具。** 自带 vendor 二进制可以解决安装依赖问题。

### 6. 输入验证要比执行逻辑更严格

Edit 工具的 `validateInput` 有 9 步验证，比实际的 `call` 方法更复杂。这是对的 — **拒绝一个不合法的操作，比执行后再修复要容易得多。** 验证层是 Agent 安全的第一道防线。

### 7. 推测执行：乐观但不鲁莽

推测性执行假设用户会批准（乐观），但通过 overlay 隔离确保失败时无副作用（不鲁莽）。这个"乐观 + 隔离"的模式适用于许多需要人机交互确认的场景。

---

## 速查表

### 关键常量

| 常量 | 值 | 含义 |
|------|-----|------|
| Glob 默认结果限制 | 100 个文件 | 防止结果过多 |
| Grep 默认结果限制 | 250 行 | `head_limit` 默认值 |
| Grep 最大列宽 | 500 字符 | `--max-columns` |
| ripgrep 超时 | 20 秒（WSL: 60 秒） | 搜索超时 |
| Read 最大 PDF 页数 | 20 页/次 | `JTH` |
| Read 无 pages 最大页数 | 10 页 | `Mv_` |
| 二进制检测采样 | 8KB | 前 8192 字节 |
| 可疑字节阈值 | 10% | 超过则判定为二进制 |

### 关键函数索引

| 函数 | 作用 |
|------|------|
| `sq()` | 路径解析与 NFC 标准化 |
| `ZjH()` | 绝对路径 → 相对路径 |
| `V4_()` | 二进制文件扩展名检测 |
| `oY8()` | 字节内容二进制检测 |
| `np()` | 同步读取文件（编码/行尾检测） |
| `T_H()` | 写入文件（保持编码/行尾） |
| `PwH()` | 异步文本文件读取（分页） |
| `Hr1()` | 文本文件读取（按行分页提取） |
| `ZD8()` | 行号格式化（新旧两种格式） |
| `dp4()` | 行号前缀反向剥离 |
| `kf1()` | 行号格式 feature flag 读取 |
| `dK9()` | Read 文件类型分发器 |
| `PH8()` | 图片文件处理 |
| `PzH()` | 智能引号 fuzzy 匹配 |
| `KR7()` | Unicode 弯引号标准化 |
| `LT1()` | 字符串替换（含换行符处理） |
| `lS7()` | Glob 搜索实现 |
| `daq()` | ripgrep 进程执行 |
| `Pc6()` | 搜索结果分页 |
| `BO()` | Checkpoint 启用检查 |
| `b8H()` | Checkpoint 创建 |
| `DW7()` | 物理备份文件创建 |
| `Bh_()` | 推测性执行 overlay 目录路径 |
| `iK1()` | 推测成功时 overlay → 真实文件系统合并 |
| `vqH()` | 只读权限检查 |
| `szH()` | 写入权限检查 |
| `VY()` | 路径 deny/allow 规则匹配 |

### 工具定义位置

| 工具 | 变量名 | 模块位置 |
|------|--------|---------|
| Read | `w5` | `14_html_parser.js:31550` |
| Write | `jP` | `13_ui_rendering.js:2143` |
| Edit | `CP` | `14_html_parser.js:710` |
| Glob | `zc` | `13_ui_rendering.js:3033` |
| Grep | `Bx` | `13_ui_rendering.js:2665` |
| NotebookEdit | `So` | `14_html_parser.js:1326` |
