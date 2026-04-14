
# 第 25 章：配置、凭据与 Profiles

> **核心问题**：分层配置如何工作？多密钥轮换的 Credential Pool 如何设计？

---

## 25.1 配置系统架构

- 源锚：`hermes_cli/config.py`
- config.yaml 的分层加载：默认值 → 全局配置 → 项目配置 → 环境变量 → CLI 参数

> TODO: 配置加载的优先级链

---

## 25.2 config.yaml 详解

- 核心配置项分类
- 模型配置
- 工具配置
- 安全配置

> TODO: 配置项完整参考

---

## 25.3 Credential Pool

- 源锚：`agent/credential_pool.py`
- 多 API Key 管理
- 状态追踪：`STATUS_OK` / `STATUS_EXHAUSTED`
- 认证类型：`AUTH_TYPE_OAUTH` / `AUTH_TYPE_API_KEY`

> TODO: Credential Pool 的状态转换图

---

## 25.4 Profiles

- 多 Profile 支持
- Profile 切换与继承
- 源锚：`hermes_cli/auth.py`

> TODO: Profile 的定义与切换机制

---

## 25.5 认证配置

- API Key 配置
- OAuth 配置
- 源锚：`hermes_cli/auth.py`

> TODO: 认证流程的完整步骤

---

## 速查表

| 文件 | 角色 |
|------|------|
| `hermes_cli/config.py` | 配置系统 |
| `agent/credential_pool.py` | 凭据池管理 |
| `hermes_cli/auth.py` | 认证配置 |
