# Claude Code Deep Dive

> **Claude Code v2.1.86 架构深度解析 — 从反编译源码出发，逐层拆解核心机制**

Claude Code 是 Anthropic 推出的 AI 编程助手，它不只是一个"能写代码的 LLM"，而是一个**完整的 Agentic 系统** — 拥有循环推理、工具调用、安全沙箱、多智能体协作等工业级能力。

本书通过对 Claude Code v2.1.86 反编译源码的逐层拆解，揭示这个系统的真实架构。不是猜测，不是黑盒分析，而是直接从代码出发，理解每一个设计决策背后的工程智慧。

---

## 本书结构

全书分为 **5 篇 22 章**，从入门概览到核心架构、工具系统、安全机制，最终到实战与展望：

### 第一篇 · 入门（编写中）

| 章节 | 主题 |
|------|------|
| 第 1 章 | 什么是 Claude Code |
| 第 2 章 | 安装与打包 |
| 第 3 章 | 架构总览 |

### [第二篇 · 核心架构](part-2/ch04-agentic-loop.md)

| 章节 | 主题 | 核心问题 |
|------|------|----------|
| [第 4 章](part-2/ch04-agentic-loop.md) | Agentic Loop | Agent 如何持续推理直到任务完成？ |
| [第 5 章](part-2/ch05-api-client.md) | API Client | 流式通信如何稳定地处理 token 级响应？ |
| [第 6 章](part-2/ch06-system-prompt.md) | System Prompt | 行为指令如何动态组装、因地制宜？ |
| [第 7 章](part-2/ch07-context-management.md) | Context 管理 | 128K 上下文窗口如何智能分配？ |

### [第三篇 · 工具与能力](part-3/ch08-tool-system.md)

| 章节 | 主题 | 核心问题 |
|------|------|----------|
| [第 8 章](part-3/ch08-tool-system.md) | 工具系统总论 | 40+ 工具如何统一注册、调度、执行？ |
| [第 9 章](part-3/ch09-bash-tool.md) | Bash 工具 | 最强大也最危险的能力如何驯服？ |
| [第 10 章](part-3/ch10-file-io-tools.md) | File I/O 工具族 | 文件操作如何做到精确可控？ |
| [第 11 章](part-3/ch11-git-integration.md) | Git 集成 | 版本控制如何深度融入 Agent 工作流？ |
| [第 12 章](part-3/ch12-mcp-protocol.md) | MCP 协议 | 开放式工具扩展如何实现？ |

### [第四篇 · 安全与扩展](part-4/ch13-config-permission.md)

| 章节 | 主题 | 核心问题 |
|------|------|----------|
| [第 13 章](part-4/ch13-config-permission.md) | 配置与权限系统 | 如何实现渐进式信任？ |
| [第 14 章](part-4/ch14-sandbox.md) | Sandbox 安全沙箱 | 纵深防御体系如何构建？ |
| [第 15 章](part-4/ch15-hooks-system.md) | Hooks 系统 | 生命周期拦截点如何设计？ |
| [第 16 章](part-4/ch16-subagent-team.md) | Sub-Agent 与 Team | 多智能体如何协作？ |
| [第 17 章](part-4/ch17-slash-commands.md) | Slash 命令与 Skill | 用户扩展入口如何实现？ |
| [第 18 章](part-4/ch18-terminal-ui.md) | Terminal UI | 终端渲染引擎如何工作？ |

### 第五篇 · 实战与展望（编写中）

| 章节 | 主题 |
|------|------|
| 第 19 章 | 设计哲学 |
| 第 20 章 | 构建你的 Agent |
| 第 21 章 | 关键实现挑战 |
| 第 22 章 | 未来展望 |

---

## 阅读建议

- **快速了解**：先读第 4 章（Agentic Loop），理解 Agent 的核心运行机制
- **按篇阅读**：每篇相对独立，可根据兴趣选择
- **深入研究**：每章都附有完整的源码引用和速查表，可作为源码阅读的索引

## 关于

- **作者**：[Liang Cui](https://cuiliang.ai)
- **分析版本**：Claude Code v2.1.86
- **源码**：[GitHub](https://github.com/cuiliang-ai/books)
- **状态**：持续更新中（15/22 章已完成）
