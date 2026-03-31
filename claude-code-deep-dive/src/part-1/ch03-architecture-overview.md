
# 第 3 章：架构总览

> **核心问题**：一个由 19 个反编译模块、40+ 工具、多层安全防线组成的 Coding Agent，整体架构是什么样的？在深入每一个子系统之前，我们需要一张完整的地图。

一座城市如果没有地图，你只能在街巷中摸索。Claude Code 的代码库也是如此 — 70 万行反混淆代码分布在 19 个模块中，包含 Agentic Loop、工具系统、权限引擎、流式 API 客户端、多智能体协作、终端 UI 等十多个子系统。如果直接跳入某个模块的细节，很容易迷失在函数调用链中。

本章是整本书的"地图"。我们将从最高层的系统全景开始，逐层拆解 Claude Code 的架构分层、六大核心子系统、一个请求的完整数据流、19 个模块的依赖关系，最后预览贯穿全系统的设计哲学。读完本章后，你将拥有一个清晰的导航框架 — 无论后续深入哪一章，都能准确定位"我在看什么、它属于哪一层、它和其他部分如何协作"。

---

## 3.1 系统全景图

Claude Code 的整体架构可以从上到下分为七个层次。每一层解决一类特定的问题，层与层之间通过明确的接口交互：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                     USER LAYER  [用户层]                            │   │
│   │                                                                     │   │
│   │   Terminal UI (Ink/React)    CLI Arguments    REPL / One-shot       │   │
│   │   ├─ 50+ React Components   ├─ --print       ├─ Interactive Mode   │   │
│   │   ├─ 6 Themes               ├─ --dangerously  ├─ Conversation      │   │
│   │   ├─ Keybinding Engine      │   -skip-perms   │   History          │   │
│   │   └─ Streaming Markdown     └─ --model        └─ Session Resume    │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                       │                                     │
│                                       ▼                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                   COMMAND LAYER  [命令层]                           │   │
│   │                                                                     │   │
│   │   Slash Commands (/commit /model /review ...)                      │   │
│   │   ├─ 20+ Built-in Commands                                         │   │
│   │   ├─ Skill System (YAML-defined AI workflows)                      │   │
│   │   └─ MCP Prompts (server-provided prompts)                         │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                       │                                     │
│                                       ▼                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                     CORE LAYER  [核心层]                            │   │
│   │                                                                     │   │
│   │   Agentic Loop              System Prompt          Context Mgmt    │   │
│   │   ├─ async generator        ├─ 15 prompt types     ├─ L1 Replace   │   │
│   │   ├─ streaming pipeline     ├─ CLAUDE.md inject    ├─ L2 Micro     │   │
│   │   ├─ tool dispatch          ├─ cache partitioning  ├─ L3 Auto      │   │
│   │   └─ multi-layer retry      └─ dynamic assembly    │   Compact     │   │
│   │                                                     └─ Token est.  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                       │                                     │
│                                       ▼                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                   CAPABILITY LAYER  [能力层]                        │   │
│   │                                                                     │   │
│   │   Built-in Tools (40+)                  MCP Protocol               │   │
│   │   ├─ File I/O: Read/Write/Edit/Glob/   ├─ 6 config sources        │   │
│   │   │           Grep/NotebookEdit        ├─ 7 transport types        │   │
│   │   ├─ Execution: Bash                    ├─ Tools/Prompts/Resources │   │
│   │   ├─ Web: WebFetch/WebSearch            └─ Dynamic registration    │   │
│   │   ├─ Agent: Agent/Worktree/PlanMode                                │   │
│   │   └─ VCS: Git integration                                          │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                       │                                     │
│                                       ▼                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                   SECURITY LAYER  [安全层]                          │   │
│   │                                                                     │   │
│   │   Permission Engine         Sandbox              Hooks System      │   │
│   │   ├─ 5-layer cascade        ├─ macOS Seatbelt    ├─ 5 lifecycle    │   │
│   │   ├─ deny-first rules       ├─ Linux Landlock    │   events        │   │
│   │   ├─ 5 permission modes     ├─ Docker isolation  ├─ Pre/Post tool  │   │
│   │   └─ runtime persistence    └─ Network + FS      └─ Programmable   │   │
│   │                                  restriction         interception  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                       │                                     │
│                                       ▼                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                 COLLABORATION LAYER  [协作层]                       │   │
│   │                                                                     │   │
│   │   Sub-Agent           Fork              Team                       │   │
│   │   ├─ Independent ctx  ├─ Inherited ctx  ├─ Independent processes   │   │
│   │   ├─ Task delegation  ├─ Shared cache   ├─ Bidirectional messaging │   │
│   │   └─ Nestable         └─ Cheap parallel └─ Shared task list        │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                       │                                     │
│                                       ▼                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                 COMMUNICATION LAYER  [通信层]                       │   │
│   │                                                                     │   │
│   │   API Client (Multi-Provider)           SSE Streaming              │   │
│   │   ├─ First-Party (Anthropic)            ├─ SseDecoder byte-level   │   │
│   │   ├─ AWS Bedrock (SigV4)                ├─ MessageStream events    │   │
│   │   ├─ Google Vertex (GoogleAuth)         ├─ AsyncIterator protocol  │   │
│   │   ├─ Azure Foundry (AzureAD)            └─ Content block yield     │   │
│   │   └─ Retry + Backoff + Rate Limit                                  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

> **设计决策**：七层架构中，核心层（Agentic Loop + System Prompt + Context Management）是整个系统的"心脏"，但它本身不直接与外界交互 — 向上通过命令层和用户层接收输入，向下通过能力层操作真实世界，旁边通过安全层约束行为。这种"核心无副作用、边界做脏活"的设计，使得 Agentic Loop 可以保持简洁的流式状态机模型，而不被 I/O、安全检查等关注点污染。

理解这张全景图的关键在于：**每一层只关心自己的职责**。用户层不知道 API 用的是 Anthropic 还是 Bedrock，能力层不关心安全规则是 deny 还是 allow，通信层不在乎消息会显示在终端还是管道输出。这种职责分离是 Claude Code 能在 70 万行代码规模下保持可维护性的基础。

---

## 3.2 六大子系统概述

全景图中的七层可以进一步归纳为六个核心子系统。每个子系统在后续章节中都有专门的深度分析，这里我们只做"导游式"的介绍 — 说明它解决什么问题、核心设计理念是什么、在哪些章节会详细展开。

### 3.2.1 Agentic Loop — Agent 的心跳

**解决的问题**：如何让一个 LLM 从"一问一答"进化为"自主执行多步任务直至完成"？

Agentic Loop 是 Claude Code 最核心的子系统。它本质上是一个**流式 async generator 状态机**，驱动着"调用 API → 解析响应 → 执行工具 → 回注结果 → 继续"的循环，直到模型认为任务完成或资源耗尽。

三个关键入口函数构成了 Loop 的执行链：

```
av() (agentExecute)      — 最外层入口，准备模型、上下文、System Prompt
  └→ zC() (agentLoop)    — 注入 UserContext，启动主循环
      └→ xi1() (mainLoop) — 真正的循环体，6 个 Phase 逐步推进
```

Agentic Loop 的设计精髓在于**流水线式并行** — API 流式输出还在进行时，已完成的 tool_use block 就开始执行了。这使得 Agent 的执行效率远超"先全部生成、再逐个执行"的朴素模式。

> 详细分析见 [第 4 章：Agentic Loop — Agent 的心跳](part-2/ch04-agentic-loop.md)

### 3.2.2 工具系统 — Agent 的执行臂

**解决的问题**：LLM 只能生成文本，如何让它"动手"操作文件、执行命令、搜索代码、访问网络？

工具系统是连接 LLM 思维与真实世界的桥梁。Claude Code 内置了 40+ 工具，分为四大类：

| 类别 | 代表工具 | 能力 |
|------|---------|------|
| **文件 I/O** | Read, Write, Edit, Glob, Grep | 精确的文件读写与搜索 |
| **命令执行** | Bash | 任意 Shell 命令，带沙箱隔离 |
| **网络** | WebFetch, WebSearch | URL 抓取与网络搜索 |
| **扩展** | MCP Tools | 通过 MCP 协议动态接入外部工具 |

每个工具都遵循统一的 `ToolDefinition` 接口 — 声明 `name`、`description`、`input_schema`，实现 `call()` 方法。工具调用通过 Anthropic Messages API 的 `tool_use` / `tool_result` 协议闭环。一个亮点是**并发安全调度** — 只读工具（Read、Glob、Grep）可以并行执行，写入工具（Write、Edit、Bash）串行执行，兼顾性能与安全。

> 详细分析见 [第 8 章：工具系统总论](part-3/ch08-tool-system.md)、[第 9 章：Bash 工具](part-3/ch09-bash-tool.md)、[第 10 章：File I/O 工具族](part-3/ch10-file-io-tools.md)、[第 11 章：Git 集成](part-3/ch11-git-integration.md)、[第 12 章：MCP 协议](part-3/ch12-mcp-protocol.md)

### 3.2.3 安全体系 — Agent 的行为围栏

**解决的问题**：一个拥有 Bash 执行权限的 Agent，如何做到"该做的自动做，不该做的绝不做"？

Claude Code 的安全体系由三道防线组成，形成**纵深防御**：

```
第一道防线：权限系统 (应用层)
  ├─ 5 层级联配置 (user → project → local → flag → policy)
  ├─ deny-first 规则引擎
  └─ 5 种权限模式 (default/plan/acceptEdits/auto/bypass)

第二道防线：沙箱 (操作系统层)
  ├─ macOS: Seatbelt (sandbox-exec)
  ├─ Linux: Landlock + Seccomp
  └─ 文件系统 + 网络双重限制

第三道防线：Hooks (可编程拦截)
  ├─ 5 个生命周期事件 (SessionStart/PreToolUse/PostToolUse/Notification/Stop)
  └─ 用户自定义审计、拦截、修改逻辑
```

三道防线各司其职：权限系统做"逻辑检查"（这条命令是否在白名单中），沙箱做"物理隔离"（即使命令绕过检查也无法越界），Hooks 做"可编程增强"（执行前格式化检查、执行后日志审计）。

> 详细分析见 [第 13 章：配置与权限系统](part-4/ch13-config-permission.md)、[第 14 章：Sandbox 安全沙箱](part-4/ch14-sandbox.md)、[第 15 章：Hooks 系统](part-4/ch15-hooks-system.md)

### 3.2.4 多智能体协作 — Agent 的分身术

**解决的问题**：当任务复杂到单个 Agent 效率低下时，如何将工作分解给多个协作单元？

Claude Code 提供了三层递进的协作模式：

- **Sub-Agent**：最简单的委派 — 创建一个独立上下文的子 Agent 执行特定任务，完成后结果返回
- **Fork**：继承父 Agent 完整上下文的"分叉" — 共享 Prompt Cache，适合廉价并行
- **Team**：完整的多智能体系统 — 独立进程、双向通信、共享任务列表、存活到显式 shutdown

三层模式覆盖了从"帮我查一下这个函数"到"并行重构 5 个模块"的全部协作场景。每一层都在上下文隔离、通信开销和灵活性之间做了不同的取舍。

> 详细分析见 [第 16 章：Sub-Agent 与 Team — 多智能体协作](part-4/ch16-subagent-team.md)

### 3.2.5 上下文管理 — Agent 的有限记忆

**解决的问题**：在有限的 Context Window（200K tokens）内，如何在长时间会话中保持对任务的完整理解？

这是 Coding Agent 最独特的挑战。一次代码重构可能涉及 20+ 文件、30+ 轮工具调用，产生的上下文远超窗口容量。Claude Code 用三层递进策略应对：

- **L1 Content Replacement**：工具结果原地替换（如截断过长输出），零成本持续运行
- **L2 Microcompact**：局部压缩单条消息（利用 cache_edits），低成本按需触发
- **L3 Auto-Compact**：全局摘要压缩（消耗一次完整 API 调用），仅在阈值触发时执行

三层策略体现了"渐进式降级" — 轻量方案能解决的不用重量方案，能局部处理的不做全局处理。配合精确的 token 估算和 Prompt Cache 机制，在信息保持和成本控制之间取得平衡。

> 详细分析见 [第 7 章：Context 管理 — 有限记忆的艺术](part-2/ch07-context-management.md)

### 3.2.6 Terminal UI — Agent 的交互界面

**解决的问题**：如何在传统终端中提供"Web 级"的交互体验 — 流式 Markdown、彩色 diff、动画、主题？

Claude Code 选择了 **Ink（React for CLI）** 作为 UI 框架，将 Web 开发中的组件化、声明式更新引入终端渲染。基于 Ink 构建了 50+ 自定义 React 组件、60+ 语义颜色键、6 套主题（含色盲友好变体）、类 Vim chord 快捷键系统。

UI 层的核心挑战是**流式渲染** — 模型通过 SSE 逐 token 输出，UI 需要在不完整的 Markdown 上做增量渲染和语法高亮。React 的 VDOM diffing 天然适合"只重绘变化部分"的场景，这是选择 Ink 而非传统 ncurses 的关键原因。

> 详细分析见 [第 18 章：Terminal UI — 终端渲染引擎](part-4/ch18-terminal-ui.md)

---

## 3.3 数据流：一个请求的完整旅程

理解架构不仅要知道"有哪些模块"，更要知道"数据如何流动"。让我们跟踪一个典型请求 — 用户输入 `帮我把 UserService 重构为单例模式` — 从键盘按下到最终响应的完整路径。

```
用户键入: "帮我把 UserService 重构为单例模式" [Enter]

[1] INPUT CAPTURE
    │
    │  Terminal UI (Ink/React)
    │  ├─ TextInput 组件捕获输入
    │  ├─ 检查 "/" 前缀 → 非 slash command → 普通消息
    │  └─ 创建 user message: { role: "user", content: "..." }
    │
    ▼
[2] AGENT ENTRY
    │
    │  av() (agentExecute)
    │  ├─ 确定模型: claude-sonnet-4-20250514
    │  ├─ 收集上下文: 工作目录、git 状态、环境
    │  ├─ 构建 System Prompt: 静态段 + CLAUDE.md + 工具描述 + 动态段
    │  ├─ 创建 toolUseContext: 可用工具列表 + 权限配置
    │  └─ 调用 zC() (agentLoop)
    │
    ▼
[3] CONTEXT PREPROCESSING ─────────────────────────────────────────────┐
    │                                                                   │
    │  xi1() (mainLoop) Phase 1                                         │
    │  ├─ c07(): Content Replacement (截断过长的工具结果)                 │
    │  ├─ fd(): Microcompact (如果有 cache_edits 可压缩的消息)           │
    │  └─ y19(): AutoCompact (如果 token 使用超过阈值, 触发全局摘要)      │
    │                                                                   │
    ▼                                                                   │
[4] API CALL                                                            │
    │                                                                   │
    │  xi1() Phase 2                                                    │
    │  ├─ kyH() (callModel): 构建 messages + tools 参数                 │
    │  ├─ dh() (createClient): 选择 Provider (firstParty/bedrock/...)   │
    │  ├─ TH8() (vcrWrapper): 可选录制/回放                             │
    │  └─ Ly9() (processSSEStream): 开始流式接收                        │
    │       │                                                           │
    │       ▼                                                           │
    │  SSE 字节流                                                       │
    │  ├─ m2H (SseDecoder): 字节 → SSE 事件                             │
    │  ├─ QbH (MessageStream): SSE → 结构化 content blocks              │
    │  └─ AsyncIterator: for await (const block of stream)              │
    │                                                                   │
    ▼                                                                   │
[5] STREAM PARSING & UI RENDERING (并行)                                │
    │                                                                   │
    │  每个 content block 通过 yield 推送:                                │
    │                                                                   │
    │  ┌─ text block ──────┐    ┌─ tool_use block ──────────────┐      │
    │  │ "我来帮你重构..."  │    │ name: "Grep"                  │      │
    │  │       │            │    │ input: {pattern:"UserService"}│      │
    │  │       ▼            │    │       │                       │      │
    │  │  UI: 流式 Markdown │    │       ▼                       │      │
    │  │  渲染 + 语法高亮   │    │  进入工具执行管线              │      │
    │  └───────────────────┘    └───────────────────────────────┘      │
    │                                                                   │
    ▼                                                                   │
[6] TOOL EXECUTION                                                      │
    │                                                                   │
    │  Phase 4: 工具分发与执行                                           │
    │  ├─ Ye6() (checkPermission): 权限检查                              │
    │  │   ├─ 规则匹配: Grep → 内置只读工具 → 自动允许                    │
    │  │   └─ (若需要用户确认 → UI 弹出权限对话框)                        │
    │  ├─ PreToolUse Hooks: 执行前拦截 (如有配置)                        │
    │  ├─ Tool.call(): 执行 Grep 搜索                                   │
    │  ├─ PostToolUse Hooks: 执行后拦截                                  │
    │  └─ 构建 tool_result: { tool_use_id, content, is_error }          │
    │                                                                   │
    ▼                                                                   │
[7] RESULT INJECTION & CONTINUE                                         │
    │                                                                   │
    │  Phase 5-6: 回注结果 → 检查 maxTurns → 组装下一轮                  │
    │  ├─ 将 tool_result 追加到 messages 数组                            │
    │  ├─ turnCount++ → 未超过 maxTurns → continue                      │
    │  └─ 回到 Phase 1, 开始下一轮循环                                   │
    │                                                                   │
    │  ... (Agent 可能执行 5-20 轮: Grep → Read → Edit → Bash → ...)    │
    │                                                                   │
    ▼                                                                   │
[8] TERMINATION                                                         │
    │                                                                   │
    │  Phase 3: 终止判断                                                 │
    │  ├─ 模型响应不含 tool_use → 判定任务完成                            │
    │  ├─ Stop Hooks 检查 (如有配置, 验证任务是否真的完成)                │
    │  └─ 返回最终 assistant message                                     │
    │                                                                   │
    ▼                                                                   │
[9] OUTPUT                                                              │
    │                                                                   │
    │  Terminal UI                                                      │
    │  ├─ 渲染最终回答 (Markdown → 语法高亮 → ANSI 输出)                 │
    │  ├─ 显示 Token 使用量 + 成本                                       │
    │  └─ 等待用户下一次输入 → 回到 [1]                                   │
    │                                                                   │
    └───────────────────────────────────────────────────────────────────┘
```

这个流程揭示了几个重要的架构特征：

1. **流式贯穿**：从 SSE 字节流到 UI 渲染，没有任何"等待全部完成再处理"的环节。text block 实时渲染，tool_use block 完成即执行。
2. **安全检查内嵌**：权限检查和 Hooks 拦截不是独立的"安全网关"，而是嵌入在工具执行管线内部，每次工具调用都会经过。
3. **上下文是活的**：每一轮循环开始前都会做 Content Replacement 和可能的压缩，上下文在持续演化，不是静态累积。
4. **终止是模型决定的**：Agent 不是"执行完预定步骤就停止"，而是模型自行判断"任务完成了"才停止（除非被 maxTurns 或资源限制强制终止）。

---

## 3.4 模块依赖关系：19 个反编译模块的阅读地图

Claude Code 的 npm 包打包后是一个压缩的 JavaScript 文件，反编译后可拆分为 19 个功能模块。理解它们之间的依赖关系，能帮助你在阅读源码时建立上下文 — 知道一个函数来自哪个模块、它可能调用哪些其他模块的函数。

### 模块一览表

| # | 模块名 | 功能领域 | 对应章节 |
|---|--------|---------|---------|
| 01 | `runtime_bootstrap` | 运行时启动、环境检测、Node polyfills | — |
| 02 | `api_client` | Anthropic SDK、HTTP 客户端、Provider 路由 | [第 5 章](part-2/ch05-api-client.md) |
| 03 | `file_system` | 文件操作工具 (Read/Write/Edit/Glob/Grep) | [第 10 章](part-3/ch10-file-io-tools.md) |
| 04 | `git_operations` | Git 集成与版本控制 | [第 11 章](part-3/ch11-git-integration.md) |
| 05 | `config_settings` | 配置系统 (5 层级联设置) | [第 13 章](part-4/ch13-config-permission.md) |
| 06 | `permission_system` | 权限引擎、deny-first 规则、模式切换 | [第 13 章](part-4/ch13-config-permission.md) |
| 07 | `crypto_encoding` | 加密编码、token 加密、安全通信 | — |
| 08 | `system_prompt` | System Prompt 核心构建逻辑 | [第 6 章](part-2/ch06-system-prompt.md) |
| 09 | `data_processing` | 通用数据处理、颜色定义、token 估算 | [第 7 章](part-2/ch07-context-management.md) |
| 10 | `tool_bash` | Bash 工具实现、沙箱集成 | [第 9 章](part-3/ch09-bash-tool.md) |
| 11 | `api_streaming` | SSE 流式解码、MessageStream | [第 5 章](part-2/ch05-api-client.md) |
| 12 | `computer_use` | 计算机使用 (屏幕截图、鼠标/键盘操作) | — |
| 13 | `ui_rendering` | Ink/React UI 组件 (70K+ 行) | [第 18 章](part-4/ch18-terminal-ui.md) |
| 14 | `html_parser` | HTML 解析 (WebFetch 结果处理) | — |
| 15 | `hooks_system` | Hooks 生命周期、AppState 管理 | [第 15 章](part-4/ch15-hooks-system.md) |
| 16 | `commands_slash` | Slash 命令、Skill 系统 | [第 17 章](part-4/ch17-slash-commands.md) |
| 17 | `system_prompt_full` | 完整 System Prompt 文本 (1 万+ token) | [第 6 章](part-2/ch06-system-prompt.md) |
| 18 | `sdk_examples` | SDK 使用示例、工具描述模板 | — |
| 19 | `tail` | 尾部初始化、入口点绑定 | — |

### 模块依赖图

```
                    ┌──────────┐
                    │    01    │
                    │ runtime  │
                    │bootstrap │
                    └────┬─────┘
                         │ (foundation: polyfills, env detection)
          ┌──────────────┼──────────────┬──────────────────┐
          ▼              ▼              ▼                  ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐        ┌──────────┐
    │    05    │  │    07    │  │    09    │        │    14    │
    │  config  │  │  crypto  │  │  data   │        │  html   │
    │ settings │  │ encoding │  │processing│        │ parser  │
    └────┬─────┘  └────┬─────┘  └────┬─────┘        └──────────┘
         │              │              │
         ▼              │              ▼
    ┌──────────┐        │        ┌──────────┐
    │    06    │        │        │    08    │
    │permission│        │        │  system  │
    │  system  │        │        │  prompt  │
    └────┬─────┘        │        └────┬─────┘
         │              │              │
         │       ┌──────┘              ▼
         │       │             ┌──────────┐
         │       │             │    17    │
         │       │             │  system  │
         │       │             │prompt_ful│
         │       │             └──────────┘
         │       │
         ▼       ▼
    ┌──────────────────┐
    │   02 + 11        │
    │  api_client +    │
    │  api_streaming   │
    └────────┬─────────┘
             │
    ┌────────┴─────────────────────────────────────────┐
    │              CORE AGENTIC INFRASTRUCTURE          │
    │                                                   │
    │  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
    │  │    03    │  │    04    │  │    10    │       │
    │  │file_sys  │  │   git   │  │tool_bash │       │
    │  │  tools   │  │   ops   │  │          │       │
    │  └──────────┘  └──────────┘  └──────────┘       │
    │                                                   │
    │  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
    │  │    12    │  │    15    │  │    16    │       │
    │  │computer  │  │  hooks  │  │commands  │       │
    │  │  use     │  │ system  │  │  slash   │       │
    │  └──────────┘  └──────────┘  └──────────┘       │
    │                                                   │
    └──────────────────────┬───────────────────────────┘
                           │
                           ▼
                    ┌──────────┐       ┌──────────┐
                    │    13    │──────→│    19    │
                    │    UI    │       │   tail   │
                    │rendering │       │  (entry) │
                    └──────────┘       └──────────┘
```

### 阅读策略建议

基于这张依赖图，我们推荐三种阅读路径：

**路径 A：自顶向下（理解用户体验）**
```
第 18 章 (UI) → 第 17 章 (Slash 命令) → 第 4 章 (Agentic Loop)
→ 第 8 章 (工具系统) → 第 5 章 (API Client)
```

**路径 B：自底向上（理解实现机制）**
```
第 5 章 (API Client) → 第 4 章 (Agentic Loop) → 第 6 章 (System Prompt)
→ 第 7 章 (Context) → 第 8-12 章 (工具) → 第 13-15 章 (安全)
```

**路径 C：按兴趣跳读（推荐）**
```
先读第 4 章 (Agentic Loop, 理解心跳) → 然后跳到你最感兴趣的子系统
每章都是相对独立的，有明确的前置知识说明
```

> **设计决策**：模块 13（`ui_rendering`）是最庞大的单一模块（70000+ 行），因为 Ink/React 组件天然需要大量布局和样式代码。而模块 17（`system_prompt_full`）虽然只包含一份 System Prompt 文本，却单独成模块 — 这是因为它在运行时被当作静态资源加载，与构建它的逻辑（模块 08）分离，符合"代码与配置分离"的原则。

---

## 3.5 数据结构枢纽：贯穿系统的关键类型

在深入各子系统之前，了解几个贯穿全系统的核心数据结构会让后续阅读更顺畅：

### Messages — 对话的基本单元

整个系统围绕 `messages` 数组运转。它是 Anthropic Messages API 的核心数据结构，也是 Agentic Loop 的状态载体：

```javascript
// The central data structure flowing through the entire system
messages = [
    { role: "user", content: "..." },           // user input
    { role: "assistant", content: [             // LLM response
        { type: "text", text: "..." },           //   text block
        { type: "tool_use", id: "...",           //   tool call
          name: "Read", input: {...} }
    ]},
    { role: "user", content: [                  // tool result (injected)
        { type: "tool_result",
          tool_use_id: "...",
          content: "..." }
    ]},
    // ... more turns
]
```

### ToolDefinition — 工具的统一接口

每个工具都实现这个接口，使 Agentic Loop 可以统一管理 40+ 工具：

```javascript
// Unified interface for all tools (built-in + MCP)
{
    name: "Read",
    description: "Reads a file from the local filesystem...",
    input_schema: { /* JSON Schema */ },
    isReadOnly: () => true,          // concurrency safety flag
    isEnabled: () => true,           // dynamic enable/disable
    call: async (input) => result,   // execution entry point
    needsPermission: (input) => ...  // permission check
}
```

### Usage — Token 的五维计量

精确的 token 计量贯穿了 API 调用、上下文压缩、成本显示三个子系统：

```javascript
// 5-dimensional token usage tracking
{
    input_tokens: 5000,              // prompt tokens consumed
    output_tokens: 800,              // generation tokens consumed
    cache_creation_input_tokens: 0,  // new cache entries created
    cache_read_input_tokens: 4200,   // cache hits
    server_tool_use: { ... }         // server-side tool usage
}
```

这三个数据结构 — `messages`（状态）、`ToolDefinition`（能力）、`usage`（计量） — 是串联六大子系统的"血管"。在后续章节中，你会反复遇到它们。

---

## 3.6 设计哲学预览

在深入每个子系统的实现之前，值得先了解贯穿整个 Claude Code 的几个核心设计原则。这些原则不是抽象的教条 — 你会在后续每一章中看到它们的具体体现。

### 安全第一 (Security First)

**一句话**：任何功能设计都从"如果被滥用会怎样"开始思考。

权限系统的 deny-first 规则、沙箱的操作系统级隔离、Hooks 的生命周期拦截 — 三道防线不是"加上去的"，而是从第一天就内置在架构中。Bash 工具不是一个简单的 `exec()` 封装加上安全检查，而是**安全约束就是工具本身的一部分**。

### 渐进式信任 (Progressive Trust)

**一句话**：默认不信任，通过用户交互逐步建立信任。

第一次执行 `git push` 会弹出权限对话框，用户选择 "Always allow" 后这个决定被持久化。从 default 模式到 auto-accept 模式，用户可以根据自己的信任级别选择不同的权限模式。系统不假设用户信任 Agent — 信任是一步步赢得的。

### 流式处理 (Streaming First)

**一句话**：永远不等待"全部完成" — 有一部分数据就处理一部分。

SSE 字节流逐 token 解码、content block 完成即 yield 给 UI 和工具执行、Markdown 在不完整状态下增量渲染。整个从 API 到 UI 的管线是一个 `async function*` 驱动的流式管道，没有任何"buffer everything then process"的环节。

### 依赖注入 (Dependency Injection)

**一句话**：核心逻辑不直接依赖具体实现，而是通过参数接收依赖。

`av()` (agentExecute) 接收一个巨大的参数对象，包含模型选择、工具列表、权限配置、回调函数。这使得同一个 Agentic Loop 可以驱动主查询（完整工具集）、Sub-Agent 查询（受限工具集）和自动紧凑查询（无工具），而无需为每种场景写不同的循环。

### 优雅降级 (Graceful Degradation)

**一句话**：任何一个环节失败，都不应该让整个系统崩溃。

API 调用失败有 3 层重试（指数退避 + 抖动），Context 超限有 3 级压缩（替换 → 局部 → 全局），模型输出不完整有恢复提示注入，工具执行超时有清理机制。每种故障场景都有专门的恢复策略，而不是一个通用的 `try-catch` 兜底。

---

## 小结

本章从七个维度建立了 Claude Code 的全局认知：

| 维度 | 你了解到了什么 |
|------|-------------|
| **系统分层** | 七层架构（用户 → 命令 → 核心 → 能力 → 安全 → 协作 → 通信） |
| **六大子系统** | Agentic Loop、工具系统、安全体系、多智能体、上下文管理、Terminal UI |
| **数据流** | 一个请求从键盘输入到终端输出的 9 步完整路径 |
| **模块依赖** | 19 个反编译模块的功能划分与依赖关系 |
| **核心数据结构** | messages、ToolDefinition、usage 三个贯穿全系统的枢纽类型 |
| **设计哲学** | 安全第一、渐进式信任、流式处理、依赖注入、优雅降级 |

你现在拥有了一张完整的地图。从下一章开始，我们将沿着这张地图深入每一个子系统。第 4 章将首先打开 Claude Code 最核心的模块 — Agentic Loop，拆解这颗"心脏"的每一个零件。

> **给急性子读者的建议**：如果你已经等不及想看代码了，直接跳到 [第 4 章：Agentic Loop](part-2/ch04-agentic-loop.md) — 它是理解所有其他章节的基础。如果你对某个特定子系统更感兴趣（比如"Agent 的安全是怎么做的"），可以按 3.4 节的路径 C 直接跳到对应章节。每一章都在开头标注了前置知识依赖。
