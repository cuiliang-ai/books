
# 第 30 章：设计哲学与同类对比

> **核心问题**：Hermes Agent 的设计哲学是什么？与 Claude Code、Aider、Cursor 等工具相比有何本质区别？

---

## 30.1 设计哲学

- 自进化优先 — 从经验中学习
- 多模型无锁定 — Provider 自由切换
- 多平台统一 — 一个 Agent 多个前端
- 研究就绪 — RL 训练与评估基础设施

> TODO: 核心设计原则的深入分析

---

## 30.2 与 Claude Code 对比

| 维度 | Hermes Agent | Claude Code |
|------|-------------|-------------|
| 语言 | Python | TypeScript/Bun |
| 学习能力 | Skills + Memory 闭环 | 无自进化 |
| 模型支持 | 10+ Provider | 仅 Anthropic |
| 平台支持 | CLI + 15 平台 | CLI + IDE |

> TODO: 深入对比分析

---

## 30.3 与 Aider 对比

| 维度 | Hermes Agent | Aider |
|------|-------------|-------|
| 定位 | 通用 AI Agent | Git-aware 编程 |
| 学习能力 | 自进化闭环 | 无持久记忆 |

> TODO: 定位差异分析

---

## 30.4 与 Cursor 对比

| 维度 | Hermes Agent | Cursor |
|------|-------------|--------|
| 形态 | CLI + 多平台 | IDE |
| 开源 | MIT 开源 | 商业产品 |

> TODO: 商业 vs 开源的取舍

---

## 30.5 架构取舍

- Python 单仓的优势与代价
- 227K 行代码的可维护性
- 插件化 vs 内聚的平衡

> TODO: 架构决策的深入讨论

---

## 速查表

| 文件 | 角色 |
|------|------|
| `README.md` | 产品定位 |
| `AGENTS.md` | 开发指南 |
| `RELEASE_v0.*.md` | 版本演进 |
