
# 第 13 章：文件操作与 Web 工具族

> **核心问题**：文件 CRUD 与 fuzzy patch 如何实现？Web 搜索/提取的多后端策略是什么？

---

## 13.1 文件工具概览

- 源锚：`tools/file_tools.py`
- CRUD 操作：create_file, read_file, update_file, delete_file
- fuzzy patch — 模糊匹配的文件修补

> TODO: 文件工具的完整 API 与 fuzzy patch 算法

---

## 13.2 Fuzzy Patch 机制

- 模糊行匹配
- 上下文感知的补丁应用

> TODO: fuzzy patch 的匹配算法与容错设计

---

## 13.3 Web 搜索工具

- 多后端策略：Exa / Firecrawl / Parallel / Tavily
- 源锚：`tools/web_tools.py`（2,103 行）

> TODO: 各搜索后端的特点与选择逻辑

---

## 13.4 Web 内容提取

- URL 抓取与内容解析
- Markdown 转换
- 源锚：`tools/web_tools.py`

> TODO: 内容提取的处理流水线

---

## 13.5 路径安全

- 源锚：`tools/path_security.py`
- 路径遍历防护

> TODO: 路径安全检查的实现

---

## 速查表

| 文件 | 角色 |
|------|------|
| `tools/file_tools.py` | 文件 CRUD + fuzzy patch |
| `tools/web_tools.py` | Web 搜索与内容提取 |
| `tools/path_security.py` | 路径安全检查 |
