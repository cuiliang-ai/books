# Claude Code 源码深度解析

> **基于 Claude Code 原始 TypeScript 源码的架构深度解析 — 不再是反编译猜测，而是直面真实代码**

Claude Code 是 Anthropic 推出的终端 AI 编程助手。它不只是一个"能写代码的 LLM"，而是一个**完整的 Agentic 系统** — 拥有循环推理、工具调用、安全沙箱、多智能体协作等工业级能力。

本书基于 Claude Code 的**原始 TypeScript 源码**进行逐层拆解，揭示这个系统的真实架构。

---

## 与前作的区别

本书是 [《Claude Code Deep Dive》](https://github.com/cuiliang-ai/books)的**全面升级版**。核心区别如下：

| 维度 | 前作（反编译版） | 本书（源码版） |
|------|----------------|--------------|
| **分析对象** | 打包混淆后的 `main.mjs`（~503K 行） | 原始 TypeScript 源码（`src/` 目录） |
| **命名** | 混淆名 + 推测语义名，如 `av()` (agentExecute) | 真实文件名/函数名，如 `query()` in `query.ts` |
| **结构理解** | 手工拆分 19 个模块，边界靠猜测 | 真实目录结构，模块边界清晰 |
| **准确度** | 语义推测可能有误 | 直接阅读原始代码，100% 准确 |
| **深度** | 受混淆限制，部分细节无法解读 | 可深入任意实现细节 |
| **打包方式** | 基于 npm + esbuild 时期 | 基于 Bun 运行时 + `bun:bundle` feature flags |

> **设计决策**：Anthropic 已将 Claude Code 从 npm/Node.js 分发切换到 **Bun 独立二进制**分发。TypeScript 源码通过 `bun build --compile` 编译为独立可执行文件，运行时为 Bun（JavaScriptCore 引擎）。这意味着代码中随处可见的 `import { feature } from 'bun:bundle'` 是编译期条件编译的核心机制，在打包时会被静态求值，实现 dead code elimination。

---

## 本书结构

全书分为 **5 篇**，从入门概览到核心架构、工具系统、安全机制，最终到实战与展望：

### 第一篇 · 入门

| 章节 | 主题 | 核心问题 |
|------|------|----------|
| [第 1 章](part-1/ch01-what-is-claude-code.md) | 什么是 Claude Code | 它与 Copilot/Cursor 的本质区别是什么？ |
| [第 2 章](part-1/ch02-installation-packaging.md) | 安装与打包 | 从 TypeScript 源码到独立二进制，经历了什么？ |
| [第 3 章](part-1/ch03-architecture-overview.md) | 架构总览 | 七层架构如何协作？一个请求的完整数据流？ |

### 第二篇 · 核心架构

| 章节 | 主题 | 核心问题 |
|------|------|----------|
| 第 4 章 | Agentic Loop | `query()` 如何驱动 Agent 持续推理直到完成？ |
| 第 5 章 | API Client | 流式通信如何稳定处理 token 级响应？ |
| 第 6 章 | System Prompt | 行为指令如何动态组装、因地制宜？ |
| 第 7 章 | Context 管理 | 200K 上下文窗口如何智能分配？ |

### 第三篇 · 工具与能力

| 章节 | 主题 | 核心问题 |
|------|------|----------|
| 第 8 章 | 工具系统总论 | 40+ 工具如何统一注册、调度、执行？ |
| 第 9 章 | Bash 工具 | 最强大也最危险的能力如何驯服？ |
| 第 10 章 | File I/O 工具族 | 文件操作如何做到精确可控？ |
| 第 11 章 | Git 集成 | 版本控制如何深度融入 Agent 工作流？ |
| 第 12 章 | MCP 协议 | 开放式工具扩展如何实现？ |

### 第四篇 · 安全与扩展

| 章节 | 主题 | 核心问题 |
|------|------|----------|
| 第 13 章 | 配置与权限系统 | 如何实现渐进式信任？ |
| 第 14 章 | Sandbox 安全沙箱 | 纵深防御体系如何构建？ |
| 第 15 章 | Hooks 系统 | 生命周期拦截点如何设计？ |
| 第 16 章 | Sub-Agent 与 Team | 多智能体如何协作？ |
| 第 17 章 | Slash 命令与 Skill | 用户扩展入口如何实现？ |
| 第 18 章 | Terminal UI | 终端渲染引擎如何工作？ |

### 第五篇 · 实战与展望

| 章节 | 主题 |
|------|------|
| 第 19 章 | 设计哲学 |
| 第 20 章 | 构建你的 Agent |
| 第 21 章 | 关键实现挑战 |
| 第 22 章 | 未来展望 |

---

## 源码目录速览

本书分析的源码位于 `src/` 目录下，以下是核心目录结构：

```
src/
├── main.tsx                  # CLI 主入口（Commander.js 参数解析 + 启动序列）
├── query.ts                  # Agentic Loop 核心（query() 循环）
├── QueryEngine.ts            # 查询引擎（SDK/headless 模式入口）
├── Tool.ts                   # Tool 接口定义与 ToolUseContext
├── tools.ts                  # 工具注册表（getAllBaseTools / getTools）
├── commands.ts               # Slash 命令注册表（90+ 命令）
├── Task.ts                   # 后台任务抽象
├── components/               # React/Ink UI 组件（App, REPL, MessageList...）
├── tools/                    # 40+ 工具实现
│   ├── BashTool/             #   Bash 执行 + 沙箱
│   ├── FileReadTool/         #   文件读取
│   ├── FileEditTool/         #   文件编辑
│   ├── FileWriteTool/        #   文件写入
│   ├── GlobTool/             #   文件搜索
│   ├── GrepTool/             #   内容搜索
│   ├── AgentTool/            #   子 Agent + 多智能体
│   ├── WebFetchTool/         #   URL 抓取
│   ├── WebSearchTool/        #   网络搜索
│   └── ...                   #   更多工具
├── services/                 # 服务层
│   ├── api/                  #   API 客户端（claude.ts, client.ts, withRetry.ts）
│   ├── mcp/                  #   MCP 协议（config, client, types）
│   ├── compact/              #   上下文压缩（auto, micro, snip）
│   ├── analytics/            #   遥测分析
│   └── ...
├── utils/                    # 工具函数
│   ├── permissions/          #   权限引擎
│   ├── sandbox/              #   沙箱适配器
│   ├── hooks/                #   Hooks 系统
│   ├── model/                #   模型选择与配置
│   └── ...
├── state/                    # 应用状态管理（AppState, store）
├── entrypoints/              # 入口点（cli, mcp, init）
├── bridge/                   # 远程桥接（Claude Desktop 集成）
├── commands/                 # Slash 命令实现（90+ 命令目录）
└── skills/                   # Skill 系统（YAML 定义的 AI 工作流）
```

---

## 阅读约定

本书基于**原始 TypeScript 源码**分析，使用真实的文件名、函数名、类名。标注格式如下：

> `query()` in `src/query.ts` — Agentic Loop 核心函数

- **前者**（`query()`）是源码中的**真实函数名**
- **后者**（`src/query.ts`）是**真实文件路径**

代码引用示例：

```typescript
// src/query.ts — Agentic Loop 核心循环
export async function* query(params: QueryParams): AsyncGenerator<...> {
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  return terminal
}
```

每章末尾的**速查表**汇总了该章涉及的所有关键文件和函数。

### `feature()` 编译开关约定

源码中大量使用 `import { feature } from 'bun:bundle'` 进行条件编译：

```typescript
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? require('./services/compact/reactiveCompact.js')
  : null
```

`feature()` 在编译时被静态求值为 `true` 或 `false`，用于：
- **Dead code elimination**：外部构建中排除内部功能
- **Feature flags**：控制实验性功能的开启/关闭
- **构建变体**：区分 `ant`（内部）和 `external`（外部）构建

本书中提及 feature flag 时会标注 `[feature: FLAG_NAME]`。

## 阅读建议

- **快速了解**：先读第 3 章（架构总览），建立全局地图
- **深入核心**：接着读第 4 章（Agentic Loop），理解 Agent 的心跳
- **按篇阅读**：每篇相对独立，可根据兴趣选择
- **源码对照**：每章都附有真实源码引用和速查表，建议边读边对照 `src/` 目录

## 关于

- **作者**：[Liang Cui](https://cuiliang.ai/about/)
- **分析对象**：Claude Code 原始 TypeScript 源码
- **源码**：[GitHub](https://github.com/cuiliang-ai/books)
- **状态**：持续更新中

---

## 声明

> **⚠️ 本书仅供学习和研究目的使用。**

- **知识产权**：Claude Code 是 [Anthropic](https://www.anthropic.com/) 公司的产品，其源代码及相关知识产权归 Anthropic 所有。本书引用的代码片段仅用于说明架构原理，版权归原权利人所有。
- **非官方**：本书为独立的第三方研究作品，未经 Anthropic 公司授权、赞助或认可。
- **商标**：Claude、Claude Code、Anthropic 均为 Anthropic 公司的商标或注册商标，本书中的使用仅为描述性引用，不暗示任何关联或背书。
- **合理使用**：本书的分析属于为研究和教学目的对软件架构的学术性探讨，符合合理使用 (Fair Use) 原则。
- **范围限制**：本书不提供完整源码，仅引用必要的代码片段用于技术分析和教学。
- **免责**：本书内容仅供参考，不构成任何形式的技术建议或保证。
- **配合处理**：如权利人对本书内容有异议，作者将积极配合处理。联系邮箱：cuiliang05@gmail.com
