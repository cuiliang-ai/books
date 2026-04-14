
# 第 17 章：Memory 系统 — MEMORY.md 与 USER.md

> **核心问题**：MEMORY.md 和 USER.md 的冻结快照模式如何工作？插件化记忆后端如何协作？

---

## 17.1 Memory 工具

- 源锚：`tools/memory_tool.py`
- MEMORY.md — Agent 自身的学习记忆
- USER.md — 用户偏好与信息
- `§` 分隔符格式

> TODO: MEMORY.md / USER.md 的格式规范

---

## 17.2 MemoryManager 架构

- 源锚：`agent/memory_manager.py`
- Builtin 记忆（MEMORY.md + USER.md）
- 一个外部 Provider 插槽
- `sanitize_context()` — 记忆内容净化
- `build_memory_context_block()` — 组装记忆上下文

> TODO: MemoryManager 的完整流程

---

## 17.3 MemoryProvider 抽象

- 源锚：`agent/memory_provider.py`
- 抽象基类定义
- `store()`, `retrieve()`, `search()` 接口

> TODO: Provider 接口的完整定义

---

## 17.4 注入检测

- `_MEMORY_THREAT_PATTERNS` — 记忆注入威胁检测
- 源锚：`tools/memory_tool.py`

> TODO: 记忆写入的安全防护

---

## 17.5 可插拔记忆后端

- 8 种外部插件：Honcho / Holographic / mem0 / ByteRover / Hindsight / RetainDB / SuperMemory / OpenViking
- 源锚：`plugins/memory/`

> TODO: 各插件的特点与集成方式

---

## 速查表

| 文件 | 角色 |
|------|------|
| `tools/memory_tool.py` | Memory 工具（MEMORY.md + USER.md） |
| `agent/memory_manager.py` | MemoryManager 编排器 |
| `agent/memory_provider.py` | MemoryProvider 抽象基类 |
| `plugins/memory/` | 8 种外部记忆插件 |
