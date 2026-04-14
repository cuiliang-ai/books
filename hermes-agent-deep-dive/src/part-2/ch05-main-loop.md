
# 第 5 章：主循环解剖

> **核心问题**：`run_conversation()` 的完整时序是什么？迭代预算如何控制循环终止？

---

## 5.1 run_conversation() 总览

- 源锚：`run_agent.py:7544` — `run_conversation()`
- 核心循环：消息组装 → LLM 调用 → 工具执行 → 结果注入 → 判断终止

> TODO: 完整伪代码与时序图

---

## 5.2 迭代预算机制

- `IterationBudget` — 最大迭代次数、工具调用计数
- 源锚：`run_agent.py` — `IterationBudget`

> TODO: 预算耗尽时的行为分析

---

## 5.3 工具调用分发

- 串行 vs 并行执行决策
- `_should_parallelize_tool_batch()` — 并行安全判断
- `_PARALLEL_SAFE_TOOLS` / `_PATH_SCOPED_TOOLS`
- 源锚：`run_agent.py`

> TODO: 并行工具执行的详细流程

---

## 5.4 流式响应处理

- 流式 token 输出
- 工具调用的流式检测与分发

> TODO: 流式处理详解

---

## 5.5 循环终止条件

- 自然结束（无工具调用）
- 预算耗尽
- 用户中断
- 错误累积

> TODO: 终止条件决策树

---

## 速查表

| 文件 | 角色 |
|------|------|
| `run_agent.py` | `run_conversation()` 主循环 |
| `model_tools.py` | 工具分发桥接层 |
