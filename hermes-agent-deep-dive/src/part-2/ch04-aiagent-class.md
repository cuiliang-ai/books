
# 第 4 章：AIAgent 类全貌

> **核心问题**：AIAgent 的构造参数、状态字段和生命周期是怎样的？它是如何被实例化和配置的？

---

## 4.1 类签名与构造参数

- 源锚：`run_agent.py` — `class AIAgent`
- 构造参数超过 30 个，涵盖模型、工具集、安全、记忆等维度

> TODO: 完整构造参数表与分类

---

## 4.2 核心状态字段

- `messages: list` — 会话消息历史
- `tools: dict` — 已注册工具映射
- `iteration_budget: IterationBudget` — 迭代预算控制
- 源锚：`run_agent.py` — `IterationBudget` dataclass

> TODO: 状态字段完整清单与生命周期

---

## 4.3 AIAgent 的实例化路径

- CLI 路径：`HermesCLI` → `AIAgent()`
- Gateway 路径：`GatewayRunner` → `AIAgent()`
- ACP 路径：`acp_adapter` → `AIAgent()`

> TODO: 不同入口点的参数差异矩阵

---

## 4.4 生命周期管理

- 创建 → 配置 → run_conversation() → 清理
- 源锚：`run_agent.py`

> TODO: 生命周期时序图

---

## 4.5 辅助类

- `IterationBudget` — 迭代次数预算
- `_SafeWriter` — 安全输出写入器
- 源锚：`run_agent.py`

> TODO: 辅助类详解

---

## 速查表

| 文件 | 角色 |
|------|------|
| `run_agent.py` | AIAgent 类定义 |
| `cli.py` | CLI 实例化路径 |
| `gateway/run.py` | Gateway 实例化路径 |
| `acp_adapter/entry.py` | ACP 实例化路径 |
