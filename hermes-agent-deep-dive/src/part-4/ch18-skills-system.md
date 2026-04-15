
# 第 18 章：Skills 系统 — 程序化记忆

> **核心问题**：Agent 如何积累和复用"怎么做"的知识？78 个内置 Skill 如何按需加载而不撑爆上下文窗口？

---

## 18.1 Skills 系统解决什么问题

第 17 章的 Memory 系统存储的是**声明性知识**——"用户偏好 Python 类型注解"、"这台机器有 CUDA 12.4"。但有一类知识无法用简短条目表达：**程序化知识**。如何用 Axolotl 微调一个 7B 模型？如何在 Modal 上启动一个 vLLM 推理服务？如何用 Playwright 自动化网页测试？这些知识有明确的步骤、前提条件、代码片段和参数模板。

Skills 就是 Hermes 的程序化记忆系统。一个 Skill 不是一条事实，而是一段**可复用的经验单元**——一个目录，核心是 `SKILL.md` 文件（YAML 元数据 + Markdown 指令），可选附带参考文档、模板和脚本。所有 Skills 存储在 `~/.hermes/skills/`，当前版本附带 78 个内置 Skill，分布在 26 个分类中。

### 核心挑战：上下文窗口管理

78 个 Skill 的全文不可能同时放进上下文窗口——即使是 200K token 的窗口也会被挤占。Hermes 借鉴 Anthropic 的 Claude Skills 系统，实现了**三级渐进式披露**：

| 层级 | API | 返回内容 | token 成本 |
|------|-----|---------|-----------|
| Tier 0 | `skills_categories()` | 分类名称 + 描述 | 极低 |
| Tier 1 | `skills_list()` | 所有 Skill 的 name + description | 低 |
| Tier 2 | `skill_view(name)` | 完整 SKILL.md 内容 | 中 |
| Tier 3 | `skill_view(name, file)` | 链接的参考文档/模板 | 按需 |

Agent 按需逐层加载——先看分类目录知道有哪些能力域，再看列表找到具体 Skill，最后才加载完整指令。

### Skill 发现→加载→使用全流程

点击下方的 **"播放流程"** 按钮观看 Skill 从发现到使用的完整链路，或点击任意阶段查看详情：

<div class="rc-flow" id="skill-flow">
  <div class="rc-flow-controls">
    <button class="rc-play-btn" onclick="(function(){
      var f=document.getElementById('skill-flow');
      var stages=f.querySelectorAll('.rc-stage');
      var btn=f.querySelector('.rc-play-btn');
      btn.disabled=true;
      var i=0;
      function step(){if(i>=stages.length){btn.disabled=false;return;}
      showSkillStage(i+1);i++;setTimeout(step,1800);}step();
    })()">▶ 播放流程</button>
    <button onclick="resetSkillFlow()">重置</button>
  </div>
  <div class="rc-flow-body">
    <div class="rc-flow-diagram">
      <div class="rc-stage" data-stage="1" onclick="showSkillStage(1)">
        <div class="rc-stage-title">① 扫描发现</div>
        <div class="rc-stage-sub">_find_all_skills()</div>
      </div>
      <div class="rc-arrow">↓</div>
      <div class="rc-stage" data-stage="2" onclick="showSkillStage(2)">
        <div class="rc-stage-title">② 平台过滤</div>
        <div class="rc-stage-sub">skill_matches_platform()</div>
      </div>
      <div class="rc-arrow">↓</div>
      <div class="rc-stage" data-stage="3" onclick="showSkillStage(3)">
        <div class="rc-stage-title">③ 渐进式披露</div>
        <div class="rc-stage-sub">Tier 0 → 1 → 2 → 3</div>
      </div>
      <div class="rc-arrow">↓</div>
      <div class="rc-stage" data-stage="4" onclick="showSkillStage(4)">
        <div class="rc-stage-title">④ 安全检查</div>
        <div class="rc-stage-sub">注入检测 + 路径遍历防护</div>
      </div>
      <div class="rc-arrow">↓</div>
      <div class="rc-stage" data-stage="5" onclick="showSkillStage(5)">
        <div class="rc-stage-title">⑤ 注入上下文</div>
        <div class="rc-stage-sub">slash 命令 / --skill 预加载</div>
      </div>
      <div class="rc-arrow">↓</div>
      <div class="rc-stage rc-stage-loop" data-stage="6" onclick="showSkillStage(6)">
        <div class="rc-stage-title">⑥ Agent 执行</div>
        <div class="rc-stage-sub">按指令操作 → 可能创建新 Skill</div>
      </div>
    </div>
    <div class="rc-flow-detail">
      <div class="rc-detail-placeholder">← 点击阶段或播放查看详情</div>
    </div>
  </div>
  <div class="rc-progress">
    <div class="rc-progress-dot" data-dot="1"></div>
    <div class="rc-progress-dot" data-dot="2"></div>
    <div class="rc-progress-dot" data-dot="3"></div>
    <div class="rc-progress-dot" data-dot="4"></div>
    <div class="rc-progress-dot" data-dot="5"></div>
    <div class="rc-progress-dot" data-dot="6"></div>
  </div>
</div>

<script>
(function(){
  var skillData = [
    { title:"① 扫描发现", section:"§18.4 Skill 发现与平台过滤",
      html:"<code>_find_all_skills()</code> 递归扫描 <code>~/.hermes/skills/</code> 及配置的外部目录，收集所有 <code>SKILL.md</code> 文件。解析每个文件的 YAML frontmatter 提取 name、description、platforms 等元数据。<strong>容错设计</strong>：如果 YAML 格式错误，自动回退到逐行 <code>key: value</code> 解析，宁可拿到不完美的元数据也不丢掉整个 Skill。",
      funcs:["_find_all_skills()","parse_frontmatter()","rglob('SKILL.md')"] },
    { title:"② 平台过滤", section:"§18.4 平台兼容性",
      html:"Skill 可在 frontmatter 中声明 <code>platforms: [macos, linux]</code>。<code>PLATFORM_MAP</code> 将人类友好的名称映射到 <code>sys.platform</code> 前缀：macos→darwin、linux→linux、windows→win32。<strong>不匹配的 Skill 被静默跳过</strong>，Windows 用户不会看到 macOS 专属的 Apple Notes Skill。同时检查 <code>disabled_skills</code> 配置（支持全局禁用和平台特定禁用）。",
      funcs:["skill_matches_platform()","PLATFORM_MAP","disabled_skills"] },
    { title:"③ 渐进式披露", section:"§18.3 三级渐进式披露",
      html:'这是 Skills 系统最核心的设计。Agent 按需逐层加载：<br><br><strong>Tier 0</strong> <code>skills_categories()</code> — 只看分类名称，token 极低<br><strong>Tier 1</strong> <code>skills_list()</code> — 所有 Skill 的 name + description<br><strong>Tier 2</strong> <code>skill_view(name)</code> — 完整 SKILL.md 内容<br><strong>Tier 3</strong> <code>skill_view(name, file)</code> — 链接的参考文档/模板<br><br>这解决了"78 个 Skill 全文放不进 200K 上下文窗口"的根本矛盾。',
      funcs:["skills_categories()","skills_list()","skill_view()"] },
    { title:"④ 安全检查", section:"§18.7 安全检查",
      html:'<code>skill_view</code> 在返回内容前执行两层检查。<strong>注入模式检测</strong>：扫描 9 种 prompt injection 模式（"ignore previous instructions" 等），检测到时<strong>发出警告而非阻止</strong>——因为 Skill 可能合法地讨论注入（如 red-teaming Skill）。<strong>路径遍历防护</strong>：对链接文件检查 <code>..</code> 路径组件 + 解析后的绝对路径验证，双重防御 symlink 和 Unicode 攻击。',
      funcs:["_INJECTION_PATTERNS","has_traversal_component","validate_within_dir"] },
    { title:"⑤ 注入上下文", section:"§18.5 Slash 命令系统",
      html:'Skill 通过两种方式进入 Agent 上下文：<br><br><strong>Slash 命令</strong>（<code>/axolotl fine-tune my model</code>）— <code>build_skill_invocation_message()</code> 加载 Skill 内容，附带 <code>[SYSTEM: The user has invoked the &quot;axolotl&quot; skill...]</code> 激活注释，作为<strong>单条用户消息</strong>注入。<br><br><strong>--skill 预加载</strong>（<code>hermes --skill axolotl</code>）— 在会话开始时将 Skill 注入 <strong>system prompt</strong>，全程有效而非单条消息。',
      funcs:["scan_skill_commands()","build_skill_invocation_message()","--skill"] },
    { title:"⑥ Agent 执行", section:"§18.5 + §20 章学习循环",
      html:"Agent 收到 Skill 指令后按步骤执行。如果执行过程中发现了更好的方法或遇到了需要变通的情况，第 20 章的<strong>影子 Agent</strong> 可能会在后台自动更新或创建新的 Skill（通过 <code>skill_manage</code> 工具）。<br><br>这形成了一个<strong>闭环</strong>：Skill 指导执行 → 执行产生经验 → 经验提炼为新 Skill → 新 Skill 指导下次执行。循环图标 ↻ 暗示了这种迭代性质。",
      funcs:["skill_manage()","_spawn_background_review()","SKILL.md"] }
  ];
  window.showSkillStage = function(n) {
    var f = document.getElementById('skill-flow');
    f.querySelectorAll('.rc-stage').forEach(function(s,i){
      s.classList.toggle('active', i===n-1);
    });
    f.querySelectorAll('.rc-arrow').forEach(function(a,i){
      a.classList.toggle('active', i===n-1 || i===n-2);
    });
    f.querySelectorAll('.rc-progress-dot').forEach(function(d,i){
      d.classList.remove('active','done');
      if(i<n-1) d.classList.add('done');
      else if(i===n-1) d.classList.add('active');
    });
    var d = skillData[n-1];
    var detail = f.querySelector('.rc-flow-detail');
    detail.innerHTML = '<div class="rc-detail-content">'
      +'<h4>'+d.title+'</h4>'
      +'<div class="rc-detail-section">'+d.section+'</div>'
      +'<div class="rc-detail-text">'+d.html+'</div>'
      +'<div class="rc-detail-funcs">'
      +d.funcs.map(function(fn){return '<code>'+fn+'</code>';}).join('')
      +'</div></div>';
  };
  window.resetSkillFlow = function() {
    var f = document.getElementById('skill-flow');
    f.querySelectorAll('.rc-stage,.rc-arrow,.rc-progress-dot').forEach(function(e){
      e.classList.remove('active','done');
    });
    f.querySelector('.rc-flow-detail').innerHTML =
      '<div class="rc-detail-placeholder">← 点击阶段或播放查看详情</div>';
    f.querySelector('.rc-play-btn').disabled = false;
  };
})();
</script>

### 本章结构

| 部分 | 节 | 内容 | 重要度 |
|------|-----|------|--------|
| **一、核心：Skill 的定义与加载** | §18.2–18.4 | SKILL.md 格式 → 渐进式披露 → 发现与过滤 | ⭐⭐⭐ 必读 |
| **二、使用：Slash 命令与配置** | §18.5–18.6 | Slash 命令系统 → 配置变量与条件激活 | ⭐⭐ 理解 Skill 如何被调用 |
| **三、安全与内置 Skill 概览** | §18.7–18.8 | 安全检查 → 78 个内置 Skill 的组织 | ⭐ 按需查阅 |

---

# 一、核心：Skill 的定义与加载

> 这部分回答三个基本问题：一个 Skill 长什么样？怎么被 Agent 发现？怎么按需加载而不浪费 token？

## 18.2 SKILL.md 格式

每个 Skill 是一个目录，核心是 `SKILL.md` 文件，使用 YAML frontmatter + Markdown body 的组合格式：

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

可选的子目录提供补充材料：`references/` 放 API 文档，`templates/` 放配置模板，`assets/` 放补充文件（遵循 agentskills.io 开放标准），`scripts/` 放可执行脚本。

Frontmatter 解析通过 `agent/skill_utils.py` 的 `parse_frontmatter()` 实现，有一个务实的容错设计：如果 YAML 解析失败（用户手写的 YAML 经常有格式问题），它会回退到简单的 `key: value` 逐行解析。宁可拿到不完美的元数据，也不要因为格式问题丢掉整个 Skill：

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

---

## 18.3 渐进式披露（Progressive Disclosure）

渐进式披露是 Skills 系统最重要的设计——它解决了"丰富知识库 vs 有限上下文窗口"的根本矛盾。

**Tier 0 — 分类目录**（`skills_categories`）。仅返回分类名称和描述，让 Agent 在最低成本下了解有哪些能力域。分类信息来自目录结构和可选的 `DESCRIPTION.md` 文件。

**Tier 1 — 元数据列表**（`skills_list`）。返回所有 Skill 的名称和描述（受 `MAX_NAME_LENGTH = 64` 和 `MAX_DESCRIPTION_LENGTH = 1024` 限制），不加载 body 内容。Agent 知道自己"能做什么"，但不消耗 token 去加载"怎么做"。

**Tier 2/3 — 完整内容**（`skill_view`）。当 Agent 决定需要某个 Skill 的详细指导时，调用 `skill_view(name)` 加载完整 SKILL.md（Tier 2）。如果 Skill 有链接文件，可用 `skill_view(name, file_path)` 加载特定参考文档或模板（Tier 3）。

这个分层不是任意的——它是上下文窗口管理的必然结果。在第 1 章讨论的设计哲学中，Hermes 选择了"Skills 而非规则"，本章展示了这个选择的实现代价：需要一个精细的加载策略来平衡知识可用性和 token 消耗。

---

## 18.4 Skill 发现与平台过滤

`_find_all_skills()` 递归扫描 Skills 目录及配置的外部目录，收集所有可用的 Skill 元数据。扫描过程中有三个重要的过滤步骤。

**平台过滤**。Skill 可以在 frontmatter 中声明支持的操作系统。`PLATFORM_MAP` 将人类友好的名称映射到 `sys.platform` 前缀：`"macos" → "darwin"`、`"linux" → "linux"`、`"windows" → "win32"`。声明 `platforms: [macos, linux]` 的 Skill，Windows 用户不会看到。

**禁用过滤**。用户可在 `config.yaml` 中禁用特定 Skill，支持全局禁用和平台特定禁用。一个 Skill 可能在 CLI 中启用但在 Telegram 上禁用（比如不适合移动端的复杂工作流）。

**外部目录**。除默认的 `~/.hermes/skills/`，用户可通过 `skills.external_dirs` 配置额外的 Skill 目录。

---

# 二、使用：Slash 命令与配置

> Skill 被发现后，用户如何调用它？Skill 如何声明自己需要的环境变量和配置项？

## 18.5 Slash 命令系统

每个 Skill 自动成为一个 slash 命令。`scan_skill_commands()` 将 Skill 名称转换为 `/skill-name` 格式：

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

当用户输入 `/axolotl fine-tune my model` 时，`build_skill_invocation_message()` 加载 Skill 内容并构建一条包含完整指令的消息，附带 `[SYSTEM: The user has invoked the "axolotl" skill...]` 激活注释。

CLI 还支持 `--skill` 参数预加载——`hermes --skill axolotl` 会在会话开始时将 Skill 注入 system prompt（全程有效），而非作为单条用户消息。

---

## 18.6 配置变量与条件激活

**配置变量**。Skills 可以通过 frontmatter 的 `metadata.hermes.config` 声明需要的配置项，存储在 `config.yaml` 的 `skills.config.*` 命名空间下。加载时自动解析并注入 Skill 消息，Agent 无需自己读取 config.yaml。

**条件激活**。Skills 可以声明在特定工具集可用或不可用时才激活：

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

`requires_toolsets` 表示 Skill 需要某些工具集才有意义（如 `requires_toolsets: [browser]`）。`fallback_for_toolsets` 表示 Skill 是某个工具集不可用时的替代方案。这让 Skills 能适应不同的部署环境——第 12 章讨论的终端后端差异直接影响可用的工具集。

**环境变量捕获**。Skill 可在 frontmatter 中声明所需的环境变量。加载时检查缺失项，通过 `_secret_capture_callback` 提示用户在终端中安全输入，捕获后通过 `register_env_passthrough` 注册到沙盒执行环境。Gateway 模式下安全输入不可用，会提示用户在 CLI 中设置或手动添加到 `.env` 文件。

---

# 三、安全与内置 Skill 概览

> Skill 内容会被注入上下文——它可能来自外部目录或社区分享，因此需要安全检查。本部分也概览了 Hermes 附带的 78 个内置 Skill 的组织方式。

## 18.7 安全检查

`skill_view` 在加载 Skill 时执行两层安全检查。

**注入模式检测**。扫描 9 种 prompt injection 模式（"ignore previous instructions"、"you are now" 等）。与第 17 章的记忆注入检测不同，Skill 的检测是**警告而非阻止**——因为 Skill 内容可能合法地讨论 prompt injection（如 `red-teaming/godmode` Skill）：

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
```

**路径遍历防护**。对链接文件的访问进行严格控制——`has_traversal_component` 检测 `..` 路径组件，`validate_within_dir` 验证解析后的绝对路径仍在 Skill 目录内。双重检查防止 symlink 和 Unicode 规范化攻击。

---

## 18.8 78 个内置 Skills 的组织

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

这个分类反映了 Hermes 的定位——不是一个编程专精工具，而是一个通用 Agent。从 Apple Notes 到 Minecraft Mod Server，从 ArXiv 论文检索到 Polymarket 预测市场，覆盖范围远超传统 AI 编程助手。

---

## 18.9 与其他章节的连接

Skills 系统和第 17 章的 Memory 系统形成了 Hermes 知识持久层的两半。Memory 存储声明性知识（事实、偏好），Skills 存储程序性知识（步骤、模板、脚本）。Memory 的 schema 描述明确指引"如果你发现了新的做事方式，用 skill 工具保存"。

第 20 章将展示 Skill 自动创建和改进的 nudge 机制——Agent 完成复杂任务后，影子 Agent 审查对话历史，决定是否创建新 Skill 或更新已有的。第 6 章的 system prompt 构建过程中，预加载的 Skills 会作为 system prompt 的一部分注入。

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
