
# 第 9 章：错误分类、限流与路由降级

> **核心问题**：当 LLM API 返回错误时，自动 failover 如何工作？限流如何处理？

---

## 9.1 错误分类体系

- HTTP 状态码分类：4xx vs 5xx
- 可重试 vs 不可重试错误
- 源锚：`run_agent.py` — 错误处理逻辑

> TODO: 错误分类决策树

---

## 9.2 限流（Rate Limiting）处理

- 429 Too Many Requests
- Retry-After 头解析
- 指数退避策略

> TODO: 限流处理流程

---

## 9.3 自动 Failover

- Credential Pool 的状态转换
- `STATUS_EXHAUSTED` 触发凭据轮换
- 多 Provider 降级链

> TODO: failover 状态机图

---

## 9.4 模型降级策略

- strong → cheap 模型降级
- Provider 间降级（OpenAI → Anthropic → OpenRouter）

> TODO: 降级策略的配置与触发条件

---

## 速查表

| 文件 | 角色 |
|------|------|
| `agent/credential_pool.py` | 凭据池与 failover |
| `agent/smart_model_routing.py` | 模型路由降级 |
| `run_agent.py` | 错误处理主逻辑 |
