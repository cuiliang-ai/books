
# 附录 B：配置 YAML Schema 与环境变量参考

> 本附录提供 Hermes Agent config.yaml 的完整配置项说明与所有支持的环境变量。

---

## B.1 config.yaml 概览

- 配置文件位置：`~/.hermes/config.yaml`
- 分层加载顺序：默认值 → 全局配置 → 项目配置 → 环境变量 → CLI 参数

> TODO: config.yaml 的完整示例

---

## B.2 模型配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `model` | string | — | 默认模型 |
| `cheap_model` | string | — | 廉价模型（辅助任务） |
| `strong_model` | string | — | 强力模型（复杂任务） |

> TODO: 完整模型配置项

---

## B.3 工具配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `toolsets` | list | — | 启用的工具集 |
| `terminal_backend` | string | `local` | 终端后端类型 |

> TODO: 完整工具配置项

---

## B.4 安全配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `auto_approve` | bool | false | 自动审批危险命令 |
| `allowed_commands` | list | — | 白名单命令 |

> TODO: 完整安全配置项

---

## B.5 Gateway 配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `platforms` | dict | — | 平台配置 |

> TODO: 完整 Gateway 配置项

---

## B.6 环境变量参考

| 变量名 | 说明 |
|--------|------|
| `OPENAI_API_KEY` | OpenAI API 密钥 |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `HERMES_CONFIG` | 配置文件路径覆盖 |

> TODO: 完整环境变量列表（从源码中提取所有 `os.environ` / `os.getenv` 调用）

---

## B.7 pyproject.toml 依赖组

| 依赖组 | 说明 |
|--------|------|
| `[project.optional-dependencies]` | 20+ 可选依赖组 |

> TODO: 完整依赖组列表
