
# 第 11 章：Toolset 代数与工具分类

> **核心问题**：40+ 工具如何分组？Toolset 的代数组合与 `resolve_toolset()` 图展开如何工作？

---

## 11.1 核心工具清单

- `_HERMES_CORE_TOOLS` — 核心工具列表
- 源锚：`toolsets.py`

> TODO: 完整核心工具列表

---

## 11.2 TOOLSETS 字典

- 命名工具集的定义与组合
- 源锚：`toolsets.py` — `TOOLSETS` dict

> TODO: 所有 Toolset 的定义与包含关系

---

## 11.3 resolve_toolset() 图展开

- 源锚：`toolsets.py` — `resolve_toolset()`
- 递归展开嵌套 Toolset 引用
- 去重与排序

> TODO: 图展开算法的伪代码

---

## 11.4 resolve_multiple_toolsets()

- 多 Toolset 合并
- 源锚：`toolsets.py` — `resolve_multiple_toolsets()`

> TODO: 合并策略

---

## 11.5 工具集与运行模态的关系

- CLI / Gateway / ACP / Batch 各使用哪些 Toolset

> TODO: 模态 × Toolset 矩阵

---

## 速查表

| 文件 | 角色 |
|------|------|
| `toolsets.py` | Toolset 定义与解析 |
| `model_tools.py` | 工具集到 Schema 的转换 |
