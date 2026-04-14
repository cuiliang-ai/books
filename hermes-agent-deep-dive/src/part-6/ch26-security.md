
# 第 26 章：安全纵深

> **核心问题**：命令审批、路径安全、注入防御的三层安全纵深如何设计？

---

## 26.1 安全模型概览

- 三层防御：命令审批 → 路径安全 → 注入检测
- 渐进式信任

> TODO: 安全模型的整体架构图

---

## 26.2 危险命令审批

- 源锚：`tools/approval.py`
- 危险命令检测
- per-session 审批状态
- Smart Approval — 辅助 LLM 判断

> TODO: 审批流程的完整决策树

---

## 26.3 路径安全

- 源锚：`tools/path_security.py`
- 路径遍历防护
- 敏感文件保护

> TODO: 路径安全检查的规则集

---

## 26.4 Prompt 注入防御

- 系统提示注入检测：`_CONTEXT_THREAT_PATTERNS`
- 记忆注入检测：`_MEMORY_THREAT_PATTERNS`
- 源锚：`agent/prompt_builder.py`, `tools/memory_tool.py`

> TODO: 注入检测的模式列表与响应策略

---

## 26.5 沙箱执行

- Docker / Singularity 隔离
- PTC 沙箱的 SANDBOX_ALLOWED_TOOLS
- 源锚：`tools/environments/`, `tools/code_execution_tool.py`

> TODO: 沙箱的隔离边界

---

## 速查表

| 文件 | 角色 |
|------|------|
| `tools/approval.py` | 危险命令审批 |
| `tools/path_security.py` | 路径安全检查 |
| `agent/prompt_builder.py` | 注入检测（系统提示） |
| `tools/memory_tool.py` | 注入检测（记忆） |
| `tools/environments/` | 沙箱执行环境 |
