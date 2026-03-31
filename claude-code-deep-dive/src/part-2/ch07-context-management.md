
# 第 7 章：Context 管理 — Agent 的记忆

> **核心问题**：当一个 Coding Agent 在长时间会话中处理复杂项目时，如何在有限的 Context Window 内保持对任务的完整理解，而不丢失关键信息、不浪费成本、不在上下文耗尽时崩溃？

LLM 的 Context Window 就是 Agent 的"工作记忆"。它不像人类记忆可以自由联想回忆，而是一个严格有限的滑动窗口 — 超出窗口的信息彻底消失，没有任何方式找回。

这意味着一个长时间运行的 Coding Agent 面临一个根本矛盾：**任务越复杂，积累的上下文越多；上下文越多，离窗口上限越近；触顶后要么崩溃，要么丢失信息**。Claude Code 为此设计了一整套精细的上下文管理系统 — 从 token 估算、分级压缩到 cache 优化，层层递进地解决这个问题。

本章将完整解析这套系统的每一个环节。

---

## 7.1 概述：为什么 Context 管理是 Coding Agent 的核心难题

一个普通的 Chat 应用不需要太复杂的 Context 管理 — 对话通常不长，用户可以随时开新会话。但 Coding Agent 截然不同：

**任务天然需要大量上下文**：一次代码重构可能涉及 20+ 文件，每个文件几百行。读取这些文件就要消耗大量 token，更不用说工具调用的参数和返回值、错误信息、用户的修改指令等。

**任务不可中断**：用户说"帮我重构这个模块"，Agent 可能需要连续执行 30+ 轮工具调用。中途因为 Context 耗尽而中断，用户体验会非常糟糕。

**信息价值不均匀**：3 轮前读取的一个配置文件可能已经不再相关，但 10 轮前用户提出的核心需求必须一直记住。简单地"截断最早的消息"会丢失关键信息。

Claude Code 的 Context 管理系统本质上是在解决一个资源调度问题：**在有限的 token 预算内，最大化保留对当前任务有价值的信息**。它的策略可以用三层模型概括：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Context 管理三层模型                          │
│                                                                 │
│  L1  Content Replacement    工具结果原地替换             持续运行 │
│      ─────────────────────────────────────────────────────────  │
│  L2  Microcompact           局部压缩（cache_edits）      按需触发 │
│      ─────────────────────────────────────────────────────────  │
│  L3  Auto-Compact           全局摘要压缩                 阈值触发 │
│                                                                 │
│      成本:  L1 ≈ 0    L2 ≈ 低    L3 ≈ 一次完整 API 调用        │
│      粒度:  单条结果   单条消息    全部历史                       │
│      信息损失: 无      低          中                             │
└─────────────────────────────────────────────────────────────────┘
```

> **设计决策**：三层策略体现了"渐进式降级"思想 — 能用轻量方案解决的不用重量方案，能局部处理的不做全局处理。只有当前两层都无法维持 context 在安全范围内时，才触发最昂贵的全局压缩。

**小结**：Context 管理的核心矛盾是"任务复杂度无限增长 vs. 窗口容量有限"。Claude Code 用三层递进策略（替换 → 局部压缩 → 全局摘要）来应对，每一层在成本和信息损失之间做了不同的取舍。

---

## 7.2 Context Window 大小决策：j0() (getContextWindow) 与模型能力矩阵

在做任何 Context 管理之前，首先要知道"我有多大的窗口可用"。这看似简单，但在 Claude Code 中涉及多个模型、多种 provider、多个 feature flag 的交叉判断。

### Context Window 大小查询

函数 `j0()` (推测名: `getContextWindowSize`) 负责确定当前模型的 Context Window 大小：

```javascript
// j0() — getContextWindowSize
// Determine context window size for current model
var c01 = 200000; // 200K tokens (default for standard models)

function j0(model, betas) {
  // [1m] tag in model name → enable 1M context
  if (PE(model)) return 1_000_000;

  // Query model capabilities cache
  var caps = Q01(model);
  if (caps?.max_input_tokens >= 100_000) {
    // If 1M context is disabled, cap at default 200K
    if (caps.max_input_tokens > c01 && Gl()) return c01;
    return caps.max_input_tokens;
  }

  // Beta flag: "long-context-1m-2025-..." for Sonnet 4 / Opus 4-6
  if (betas?.includes(se) && Ij1(model)) return 1_000_000;

  // Sonnet 4-6 special handling (coral_reef_sonnet flag)
  if (l01(model)) return 1_000_000;

  return c01; // 200K default
}
```

### Output Token 限制

Output Token 限制同样因模型而异，通过 `e66()` (推测名: `getOutputTokenLimits`) 查询：

```javascript
// e66() — getOutputTokenLimits
// Returns { default, upperLimit } for each model
function e66(model) {
  var name = Vz(model); // getModelName

  // Model-specific output token limits
  if (name.includes("opus-4-6"))      return { default: 64000,  upperLimit: 128000 };
  if (name.includes("sonnet-4-6"))    return { default: 32000,  upperLimit: 128000 };
  if (name.includes("opus-4-5") ||
      name.includes("sonnet-4") ||
      name.includes("haiku-4"))       return { default: 32000,  upperLimit: 64000 };
  if (name.includes("opus-4-1") ||
      name.includes("opus-4"))        return { default: 32000,  upperLimit: 32000 };
  if (name.includes("claude-3-opus")) return { default: 4096,   upperLimit: 4096 };
  if (name.includes("3-5-sonnet"))    return { default: 8192,   upperLimit: 8192 };
  if (name.includes("3-7-sonnet"))    return { default: 32000,  upperLimit: 64000 };

  // Default fallback
  return { default: 32000, upperLimit: 64000 };
}
```

用户可以通过 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 环境变量覆盖默认值，但不能超过 `upperLimit`。

### 有效 Context Window 计算

Context Window 并不等于"可用于对话的空间"。需要为输出预留空间：

```javascript
// ZQ() — getEffectiveContextWindow
// Effective window = full window - output token budget
var D7z = 20000; // output tokens buffer cap (capped at 20K for compaction calc)

function ZQ(model) {
  var maxOutput = Math.min(U68(model), D7z); // cap at 20K
  var effectiveWindow = j0(model, yX());     // full context window
  // Env override: CLAUDE_CODE_AUTO_COMPACT_WINDOW
  return effectiveWindow - maxOutput;
}
```

### 模型能力矩阵

综合以上逻辑，当前支持的模型构成如下能力矩阵：

```
┌──────────────────────────────────────────────────────────────┐
│                 模型能力矩阵 (Context / Output)              │
│                                                              │
│  Opus 4-6     1M / 64K (max 128K)    ← 最大窗口             │
│  Sonnet 4-6   1M / 32K (max 128K)    ← 1M context           │
│  Opus 4-5     200K / 32K (max 64K)                           │
│  Sonnet 4     200K / 32K (max 64K)                           │
│  Claude 3.7   200K / 32K (max 64K)                           │
│  Claude 3.5   200K / 8K  (max 8K)    ← 旧模型               │
│  Claude 3     200K / 4K  (max 4K)    ← 最小输出              │
│                                                              │
│  有效窗口 = Context Window - min(maxOutput, 20K)             │
│  例: 200K model → 200K - 20K = 180K 有效窗口                │
│  例: 1M model  → 1M - 20K   = 980K 有效窗口                 │
└──────────────────────────────────────────────────────────────┘
```

### Context 使用率监控

每次 API 调用后，Claude Code 通过 `MM8()` (推测名: `computeContextUsage`) 计算当前使用率：

```javascript
// MM8() — computeContextUsage
function MM8(usage, contextWindowSize) {
  if (!usage) return { used: null, remaining: null };
  var totalInputTokens = usage.input_tokens +
                         usage.cache_creation_input_tokens +
                         usage.cache_read_input_tokens;
  var usedPct = Math.round(totalInputTokens / contextWindowSize * 100);
  return {
    used: Math.min(100, Math.max(0, usedPct)),
    remaining: 100 - usedPct
  };
}
```

> **设计决策**：Context Window 大小不是一个固定常量，而是根据模型、beta flag、环境变量动态计算。这种灵活性允许 Claude Code 在新模型发布时快速适配，同时让高级用户可以通过环境变量微调行为（比如 `CLAUDE_CODE_DISABLE_1M_CONTEXT` 强制禁用 1M context）。

**小结**：Context Window 大小由 `j0()` 函数根据模型名、beta flag、环境变量综合决定。有效窗口还要扣除 output token 预留（上限 20K）。所有后续的触发阈值计算都基于这个有效窗口值。

---

## 7.3 三级上下文管理策略

Claude Code 不是等到 Context 快满了才一次性处理，而是在不同层级持续优化上下文占用。三种策略分别应对不同场景。

### L1: Content Replacement — 工具结果原地替换

最轻量的策略，成本为零，信息损失为零。

**原理**：某些工具的返回结果在使用后变得冗余。例如，Grep 搜索返回了 50 个文件路径，Agent 选择读取其中 3 个后，那 50 个路径就不再有价值。Claude Code 可以用简短的占位文本替换这些冗余结果：

```
原始 tool_result:
  "Found 50 files matching *.tsx:\n1. src/App.tsx\n2. src/Button.tsx\n..."
  (2000 tokens)

替换后:
  "[Tool result replaced - content no longer needed]"
  (10 tokens)
```

**应用场景**：
- 基于时间的微压缩（Time-Based Micro-Compaction）：当对话间隔超过 60 分钟时，自动清除旧的 tool result：

```javascript
// Time-based microcompact configuration
var config = {
  enabled: false,        // disabled by default
  gapThresholdMinutes: 60,
  keepRecent: 5          // keep last 5 tool results
};

// Old tool results replaced with:
"[Old tool result content cleared]"
```

- 文件读取去重：重复读取同一文件时，旧的结果可被替换。

### L2: Microcompact — 局部压缩

中等成本，利用 `cache_edits` 机制在不破坏 prompt cache 的前提下删除旧内容。

**原理**：Anthropic API 支持 `cache_edits` block，允许在引用已缓存内容时进行增量编辑。Claude Code 利用这个机制，将旧的 tool_result 替换为 `cache_reference`，从而在逻辑上"删除"了这些内容，但不会导致 cache 失效：

```javascript
// Microcompact: replace old tool results with cache references
// This "deletes" content from the model's view without breaking cache
{
  type: "cache_edits",
  edits: [
    { cache_reference: "tool_use_id_123" }  // reference replaces content
  ]
}
```

**关键优势**：传统方式下，删除一条中间消息会导致后续所有内容的 cache 失效（因为 cache key 是基于前缀计算的）。`cache_edits` 允许"跳过"指定内容，保持后续 cache 有效。

### L3: Auto-Compact — 全局摘要压缩

最重量级的策略，需要一次完整的 API 调用。当前两层无法阻止 Context 逼近上限时启动，将全部历史消息压缩为一份结构化摘要。这是本章的重点，将在 7.4 节展开。

### 三层协同工作

```
Token 使用量
  │
  │                                              ┌─ Auto-Compact
  │                                         ╱    │  全局压缩
  │                              ╱─────────      │  token 骤降
  │                   ╱─────────              ───┤
  │        ╱─────────                             │
  │───────     L1/L2 持续优化                      │
  │            减缓增长速度                        │
  │                                              │
  ├──────────────────────────────────────────────┼──→ 时间
  0                                           阈值
                                         (有效窗口 - 13K)
```

L1 和 L2 像是"日常清洁"，持续减缓 context 增长速度。L3 像是"大扫除"，在空间即将耗尽时一次性释放大量空间。

> **设计决策**：三层策略的设计体现了一个工程原则 —"延迟昂贵操作"。L1/L2 成本极低，可以频繁执行；L3 需要一次完整 API 调用（消耗 token、产生延迟），所以只在必要时触发。这种分层设计使得大多数会话可能永远不需要触发 L3，从而节省了大量成本。

**小结**：三级策略从轻到重递进 — Content Replacement 零成本替换冗余内容，Microcompact 利用 cache_edits 局部删除，Auto-Compact 全局摘要压缩。三者协同工作，既控制了 Context 增长速度，又在必要时提供了彻底的空间释放能力。

---

## 7.4 Auto-Compaction 深度解析

Auto-Compaction 是 Claude Code Context 管理系统的核心机制。它在 Context 即将耗尽时自动触发，将整段对话压缩为结构化摘要，腾出空间继续工作。这个过程涉及触发判断、token 估算、摘要生成、文件恢复、异常处理等多个环节。

### 7.4.1 触发机制：Agent 侧本地 token 估算

Auto-Compact 的触发判断**发生在 Agent 侧（本地），而非 API 侧**。这是一个关键的架构决策 — Agent 在每次 API 调用之前，先用本地估算检查当前 token 数是否超过阈值，超过则拦截正常请求，转而执行 compact。

```
用户发消息 / 工具返回结果
    │
    ▼
Agent 侧估算当前 token 数 ← sG() (getCurrentTokenCount)
    │
    │  计算方式：
    │  = 最近一次 API 返回的 usage (精确值)
    │  + 之后新增消息的本地估算 (text.length / 4 × 1.333)
    │
    ▼
与阈值比较 ← Dj6() (evaluateContextStatus)
    │
    │  Auto-Compact 阈值 = 有效窗口 - 13K (保留缓冲)
    │  例: 200K 模型 → 180K - 13K = 167K
    │
    ├─ 未超过 → 正常发送 API 请求，继续 agentic loop
    │
    └─ 超过 → 拦截！不发正常请求，执行 compact
         │
         ▼
      BJK() (executeAutoCompact) → 摘要 + 替换 → 继续 loop
```

获取当前 token 数的 `sG()` (推测名: `getCurrentTokenCount`) 函数采用"精确基准 + 增量估算"的混合策略：

```javascript
// sG() — getCurrentTokenCount
// Hybrid approach: precise API usage + estimated new messages
function sG(messages) {
  // Walk backward from latest message to find most recent API usage
  for (var i = messages.length - 1; i >= 0; i--) {
    var usage = Vg(messages[i]); // getApiUsage
    if (usage) {
      // Precise API-reported tokens + estimated subsequent messages
      return gi6(usage) + Nv6(messages.slice(i + 1));
      //     ↑ total from API   ↑ estimate for new messages
    }
  }
  // No API response yet — estimate everything
  return Nv6(messages);
}
```

判断函数 `Dj6()` (推测名: `evaluateContextStatus`) 返回多个状态标志：

```javascript
// Dj6() — evaluateContextStatus
var Pe1 = 13000;  // auto-compact reserved buffer
var P7z = 20000;  // warning threshold
var We1 = 3000;   // blocking limit buffer (manual compact only)
var SXK = 3;      // consecutive failure circuit breaker

function Dj6(tokenCount, model) {
  var threshold = et6(model);       // getAutoCompactThreshold
  var effectiveWindow = ZQ(model);  // getEffectiveContextWindow
  var percentLeft = Math.max(0,
    Math.round((effectiveWindow - tokenCount) / effectiveWindow * 100));

  return {
    percentLeft,
    isAboveWarningThreshold:      tokenCount >= effectiveWindow - P7z,
    isAboveErrorThreshold:        tokenCount >= effectiveWindow - P7z,
    isAboveAutoCompactThreshold:  zb() && tokenCount >= threshold,
    isAtBlockingLimit:            tokenCount >= ZQ(model) - We1
  };
}
```

启用条件检查：

```javascript
// zb() — isAutoCompactEnabled
function zb() {
  if (process.env.DISABLE_COMPACT) return false;
  if (process.env.DISABLE_AUTO_COMPACT) return false;
  return j8().autoCompactEnabled;  // user settings check
}
```

### 7.4.2 Token 估算算法：text.length / 4 × 1.333 安全系数

为什么不调用 API 精确计数？因为每轮 agentic loop 都要检查 — 每次都调 API 计数的延迟和成本不可接受。所以 Claude Code 使用纯本地估算：

```javascript
// D3() — estimateTokenCount
// Basic estimation: ~4 characters = 1 token for English text
function D3(text, charsPerToken = 4) {
  return Math.round(text.length / charsPerToken);
}

// fv6() — estimateMessageTokens
// Iterate all content blocks and accumulate estimates
function fv6(messages) {
  var tokens = 0;
  for (var msg of messages) {
    for (var block of msg.message.content) {
      if (block.type === "text")        tokens += D3(block.text);
      if (block.type === "tool_result") tokens += pOq(block); // estimateToolResultTokens
      if (block.type === "image")       tokens += 2000;       // fixed estimate
      if (block.type === "document")    tokens += 2000;       // fixed estimate
      if (block.type === "thinking")    tokens += D3(block.thinking);
      if (block.type === "tool_use")    tokens += D3(block.name + JSON.stringify(block.input));
    }
  }
  return Math.ceil(tokens * 1.3333);  // x1.333 safety factor!
}
```

**为什么乘以 1.333？** 这是为了补偿 `length/4` 估算的系统性低估：

| 内容类型 | 偏差方向 | 原因 | 安全系数如何补偿 |
|----------|---------|------|-----------------|
| 英文 | 较准确 | 平均 ~4 字符/token | 1.333x 提供余量 |
| 中文 | 低估 | 1 汉字 ≈ 1-2 token，但 `length` 算 1 | 1.333x 部分补偿 |
| JSON | 低估 | 符号密集，token 效率低 | 另有特殊处理：`length/2` |
| 代码 | 略低估 | 关键字短但 token 多 | 1.333x 部分补偿 |

对 JSON/JSONL 文件有特殊的字符-token 比率：

```javascript
// rXK() — estimateFileTokens
// JSON files use length/2 instead of length/4
function rXK(text, extension) {
  return D3(text, i7z(extension));
  // json/jsonl/jsonc → charsPerToken = 2
  // all others       → charsPerToken = 4
}
```

> **设计决策**：安全系数 1.333 体现了"宁可早 compact 也不要 overflow"的策略。本地估算天然不精确，如果低估了 token 数导致 API 报错 `prompt_too_long`，不仅浪费了这次 API 调用的成本，还需要额外的裁剪重试。与其冒这个风险，不如用安全系数提前一点触发 compact — 代价只是多做一次摘要，远小于 overflow 的代价。

### 7.4.3 摘要流程：9 段式结构化摘要模板

当 Auto-Compact 被触发后，Claude Code 将全部对话发给 Claude 生成摘要。摘要使用一个精心设计的 9 段式结构化模板，确保关键信息不丢失。

**摘要提示词（`d1z` 常量，推测名: `COMPACTION_PROMPT`）**：

```
Your task is to create a detailed summary of the RECENT portion
of the conversation — the messages that follow earlier retained context.
The earlier messages are being kept intact and do NOT need to be summarized.

Before providing your final summary, wrap your analysis in <analysis> tags...

1. Analyze the recent messages chronologically:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details: file names, full code snippets, function signatures
   - Errors encountered and how you fixed them
   - User feedback

Your summary should include:
1. Primary Request and Intent        ← 用户的核心目标
2. Key Technical Concepts            ← 关键技术决策
3. Files and Code Sections           ← 完整代码片段（不是描述）
4. Errors and Fixes                  ← 遇到的错误及修复方式
5. Problem Solving                   ← 解决问题的推理过程
6. All User Messages (non-tool)      ← 用户说的每句话
7. Pending Tasks                     ← 还没完成的任务
8. Current Work                      ← 正在做什么
9. Optional Next Step                ← 建议的下一步

REMINDER: Do NOT call any tools. Respond with plain text only —
an <analysis> block followed by a <summary> block.
```

9 个段落的设计有明确的信息保留优先级：

```
┌─────────────────────────────────────────────────────────┐
│              9 段式摘要结构                               │
│                                                         │
│  ┌─ 1. Primary Request ──────┐  用户要做什么？           │
│  │  2. Key Technical Concepts │  怎么做的？               │
│  │  3. Files and Code         │  改了哪些文件？           │
│  │  4. Errors and Fixes       │  遇到了什么问题？         │
│  │  5. Problem Solving        │  怎么解决的？             │
│  │  6. All User Messages      │  用户原话（不能丢！）     │
│  │  7. Pending Tasks          │  还有什么没做？           │
│  │  8. Current Work           │  正在做什么？             │
│  └─ 9. Next Step ─────────────┘  接下来该做什么？         │
│                                                         │
│  第 6 段要求保留所有用户消息原文                           │
│  第 3 段要求保留完整代码片段（不只是描述）                 │
└─────────────────────────────────────────────────────────┘
```

**摘要后处理**（`c1z` 函数，推测名: `processCompactSummary`）：

```javascript
// c1z() — processCompactSummary
// Remove <analysis> block, extract <summary> content
function c1z(rawSummary) {
  // 1. Remove <analysis>...</analysis> block (Chain-of-Thought, not needed)
  result = result.replace(/<analysis>[\s\S]*?<\/analysis>/, "");

  // 2. Extract <summary>...</summary> content
  var match = result.match(/<summary>([\s\S]*?)<\/summary>/);
  if (match) {
    result = "Summary:\n" + match[1].trim();
  }

  // 3. Collapse excessive blank lines
  result = result.replace(/\n\n+/g, "\n\n");
  return result.trim();
}
```

**摘要注入格式**（`p68` 函数，推测名: `formatCompactSummary`）：

压缩后的摘要被包装为一条特殊的用户消息，注入到新的对话起点：

```javascript
// p68() — formatCompactSummary
function p68(summary, shouldContinue, transcriptPath, hasRecentMessages) {
  var text = `This session is being continued from a previous conversation
that ran out of context. The summary below covers the earlier portion
of the conversation.

${processedSummary}`;

  // If transcript file exists, tell Agent it can read full history
  if (transcriptPath) {
    text += `\n\nIf you need specific details from before compaction
(like exact code snippets, error messages, or content you generated),
read the full transcript at: ${transcriptPath}`;
  }

  if (hasRecentMessages) {
    text += "\n\nRecent messages are preserved verbatim.";
  }

  // Critical: tell Agent to continue seamlessly, no recap
  if (shouldContinue) {
    text += "\nContinue the conversation from where it left off
without asking the user any further questions. Resume directly —
do not acknowledge the summary, do not recap what was happening,
do not preface with \"I'll continue\" or similar. Pick up the last
task as if the break never happened.";
  }

  return text;
}
```

**Compact API 调用配置**：

```javascript
// Compaction API call in MXK() (executeCompactApiCall)
{
  systemPrompt: "You are a helpful AI assistant tasked with summarizing conversations.",
  thinkingConfig: { type: "disabled" },  // Thinking disabled — save tokens!
  tools: [HY, Qi6, ...mcpTools],        // FileRead + ToolSearch + MCP tools
  maxOutputTokensOverride: Math.min(20000, U68(model)),  // cap at 20K
  querySource: "compact"
}
```

> **设计决策**：Compact 调用禁用了 thinking（extended thinking），因为摘要任务不需要深度推理，禁用 thinking 可以节省大量 token。但保留了 FileRead 和 ToolSearch 工具 — 如果 Claude 在写摘要时需要查看某个文件的当前状态，它可以读取。

### 7.4.4 压缩后恢复：最近 5 个文件自动重读

Compact 后，原始对话消息被摘要替换，所有文件内容都不在 context 中了。为了让 Agent 能无缝继续工作，Claude Code 自动重读最近操作过的文件：

```javascript
// Compact file recovery constants
var $XK = 5;       // max 5 files to recover
var l1z = 50000;   // total recovery token limit (50K)
var i1z = 5000;    // per-file token limit (5K)
```

恢复逻辑：

```
Compact 完成
    │
    ▼
扫描被压缩的消息，找到最近读取的文件
    │
    ▼
取最后 5 个唯一文件路径
    │
    ▼
逐个重新读取 (每个 ≤5K token，总计 ≤50K token)
    │
    ▼
作为 attachment 消息追加到 compact 摘要之后
```

**压缩后的完整消息结构**：

```
[compact_boundary]       ← system 消息，subtype="compact_boundary"
                           包含元数据：trigger, preCompactTokenCount
[summary_message]        ← user 消息，包含格式化的摘要正文
[recovered_file_1]       ← attachment，最近读取的文件内容
[recovered_file_2]       ← attachment
[recovered_file_3]       ← attachment
[plan / skills / tasks]  ← 其他 attachment 恢复
[hook_results]           ← session_start hook 结果
[recent_messages...]     ← 如果有保留的近期消息（部分压缩时）
```

compact_boundary 标记包含触发元数据：

```javascript
// g68() — createCompactBoundary
function g68(trigger, preCompactTokenCount, lastMessageUuid) {
  return {
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: {
      trigger: trigger, // "auto" | "manual"
      preCompactTokenCount,
      // preservedSegment for partial compaction
    }
  };
}
```

### 7.4.5 兜底机制：API 返回 prompt_too_long → 裁剪重试

如果 Agent 侧的 token 估算低估了，导致正常 API 调用或 compact 调用本身遇到 `prompt_too_long` 错误，有两层兜底：

**兜底 1：调低 output token 重试**

```javascript
// Ewq() — handleInputOverflow
// Parse API error: "input length + max_tokens exceed context limit: 150K + 32K > 180K"
function Ewq(error) {
  var match = error.message.match(/(\d+) \+ (\d+) > (\d+)/);
  var { inputTokens, maxTokens, contextLimit } = match;

  // Reduce max_tokens to fit within limit
  var availableContext = Math.max(0, contextLimit - inputTokens - 1000);
  if (availableContext < 3000) throw error;  // FLOOR: minimum 3K output tokens

  retryContext.maxTokensOverride = Math.max(3000, availableContext);
}
```

**兜底 2：裁剪消息重试（最多 3 次）**

如果连 compact 请求本身都太长，执行递归裁剪重试：

```javascript
var wXK = 3;  // max trim-retry attempts

// jXK() — trimMessagesForRetry
function jXK(messages, apiResponse) {
  var tokenLimit = GXK(apiResponse); // parseTokenLimitFromError

  if (tokenLimit !== undefined) {
    // Precise mode: accumulate tokens, keep messages that fit
    var accumulated = 0, count = 0;
    for (var msg of groupedMessages) {
      accumulated += Nv6(msg); // estimateGroupTokens
      count++;
      if (accumulated >= tokenLimit) break;
    }
  } else {
    // Fuzzy mode: keep last 20% of messages
    count = Math.max(1, Math.floor(groupedMessages.length * 0.2));
  }

  // Return the kept (later) portion
  return keepMessages.slice(count);
}
```

**完整的异常处理流程图**：

```
正常 API 调用
    │
    ├─ 成功 → 继续 agentic loop
    │
    └─ prompt_too_long 错误
         │
         ├─ Ewq(): 调低 max_tokens 重试
         │    │
         │    ├─ 成功 → 继续 (output 可能被截断)
         │    └─ 仍然失败 → 触发 Auto-Compact
         │
         └─ Auto-Compact 的 API 调用也 prompt_too_long
              │
              ▼
         裁剪重试循环 (最多 3 次):
              │
              ├─ 精确模式：按 API 告知的 limit 裁剪
              ├─ 模糊模式：保留后 20% 消息
              │
              ├─ 成功 → 用裁剪后的摘要继续
              └─ 3 次失败 → 熔断 (SXK=3)，放弃 compact
```

> **设计决策**：连续失败 3 次的熔断机制（`SXK = 3`）防止了无限循环。如果 compact 反复失败，说明对话已经处于极端状态，继续重试只会浪费资源。此时不如放弃 compact，让 Agent 尽量在剩余空间内完成任务，或提示用户开新会话。

**小结**：Auto-Compaction 是一个精心设计的多步骤流程 — Agent 侧本地估算触发（不等 API 报错）、1.333x 安全系数宁早勿晚、9 段式结构化摘要保留关键信息、自动重读最近 5 个文件减少信息断裂、两层兜底处理异常情况。整个流程对用户透明，理想情况下用户甚至感觉不到 compact 发生过。

---

## 7.5 Fork Cache 共享优化

Auto-Compact 需要把整段对话发给 Claude 写摘要，这个操作本身可能消耗大量 token。Claude Code 用了一个非常巧妙的优化 — Fork Cache 共享 — 将 compact 的成本降低约 90%。

### 问题：Compact 为什么昂贵？

标准的 compact 方式是用一个全新的 system prompt（"你是摘要助手"）+ 全部对话消息调用 API。问题在于：正常对话已经在 API 侧建立了 prompt cache（system prompt + 前面的消息都被缓存了），但 compact 用了不同的 system prompt，**整个 cache 全部失效**：

```
正常 agentic loop 的 API 调用:
  System Prompt (30K tokens)  ← cached in API side
  + Messages (160K tokens)    ← cached in API side
  = 190K tokens               ← mostly cache hits, cheap

标准 Compact 调用:
  System Prompt = "You are a summarization assistant"  ← NEW system prompt!
  + Messages (160K tokens)                              ← same content
  = 160K tokens                                         ← ALL cache miss, expensive!
```

160K tokens 全部按正常价格收费，这是一次非常昂贵的操作。

### 解决方案：Fork — 不换 System Prompt

Fork 方式的核心思路是：**不替换 system prompt，把摘要指令作为新的 user message 追加到对话末尾**。这样前面所有 cached tokens 都可以复用：

```
Fork compact 调用:
  [System Prompt 30K]     ← reuse cache ✓
  [Messages 1-100]        ← reuse cache ✓
  [Messages 101-120]      ← reuse cache ✓
  [Summary instruction]   ← only this is new (~1K tokens)

vs. 标准 compact:
  [New System Prompt]     ← cache miss ✗
  [Messages 1-120]        ← cache miss ✗ (all 160K re-processed)
```

### 代码实现

```javascript
// In MXK() — executeCompactApiCall
// Step 1: Try fork approach (cache sharing)
var result = await qf({                    // qf = forkConversation
  promptMessages: [summaryRequest],        // "Please summarize" as user message
  cacheSafeParams,                         // keep cache key consistent
  querySource: "compact",
  forkLabel: "compact",
  maxTurns: 1,                             // only 1 turn — get summary, stop
  skipCacheWrite: true                     // don't write new cache entries
});

// Step 2: If fork fails → fallback to standard approach
if (!result) {
  result = await standardCompactCall({
    systemPrompt: "You are a helpful AI assistant tasked with summarizing...",
    messages: allMessages,
    ...
  });
}
```

### 成本对比

以 200K context、160K 对话消息为例：

| 方式 | 新处理的 token | Cache 命中 | 相对成本 |
|------|---------------|-----------|---------|
| 标准 compact | ~160K (全部重算) | 0% | 100% |
| Fork compact | ~1K (仅摘要指令) | ~99% | **~10%** |

Prompt cache 的价格是正常输入的 10%，所以 cache hit 部分的成本只有正常的 1/10。

### `skipCacheWrite: true` 防止 Cache 污染

Fork compact 调用设置了 `skipCacheWrite: true`。这是因为 compact 是一次性操作 — 摘要完成后，对话被替换为全新的消息序列。如果让 compact 的结果写入 cache，这些 cache 条目永远不会被后续请求命中，纯粹是浪费。

```
时间线:

  [正常对话 cache]     [compact 调用]     [压缩后新对话]
  ────────────────    ──────────────    ────────────────
  cache entries A     如果写入 cache B   cache entries C
                      B 永远不会再被     （全新的消息序列，
                      命中 — 浪费!       与 A、B 都不匹配）
```

### Fork 的 5 个优势

| # | 优势 | 说明 |
|---|------|------|
| 1 | 复用 cache，省 ~90% 费用 | 摘要指令追加到末尾，前面 160K+ tokens 全部 cache hit |
| 2 | skipCacheWrite，不污染 cache | compact 是一次性操作，不写入 cache，后续对话不受影响 |
| 3 | 摘要质量更高 | 保留了完整原始 system prompt（工具规则、行为准则），Claude 判断"什么信息重要"更准确 |
| 4 | maxTurns: 1，严格控制 | 限死只跑 1 轮，拿到摘要就结束，不会产生额外工具调用 |
| 5 | 失败静默回退，零风险 | fork 成功省钱省时间，失败无声回退标准方式，用户无感知 |

### Fork 失败场景

Fork 并非总能成功：

- **Cache 过期** — Anthropic cache TTL 是 5 分钟，对话间隔太久 cache 已被 evict
- **对话太久没有 API 调用** — cache 自然过期
- **Provider 不支持** — 某些 Bedrock 配置不支持 cache sharing

失败后静默回退到标准方式，用户无感知。

> **设计决策**：Fork compact 是一个"低风险高收益"的优化。成功时节省 ~90% 成本和显著的延迟；失败时零代价，无声回退。这种设计模式（try optimistic path → fallback gracefully）在 Claude Code 中反复出现，是工程上处理"可能失败的优化"的最佳实践。

**小结**：Fork Cache 共享通过"不换 system prompt、把摘要指令追加为 user message"的方式，让 compact 调用复用已有的 prompt cache，将成本降低约 90%。`skipCacheWrite: true` 防止一次性操作污染 cache。失败时静默回退，零风险。

---

## 7.6 Prompt Caching 策略：静态/动态分割 + Cache Breakpoint 插入

除了 compact 场景的 cache 优化，Claude Code 在日常 API 调用中也有一套精细的 prompt caching 策略，通过将 system prompt 分为 static/dynamic 两部分并在消息中插入 cache breakpoint 来最大化 cache 命中率。

### System Prompt 静态/动态分割

Claude Code 的 system prompt 包含多个部分，被一个特殊标记 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 分为两组：

```
┌──────────────────────────────────────────────────────────┐
│                    System Prompt 结构                     │
│                                                          │
│  ┌── STATIC 部分 (cacheScope: "global") ──────────────┐ │
│  │  Billing header                                     │ │
│  │  Organization identity                              │ │
│  │  __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__                 │ │
│  │  Default system prompt (core agent instructions)    │ │
│  │  Tool definitions (all built-in tool descriptions)  │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌── DYNAMIC 部分 (cacheScope: null) ─────────────────┐ │
│  │  CLAUDE.md content          ← changes per project   │ │
│  │  Git status                 ← changes per commit    │ │
│  │  Current date               ← changes daily         │ │
│  │  Custom system prompt       ← user-specific         │ │
│  │  Append system prompt       ← user-specific         │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

```javascript
// s57() — splitSystemPromptForCaching
function s57(promptBlocks, options) {
  // Find the dynamic boundary marker
  var boundaryIndex = blocks.findIndex(b => b === Zj6);
  // Zj6 = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"

  if (boundaryIndex !== -1) {
    // Static part → cacheScope: "global" (shared across sessions/users)
    // Dynamic part → cacheScope: null (not cached)
    return [
      { text: staticBlocks, cacheScope: "global" },
      { text: dynamicBlocks, cacheScope: null }
    ];
  }

  // No boundary found → use "org" scope for everything
  return [{ text: allBlocks, cacheScope: "org" }];
}
```

**为什么这样分割？**

Static 部分（核心指令 + 工具定义）在所有用户、所有项目间是**完全相同**的。用 `"global"` scope 缓存意味着一个用户的第一次调用创建的 cache 可以被所有后续用户复用。

Dynamic 部分（CLAUDE.md、git status、日期）每次都可能不同，缓存它们只会浪费 cache 空间。

### Cache Scope 类型

```javascript
// Cache scope hierarchy:
// "global" → shared across all users (system prompt static)
// "org"    → shared within organization
// null     → not cached
```

### 消息级 Cache Breakpoint

在对话消息中，Claude Code 在最后两条 user message 处插入 cache breakpoint：

```javascript
// Byz() — insertCacheBreakpoints
function Byz(messages, enableCaching, querySource, ...) {
  // Add cache_control to the last content block of the last user message
  // Convert previous user messages' tool_results to cache_reference
  // Keep only the last 2 cache breakpoints (penultimate + last user message)
}
```

为什么只在最后两条 user message 设置 breakpoint？因为每轮对话，最后一条 user message 是新的，倒数第二条是上一轮的。在两处设置 breakpoint 可以：

```
Turn N 的 cache 结构:
  [SP] [msg1] [msg2] ... [msgN-2] [BP] [msgN-1] [BP] [msgN]
                                   ↑              ↑     ↑
                              breakpoint 1   breakpoint 2  new

Turn N+1:
  [SP] [msg1] [msg2] ... [msgN-2] [msgN-1] [BP] [msgN] [BP] [msgN+1]
                                             ↑          ↑      ↑
                                        BP moved    BP moved   new

  → [SP] ... [msgN-1] 部分全部 cache hit
```

两个 breakpoint 形成了"滑动的 cache 窗口"，每轮只有最新的 1-2 条消息需要重新处理，前面的全部命中 cache。

> **设计决策**：Prompt caching 策略的核心是"识别变化频率并据此分层"。永远不变的（工具定义）用 global cache；每次请求都变的（当前消息）不 cache；中间的消息用 breakpoint 实现滑动 cache。这种分层设计最大化了 cache 命中率，同时不浪费 cache 空间。

**小结**：Claude Code 将 system prompt 分为 static（global cache）和 dynamic（不缓存）两部分。消息中使用两个滑动的 cache breakpoint，确保每轮调用只有最新消息需要重新处理。这套策略使得日常 API 调用的大部分输入 token 都是 cache hit，成本只有正常的约 1/10。

---

## 7.7 Session Memory：会话持久化与跨 Compact 恢复

Session Memory 是 Auto-Compact 的**替代方案**（而非补充），使用结构化笔记文件代替 AI 生成的摘要。它是一个实验性功能，默认未启用。

### 启用条件

```javascript
// du8() — isSessionMemoryCompactEnabled
function du8() {
  if (process.env.ENABLE_CLAUDE_CODE_SM_COMPACT) return true;
  if (process.env.DISABLE_CLAUDE_CODE_SM_COMPACT) return false;
  // Feature flags: tengu_session_memory AND tengu_sm_compact
  return F8("tengu_session_memory", false) && F8("tengu_sm_compact", false);
}
```

### Session Memory 模板

Session Memory 使用一个固定结构的 Markdown 文件来记录会话状态：

```markdown
# Session Title
_A short and distinctive 5-10 word descriptive title_

# Current State
_What is actively being worked on right now?_

# Task specification
_What did the user ask to build?_

# Files and Functions
_Important files and their relevance_

# Workflow
_Bash commands and their order_

# Errors & Corrections
_Errors encountered and how fixed_

# Codebase and System Documentation
_Important system components_

# Learnings
_What has worked well? What to avoid?_

# Key results
_Specific outputs the user requested_

# Worklog
_Step by step summary_
```

### 与 Auto-Compact 的对比

```
┌─────────────────────────────────────────────────────────────────┐
│            Auto-Compact vs. Session Memory                      │
│                                                                 │
│  Auto-Compact:                                                  │
│    对话消息 (167K+) ──AI 摘要──→ 压缩后摘要 (~10-20K)           │
│    - 每次 compact 都重新生成                                     │
│    - 摘要质量取决于 AI                                           │
│    - 一次性 API 调用                                             │
│                                                                 │
│  Session Memory:                                                │
│    对话消息 → 持续更新 Memory 文件 → compact 时用 Memory 替代摘要│
│    - 持续增量更新，不是一次性生成                                │
│    - 结构化模板确保关键字段不遗漏                                 │
│    - 更新通过专门的 agent 调用完成                                │
└─────────────────────────────────────────────────────────────────┘
```

### Token 预算

Session Memory 有严格的大小限制：

```javascript
var Uu8 = 2000;    // max tokens per section
var fXK = 12000;   // max tokens for entire file
```

### SM Compact 触发条件

Session Memory Compact 有自己的触发配置：

```javascript
var Qu8 = {
  minTokens: 10000,           // minimum 10K tokens before SM compact triggers
  minTextBlockMessages: 5,    // minimum 5 text messages in conversation
  maxTokens: 40000            // keep at most 40K recent message tokens
};
```

### 更新机制

Session Memory 的更新是通过一个专门的 agent 调用完成的，类似一个"子任务"：

```
Update instruction to the sub-agent:

Your ONLY task is to use the Edit tool to update the notes file, then stop.
- NEVER modify section headers or italic descriptions
- Write DETAILED, INFO-DENSE content
- Keep each section under ~2000 tokens
- IMPORTANT: Always update "Current State" to reflect the most recent work
```

> **设计决策**：Session Memory 和 Auto-Compact 代表了两种不同的"记忆"哲学。Auto-Compact 是"事后总结" — 等 context 满了再压缩；Session Memory 是"持续记录" — 像人类笔记一样实时更新。Session Memory 的优势在于信息不会突然丢失（因为一直在增量更新），但劣势在于需要额外的 API 调用来维护笔记文件。目前仍在实验阶段。

**小结**：Session Memory 是 Auto-Compact 的实验性替代方案，用结构化 Markdown 笔记持续记录会话状态。每个 section 限 2K token，整个文件限 12K token。通过专门的 agent 调用增量更新，而非一次性 AI 生成摘要。目前默认未启用，需通过环境变量或 feature flag 开启。

---

## 7.8 Tool Search 延迟加载：defer_loading 按需激活工具定义

工具定义（tool definitions）占据 system prompt 中的大量 token。当接入大量 MCP 工具时，工具定义可能消耗 Context Window 的 10% 甚至更多。Tool Search 机制允许将不常用的工具定义"延迟加载"，只在 Agent 需要时才激活。

### 工具搜索阈值

```javascript
// Deferred tools threshold: 10% of context window by default
var ve1 = 10;  // percentage threshold
var C7z = 2.5; // character threshold multiplier

// uXK() — getDeferredToolsThreshold
function uXK(model) {
  var contextWindow = j0(model, PM8(model)); // getContextWindowSize
  return Math.floor(contextWindow * (Ve1() / 100));
  // 200K model → 20K tokens threshold
  // 1M model   → 100K tokens threshold
}
```

当所有工具定义的总 token 数超过这个阈值时，系统会自动将部分工具标记为 "deferred"，从 system prompt 中移除，只在工具搜索时才加载。

### ToolSearchTool

Agent 可以通过 `ToolSearchTool` (变量名 `Qi6`) 搜索和激活延迟加载的工具：

```javascript
// Qi6 — ToolSearchTool
{
  name: "ToolSearch",  // tool name as presented to model

  call({ query, max_results = 5 }) {
    // "select:tool_name" → direct selection, activate immediately
    // keyword search → fuzzy match against (name, description, searchHint)
    // "+" prefix → must-match filter

    return {
      matches: ["tool_name_1", "tool_name_2"],
      query,
      total_deferred_tools: count,
      pending_mcp_servers: [...]  // MCP servers still connecting
    };
  },

  // Returns tool_reference blocks instead of plain text
  mapToolResultToToolResultBlockParam(result, toolUseId) {
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: result.matches.map(name => ({
        type: "tool_reference",
        tool_name: name
      }))
    };
  }
}
```

### 工具搜索返回 tool_reference

搜索结果不是返回文本描述，而是返回 `tool_reference` blocks。这是 Anthropic API 的一个特殊机制 — 返回 `tool_reference` 后，API 侧会在下一轮调用时自动将对应工具的完整定义注入到上下文中。

```
Agent 不知道 "database_query" 工具:
    │
    ▼
Agent calls ToolSearch({ query: "database" })
    │
    ▼
ToolSearch returns: { type: "tool_reference", tool_name: "database_query" }
    │
    ▼
Next API call: API automatically includes database_query tool definition
    │
    ▼
Agent can now use database_query tool
```

### 不支持 Tool Search 的模型

```javascript
// Haiku models don't support tool_reference blocks
var I7z = ["haiku"];
```

### Context 节省效果

以一个接入 50 个 MCP 工具的场景为例：

```
不用 Tool Search:
  50 个工具定义 × ~400 tokens/tool = ~20K tokens
  占 200K context 的 10% — 始终存在

使用 Tool Search:
  10 个核心工具 × ~400 tokens = ~4K tokens (始终加载)
  40 个延迟工具 = 0 tokens (按需加载)
  ToolSearch 工具本身 ~200 tokens
  = ~4.2K tokens — 节省 ~16K tokens
```

> **设计决策**：Tool Search 解决了一个"MCP 工具爆炸"问题 — 随着用户接入越来越多的 MCP 服务器，工具定义的总量可能超过 context window 的承受能力。延迟加载机制将"所有工具都在 system prompt 中"变为"按需加载"，用一次额外的 tool call 换取大量 context 空间。阈值设为 context window 的 10% 是一个合理的平衡点 — 低于 10% 时不值得引入延迟加载的复杂度，高于 10% 时节省的空间足以弥补额外 tool call 的开销。

**小结**：Tool Search 允许工具定义延迟加载，当工具定义总量超过 context window 10% 时自动启用。Agent 通过 ToolSearchTool 搜索并激活需要的工具，返回 `tool_reference` block 让 API 在下一轮注入完整定义。这个机制在大量 MCP 工具场景下节省了显著的 context 空间。

---

## 7.9 设计启示

Claude Code 的 Context 管理系统是整个架构中最能体现"工程智慧"的部分。从中可以提炼出多条对 Coding Agent 开发的普适性设计原则。

### 1. 分层渐进式降级

不要设计一个"万能"的 Context 管理方案，而是设计多层递进方案：

```
成本极低的方案 → 先用
     │
     ↓ 不够了
成本中等的方案 → 再用
     │
     ↓ 还不够
成本较高的方案 → 最后用
```

这个模式的好处是：大多数时候用廉价方案就足够了，昂贵方案只在真正需要时才启动。Claude Code 的三级策略（替换 → 微压缩 → 全局摘要）就是这个模式的典范。

### 2. 宁可保守也不要 Overflow

估算不准是必然的，关键是设计偏差方向：

- **1.333x 安全系数** — 宁可估多导致提前 compact，也不要估少导致 API overflow
- **13K 保留缓冲** — 给 compact 操作本身留足空间
- **两层兜底** — 即使估算和缓冲都不够，还有裁剪重试

这个原则可以推广到所有资源管理场景：**宁可多预留一些，也不要在极限状态下崩溃**。

### 3. 利用已有 Cache 而非重建

Fork compact 的思路 — 不换 system prompt，把摘要指令追加为 user message — 是"利用现有资源"思维的极好体现。与其重建一个全新的 API 调用（cache 全部失效），不如在现有调用的基础上追加（复用 99% cache）。

这个模式适用于任何有 cache/预计算结果的系统：**先看能否在已有结果上增量操作，再考虑从头重算。**

### 4. 结构化模板 > 自由格式

9 段式摘要模板不是一个随意的设计 — 它确保了摘要覆盖所有关键维度（用户意图、技术决策、文件变更、错误修复、待办任务...）。如果让 AI 自由发挥写摘要，很可能遗漏某些维度。

这个原则适用于所有 LLM 输出场景：**当输出需要可靠和全面时，用结构化模板约束 AI 的输出格式。**

### 5. 透明降级优于静默失败

Claude Code 在每个失败点都有明确的处理策略：

| 失败场景 | 处理方式 |
|---------|---------|
| Fork compact 失败 | 静默回退到标准 compact |
| Compact API 返回 prompt_too_long | 裁剪重试（最多 3 次） |
| 连续 3 次 compact 失败 | 熔断，停止尝试 |
| API 返回 context overflow | 调低 max_tokens 重试 |
| max_tokens 仍不够 | 报告错误给用户 |

没有一种失败会导致系统静默丢数据或卡死 — 要么自动恢复，要么明确告知用户。

### 6. 分离变化频率不同的内容

Prompt caching 的 static/dynamic 分割体现了一个重要原则：**根据变化频率分层缓存**。

```
永远不变     → global cache (跨用户共享)
很少变化     → org cache (组织内共享)
每次请求都变 → 不缓存 (避免浪费)
```

这与 Web 缓存中"静态资源 → CDN、API 响应 → 浏览器缓存、用户数据 → 不缓存"的分层策略如出一辙。

### 7. Agent 主动管理 > 被动响应

Claude Code 不等 API 报 overflow 错误才处理 — 它在 Agent 侧主动预判并提前压缩。这种"主动管理"策略比"被动响应"有三个优势：

1. **避免浪费** — API 报错意味着这次调用的 token 全部浪费
2. **更平滑** — 提前 compact 用户几乎无感知，API 报错需要额外恢复
3. **更可控** — Agent 可以选择最佳时机 compact，而非被迫在错误后 compact

---

## 速查表

### 核心常量

| 混淆名 | 推测英文名 | 值 | 用途 |
|--------|-----------|-----|------|
| `c01` | DEFAULT_CONTEXT_WINDOW | 200,000 | 默认 context window |
| `D7z` | OUTPUT_BUFFER_CAP | 20,000 | 输出 token 缓冲上限 |
| `Pe1` | AUTO_COMPACT_BUFFER | 13,000 | 自动压缩保留缓冲 |
| `We1` | BLOCKING_LIMIT_BUFFER | 3,000 | 阻塞限制缓冲（手动 compact） |
| `SXK` | MAX_CONSECUTIVE_FAILURES | 3 | 连续失败熔断阈值 |
| `wXK` | MAX_TRIM_RETRIES | 3 | prompt-too-long 最大裁剪重试 |
| `Lv4` | COMPACT_MAX_OUTPUT | 20,000 | compact 调用最大输出 token |
| `$XK` | MAX_RECOVERY_FILES | 5 | compact 后最大文件恢复数 |
| `l1z` | RECOVERY_TOTAL_TOKEN_LIMIT | 50,000 | 恢复文件总 token 上限 |
| `i1z` | RECOVERY_PER_FILE_LIMIT | 5,000 | 单个恢复文件 token 上限 |
| `Uu8` | SM_SECTION_TOKEN_LIMIT | 2,000 | Session Memory 每 section 上限 |
| `fXK` | SM_FILE_TOKEN_LIMIT | 12,000 | Session Memory 文件总上限 |
| `Qu8.minTokens` | SM_COMPACT_MIN_TOKENS | 10,000 | SM compact 最小 token 要求 |
| `Qu8.maxTokens` | SM_COMPACT_MAX_RECENT | 40,000 | SM compact 保留近期消息上限 |
| `ve1` | TOOL_SEARCH_THRESHOLD_PCT | 10% | 工具搜索自动启用阈值 |
| `J4z` | FILE_READ_MAX_TOKENS | 25,000 | 文件读取默认 token 上限 |
| `Xb1` | FLOOR_OUTPUT_TOKENS | 3,000 | 最小输出 token 数 |
| `Se1` | COUNT_TOKENS_THINKING | 1,024 | countTokens thinking budget |
| `iu8` | TOOL_DEFINITION_CORRECTION | 500 | 工具定义 token 修正值 |

### 核心函数

| 混淆名 | 推测英文名 | 用途 |
|--------|-----------|------|
| `j0()` | getContextWindowSize | 查询模型 context window 大小 |
| `ZQ()` | getEffectiveContextWindow | 计算有效窗口（扣除输出预留） |
| `et6()` | getAutoCompactThreshold | 计算 auto-compact 触发阈值 |
| `sG()` | getCurrentTokenCount | 获取当前 token 数（混合估算） |
| `Dj6()` | evaluateContextStatus | 判断是否需要 compact |
| `D3()` | estimateTokenCount | 基础 token 估算（length/4） |
| `fv6()` | estimateMessageTokens | 消息序列 token 估算 |
| `BJK()` | executeAutoCompact | 自动压缩入口 |
| `MXK()` | executeCompactApiCall | 执行压缩 API 调用 |
| `c1z()` | processCompactSummary | 摘要后处理 |
| `p68()` | formatCompactSummary | 格式化压缩摘要 |
| `g68()` | createCompactBoundary | 创建压缩边界标记 |
| `jXK()` | trimMessagesForRetry | 裁剪消息用于重试 |
| `Ewq()` | handleInputOverflow | 处理输入溢出错误 |
| `MM8()` | computeContextUsage | 计算 context 使用率 |
| `zb()` | isAutoCompactEnabled | 检查 auto-compact 是否启用 |
| `s57()` | splitSystemPromptForCaching | 分割 system prompt 为 static/dynamic |
| `Byz()` | insertCacheBreakpoints | 在消息中插入 cache breakpoint |
| `e66()` | getOutputTokenLimits | 查询模型输出 token 限制 |
| `ar6()` | countTokensPrecise | 精确 token 计数（API 调用） |
| `qf()` | forkConversation | fork 对话（cache 共享） |

### 环境变量

| 环境变量 | 推测英文名 | 默认值 | 用途 |
|---------|-----------|--------|------|
| `DISABLE_COMPACT` | — | false | 完全禁用压缩（手动+自动） |
| `DISABLE_AUTO_COMPACT` | — | false | 禁用自动压缩（保留手动） |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | — | 模型值 | 覆盖有效 context window 大小 |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | — | 计算值 | 触发百分比 (0-100) |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | — | 计算值 | 覆盖阻塞限制 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | — | 模型默认 | 最大输出 token 数 |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | — | false | 禁用 1M context window |
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | — | 25000 | 文件读取 token 上限 |
| `ENABLE_CLAUDE_CODE_SM_COMPACT` | — | false | 启用 Session Memory compact |
| `DISABLE_CLAUDE_CODE_SM_COMPACT` | — | false | 禁用 Session Memory compact |
| `ENABLE_TOOL_SEARCH` | — | auto | 工具搜索模式 |

### Context 生命周期全景图

```
┌─────────────────────────────────────────────────────────────────┐
│                     Context Window (200K / 1M)                   │
│                                                                  │
│  ┌── System Prompt ────────────────────────────────────────────┐│
│  │  [STATIC: core instructions + tool definitions]  ← global  ││
│  │  [DYNAMIC: CLAUDE.md + git status + date]        ← no cache││
│  ├─────────────────────────────────────────────────────────────┤│
│  │  Tool Definitions (active / deferred via ToolSearch)        ││
│  ├─────────────────────────────────────────────────────────────┤│
│  │  CLAUDE.md + Memory Files                                   ││
│  ├─────────────────────────────────────────────────────────────┤│
│  │  Conversation Messages                                      ││
│  │                                                             ││
│  │    ┌── compact_boundary ──────────┐                         ││
│  │    │  summary + recovered files   │ ← compact 起点          ││
│  │    └──────────────────────────────┘                         ││
│  │    ... recent messages ...                                  ││
│  │    [cache breakpoint]  ← penultimate user message           ││
│  │    ... latest messages ...                                  ││
│  │    [cache breakpoint]  ← last user message                  ││
│  │                                                             ││
│  ├─────────────────────────────────────────────────────────────┤│
│  │  Auto-compact Buffer (13K tokens)                           ││
│  ├─────────────────────────────────────────────────────────────┤│
│  │  Output Token Space (up to 128K for Opus 4-6)               ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘

Auto-Compact 触发条件:
  current_tokens >= effective_window - 13K
  where effective_window = context_window - min(max_output, 20K)

Example (200K model):
  effective_window = 200000 - 20000 = 180000
  threshold        = 180000 - 13000 = 167000
  current ≥ 167K → trigger auto-compact
```
