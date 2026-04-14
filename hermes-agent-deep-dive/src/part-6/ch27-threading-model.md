
# 第 27 章：同步异步桥接与线程模型

> **核心问题**：同步代码与异步 IO 如何桥接？model_tools 的双事件循环设计为什么必要？

---

## 27.1 同步-异步桥接问题

- Python 的 asyncio 限制
- 同步工具 handler 调用异步 API
- 源锚：`model_tools.py` — `_run_async()`

> TODO: 桥接问题的技术背景

---

## 27.2 双事件循环设计

- `_get_tool_loop()` — 工具事件循环
- `_get_worker_loop()` — 工作线程事件循环
- 源锚：`model_tools.py`

> TODO: 双循环的创建与生命周期

---

## 27.3 线程模型

- 主线程：CLI / Gateway 事件循环
- 工具执行线程：ThreadPoolExecutor
- MCP 后台线程：专用事件循环

> TODO: 线程模型的完整图示

---

## 27.4 并发安全

- 工具执行的并发控制
- 共享状态的保护策略

> TODO: 并发安全的设计决策

---

## 速查表

| 文件 | 角色 |
|------|------|
| `model_tools.py` | 同步-异步桥接 |
| `run_agent.py` | 主循环线程 |
| `tools/mcp_tool.py` | MCP 后台事件循环 |
