
# 第 6 章：System Prompt装配与 Prompt Caching

> **核心问题**：七层System Prompt如何组装？注入检测如何防御恶意内容？Prompt caching 为何要求 bit-perfect 一致性？

---

## 6.1 为什么System Prompt如此重要

System Prompt是 LLM 看到的第一段文字。它决定了 Agent 的身份、能力边界、行为偏好，以及它对工具的使用策略。在 Hermes Agent 中，System Prompt不是一段静态文本——它是七个层次动态组装的结果，每一层都有自己的数据来源和安全考量。

`_build_system_prompt()` 位于 `run_agent.py:3057`，返回一个字符串。这个字符串在每个会话的第一轮构建一次，然后缓存到 `self._cached_system_prompt`（如第 5 章所述）。只有上下文压缩事件会触发重新构建——因为压缩会重新加载记忆，记忆内容可能已经改变。

---

## 6.2 七层组装架构

`_build_system_prompt()`（`run_agent.py:3057`）的结构是一条线性管道——按顺序将各层内容追加到 `prompt_parts` 列表中，最后用 `"\n\n"` 连接。点击下方的 **"播放组装"** 按钮观看七层逐层组装过程，或点击任意层查看详情：

<div class="rc-flow" id="sp-flow">
  <div class="rc-flow-controls">
    <button class="rc-play-btn" id="sp-play">▶ 播放组装</button>
    <button id="sp-reset">重置</button>
  </div>
  <div class="rc-flow-body">
    <div class="rc-flow-diagram">
      <div class="rc-stage" data-stage="0">
        <div class="rc-stage-title">L1 · Agent 身份</div>
        <div class="rc-stage-sub">SOUL.md 或 DEFAULT_AGENT_IDENTITY</div>
      </div>
      <div class="rc-arrow" data-arrow="0">↓</div>
      <div class="rc-stage" data-stage="1">
        <div class="rc-stage-title">L2 · 工具行为指导</div>
        <div class="rc-stage-sub">MEMORY / SKILLS / TOOL_USE 按模型注入</div>
      </div>
      <div class="rc-arrow" data-arrow="1">↓</div>
      <div class="rc-stage" data-stage="2">
        <div class="rc-stage-title">L3 · 工具执行力</div>
        <div class="rc-stage-sub">GPT/Gemini 专用强制工具使用指令</div>
      </div>
      <div class="rc-arrow" data-arrow="2">↓</div>
      <div class="rc-stage" data-stage="3">
        <div class="rc-stage-title">L4 · 用户/网关 System Prompt</div>
        <div class="rc-stage-sub">CLI 配置 / Gateway 平台消息</div>
      </div>
      <div class="rc-arrow" data-arrow="3">↓</div>
      <div class="rc-stage" data-stage="4">
        <div class="rc-stage-title">L5 · 记忆快照</div>
        <div class="rc-stage-sub">MEMORY.md + USER.md + 外部 provider</div>
      </div>
      <div class="rc-arrow" data-arrow="4">↓</div>
      <div class="rc-stage" data-stage="5">
        <div class="rc-stage-title">L6 · 技能索引</div>
        <div class="rc-stage-sub">78 个 SKILL 的 Tier 1 摘要</div>
      </div>
      <div class="rc-arrow" data-arrow="5">↓</div>
      <div class="rc-stage" data-stage="6">
        <div class="rc-stage-title">L7 · 上下文 · 时间 · 平台</div>
        <div class="rc-stage-sub">AGENTS.md + 时间戳 + PLATFORM_HINTS</div>
      </div>
    </div>
    <div class="rc-flow-detail" id="sp-detail">
      <div class="rc-detail-placeholder">← 点击层方块或播放组装查看详情</div>
    </div>
  </div>
  <div class="rc-progress">
    <div class="rc-progress-dot" data-dot="0"></div>
    <div class="rc-progress-dot" data-dot="1"></div>
    <div class="rc-progress-dot" data-dot="2"></div>
    <div class="rc-progress-dot" data-dot="3"></div>
    <div class="rc-progress-dot" data-dot="4"></div>
    <div class="rc-progress-dot" data-dot="5"></div>
    <div class="rc-progress-dot" data-dot="6"></div>
  </div>
</div>

<script>
(function() {
  var layers = [
    {
      title: 'L1 · Agent 身份',
      section: '200–2,000 tokens',
      text: 'Agent 身份的来源有两个：<code>SOUL.md</code>（用户可定制人格）和硬编码的 <code>DEFAULT_AGENT_IDENTITY</code>。SOUL.md 优先且是<strong>替换</strong>而非追加——完全控制 Agent 的"灵魂"。默认身份的最后一句"Be targeted and efficient"与迭代预算机制形成配合。',
      funcs: ['load_soul_md()', 'DEFAULT_AGENT_IDENTITY', 'prompt_builder.py:133']
    },
    {
      title: 'L2 · 工具行为指导',
      section: '500–2,000 tokens',
      text: '根据 Agent 加载了哪些工具，按需注入对应指导。<code>MEMORY_GUIDANCE</code> 定义记忆质量标准——"记住那些能减少用户未来纠正次数的东西"。<code>SKILLS_GUIDANCE</code> 驱动技能创建和修补的闭环。只注入已加载工具的指导，避免浪费上下文空间。',
      funcs: ['MEMORY_GUIDANCE', 'SESSION_SEARCH_GUIDANCE', 'SKILLS_GUIDANCE']
    },
    {
      title: 'L3 · 工具执行力',
      section: '按模型条件注入',
      text: 'GPT/Codex/Gemini 等模型倾向于<em>描述计划</em>而非<em>执行行动</em>。此层注入 <code>TOOL_USE_ENFORCEMENT_GUIDANCE</code> 强制要求"说了就做"。Claude 系列天然积极使用工具，不注入此层。GPT 还有额外的 XML 标签指令（<code>&lt;tool_persistence&gt;</code> 等）。',
      funcs: ['TOOL_USE_ENFORCEMENT_GUIDANCE', 'TOOL_USE_ENFORCEMENT_MODELS', 'OPENAI_MODEL_EXECUTION_GUIDANCE']
    },
    {
      title: 'L4 · 用户/网关 System Prompt',
      section: '0–1,000 tokens · 可选',
      text: '来自调用者的自定义System Prompt——CLI 从用户配置读取，Gateway 从平台消息提取。<strong>追加</strong>而非替换，保留前面所有层。注意 <code>ephemeral_system_prompt</code> 不在此处注入，它在消息准备流水线中追加，不进入缓存。',
      funcs: ['system_message', 'ephemeral_system_prompt']
    },
    {
      title: 'L5 · 记忆快照',
      section: '500–1,500 tokens',
      text: '内置记忆（<code>MEMORY.md</code> / <code>USER.md</code>）和外部记忆提供商（Honcho、mem0）叠加注入。记忆内容在此刻被"<strong>冻结</strong>"——会话中写入的新记忆不会更新 System Prompt，直到压缩触发重建。这是 prompt caching 的刚性需求。',
      funcs: ['_memory_store.format_for_system_prompt()', '_memory_manager.build_system_prompt()']
    },
    {
      title: 'L6 · 技能索引',
      section: '1,000–3,000 tokens',
      text: '加载所有 SKILL.md 的 Tier 1 信息（标题 + 一句话描述），构建紧凑的技能目录。78 个技能的完整内容无法放入上下文，但标题让模型知道"能做什么"，需要时通过 <code>skill_view</code> 加载完整内容（三级渐进式披露）。',
      funcs: ['build_skills_system_prompt()', 'skills_list', 'skill_view']
    },
    {
      title: 'L7 · 上下文 · 时间 · 平台',
      section: '50–5,200 tokens',
      text: '上下文文件（AGENTS.md、.cursorrules、.hermes.md）提供项目级指令。时间戳让模型知道"现在"。<code>PLATFORM_HINTS</code> 为 15 个平台定制格式指导——WhatsApp 用纯文本，Cron 模式告诉模型"没有用户在场，完全自主执行"。上下文文件硬限 20,000 字符。',
      funcs: ['build_context_files_prompt()', 'PLATFORM_HINTS', 'CONTEXT_FILE_MAX_CHARS']
    }
  ];

  var current = -1;
  var timer = null;
  var playBtn = document.getElementById('sp-play');
  var resetBtn = document.getElementById('sp-reset');
  var detailEl = document.getElementById('sp-detail');
  var stageEls = document.querySelectorAll('#sp-flow .rc-stage');
  var arrowEls = document.querySelectorAll('#sp-flow .rc-arrow');
  var dotEls = document.querySelectorAll('#sp-flow .rc-progress-dot');

  function showStage(idx) {
    current = idx;
    stageEls.forEach(function(el, i) { el.classList.toggle('active', i === idx); });
    arrowEls.forEach(function(el, i) { el.classList.toggle('active', i === idx - 1 || i === idx); });
    dotEls.forEach(function(el, i) {
      el.classList.remove('active', 'done');
      if (i === idx) el.classList.add('active');
      else if (i < idx) el.classList.add('done');
    });
    var s = layers[idx];
    var funcsHtml = s.funcs.map(function(f) { return '<code>' + f + '</code>'; }).join('');
    detailEl.innerHTML = '<div class="rc-detail-content">' +
      '<h4>' + s.title + '</h4>' +
      '<div class="rc-detail-section">' + s.section + '</div>' +
      '<div class="rc-detail-text">' + s.text + '</div>' +
      '<div class="rc-detail-funcs">' + funcsHtml + '</div>' +
      '</div>';
  }

  function resetAll() {
    if (timer) { clearInterval(timer); timer = null; }
    current = -1;
    playBtn.disabled = false;
    playBtn.textContent = '▶ 播放组装';
    stageEls.forEach(function(el) { el.classList.remove('active'); });
    arrowEls.forEach(function(el) { el.classList.remove('active'); });
    dotEls.forEach(function(el) { el.classList.remove('active', 'done'); });
    detailEl.innerHTML = '<div class="rc-detail-placeholder">← 点击层方块或播放组装查看详情</div>';
  }

  playBtn.addEventListener('click', function() {
    if (timer) return;
    playBtn.disabled = true;
    playBtn.textContent = '⏵ 组装中...';
    var step = 0;
    showStage(step);
    timer = setInterval(function() {
      step++;
      if (step >= layers.length) {
        clearInterval(timer); timer = null;
        playBtn.disabled = false;
        playBtn.textContent = '▶ 重新播放';
        return;
      }
      showStage(step);
    }, 1800);
  });

  resetBtn.addEventListener('click', resetAll);
  stageEls.forEach(function(el) {
    el.addEventListener('click', function() {
      if (timer) { clearInterval(timer); timer = null; playBtn.disabled = false; playBtn.textContent = '▶ 播放组装'; }
      showStage(parseInt(el.dataset.stage));
    });
  });
})();
</script>

> **最终组装**：七层通过 `"\n\n".join()` 连接成一个字符串，空内容被过滤。典型总大小 5,000–15,000 tokens（详见 §6.7 大小预算表）。

让我们逐层深入。

### 第一层：Agent 身份

```python
# run_agent.py:3074-3084
if not self.skip_context_files:
    _soul_content = load_soul_md()
    if _soul_content:
        prompt_parts = [_soul_content]
        _soul_loaded = True

if not _soul_loaded:
    prompt_parts = [DEFAULT_AGENT_IDENTITY]
```

Agent 的身份有两个来源：SOUL.md 文件（用户可定制的人格）和硬编码的 `DEFAULT_AGENT_IDENTITY`。SOUL.md 优先——如果存在，它完全替换默认身份。这不是追加，是替换。

`DEFAULT_AGENT_IDENTITY` 定义在 `agent/prompt_builder.py:133`：

```python
# agent/prompt_builder.py:133-141
DEFAULT_AGENT_IDENTITY = (
    "You are Hermes Agent, an intelligent AI assistant created by Nous Research. "
    "You are helpful, knowledgeable, and direct. You assist users with a wide "
    "range of tasks including answering questions, writing and editing code, "
    "analyzing information, creative work, and executing actions via your tools. "
    "You communicate clearly, admit uncertainty when appropriate, and prioritize "
    "being genuinely useful over being verbose unless otherwise directed below. "
    "Be targeted and efficient in your exploration and investigations."
)
```

注意最后一句："Be targeted and efficient"——这不是空话，它指导模型在探索性任务中避免穷举搜索，与第 5 章讨论的迭代预算机制形成配合。

### 第二层：工具行为指导

这一层根据 Agent 加载了哪些工具来注入对应的行为指导：

```python
# run_agent.py:3087-3095
tool_guidance = []
if "memory" in self.valid_tool_names:
    tool_guidance.append(MEMORY_GUIDANCE)
if "session_search" in self.valid_tool_names:
    tool_guidance.append(SESSION_SEARCH_GUIDANCE)
if "skill_manage" in self.valid_tool_names:
    tool_guidance.append(SKILLS_GUIDANCE)
```

三段指导对应三个核心工具。`MEMORY_GUIDANCE`（`agent/prompt_builder.py:143`）告诉模型如何使用记忆工具——保存持久事实，不保存临时状态：

```python
# agent/prompt_builder.py:143-155
MEMORY_GUIDANCE = (
    "You have persistent memory across sessions. Save durable facts using the memory "
    "tool: user preferences, environment details, tool quirks, and stable conventions. "
    "Prioritize what reduces future user steering — the most valuable memory is one "
    "that prevents the user from having to correct or remind you again."
)
```

"Prioritize what reduces future user steering"——这句话定义了记忆的质量标准。不是"记住一切"，而是"记住那些能减少用户未来纠正次数的东西"。

`SKILLS_GUIDANCE`（`agent/prompt_builder.py:163`）驱动技能创建和维护的闭环——Agent 不仅要创建技能，还要在发现技能过时时用 `skill_manage(action='patch')` 主动修补。这是第 1 章描述的"自进化"能力的System Prompt层驱动力。

### 第三层：工具使用执行力

某些模型（特别是 GPT 和 Gemini 系列）有一个已知的行为缺陷：它们倾向于描述计划而不是执行行动。Hermes 通过一段强制性指导来解决：

```python
# agent/prompt_builder.py:172-185
TOOL_USE_ENFORCEMENT_GUIDANCE = (
    "# Tool-use enforcement\n"
    "You MUST use your tools to take action — do not describe what you would do "
    "or plan to do without actually doing it. When you say you will perform an "
    "action (e.g. 'I will run the tests', 'Let me check the file'), you MUST "
    "immediately make the corresponding tool call in the same response.\n"
    "Every response should either (a) contain tool calls that make progress, or "
    "(b) deliver a final result to the user."
)
```

这段指导不是对所有模型都注入的——它通过一个可配置的匹配逻辑决定：

```python
# run_agent.py:3107-3121
_enforce = self._tool_use_enforcement
if _enforce is True:
    _inject = True
elif isinstance(_enforce, list):
    model_lower = (self.model or "").lower()
    _inject = any(p.lower() in model_lower for p in _enforce)
else:  # "auto"
    model_lower = (self.model or "").lower()
    _inject = any(p in model_lower for p in TOOL_USE_ENFORCEMENT_MODELS)
```

默认的 `"auto"` 模式匹配 `TOOL_USE_ENFORCEMENT_MODELS = ("gpt", "codex", "gemini", "gemma", "grok")`——这些是已知需要"推一把"才会积极使用工具的模型族。Claude 系列不在列表中，因为它们天然倾向于使用工具。

对于 GPT/Codex 模型，还有一段更激进的 `OPENAI_MODEL_EXECUTION_GUIDANCE`（`agent/prompt_builder.py:195`），包含 `<tool_persistence>`、`<mandatory_tool_use>`、`<act_dont_ask>`、`<verification>` 等 XML 标签包裹的详细行为指令。对于 Gemini/Gemma 模型，有 `GOOGLE_MODEL_OPERATIONAL_GUIDANCE`（`agent/prompt_builder.py:258`），强调绝对路径、验证优先、并行工具调用等。

这种按模型定制行为指导的策略反映了一个现实：不同 LLM 有不同的行为偏差，通用的System Prompt无法覆盖所有情况。

### 第四层：用户/网关System Prompt

```python
# run_agent.py:3137-3138
if system_message is not None:
    prompt_parts.append(system_message)
```

`system_message` 来自调用者——CLI 从用户配置中读取，Gateway 从平台消息中提取。它被追加而不是替换，保留了所有前面的层。

注意：`ephemeral_system_prompt` **不在**这里注入。它在 `run_conversation()` 的消息准备流水线中被追加到有效System Prompt末尾（第 5 章 5.7 节），但不进入缓存的 `_cached_system_prompt`。这确保了临时提示不污染持久化的System Prompt快照。

### 第五层：记忆快照

```python
# run_agent.py:3140-3158
if self._memory_store:
    if self._memory_enabled:
        mem_block = self._memory_store.format_for_system_prompt("memory")
        if mem_block:
            prompt_parts.append(mem_block)
    if self._user_profile_enabled:
        user_block = self._memory_store.format_for_system_prompt("user")
        if user_block:
            prompt_parts.append(user_block)

if self._memory_manager:
    try:
        _ext_mem_block = self._memory_manager.build_system_prompt()
        if _ext_mem_block:
            prompt_parts.append(_ext_mem_block)
    except Exception:
        pass
```

记忆有两个来源：内置的 MEMORY.md / USER.md（通过 `_memory_store`），以及外部记忆提供商（通过 `_memory_manager`，如 Honcho、mem0）。两者叠加而非互斥——内置记忆和外部记忆可以共存。

记忆内容被"冻结"在System Prompt中——即使 Agent 在会话过程中写入了新记忆，System Prompt也不会更新，直到下一次压缩触发重建。这是 prompt caching 的刚性需求（见 6.5 节）。

### 第六层：技能索引

```python
# run_agent.py:3160-3176
has_skills_tools = any(name in self.valid_tool_names
                       for name in ['skills_list', 'skill_view', 'skill_manage'])
if has_skills_tools:
    skills_prompt = build_skills_system_prompt(
        available_tools=self.valid_tool_names,
        available_toolsets=avail_toolsets,
    )
```

`build_skills_system_prompt()` 加载所有 SKILL.md 文件的 Tier 1 信息（标题 + 一句话描述），构建一个紧凑的技能目录。78 个技能的完整内容无法放入上下文窗口，但标题和条件描述可以——这让模型知道自己"能做什么"，在需要时通过 `skill_view` 工具加载完整内容（第 1 章描述的三级渐进式披露）。

### 第七层：上下文文件、时间戳与平台提示

```python
# run_agent.py:3178-3221
if not self.skip_context_files:
    context_files_prompt = build_context_files_prompt(
        cwd=_context_cwd, skip_soul=_soul_loaded)

now = _hermes_now()
timestamp_line = f"Conversation started: {now.strftime('%A, %B %d, %Y %I:%M %p')}"
prompt_parts.append(timestamp_line)

platform_key = (self.platform or "").lower().strip()
if platform_key in PLATFORM_HINTS:
    prompt_parts.append(PLATFORM_HINTS[platform_key])
```

上下文文件包括 AGENTS.md、.cursorrules、.hermes.md——项目级别的指令文件。时间戳让模型知道"现在是什么时候"。平台提示告诉模型当前通信渠道的格式约束。

`PLATFORM_HINTS` 是一个精心设计的字典（`agent/prompt_builder.py:285-367`），为每个消息平台提供定制的格式指导。WhatsApp 不渲染 Markdown，所以提示模型使用纯文本并支持 `MEDIA:/path` 协议发送文件。Cron 模式甚至告诉模型"没有用户在场——不要提问，完全自主执行"。这种平台感知的提示注入让同一个 AIAgent 在不同平台上表现出适当的行为差异。

### 最终组装

```python
# run_agent.py:3222
return "\n\n".join(p.strip() for p in prompt_parts if p.strip())
```

所有层通过 `"\n\n"` 连接成一个字符串，空内容被过滤掉。

---

## 6.3 注入检测：在信任之前扫描

System Prompt的上下文文件层有一个独特的安全风险：它加载的是用户工作目录下的文件，这些文件可能被恶意修改。`_scan_context_content()` 在加载任何上下文文件之前执行安全扫描：

```python
# agent/prompt_builder.py:35-46
_CONTEXT_THREAT_PATTERNS = [
    (r'ignore\s+(previous|all|above|prior)\s+instructions', "prompt_injection"),
    (r'do\s+not\s+tell\s+the\s+user', "deception_hide"),
    (r'system\s+prompt\s+override', "sys_prompt_override"),
    (r'disregard\s+(your|all|any)\s+(instructions|rules|guidelines)', "disregard_rules"),
    (r'act\s+as\s+(if|though)\s+you\s+(have\s+no|don\'t\s+have)\s+(restrictions|limits|rules)',
     "bypass_restrictions"),
    (r'<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->',
     "html_comment_injection"),
    (r'<\s*div\s+style\s*=\s*["\'][\s\S]*?display\s*:\s*none', "hidden_div"),
    (r'translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)', "translate_execute"),
    (r'curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)',
     "exfil_curl"),
    (r'cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)', "read_secrets"),
]
```

10 种威胁模式，每种都有一个标识符，覆盖了最常见的提示注入向量：直接指令覆盖、欺骗性隐藏、HTML 注入、间接执行、凭据窃取。

除了正则匹配，还有不可见 Unicode 字符检测：

```python
# agent/prompt_builder.py:48-51
_CONTEXT_INVISIBLE_CHARS = {
    '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
    '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
}
```

零宽字符和双向覆盖字符被视为威胁——它们可以在视觉上隐藏恶意指令。

扫描的处理方式是**阻断而非清洗**：

```python
# agent/prompt_builder.py:66-70
if findings:
    logger.warning("Context file %s blocked: %s", filename, ", ".join(findings))
    return f"[BLOCKED: {filename} contained potential prompt injection ...]"
return content
```

如果检测到威胁，整个文件内容被替换为一段阻断说明。不尝试"净化"恶意内容——因为净化逻辑本身可能被绕过。阻断是更安全的选择。

---

## 6.4 上下文文件发现

`build_context_files_prompt()` 从工作目录向上搜索到 git root：

```python
# agent/prompt_builder.py:75-109
def _find_git_root(start: Path) -> Optional[Path]:
    current = start.resolve()
    for parent in [current, *current.parents]:
        if (parent / ".git").exists():
            return parent
    return None

def _find_hermes_md(cwd: Path) -> Optional[Path]:
    stop_at = _find_git_root(cwd)
    current = cwd.resolve()
    for directory in [current, *current.parents]:
        for name in _HERMES_MD_NAMES:
            candidate = directory / name
            if candidate.is_file():
                return candidate
        if stop_at and directory == stop_at:
            break
    return None
```

搜索在 git root 处停止——不会遍历到文件系统根目录。这是安全考量：用户的 home 目录或根目录可能包含不相关的上下文文件。`.hermes.md` 和 `HERMES.md` 两种命名都被接受。

YAML frontmatter（`---` 分隔的结构化配置）在加载时被剥离——它将来可能用于模型覆盖等配置，但当前只保留人类可读的 markdown 正文注入到System Prompt。

---

## 6.5 Prompt Caching 策略

Anthropic 的 prompt caching 允许缓存System Prompt和对话前缀，在多轮对话中避免重复处理相同的输入 tokens。Hermes 通过 `agent/prompt_caching.py` 实现了 **system_and_3** 策略。

```python
# agent/prompt_caching.py:40-71
def apply_anthropic_cache_control(
    api_messages: List[Dict[str, Any]],
    cache_ttl: str = "5m",
    native_anthropic: bool = False,
) -> List[Dict[str, Any]]:
    messages = copy.deepcopy(api_messages)
    marker = {"type": "ephemeral"}
    if cache_ttl == "1h":
        marker["ttl"] = "1h"

    breakpoints_used = 0
    if messages[0].get("role") == "system":
        _apply_cache_marker(messages[0], marker, native_anthropic=native_anthropic)
        breakpoints_used += 1

    remaining = 4 - breakpoints_used
    non_sys = [i for i in range(len(messages)) if messages[i].get("role") != "system"]
    for idx in non_sys[-remaining:]:
        _apply_cache_marker(messages[idx], marker)

    return messages
```

Anthropic 允许最多 4 个缓存断点。Hermes 的分配：**断点 1** 在System Prompt（最稳定的部分），**断点 2-4** 在最后 3 条非系统消息（滑动窗口）。

为什么是"最后 3 条"而不是"前 3 条"？因为 LLM 的 KV cache 是前缀匹配的——只有从头部开始的连续匹配才能命中。System Prompt是永远匹配的前缀，而最后几条消息标记了增量增长的部分，确保新增内容被缓存供下一轮复用。

`_apply_cache_marker()` 处理了消息格式的多样性：

```python
# agent/prompt_caching.py:14-38
def _apply_cache_marker(msg, cache_marker, native_anthropic=False):
    content = msg.get("content")
    if isinstance(content, str):
        msg["content"] = [
            {"type": "text", "text": content, "cache_control": cache_marker}
        ]
        return
    if isinstance(content, list) and content:
        last = content[-1]
        if isinstance(last, dict):
            last["cache_control"] = cache_marker
```

当 content 是字符串时，它被转换为 Anthropic 的多块格式。当 content 已经是列表时，标记添加到最后一个块。

缓存的经济效益：写入缓存的 token 成本是 1.25x，但后续命中时的读取成本只有 0.1x。在一个 20 轮的对话中，System Prompt被读取 20 次——缓存使这些读取的成本降低 90%，轻松覆盖第一次的额外写入成本。

这就是为什么第 5 章中插件上下文被注入到用户消息而不是System Prompt：修改System Prompt会打破缓存前缀匹配。整个System Prompt缓存机制——从 `_cached_system_prompt` 到 SQLite 存储到 prompt caching 断点——都服务于一个目标：**让System Prompt在整个会话中 bit-perfect 不变**。

---

## 6.6 模型特定的角色与环境适配

两个容易被忽略的细节值得单独讨论。

**Developer role 替换**：OpenAI 的较新模型（GPT-5、Codex）对 `developer` 角色给予比 `system` 角色更高的指令遵循权重：

```python
# agent/prompt_builder.py:278-283
DEVELOPER_ROLE_MODELS = ("gpt-5", "codex")
```

如果模型名称匹配，`_build_api_kwargs()` 在 API 调用时将系统消息的 role 从 `"system"` 替换为 `"developer"`。内部表示不变，只在 API 边界做转换。

**环境感知提示**：Hermes 不仅告诉模型"你在什么平台上"，还告诉它"你在什么操作系统上"：

```python
# agent/prompt_builder.py:375-384
WSL_ENVIRONMENT_HINT = (
    "You are running inside WSL (Windows Subsystem for Linux). "
    "The Windows host filesystem is mounted under /mnt/ — "
    "/mnt/c/ is the C: drive, /mnt/d/ is D:, etc. "
    "When the user references Windows paths or desktop files, translate "
    "to the /mnt/c/ equivalent."
)
```

WSL 场景下，用户说"打开桌面上的文件"时，模型需要知道 `C:\Users\xxx\Desktop` 映射到 `/mnt/c/Users/xxx/Desktop`。这段提示将路径翻译的责任从用户转移到了 Agent。

还有一个 Alibaba 特有的修复（`run_agent.py:3203`）：阿里巴巴的 Coding Plan API 无论请求哪个模型，返回的模型名称总是 "glm-4.7"。Hermes 在System Prompt中注入正确的模型信息来覆盖这个 API bug。

---

## 6.7 System Prompt的大小预算

七层组装的结果可能非常庞大。在实际运行中，System Prompt通常占用 5,000-15,000 tokens：

| 层 | 典型大小 | 内容 |
|---|---------|------|
| L1: 身份 | 200-2,000 tokens | DEFAULT_AGENT_IDENTITY 或 SOUL.md |
| L2: 工具指导 | 500-2,000 tokens | MEMORY + SKILLS + TOOL_USE_ENFORCEMENT |
| L3: 用户System Prompt | 0-1,000 tokens | 可选 |
| L4: 记忆 | 500-1,500 tokens | MEMORY.md + USER.md |
| L5: 技能索引 | 1,000-3,000 tokens | 78 个 SKILL 的 Tier 1 摘要 |
| L6: 上下文文件 | 0-5,000 tokens | AGENTS.md, .cursorrules, .hermes.md |
| L7: 时间戳+平台 | 50-200 tokens | 时间、模型信息、平台提示 |

上下文文件有硬限制：`CONTEXT_FILE_MAX_CHARS = 20_000`（`agent/prompt_builder.py:399`）。超过此限制的上下文文件会被截断，防止一个巨大的 AGENTS.md 占据整个上下文窗口。

结合第 7 章讨论的上下文压缩机制，System Prompt的大小直接影响了可用于对话的上下文空间。这就是为什么记忆指导强调"keep it compact"——System Prompt中的每一个 token 都是从对话空间中"借"来的。

---

## 6.8 本章为什么重要

System Prompt是 Agent 行为的"宪法"——所有其他组件（工具、记忆、技能）都在System Prompt定义的框架内运行。理解了七层组装，你就理解了为什么 Hermes 在不同平台、不同模型、不同用户之间表现出不同但一致的行为。

第 5 章展示了System Prompt如何被缓存和重用。第 7 章将展示上下文压缩如何触发System Prompt的重建。第 8 章将讨论 prompt caching 如何与 Anthropic Messages API 适配器协同工作。

---

## 速查表

| 文件 | 行号 | 角色 |
|------|------|------|
| `run_agent.py` | 3057-3222 | `_build_system_prompt()` — 七层组装主方法 |
| `agent/prompt_builder.py` | 35-46 | `_CONTEXT_THREAT_PATTERNS` — 10 种注入检测模式 |
| `agent/prompt_builder.py` | 48-51 | `_CONTEXT_INVISIBLE_CHARS` — 不可见 Unicode 检测 |
| `agent/prompt_builder.py` | 54-70 | `_scan_context_content()` — 安全扫描与阻断 |
| `agent/prompt_builder.py` | 133-141 | `DEFAULT_AGENT_IDENTITY` — 默认 Agent 身份 |
| `agent/prompt_builder.py` | 143-170 | `MEMORY_GUIDANCE` / `SESSION_SEARCH_GUIDANCE` / `SKILLS_GUIDANCE` |
| `agent/prompt_builder.py` | 172-185 | `TOOL_USE_ENFORCEMENT_GUIDANCE` — 工具使用执行力 |
| `agent/prompt_builder.py` | 189 | `TOOL_USE_ENFORCEMENT_MODELS` — 需要执行力的模型 |
| `agent/prompt_builder.py` | 195-253 | `OPENAI_MODEL_EXECUTION_GUIDANCE` — GPT 专用指导 |
| `agent/prompt_builder.py` | 258-276 | `GOOGLE_MODEL_OPERATIONAL_GUIDANCE` — Gemini 专用指导 |
| `agent/prompt_builder.py` | 285-367 | `PLATFORM_HINTS` — 15 个平台的格式指导 |
| `agent/prompt_builder.py` | 375-396 | `build_environment_hints()` — WSL 等环境检测 |
| `agent/prompt_builder.py` | 399 | `CONTEXT_FILE_MAX_CHARS` — 上下文文件大小限制 |
| `agent/prompt_caching.py` | 14-38 | `_apply_cache_marker()` — 缓存标记注入 |
| `agent/prompt_caching.py` | 40-71 | `apply_anthropic_cache_control()` — system_and_3 策略 |
