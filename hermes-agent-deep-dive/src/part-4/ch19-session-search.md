
# 第 19 章：Session Search 与跨会话召回

> **核心问题**：FTS5 全文检索 + LLM 摘要如何实现跨会话的长期记忆？

---

## 19.1 Session Search 工具

- 源锚：`tools/session_search_tool.py`
- 搜索历史会话内容
- `MAX_SESSION_CHARS = 100_000`

> TODO: 搜索工具的接口与参数

---

## 19.2 FTS5 全文检索

- SQLite FTS5 虚拟表
- 分词与排名算法
- 源锚：`hermes_state.py` — FTS5 表定义

> TODO: FTS5 的索引构建与查询语法

---

## 19.3 LLM 辅助摘要

- 搜索结果 → LLM 摘要生成
- 相关性过滤与排序

> TODO: 摘要生成的 Prompt 与流程

---

## 19.4 跨会话召回流程

- 查询构建 → FTS5 检索 → 结果过滤 → LLM 摘要 → 注入上下文

> TODO: 完整召回流程的时序图

---

## 速查表

| 文件 | 角色 |
|------|------|
| `tools/session_search_tool.py` | Session Search 工具 |
| `hermes_state.py` | FTS5 全文检索引擎 |
