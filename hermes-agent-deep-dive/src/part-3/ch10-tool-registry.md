
# 第 10 章：Tool Registry 与发现链

> **核心问题**：工具如何自注册？ToolRegistry 的单例模式与 ToolEntry 的设计？

---

## 10.1 ToolRegistry 单例

- 源锚：`tools/registry.py` — `class ToolRegistry`
- 全局单例模式
- 线程安全考虑

> TODO: 单例实现与初始化流程

---

## 10.2 ToolEntry 数据结构

- 10 个 `__slots__` 字段：
  - `name`, `toolset`, `schema`, `handler`
  - `check_fn`, `requires_env`, `is_async`
  - `description`, `emoji`, `max_result_size_chars`
- 源锚：`tools/registry.py` — `class ToolEntry`

> TODO: 每个字段的语义与使用场景

---

## 10.3 工具自注册模式

- 装饰器 / 模块级注册
- import 链的反循环设计
- 源锚：`tools/registry.py` — 注册 API

> TODO: 自注册模式的代码示例

---

## 10.4 工具发现与过滤

- 按 Toolset 过滤
- 按 `check_fn` 动态可用性检查
- 按 `requires_env` 环境依赖过滤

> TODO: 发现链的完整流程

---

## 10.5 工具 Schema 生成

- JSON Schema 格式的工具描述
- 参数验证

> TODO: Schema 生成与验证机制

---

## 速查表

| 文件 | 角色 |
|------|------|
| `tools/registry.py` | ToolRegistry 单例 + ToolEntry |
| `model_tools.py` | 工具发现与分发 |
