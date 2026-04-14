
# 第 18 章：Skills 系统 — 程序化记忆

> **核心问题**：SKILL.md 的渐进式披露如何工作？Skills Hub 如何发现和共享 Skills？

---

## 18.1 Skills 概念

- 源锚：`tools/skills_tool.py`
- Skill = 可复用的经验单元
- SKILL.md 格式标准
- agentskills.io 兼容

> TODO: Skill 的定义与生命周期

---

## 18.2 渐进式披露（Progressive Disclosure）

- Tier 1 — 标题 + 一句话描述
- Tier 2 — 使用说明
- Tier 3 — 完整实现细节
- 源锚：`tools/skills_tool.py`

> TODO: 三级披露的触发条件与加载策略

---

## 18.3 内置 Skills

- 27 类 bundled Skills
- 50+ optional Skills
- 源锚：`skills/`

> TODO: 内置 Skill 分类与代表性示例

---

## 18.4 Skills Hub

- 远程 Skill 发现与下载
- 源锚：`tools/skills_hub.py`

> TODO: Skills Hub 的架构与 API

---

## 18.5 Skill 自动创建

- Agent 在解决问题后自动提炼 Skill
- 从会话轨迹中学习

> TODO: 自动 Skill 创建的触发与生成流程

---

## 速查表

| 文件 | 角色 |
|------|------|
| `tools/skills_tool.py` | Skills 系统主逻辑 |
| `tools/skills_hub.py` | Skills Hub 远程发现 |
| `skills/` | 内置 Skills 集合 |
