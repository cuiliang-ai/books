
# 第 18 章：Skills 系统 — 程序化记忆

> **核心问题**：SKILL.md 的渐进式披露如何工作？78 个内置 Skill 如何组织？安全边界在哪里？

---

## 18.1 Skill 是什么

第 17 章的 Memory 系统存储事实和偏好——"用户偏好 Python 类型注解"，"这台机器有 CUDA 12.4"。但有一类知识不适合用简短条目表达：**程序化知识**。如何用 Axolotl 微调一个 7B 模型？如何在 Modal 上启动一个 vLLM 推理服务？如何用 Playwright 自动化网页测试？这些知识有明确的步骤、前提条件、代码片段和参数模板，它们需要一种比记忆条目更丰富的表达格式。

这就是 Skills——Hermes Agent 的程序化记忆系统。一个 Skill 不是一条事实，而是一段可复用的经验单元。`tools/skills_tool.py` 的模块文档定义了它的结构：

```python
# tools/skills_tool.py:1-66
"""
Skills Tool Module

Skills are organized as directories containing a SKILL.md file (the main
instructions) and optional supporting files like references, templates,
and examples.

Inspired by Anthropic's Claude Skills system with progressive disclosure:
- Metadata (name ≤64 chars, description ≤1024 chars) - shown in skills_list
- Full Instructions - loaded via skill_view when needed
- Linked Files (references, templates) - loaded on demand

Directory Structure:
    skills/
    ├── my-skill/
    │   ├── SKILL.md           # Main instructions (required)
    │   ├── references/        # Supporting documentation
    │   ├── templates/         # Templates for output
    │   └── assets/            # Supplementary files (agentskills.io standard)
    └── category/
        └── another-skill/
            └── SKILL.md
"""
```

每个 Skill 是一个目录，核心是 `SKILL.md` 文件。可选的子目录提供补充材料：`references/` 放 API 文档和示例，`templates/` 放输出模板和配置文件，`assets/` 放补充文件（遵循 agentskills.io 开放标准），`scripts/` 放可执行脚本。所有 Skills 存储在 `~/.hermes/skills/` 目录下——这是单一的真相源，Agent 编辑、Hub 安装和打包的 bundled Skills 共存于此。

---

## 18.2 SKILL.md 格式

SKILL.md 使用 YAML frontmatter + Markdown body 的组合格式。Frontmatter 声明元数据，body 是完整的指令内容：

```yaml
---
name: axolotl                    # Required, max 64 chars
description: Fine-tune LLMs     # Required, max 1024 chars
version: 1.0.0                  # Optional
platforms: [macos, linux]        # Optional — restrict to specific OS
prerequisites:                   # Optional
  env_vars: [HF_TOKEN]
  commands: [python3, pip]
metadata:                        # Optional (agentskills.io)
  hermes:
    tags: [fine-tuning, llm]
    related_skills: [peft, lora]
---

# Axolotl Fine-Tuning Guide

Full instructions here...
```

Frontmatter 解析通过 `agent/skill_utils.py` 中的 `parse_frontmatter()` 实现：

```python
# agent/skill_utils.py:52-86
def parse_frontmatter(content: str) -> Tuple[Dict[str, Any], str]:
    frontmatter: Dict[str, Any] = {}
    body = content

    if not content.startswith("---"):
        return frontmatter, body

    end_match = re.search(r"\n---\s*\n", content[3:])
    if not end_match:
        return frontmatter, body

    yaml_content = content[3 : end_match.start() + 3]
    body = content[end_match.end() + 3 :]

    try:
        parsed = yaml_load(yaml_content)
        if isinstance(parsed, dict):
            frontmatter = parsed
    except Exception:
        # Fallback: simple key:value parsing for malformed YAML
        for line in yaml_content.strip().split("\n"):
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            frontmatter[key.strip()] = value.strip()

    return frontmatter, body
```

这个解析器有一个务实的容错设计：如果 YAML 解析失败（用户手写的 YAML 经常有格式问题），它会回退到简单的 `key: value` 逐行解析。宁可拿到不完美的元数据，也不要因为格式问题丢掉整个 Skill。YAML 加载使用 `CSafeLoader`（如果可用），性能比纯 Python 的 `SafeLoader` 快 5-10 倍。

---

## 18.3 渐进式披露（Progressive Disclosure）

78 个 Skill 的全文不可能同时放进任何模型的上下文窗口——即使是 200K token 的窗口，加载所有 Skill 内容也会挤占实际任务的空间。Hermes 借鉴了 Anthropic 的 Claude Skills 系统，实现了三级渐进式披露：

**Tier 0 — 分类目录**（`skills_categories`）。仅返回分类名称和描述，让 Agent 在最低成本下了解有哪些能力域可用。分类信息来自 Skills 目录结构和可选的 `DESCRIPTION.md` 文件：

```python
# tools/skills_tool.py:632-708
def skills_categories(verbose: bool = False, task_id: str = None) -> str:
    """List available skill categories with descriptions
    (progressive disclosure tier 0)."""
    ...
    categories = []
    for name in sorted(category_dirs.keys()):
        category_dir = category_dirs[name]
        description = _load_category_description(category_dir)
        cat_entry = {"name": name, "skill_count": category_counts[name]}
        if description:
            cat_entry["description"] = description
        categories.append(cat_entry)
    ...
```

**Tier 1 — 元数据列表**（`skills_list`）。返回所有 Skill 的名称和描述（受 `MAX_NAME_LENGTH = 64` 和 `MAX_DESCRIPTION_LENGTH = 1024` 限制），不加载 Skill 的 body 内容。这让 Agent 知道自己"能做什么"，但不消耗 token 去加载"怎么做"：

```python
# tools/skills_tool.py:711-776
def skills_list(category: str = None, task_id: str = None) -> str:
    """List all available skills (progressive disclosure tier 1 -
    minimal metadata)."""
    all_skills = _find_all_skills()
    if category:
        all_skills = [s for s in all_skills if s.get("category") == category]
    all_skills.sort(key=lambda s: (s.get("category") or "", s["name"]))
    ...
```

**Tier 2/3 — 完整内容**（`skill_view`）。当 Agent 决定需要某个 Skill 的详细指导时，调用 `skill_view(name)` 加载完整的 SKILL.md 内容（Tier 2）。如果 Skill 有链接文件，Agent 可以用 `skill_view(name, file_path)` 加载特定的参考文档或模板（Tier 3）。

这个分层不是任意的——它是上下文窗口管理的必然结果。在第 1 章讨论的设计哲学中，Hermes 选择了"Skills 而非规则"，本章展示了这个选择的实现代价：需要一个精细的加载策略来平衡知识可用性和 token 消耗。

---

## 18.4 Skill 发现与平台过滤

`_find_all_skills()` 递归扫描 Skills 目录及配置的外部目录，收集所有可用的 Skill 元数据。扫描过程中有几个重要的过滤步骤。

**平台过滤**。Skill 可以在 frontmatter 中声明支持的操作系统：

```python
# agent/skill_utils.py:92-115
def skill_matches_platform(frontmatter: Dict[str, Any]) -> bool:
    platforms = frontmatter.get("platforms")
    if not platforms:
        return True  # No restriction = all platforms
    if not isinstance(platforms, list):
        platforms = [platforms]
    current = sys.platform
    for platform in platforms:
        normalized = str(platform).lower().strip()
        mapped = PLATFORM_MAP.get(normalized, normalized)
        if current.startswith(mapped):
            return True
    return False
```

`PLATFORM_MAP` 将人类友好的名称映射到 `sys.platform` 前缀：`"macos" → "darwin"`、`"linux" → "linux"`、`"windows" → "win32"`。如果一个 Skill 声明 `platforms: [macos, linux]`，Windows 用户不会在列表中看到它。

**禁用过滤**。用户可以在 `config.yaml` 中禁用特定 Skill：

```python
# agent/skill_utils.py:121-160
def get_disabled_skill_names(platform: str | None = None) -> Set[str]:
    ...
    resolved_platform = (
        platform or os.getenv("HERMES_PLATFORM")
        or get_session_env("HERMES_SESSION_PLATFORM")
    )
    if resolved_platform:
        platform_disabled = (skills_cfg.get("platform_disabled") or {}).get(
            resolved_platform)
        if platform_disabled is not None:
            return _normalize_string_set(platform_disabled)
    return _normalize_string_set(skills_cfg.get("disabled"))
```

禁用支持两个维度：全局禁用和平台特定禁用。一个 Skill 可能在 CLI 中启用但在 Telegram 上禁用（比如不适合移动端的复杂工作流）。

**外部目录**。除了默认的 `~/.hermes/skills/`，用户可以通过 `skills.external_dirs` 配置额外的 Skill 目录。`get_external_skills_dirs()` 验证这些路径存在、不重复、不是默认目录本身，然后作为额外的扫描源。

---

## 18.5 skill_view：加载、安全与环境准备

`skill_view` 是 Skills 系统中最复杂的函数——它不仅加载 Skill 内容，还执行安全检查、环境变量捕获和凭据注册。

**搜索策略**遵循优先级链：直接路径匹配 → 目录名匹配 → 遗留的扁平 `.md` 文件匹配。跨多个目录（本地 + 外部）搜索，本地优先。

**安全检查**有两层。第一层检测 Skill 文件是否位于受信任的目录之外：

```python
# tools/skills_tool.py:871-907
_INJECTION_PATTERNS = [
    "ignore previous instructions",
    "ignore all previous",
    "you are now",
    "disregard your",
    "forget your instructions",
    "new instructions:",
    "system prompt:",
    "<system>",
    "]]>",
]
_content_lower = content.lower()
_injection_detected = any(p in _content_lower for p in _INJECTION_PATTERNS)
```

如果 Skill 文件来自非受信任目录或包含 injection 模式，会记录安全警告。这不会阻止加载（用户显式请求的 Skill 应该被加载），但为安全审计留下痕迹。与第 17 章的记忆注入检测不同，Skill 的检测是警告而非阻止——因为 Skill 内容可能合法地讨论 prompt injection（比如 `red-teaming/godmode` Skill）。

**路径遍历防护**对链接文件的访问进行了严格控制：

```python
# tools/skills_tool.py:941-966
if file_path and skill_dir:
    from tools.path_security import validate_within_dir, has_traversal_component

    if has_traversal_component(file_path):
        return json.dumps({
            "success": False,
            "error": "Path traversal ('..') is not allowed.",
        }, ...)

    target_file = skill_dir / file_path
    traversal_error = validate_within_dir(target_file, skill_dir)
    if traversal_error:
        return json.dumps({
            "success": False,
            "error": traversal_error,
        }, ...)
```

`has_traversal_component` 检测 `..` 路径组件，`validate_within_dir` 验证解析后的绝对路径仍在 Skill 目录内。双重检查防止 symlink 和 Unicode 规范化攻击。

**环境变量捕获**是 skill_view 最独特的能力。Skill 可以在 frontmatter 中声明所需的环境变量和凭据文件。加载时，系统检查哪些变量缺失，然后通过 `_secret_capture_callback` 提示用户在终端中安全输入：

```python
# tools/skills_tool.py:1119-1141
required_env_vars = _get_required_environment_variables(
    frontmatter, legacy_env_vars
)
missing_required_env_vars = [
    e for e in required_env_vars
    if not _is_env_var_persisted(e["name"], env_snapshot)
]
capture_result = _capture_required_environment_variables(
    skill_name, missing_required_env_vars,
)
```

捕获成功后，可用的环境变量通过 `register_env_passthrough` 注册到沙盒执行环境中——确保 Docker/Modal/SSH 后端也能访问这些变量。Gateway 模式下安全输入不可用（没有终端），会返回提示让用户在 CLI 中设置或手动添加到 `.env` 文件。

---

## 18.6 78 个内置 Skills 的组织

Hermes v0.8.0 附带 78 个 SKILL.md 文件，分布在 26 个分类目录中：

```
skills/
├── apple/                    # macOS 原生应用集成
│   ├── apple-notes/
│   ├── apple-reminders/
│   ├── findmy/
│   └── imessage/
├── autonomous-ai-agents/     # 其他 AI Agent 的使用指南
│   ├── claude-code/
│   ├── codex/
│   └── hermes-agent/         # Hermes 自己的 dogfood Skill
├── creative/                 # 创意工具
│   ├── ascii-art/
│   ├── manim-video/
│   ├── p5js/
│   └── popular-web-designs/
├── mlops/                    # 机器学习运维（最大的分类）
│   ├── training/             # Axolotl, PEFT, PyTorch FSDP, etc.
│   ├── inference/            # vLLM, llama-cpp, GGUF, etc.
│   ├── evaluation/           # LM Evaluation Harness, W&B
│   ├── models/               # Stable Diffusion, Whisper, CLIP
│   └── cloud/                # Modal 部署
├── software-development/     # 开发工作流
│   ├── plan/
│   ├── systematic-debugging/
│   ├── test-driven-development/
│   └── subagent-driven-development/
├── red-teaming/              # 安全测试
│   └── godmode/
└── ...
```

这个分类反映了 Hermes 的定位——不是一个编程专精工具，而是一个通用 Agent。从 Apple Notes 到 Minecraft Mod Server，从 ArXiv 论文检索到 Polymarket 预测市场，覆盖范围远超传统 AI 编程助手。第 1 章的产品愿景在这里得到了最直接的体现。

`mlops/` 是最大的分类，包含训练、推理、评估、模型和云部署五个子分类。这不仅服务于 Hermes 用户的 ML 工作流，也是 Nous Research 自身 ML 研发需求的反映——第 29 章讨论的 RL 训练流水线就依赖这些 Skills。

---

## 18.7 Slash 命令系统

每个 Skill 都自动成为一个 slash 命令。`agent/skill_commands.py` 中的 `scan_skill_commands()` 扫描所有 Skill 目录，将 Skill 名称转换为 `/skill-name` 格式的命令：

```python
# agent/skill_commands.py:200-262
def scan_skill_commands() -> Dict[str, Dict[str, Any]]:
    ...
    for skill_md in scan_dir.rglob("SKILL.md"):
        ...
        name = frontmatter.get('name', skill_md.parent.name)
        cmd_name = name.lower().replace(' ', '-').replace('_', '-')
        cmd_name = _SKILL_INVALID_CHARS.sub('', cmd_name)
        cmd_name = _SKILL_MULTI_HYPHEN.sub('-', cmd_name).strip('-')
        _skill_commands[f"/{cmd_name}"] = {
            "name": name,
            "description": description or f"Invoke the {name} skill",
            "skill_md_path": str(skill_md),
            "skill_dir": str(skill_md.parent),
        }
```

Skill 名称被规范化为连字符分隔的 slug：空格和下划线转连字符，移除非字母数字字符，折叠多个连字符。这确保了 CLI 和 Telegram 等平台上 slash 命令的一致性（Telegram 的 bot command 名称不支持连字符，所以 `/claude-code` 在 Telegram 上注册为 `/claude_code`，`resolve_skill_command_key` 在查找时会将下划线转回连字符匹配）。

当用户输入 `/axolotl fine-tune my model` 时，`build_skill_invocation_message()` 加载 Skill 内容并构建一条包含完整指令的消息：

```python
# agent/skill_commands.py:291-326
def build_skill_invocation_message(
    cmd_key: str, user_instruction: str = "", ...
) -> Optional[str]:
    ...
    loaded = _load_skill_payload(skill_info["skill_dir"], ...)
    loaded_skill, skill_dir, skill_name = loaded
    activation_note = (
        f'[SYSTEM: The user has invoked the "{skill_name}" skill, '
        "indicating they want you to follow its instructions. "
        "The full skill content is loaded below.]"
    )
    return _build_skill_message(
        loaded_skill, skill_dir, activation_note,
        user_instruction=user_instruction, ...
    )
```

`_build_skill_message` 将 Skill 内容、链接文件列表、setup 状态和用户指令组装成一条完整的用户消息。如果 Skill 有 setup 问题（缺少环境变量），消息中会包含 setup note 让 Agent 知道功能可能受限。

CLI 还支持 `--skill` 参数预加载 Skill——`hermes --skill axolotl` 会在会话开始时将 Skill 指令注入 system prompt，而非作为用户消息。`build_preloaded_skills_prompt()` 处理这种模式，使用不同的激活注释强调"这是会话级指导，除非用户覆盖，全程有效"。

---

## 18.8 Skill 配置变量

Skills 可以声明自己需要的配置项，通过 frontmatter 中的 `metadata.hermes.config` 字段：

```python
# agent/skill_utils.py:261-317
def extract_skill_config_vars(frontmatter: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract config variable declarations from parsed frontmatter.

    Skills declare config.yaml settings they need via:
        metadata:
          hermes:
            config:
              - key: wiki.path
                description: Path to the LLM Wiki knowledge base directory
                default: "~/wiki"
                prompt: Wiki directory path
    """
```

配置项存储在 `config.yaml` 的 `skills.config.*` 命名空间下。`resolve_skill_config_values()` 在 Skill 加载时解析当前值，`_inject_skill_config()` 将解析后的配置注入 Skill 消息，这样 Agent 无需自己读取 config.yaml 就知道配置的值。

---

## 18.9 条件激活

Skills 可以声明条件激活规则——只在特定工具集可用或不可用时才激活：

```python
# agent/skill_utils.py:240-255
def extract_skill_conditions(frontmatter: Dict[str, Any]) -> Dict[str, List]:
    hermes = metadata.get("hermes") or {}
    return {
        "fallback_for_toolsets": hermes.get("fallback_for_toolsets", []),
        "requires_toolsets": hermes.get("requires_toolsets", []),
        "fallback_for_tools": hermes.get("fallback_for_tools", []),
        "requires_tools": hermes.get("requires_tools", []),
    }
```

`requires_toolsets` 表示 Skill 需要某些工具集才有意义（如 `requires_toolsets: [browser]` 意味着没有浏览器工具就不加载）。`fallback_for_toolsets` 表示 Skill 是某个工具集不可用时的替代方案（如提供纯文本的 web 搜索替代策略）。这个条件系统让 Skills 能够适应不同的部署环境——第 12 章讨论的终端后端差异直接影响可用的工具集。

---

## 18.10 与其他章节的连接

Skills 系统和第 17 章的 Memory 系统形成了 Hermes 知识持久层的两半。Memory 存储声明性知识（事实、偏好），Skills 存储程序性知识（步骤、模板、脚本）。Memory 的 schema 描述明确指引"如果你发现了新的做事方式，用 skill 工具保存"，建立了两者之间的分工。

第 20 章将展示 Skill 自动创建和改进的 nudge 机制——Agent 在完成复杂任务后，`_spawn_background_review` 会审查对话历史，决定是否值得创建一个新的 Skill 或更新已有的。这是 Skills 从静态知识库走向动态学习系统的关键桥梁。

第 6 章的 system prompt 构建过程中，预加载的 Skills 内容会作为 system prompt 的一部分注入。第 10 章的工具注册表管理 `skills_list`、`skill_view` 这两个工具的 schema 注册和调用路由。

---

## 速查表

| 文件 | 角色 |
|------|------|
| `tools/skills_tool.py` | Skills 系统主逻辑（发现、加载、安全检查） |
| `agent/skill_utils.py` | 轻量级元数据工具（解析、平台匹配、配置提取） |
| `agent/skill_commands.py` | Slash 命令系统（扫描、构建、预加载） |
| `~/.hermes/skills/` | Skill 存储目录（26 个分类，78 个 Skill） |
| `SKILL.md` | Skill 定义文件（YAML frontmatter + Markdown body） |
| `skills_categories()` | Tier 0 — 分类目录 |
| `skills_list()` | Tier 1 — 元数据列表（name + description） |
| `skill_view()` | Tier 2/3 — 完整内容 + 链接文件 |
| `_parse_frontmatter()` | YAML 解析（带 key:value 回退） |
| `skill_matches_platform()` | 平台兼容性过滤 |
| `_INJECTION_PATTERNS` | Skill 内容安全检测（9 种模式） |
| `register_env_passthrough()` | 环境变量透传到沙盒执行环境 |
