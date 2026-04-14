
# 第 8 章：消息模型、API 适配与流式

> **核心问题**：多模型 API 如何统一抽象？Anthropic 适配器的特殊处理是什么？

---

## 8.1 消息格式统一

- OpenAI Chat Completions 格式为基础
- role: system / user / assistant / tool
- 源锚：`run_agent.py` — 消息构造

> TODO: 统一消息格式详解

---

## 8.2 Anthropic Messages API 适配器

- 源锚：`agent/anthropic_adapter.py`
- `THINKING_BUDGET` — 思考预算
- `_ANTHROPIC_OUTPUT_LIMITS` — 输出限制
- Messages API 与 Chat Completions 的格式转换

> TODO: 适配器转换逻辑详解

---

## 8.3 Credential Pool 与多模型切换

- 源锚：`agent/credential_pool.py`
- `STATUS_OK` / `STATUS_EXHAUSTED`
- `AUTH_TYPE_OAUTH` / `AUTH_TYPE_API_KEY`
- 自动 failover 机制

> TODO: 凭据池状态机与 failover 流程

---

## 8.4 Smart Model Routing

- 源锚：`agent/smart_model_routing.py`
- `_COMPLEX_KEYWORDS` — 复杂度关键词检测
- `choose_cheap_model_route()` — cheap/strong 模型路由

> TODO: 路由决策逻辑详解

---

## 8.5 流式输出处理

- SSE 流式 token 输出
- 工具调用的流式检测

> TODO: 流式处理的技术细节

---

## 速查表

| 文件 | 角色 |
|------|------|
| `agent/anthropic_adapter.py` | Anthropic API 适配器 |
| `agent/credential_pool.py` | 多凭据池管理 |
| `agent/smart_model_routing.py` | cheap/strong 路由 |
| `hermes_cli/auth.py` | 认证配置 |
