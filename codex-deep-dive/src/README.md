[← 返回书架](https://book.cuiliang.ai/)

# Codex CLI Deep Dive — 源码深度解析

> **一本以源码为依据的技术深度解析，带你走进 OpenAI Codex CLI 的每一个架构细节。**

## 这本书是什么

这是一本关于 [OpenAI Codex CLI](https://github.com/openai/codex) 的源码级技术解析。Codex CLI 是 OpenAI 推出的开源终端 AI 编程助手，采用 Rust + TypeScript 混合架构，具备多平台沙箱安全、丰富的工具系统、Ratatui 终端 UI、JSON-RPC 应用服务器等特性。

本书不是用户手册，而是**面向开发者和架构师的源码导读**。每一章都从 Codex CLI 的真实代码出发，解析其设计决策、实现细节和架构权衡。

## 目标读者

- 对 AI Agent 架构感兴趣的开发者
- 想要理解 Codex CLI 内部工作原理的用户
- 正在构建类似系统的架构师
- 对 Rust 系统编程和终端应用开发感兴趣的工程师

## 全书结构

| 篇章 | 主题 | 章节 |
|------|------|------|
| **第一篇** | 入门 | 什么是 Codex CLI、安装与打包、架构总览 |
| **第二篇** | 核心架构 | Agentic Loop、API Client、System Prompt、Context 管理 |
| **第三篇** | 工具与能力 | 工具系统总论、Shell 工具、File I/O、Skill 系统 |
| **第四篇** | 安全与扩展 | 配置权限、多平台 Sandbox、Terminal UI、App Server、多 Agent |
| **第五篇** | 实战与展望 | 设计哲学、SDK 体系、与 Claude Code 对比 |

## 基于的代码版本

本书基于 Codex CLI 开源仓库的源码分析。代码仓库：`https://github.com/openai/codex`

---

## 关于

- **作者**：[Liang Cui](https://cuiliang.ai/about/)
- **分析对象**：OpenAI Codex CLI 开源源码
- **状态**：持续更新中

---

## 声明

> **⚠️ 本书仅供学习和研究目的使用。**

- **知识产权**：Codex CLI 是 [OpenAI](https://openai.com/) 的开源项目，采用 Apache 2.0 许可证。本书引用的代码片段版权归原权利人所有。
- **非官方**：本书为独立的第三方研究作品，未经 OpenAI 公司授权、赞助或认可。
- **商标**：OpenAI、Codex 均为 OpenAI 公司的商标或注册商标，本书中的使用仅为描述性引用，不暗示任何关联或背书。
- **免责**：本书内容仅供参考，不构成任何形式的技术建议或保证。
- **配合处理**：如权利人对本书内容有异议，作者将积极配合处理。联系邮箱：cuiliang05@gmail.com
