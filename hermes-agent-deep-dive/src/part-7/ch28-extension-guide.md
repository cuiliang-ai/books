
# 第 28 章：扩展实战 — 新增工具、平台与后端

> **核心问题**：如何为 Hermes Agent 添加新工具、新消息平台适配器、新终端后端？

---

## 28.1 新增工具

- 步骤：定义 Schema → 实现 Handler → 注册到 ToolRegistry → 加入 Toolset
- 源锚：`tools/registry.py`

> TODO: 完整的工具开发指南与示例

---

## 28.2 新增平台适配器

- 步骤：继承 BasePlatformAdapter → 实现抽象方法 → 注册到 GatewayRunner
- 源锚：`gateway/platforms/base.py`

> TODO: 平台适配器开发指南

---

## 28.3 新增终端后端

- 步骤：继承 BaseEnvironment → 实现执行方法 → 注册到 terminal_tool
- 源锚：`tools/environments/base.py`

> TODO: 终端后端开发指南

---

## 28.4 新增记忆插件

- 步骤：实现 MemoryProvider → 注册到 MemoryManager
- 源锚：`agent/memory_provider.py`

> TODO: 记忆插件开发指南

---

## 28.5 新增 Skill

- SKILL.md 格式
- 发布到 Skills Hub
- 源锚：`skills/`

> TODO: Skill 开发与发布指南

---

## 速查表

| 文件 | 角色 |
|------|------|
| `tools/registry.py` | 工具注册 |
| `gateway/platforms/base.py` | 平台适配器基类 |
| `tools/environments/base.py` | 终端后端基类 |
| `agent/memory_provider.py` | 记忆插件基类 |
