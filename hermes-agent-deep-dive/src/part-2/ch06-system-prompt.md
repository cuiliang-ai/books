
# 第 6 章：系统提示装配与 Prompt Caching

> **核心问题**：七层系统提示如何组装？注入检测如何防御恶意内容？

---

## 6.1 Prompt Builder 架构

- 源锚：`agent/prompt_builder.py`
- 七层提示组装：基础指令 → 工具说明 → 安全规则 → 记忆上下文 → Skills → 用户偏好 → 动态注入

> TODO: 七层提示的完整结构图

---

## 6.2 各层详解

| 层级 | 内容 | 来源 |
|------|------|------|
| L1 | 基础系统指令 | 硬编码模板 |
| L2 | 工具 Schema | `ToolRegistry` |
| L3 | 安全规则 | 配置 + 硬编码 |
| L4 | 记忆上下文 | `MemoryManager` |
| L5 | Skills 上下文 | `SkillsTool` |
| L6 | 用户偏好 | `USER.md` |
| L7 | 动态注入 | 会话状态 |

> TODO: 每层的源码路径与生成逻辑

---

## 6.3 注入检测

- `_CONTEXT_THREAT_PATTERNS` — 威胁模式匹配
- `_scan_context_content()` — 内容扫描
- 源锚：`agent/prompt_builder.py`

> TODO: 威胁模式列表与检测流程

---

## 6.4 Prompt Caching 策略

- Anthropic prompt cache 支持
- 缓存断点位置设计

> TODO: 缓存策略详解

---

## 速查表

| 文件 | 角色 |
|------|------|
| `agent/prompt_builder.py` | 系统提示组装与注入检测 |
| `agent/memory_manager.py` | 记忆上下文供给 |
| `tools/skills_tool.py` | Skills 上下文供给 |
