
# 第 23 章：Cron 调度与 ACP 集成

> **核心问题**：定时任务如何跨平台投递？IDE 集成的 ACP 协议如何工作？

---

## 23.1 Cron 调度器

- 源锚：`cron/scheduler.py`
- `tick()` — 60 秒心跳
- 文件锁并发控制
- `SILENT_MARKER` — 静默标记
- `_KNOWN_DELIVERY_PLATFORMS` — 投递平台列表

> TODO: 调度器的心跳循环与任务匹配

---

## 23.2 定时任务配置

- 源锚：`cron/jobs.py`
- Cron 表达式解析
- 任务持久化

> TODO: 任务定义格式与生命周期

---

## 23.3 跨平台投递

- 定时触发 → 选择投递平台 → 发送消息
- 源锚：`cron/scheduler.py`

> TODO: 投递流程的完整数据流

---

## 23.4 ACP 协议与 IDE 集成

- 源锚：`acp_adapter/`
- Agent Communication Protocol
- VS Code / Zed / JetBrains 集成
- `hermes-acp` 入口点

> TODO: ACP 协议的消息格式与通信流程

---

## 速查表

| 文件 | 角色 |
|------|------|
| `cron/scheduler.py` | 定时任务调度器 |
| `cron/jobs.py` | 任务定义与管理 |
| `acp_adapter/entry.py` | ACP 服务器入口 |
