
# 第 16 章：会话存储 SessionDB

> **核心问题**：SQLite + FTS5 的持久化存储如何设计？Schema 版本迁移如何工作？

---

## 16.1 SessionDB 类

- 源锚：`hermes_state.py` — `class SessionDB`
- SQLite + WAL 模式
- `SCHEMA_VERSION = 6`

> TODO: SessionDB 的初始化与连接管理

---

## 16.2 数据库 Schema

- sessions 表 — 会话元数据
- messages 表 — 消息历史
- FTS5 虚拟表 — 全文搜索索引

> TODO: 完整 Schema 定义

---

## 16.3 WAL 模式与并发

- Write-Ahead Logging 的优势
- 单写多读模式

> TODO: WAL 模式的配置与限制

---

## 16.4 Schema 迁移

- 版本 1→6 的迁移历史
- 自动迁移机制

> TODO: 迁移脚本与向后兼容

---

## 16.5 会话序列化

- 消息的存储与恢复
- 工具调用结果的持久化

> TODO: 序列化格式与压缩

---

## 速查表

| 文件 | 角色 |
|------|------|
| `hermes_state.py` | SessionDB — SQLite 状态存储 |
