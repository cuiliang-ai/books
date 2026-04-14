
# 第 24 章：CLI 交互设计与 Skin Engine

> **核心问题**：Rich + prompt_toolkit 如何构建交互式 CLI？Skin Engine 的主题系统如何工作？

---

## 24.1 HermesCLI 架构

- 源锚：`cli.py`（9,956 行）
- Rich 库 — 富文本终端输出
- prompt_toolkit — 交互式输入

> TODO: CLI 的整体架构与事件循环

---

## 24.2 Slash 命令系统

- 源锚：`hermes_cli/commands.py`
- 命令注册表模式
- 命令发现与自动补全

> TODO: Slash 命令的注册与分发

---

## 24.3 Skin Engine

- 源锚：`hermes_cli/skin_engine.py`
- 主题定义与切换
- 颜色方案管理

> TODO: 主题系统的设计与自定义

---

## 24.4 KawaiiSpinner 与工具预览

- 源锚：`agent/display.py`
- 动画 Spinner 显示
- 工具调用的实时预览

> TODO: 显示系统的实现细节

---

## 24.5 CLI 子命令系统

- 源锚：`hermes_cli/main.py`（6,057 行）
- `hermes` 命令的子命令结构
- gateway / setup / config 等子命令

> TODO: 子命令的注册与路由

---

## 速查表

| 文件 | 角色 |
|------|------|
| `cli.py` | HermesCLI 主逻辑 |
| `hermes_cli/commands.py` | Slash 命令注册表 |
| `hermes_cli/skin_engine.py` | 主题引擎 |
| `agent/display.py` | KawaiiSpinner + 显示 |
| `hermes_cli/main.py` | CLI 入口与子命令 |
