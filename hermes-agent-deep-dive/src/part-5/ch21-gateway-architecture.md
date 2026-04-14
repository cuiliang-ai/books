
# 第 21 章：Gateway 架构与 GatewayRunner

> **核心问题**：一个 Agent 进程如何同时服务 15 个消息平台？GatewayRunner 的核心设计？

---

## 21.1 Gateway 概览

- 源锚：`gateway/run.py`（8,982 行）
- 单进程多平台架构
- 异步事件循环驱动

> TODO: Gateway 的整体架构图

---

## 21.2 GatewayRunner 类

- 核心字段与初始化
- 平台适配器的加载与启动
- SSL 证书自动检测
- 源锚：`gateway/run.py` — `class GatewayRunner`

> TODO: GatewayRunner 的初始化流程

---

## 21.3 消息路由

- 入站消息 → 平台适配器 → AIAgent
- AIAgent 响应 → 平台适配器 → 出站消息

> TODO: 消息路由的完整数据流

---

## 21.4 会话管理

- 多用户并发会话
- 会话隔离与状态管理
- 源锚：`gateway/run.py`

> TODO: 并发会话的设计

---

## 21.5 配置桥接

- Gateway 配置到 AIAgent 配置的映射
- 源锚：`gateway/run.py` — 配置桥接逻辑

> TODO: 配置桥接的字段映射

---

## 速查表

| 文件 | 角色 |
|------|------|
| `gateway/run.py` | GatewayRunner 主逻辑 |
| `gateway/platforms/base.py` | 平台适配器基类 |
