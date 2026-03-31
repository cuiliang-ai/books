# Claude Code Deep Dive

> **Claude Code v2.1.86 架构深度解析 — 从反编译源码出发，逐层拆解核心机制**

Claude Code 是 Anthropic 推出的 AI 编程助手，它不只是一个"能写代码的 LLM"，而是一个**完整的 Agentic 系统** — 拥有循环推理、工具调用、安全沙箱、多智能体协作等工业级能力。

本书通过对 Claude Code v2.1.86 反编译源码的逐层拆解，揭示这个系统的真实架构。

---

## 本书结构

全书分为 **5 篇 22 章**，从入门概览到核心架构、工具系统、安全机制，最终到实战与展望：

### [第一篇 · 入门](part-1/ch01-what-is-claude-code.md)

| 章节 | 主题 |
|------|------|
| [第 1 章](part-1/ch01-what-is-claude-code.md) | 什么是 Claude Code |
| [第 2 章](part-1/ch02-installation-packaging.md) | 安装与打包 |
| [第 3 章](part-1/ch03-architecture-overview.md) | 架构总览 |

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

## 阅读约定

本书基于反编译源码分析，代码经过混淆处理，原始函数名已丢失。全书采用以下标注格式：

> `av()` (agentExecute)

- **前者**（`av()`）是反编译后的**混淆名**，即源码中的真实标识符
- **后者**（agentExecute）是根据函数行为**推测的语义名**

这种标注贯穿全书，帮助读者同时对照混淆源码和理解函数意图。每章末尾的**速查表**汇总了该章涉及的所有函数映射。

## 阅读建议

- **快速了解**：先读第 4 章（Agentic Loop），理解 Agent 的核心运行机制
- **按篇阅读**：每篇相对独立，可根据兴趣选择
- **深入研究**：每章都附有完整的源码引用和速查表，可作为源码阅读的索引

## 关于

- **作者**：[Liang Cui](https://cuiliang.ai/about/)
- **分析版本**：Claude Code v2.1.86
- **源码**：[GitHub](https://github.com/cuiliang-ai/books)
- **状态**：持续更新中（18/22 章已完成）

---

## 声明

> **⚠️ 本书仅供学习和研究目的使用。**

- **知识产权**：Claude Code 是 [Anthropic](https://www.anthropic.com/) 公司的产品，其源代码及相关知识产权归 Anthropic 所有。本书引用的代码片段仅用于说明架构原理，版权归原权利人所有。
- **商标**：Claude、Claude Code、Anthropic 均为 Anthropic 公司的商标或注册商标，本书中的使用仅为描述性引用，不暗示任何关联或背书。
- **范围限制**：本书不提供完整的反编译源码，仅引用必要的代码片段用于技术分析和教学。
- **合规**：本书不鼓励读者自行逆向任何商业软件，请遵守相关软件的最终用户许可协议 (EULA) 及适用法律法规。
- **配合处理**：如权利人对本书内容有异议，作者将积极配合处理。联系方式见 [关于页面](https://cuiliang.ai/about/)。
