
# 第 14 章：Browser 自动化与 MCP 协议

> **核心问题**：基于 Accessibility Tree 的无视觉浏览器操控如何工作？MCP 协议的 stdio/HTTP 双传输如何连接？

---

## 14.1 Browser 工具架构

- 源锚：`tools/browser_tool.py`（2,387 行）
- `agent-browser` CLI 工具集成
- ariaSnapshot — Accessibility Tree 快照

> TODO: 浏览器工具的操作模型

---

## 14.2 三种浏览器后端

- Local — 本地 Playwright
- Browserbase — 云浏览器
- BrowserUse — 第三方集成
- 源锚：`tools/browser_providers/`

> TODO: 各后端的适用场景与配置

---

## 14.3 Accessibility Tree 驱动

- ariaSnapshot 的生成与解析
- 无视觉操控的优势与限制

> TODO: ariaSnapshot 格式与元素定位

---

## 14.4 MCP 协议概览

- Model Context Protocol — 开放式工具扩展
- 源锚：`tools/mcp_tool.py`（2,195 行）

> TODO: MCP 协议的核心概念

---

## 14.5 stdio 与 HTTP 双传输

- stdio 传输 — 本地进程通信
- HTTP/SSE 传输 — 远程服务连接
- 源锚：`tools/mcp_tool.py`

> TODO: 双传输的实现差异

---

## 14.6 OAuth 2.1 与 Sampling

- OAuth 2.1 PKCE 认证流程
- Sampling — MCP 服务端向 Agent 发起 LLM 请求

> TODO: OAuth 和 Sampling 的协议流程

---

## 14.7 动态工具代理

- MCP 服务暴露的工具自动注册为 Agent 工具
- 源锚：`tools/mcp_tool.py`

> TODO: 动态工具注册的机制

---

## 速查表

| 文件 | 角色 |
|------|------|
| `tools/browser_tool.py` | 浏览器自动化主逻辑 |
| `tools/browser_providers/` | 浏览器后端实现 |
| `tools/mcp_tool.py` | MCP 客户端（stdio + HTTP） |
