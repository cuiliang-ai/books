
# 第 20 章：封闭学习循环 — 自我进化的闭环

> **核心问题**：Skill 自动创建 → 使用中改进 → 记忆持久化 → Session 召回的完整闭环如何运作？

---

## 20.1 学习循环总览

```
解决新问题
    ↓
自动创建 Skill (skills_tool)
    ↓
持久化到 MEMORY.md (memory_tool)
    ↓
下次会话召回 (session_search)
    ↓
激活相关 Skill
    ↓
改进已有 Skill
    ↓
再次持久化...
```

> TODO: 闭环的完整数据流图

---

## 20.2 学习触发机制

- 成功完成任务后的 Skill 提炼
- 失败后的经验记录

> TODO: 触发条件的判断逻辑

---

## 20.3 知识积累与淘汰

- Skill 使用频率追踪
- 过时 Skill 的淘汰机制

> TODO: 知识生命周期管理

---

## 20.4 自进化的边界

- 当前能力边界与限制
- 安全约束下的自改进

> TODO: 自进化的设计哲学与安全考量

---

## 速查表

| 文件 | 角色 |
|------|------|
| `tools/skills_tool.py` | Skill 创建与管理 |
| `tools/memory_tool.py` | 记忆持久化 |
| `tools/session_search_tool.py` | 跨会话召回 |
| `agent/memory_manager.py` | 记忆编排 |
