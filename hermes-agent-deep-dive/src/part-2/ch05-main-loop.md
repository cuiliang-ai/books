
# 第 5 章：主循环解剖

> **核心问题**：`run_conversation()` 的 while 循环里到底发生了什么？从用户消息到最终响应，每一步的决策逻辑是什么？

---

## 5.1 方法签名与入口仪式

`run_conversation()` 从第 7544 行开始，是 AIAgent 中最长、最复杂的方法。它的签名简洁得出人意料：

```python
# run_agent.py:7544-7552
def run_conversation(
    self,
    user_message: str,
    system_message: str = None,
    conversation_history: List[Dict[str, Any]] = None,
    task_id: str = None,
    stream_callback: Optional[callable] = None,
    persist_user_message: Optional[str] = None,
) -> Dict[str, Any]:
```

六个参数，返回一个字典。但这个方法的实际复杂度远超签名所暗示的——在进入主循环之前，有一段长达 300 行的"入口仪式"，负责初始化会话状态、构建系统提示、执行入口预压缩。

入口仪式的第一步是**环境防护**：

```python
# run_agent.py:7572-7574
_install_safe_stdio()
from hermes_logging import set_session_context
set_session_context(self.session_id)
```

`_install_safe_stdio()` 再次被调用——即使 `__init__` 已经调用过一次。这是防御性编程：Gateway 模式下，`run_conversation()` 可能在 `__init__` 之后很久才被调用，期间 stdio 状态可能已经改变。

接下来是**输入清洗**：

```python
# run_agent.py:7589-7591
if isinstance(user_message, str):
    user_message = _sanitize_surrogates(user_message)
```

从富文本编辑器（Google Docs、Word）粘贴的文本可能包含孤立代理字符（lone surrogates），这些字符在 Python 的 UTF-8 JSON 序列化中会崩溃。`_sanitize_surrogates()` 在入口处统一清洗。

然后是**运行时恢复**：

```python
# run_agent.py:7583-7584
self._restore_primary_runtime()
```

如果上一轮激活了 fallback 模型，这一轮开始时恢复到主模型。每一轮都给主模型一次重新尝试的机会——这是一个"乐观恢复"策略。fallback 不是永久的降级，它只是一次临时的绕行。降级与恢复的完整逻辑在第 9 章详述。

---

## 5.2 系统提示的缓存与重用

系统提示的构建策略是 `run_conversation()` 中一个精心设计的优化点。核心原则是：**一次构建，整个会话复用**。

```python
# run_agent.py:7699-7738
if self._cached_system_prompt is None:
    stored_prompt = None
    if conversation_history and self._session_db:
        try:
            session_row = self._session_db.get_session(self.session_id)
            if session_row:
                stored_prompt = session_row.get("system_prompt") or None
        except Exception:
            pass

    if stored_prompt:
        self._cached_system_prompt = stored_prompt
    else:
        self._cached_system_prompt = self._build_system_prompt(system_message)
```

这段代码的决策树：

1. 如果系统提示已缓存（`_cached_system_prompt is not None`），跳过——什么都不做。
2. 如果有会话历史且 SQLite 中存储了之前的系统提示，**直接复用**——不重新构建。
3. 否则，调用 `_build_system_prompt()` 从头构建，然后缓存。

第二条规则是为 Gateway 模式设计的。Gateway 每条消息创建一个新 AIAgent，但同一个会话的系统提示应该保持不变——如果每次都重新构建，记忆内容可能发生变化（因为 Agent 自己会写入记忆），导致不同的系统提示，打破 Anthropic 的 prompt cache 前缀匹配。prompt caching 要求前缀完全一致才能命中缓存，这个经济效益在第 6 章详细分析。

---

## 5.3 入口预压缩

在进入主循环之前，`run_conversation()` 执行一个预压缩步骤（源码中称为 preflight）——检查当前上下文是否已经超过阈值：

```python
# run_agent.py:7747-7796
if (
    self.compression_enabled
    and len(messages) > self.context_compressor.protect_first_n
                        + self.context_compressor.protect_last_n + 1
):
    _preflight_tokens = estimate_request_tokens_rough(
        messages,
        system_prompt=active_system_prompt or "",
        tools=self.tools or None,
    )

    if _preflight_tokens >= self.context_compressor.threshold_tokens:
        for _pass in range(3):
            _orig_len = len(messages)
            messages, active_system_prompt = self._compress_context(
                messages, system_message, approx_tokens=_preflight_tokens,
                task_id=effective_task_id,
            )
            if len(messages) >= _orig_len:
                break  # Cannot compress further
```

为什么需要入口预压缩？考虑这个场景：用户从 Claude（200K 上下文）切换到一个只有 64K 上下文的本地模型，但会话历史已经积累了 150K tokens。如果不做入口预压缩，第一个 API 调用就会因为上下文溢出而失败——这是一个 4xx 错误，可能被错误分类为不可重试。

入口预压缩最多执行 3 轮（`for _pass in range(3)`），因为每轮压缩只能消除"中间段"的消息——如果系统提示本身就超过了阈值，更多的压缩轮次也无济于事。

注意一个细微的副作用：压缩后 `conversation_history` 被设置为 `None`（第 7788 行），确保压缩后的消息被当作"全新的起点"写入 SQLite——否则 `_flush_messages_to_session_db` 会跳过已有的消息，导致压缩后的摘要消息丢失。

---

## 5.4 插件钩子：pre_llm_call

紧接着入口预压缩的是插件钩子系统——Hermes 的扩展点之一：

```python
# run_agent.py:7810-7832
try:
    from hermes_cli.plugins import invoke_hook as _invoke_hook
    _pre_results = _invoke_hook(
        "pre_llm_call",
        session_id=self.session_id,
        user_message=original_user_message,
        conversation_history=list(messages),
        is_first_turn=(not bool(conversation_history)),
        model=self.model,
        platform=getattr(self, "platform", None) or "",
    )
```

插件返回的上下文被注入到**用户消息**中，而不是系统提示中。注释解释了为什么：

> Context is ALWAYS injected into the user message, never the system prompt. This preserves the prompt cache prefix.

系统提示是 Hermes 的领地，插件贡献的上下文放在用户消息旁边。这个约束看起来是技术上的妥协，但它实现了一个重要的架构目标：系统提示在整个会话中保持稳定，最大化 prompt caching 的命中率。

---

## 5.5 主循环的心跳

终于进入主循环。这是 Hermes Agent 的心跳：

```python
# run_agent.py:7866
while (api_call_count < self.max_iterations and self.iteration_budget.remaining > 0) or self._budget_grace_call:
```

循环条件有三个组件：

1. `api_call_count < self.max_iterations` — 当前轮次的本地计数器
2. `self.iteration_budget.remaining > 0` — 全局迭代预算
3. `self._budget_grace_call` — 预算耗尽后的"恩典"调用标志

第三个条件是一个精妙的设计：当预算耗尽时，Agent 不会立即停止。它会注入一条消息告诉模型"你的预算快用完了，请给出最终回复"，然后允许一次额外的 API 调用。这给了模型一个机会来优雅地总结工作，而不是戛然而止。

循环体的第一步是**中断检查**：

```python
# run_agent.py:7871-7876
if self._interrupt_requested:
    interrupted = True
    _turn_exit_reason = "interrupted_by_user"
    if not self.quiet_mode:
        self._safe_print("\n⚡ Breaking out of tool loop due to interrupt...")
    break
```

这是 Gateway 模式的关键机制。当用户在 Telegram 上发送新消息时，Gateway 设置 `_interrupt_requested = True`，主循环在下一次迭代开始时检测到它并退出。中断是"协作式"的——不是强制终止线程，而是在安全点（循环头部）检查标志。

---

## 5.6 消息准备流水线

每次 API 调用之前，主循环构建一个 `api_messages` 列表——这是发送给 LLM 的最终消息序列。这个构建过程是一条精心设计的流水线：

```python
# run_agent.py:7931-7978
api_messages = []
for idx, msg in enumerate(messages):
    api_msg = msg.copy()

    # 注入临时上下文到当前轮次的用户消息
    if idx == current_turn_user_idx and msg.get("role") == "user":
        _injections = []
        if _ext_prefetch_cache:
            _fenced = build_memory_context_block(_ext_prefetch_cache)
            if _fenced:
                _injections.append(_fenced)
        if _plugin_user_context:
            _injections.append(_plugin_user_context)
        if _injections:
            _base = api_msg.get("content", "")
            api_msg["content"] = _base + "\n\n" + "\n\n".join(_injections)

    # 传递推理内容给 API
    if msg.get("role") == "assistant":
        reasoning_text = msg.get("reasoning")
        if reasoning_text:
            api_msg["reasoning_content"] = reasoning_text

    # 清理内部字段
    api_msg.pop("reasoning", None)
    api_msg.pop("finish_reason", None)
    api_msg.pop("_thinking_prefill", None)
    api_messages.append(api_msg)
```

这条流水线做了几件关键的事：

1. **外部记忆注入** — 来自 Memory Provider 的上下文被 fenced 包裹后注入用户消息
2. **推理内容传递** — assistant 消息的 `reasoning` 字段（内部存储用）被转换为 `reasoning_content`（API 兼容格式）
3. **内部字段清洗** — `finish_reason`、`_thinking_prefill` 等内部标记被移除，避免严格的 API 端点拒绝未知字段

注意 `messages` 列表本身**不被修改**——流水线操作的是 `msg.copy()` 产生的副本。这确保了内部消息历史的完整性。

接下来是系统消息的组装和缓存注入：

```python
# run_agent.py:7980-8012
effective_system = active_system_prompt or ""
if self.ephemeral_system_prompt:
    effective_system = (effective_system + "\n\n" + self.ephemeral_system_prompt).strip()
if effective_system:
    api_messages = [{"role": "system", "content": effective_system}] + api_messages

if self._use_prompt_caching:
    api_messages = apply_anthropic_cache_control(
        api_messages, cache_ttl=self._cache_ttl,
        native_anthropic=(self.api_mode == 'anthropic_messages')
    )

api_messages = self._sanitize_api_messages(api_messages)
```

`_sanitize_api_messages()` 是一个关键的安全网——它修复因压缩或手动消息操作导致的"孤立"工具消息：有 `tool_calls` 但没有对应的 `tool` 结果，或有 `tool` 结果但没有匹配的 `tool_calls`。这些不一致会导致 API 返回 400 错误。

消息准备的最后一步是**JSON 规范化**——对 tool_calls 的 arguments 字段进行 `json.dumps(sort_keys=True, separators=(",", ":"))`，确保每次生成的消息是 bit-perfect 一致的。这是 KV cache 优化的需要：本地推理服务器（llama.cpp, vLLM, Ollama）通过前缀匹配复用 KV cache，任何微小的差异都会导致 cache miss。

---

## 5.7 API 调用：始终流式

主循环的核心是 API 调用。Hermes 做了一个看似激进的选择——**始终使用流式路径**：

```python
# run_agent.py:8124-8157
# Always prefer the streaming path — even without stream
# consumers. Streaming gives us fine-grained health
# checking (90s stale-stream detection, 60s read timeout)
# that the non-streaming path lacks.
_use_streaming = True
if not self._has_stream_consumers():
    from unittest.mock import Mock
    if isinstance(getattr(self, "client", None), Mock):
        _use_streaming = False

if _use_streaming:
    response = self._interruptible_streaming_api_call(
        api_kwargs, on_first_delta=_stop_spinner
    )
else:
    response = self._interruptible_api_call(api_kwargs)
```

注释解释了为什么：即使没有流式消费者（如 TTS 管道或 CLI TUI），流式路径也提供了非流式路径没有的**健康检查能力**——90 秒的静默流检测和 60 秒的读超时。没有这些，子代理和安静模式的调用者可能在提供商保持连接但不返回数据时无限等待。

唯一的例外是测试中的 Mock 客户端——Mock 对象不支持流式迭代器，所以回退到非流式路径。

`on_first_delta=_stop_spinner` 参数让思考动画在收到第一个 token 时立即停止——从视觉上给用户一个"模型开始回复了"的信号。

---

## 5.8 响应验证的三分支

API 调用返回后，主循环立即验证响应的有效性。验证逻辑按 `api_mode` 分为三个分支：

```python
# run_agent.py:8180-8234
if self.api_mode == "codex_responses":
    output_items = getattr(response, "output", None)
    if response is None:
        response_invalid = True
    elif not isinstance(output_items, list):
        response_invalid = True

elif self.api_mode == "anthropic_messages":
    content_blocks = getattr(response, "content", None)
    if not content_blocks:
        response_invalid = True

else:  # chat_completions
    if response is None or not hasattr(response, 'choices') or not response.choices:
        response_invalid = True
```

每种协议有不同的"有效响应"标准：
- **Codex Responses**：需要 `response.output` 是非空列表（或 `output_text` 有内容）
- **Anthropic Messages**：需要 `response.content` 是非空列表
- **Chat Completions**：需要 `response.choices` 是非空列表

如果响应无效，主循环执行一个分层恢复策略：先尝试 fallback 切换，然后重试（带指数退避），最后放弃。这个恢复策略的细节在第 9 章深入分析。

---

## 5.9 finish_reason 与循环控制

通过验证后，主循环从响应中提取 `finish_reason`——这决定了循环是继续还是结束：

```python
# run_agent.py:8374-8378
if self.api_mode == "anthropic_messages":
    stop_reason_map = {
        "end_turn": "stop",
        "tool_use": "tool_calls",
        "max_tokens": "length",
        "stop_sequence": "stop",
    }
    finish_reason = stop_reason_map.get(response.stop_reason, "stop")
else:
    finish_reason = response.choices[0].finish_reason
```

Anthropic 使用不同的术语（`end_turn` vs `stop`，`tool_use` vs `tool_calls`），这里通过一个映射表统一。统一后的 `finish_reason` 有三个关键值：

- **`"stop"`** — 模型认为回答完成，循环结束
- **`"tool_calls"`** — 模型请求调用工具，循环继续
- **`"length"`** — 输出被截断，触发续写或回退逻辑

`"length"` 的处理特别复杂——它需要区分"思考预算耗尽"（模型全部 token 花在推理上）和"正常截断"（回复太长）。前者直接返回错误提示，后者尝试最多 3 次续写请求。思考预算耗尽的检测使用正则匹配 `<think>` 标签——如果响应包含思考标签但没有可见文本输出，说明所有 output tokens 都被推理消耗了。

---

## 5.10 工具调用分发

当 `finish_reason` 是 `"tool_calls"` 时，循环进入工具执行阶段。`_execute_tool_calls()` 是分发入口：

```python
# run_agent.py:6703-6724
def _execute_tool_calls(self, assistant_message, messages, effective_task_id, api_call_count=0):
    tool_calls = assistant_message.tool_calls
    self._executing_tools = True
    try:
        if not _should_parallelize_tool_batch(tool_calls):
            return self._execute_tool_calls_sequential(
                assistant_message, messages, effective_task_id, api_call_count
            )
        return self._execute_tool_calls_concurrent(
            assistant_message, messages, effective_task_id, api_call_count
        )
    finally:
        self._executing_tools = False
```

关键决策点是 `_should_parallelize_tool_batch()`——它决定一批工具调用是串行执行还是并行执行。

### 并行安全判断

```python
# run_agent.py:219-234
_PARALLEL_SAFE_TOOLS = frozenset({
    "ha_get_state", "ha_list_entities", "ha_list_services",
    "read_file", "search_files", "session_search",
    "skill_view", "skills_list", "vision_analyze",
    "web_extract", "web_search",
})

_PATH_SCOPED_TOOLS = frozenset({"read_file", "write_file", "patch"})
_NEVER_PARALLEL_TOOLS = frozenset({"clarify"})
```

三个集合定义了并行策略：

- `_NEVER_PARALLEL_TOOLS` — 绝对不能并行的工具。`clarify` 是交互式的——它需要等待用户输入，并行执行多个 clarify 会导致混乱。
- `_PARALLEL_SAFE_TOOLS` — 只读工具，无共享可变状态，可以安全并行。
- `_PATH_SCOPED_TOOLS` — 文件工具，只有在操作不同路径时才能并行。

`_should_parallelize_tool_batch()` 的逻辑是保守的——任何不在白名单中的工具都会让整个批次回退到串行。这是正确的取舍：并行执行的正确性保证比性能更重要。一个 `terminal` 工具调用修改了文件系统状态，另一个 `read_file` 依赖于该状态——并行执行会产生数据竞争。

并行执行使用 `ThreadPoolExecutor`，最大 8 个工作线程（`_MAX_TOOL_WORKERS = 8`）。

---

## 5.11 工具调用路由

`_invoke_tool()` 是单个工具调用的路由方法。它区分两类工具：**Agent 级别工具**和**注册表工具**。

```python
# run_agent.py:6726-6788
def _invoke_tool(self, function_name, function_args, effective_task_id, tool_call_id=None):
    if function_name == "todo":
        from tools.todo_tool import todo_tool as _todo_tool
        return _todo_tool(todos=function_args.get("todos"), store=self._todo_store)
    elif function_name == "session_search":
        # ...uses self._session_db
    elif function_name == "memory":
        # ...uses self._memory_store
    elif function_name == "clarify":
        # ...uses self.clarify_callback
    elif function_name == "delegate_task":
        # ...creates child AIAgent
    else:
        return handle_function_call(function_name, function_args, task_id=effective_task_id)
```

Agent 级别工具（todo, session_search, memory, clarify, delegate_task）拥有 AIAgent 实例状态的访问权——它们需要 `self._todo_store`、`self._session_db`、`self._memory_store` 等。注册表工具（terminal, read_file, web_search 等）通过 `handle_function_call()` 分发，它们是无状态的——只依赖参数和全局状态。

这种二分法解释了为什么某些工具在 `run_agent.py` 中有特殊处理而不是统一通过注册表——它们需要 Agent 的上下文。

---

## 5.12 循环终止条件

主循环有五种终止方式，每种对应不同的退出原因：

**条件一：自然结束** — 模型返回 `finish_reason="stop"` 且没有 tool_calls。这是最常见的终止条件——模型认为任务完成了。

**条件二：预算耗尽** — `iteration_budget.consume()` 返回 `False`。当预算耗尽时，Agent 会注入一条系统消息要求模型总结，然后设置 `_budget_grace_call = True` 允许一次额外调用。

**条件三：用户中断** — `_interrupt_requested` 为 `True`。Gateway 设置这个标志来中断正在运行的 Agent。

**条件四：不可恢复错误** — API 连续失败超过 `max_retries`（默认 3 次）且 fallback 链也耗尽。

**条件五：上下文溢出** — 压缩尝试超过 `max_compression_attempts`（默认 3 次）仍无法将上下文缩小到阈值以下。

每种终止方式都设置 `_turn_exit_reason`——一个诊断用的字符串，记录循环为什么结束。这对 Gateway 的日志分析和 RL 训练数据生成都至关重要。

---

## 5.13 会话后处理

主循环结束后，`run_conversation()` 执行清理和持久化：

1. **记忆刷新** — 如果用户轮次计数达到 `_memory_flush_min_turns`，将内存中的记忆写入磁盘
2. **轨迹保存** — 如果 `save_trajectories` 为 True，将完整消息历史写入 JSONL 文件
3. **会话持久化** — 将消息增量写入 SQLite
4. **资源清理** — 释放 VM、浏览器等临时资源
5. **技能推送检查** — 如果本轮工具迭代次数达到 `_skill_nudge_interval`，在返回结果中注入技能创建提示

返回值是一个字典，调用者（CLI 或 Gateway）从中提取 `final_response` 展示给用户，保存 `messages` 供下一轮使用。

---

## 5.14 完整时序图

将上述所有步骤串联起来，`run_conversation()` 的完整时序是：

```
run_conversation(user_message)
│
├── 1. 入口仪式
│   ├── _install_safe_stdio()
│   ├── _restore_primary_runtime()
│   ├── _sanitize_surrogates(user_message)
│   ├── 重置重试计数器
│   └── 创建新 IterationBudget
│
├── 2. 系统提示
│   ├── 从 SQLite 加载已有提示 (Gateway 路径)
│   └── 或 _build_system_prompt() 从头构建 (首轮)
│
├── 3. 入口预压缩
│   ├── estimate_request_tokens_rough()
│   └── _compress_context() × 最多 3 轮
│
├── 4. 插件钩子 (pre_llm_call)
│
├── 5. 主循环 ──────────────────────────────────────────┐
│   │                                                    │
│   ├── 中断检查                                         │
│   ├── 预算消耗                                         │
│   ├── 消息准备流水线                                    │
│   │   ├── 记忆注入 → 用户消息                           │
│   │   ├── reasoning → reasoning_content                │
│   │   ├── 系统消息 + ephemeral 拼接                     │
│   │   ├── prompt caching 断点注入                       │
│   │   └── _sanitize_api_messages()                     │
│   ├── API 调用 (始终流式)                               │
│   ├── 响应验证 (三分支)                                 │
│   ├── finish_reason 提取                               │
│   ├── 工具调用?                                        │
│   │   ├── 是 → _execute_tool_calls() → 结果注入 → 继续  │
│   │   └── 否 → 提取文本响应 → 跳出循环                  │
│   └── ──────────────────────────────────── (loop) ─────┘
│
├── 6. 后处理
│   ├── 记忆刷新
│   ├── 轨迹保存
│   ├── 会话持久化
│   └── 技能推送检查
│
└── return { final_response, messages, api_calls, ... }
```

这就是 Hermes Agent 的心跳——一个精心编排的循环，每次迭代都在"调用 LLM → 执行工具 → 注入结果"的闭环中推进任务。下一章将深入系统提示的构建（步骤 2），第 7 章将展开入口预压缩的内部算法（步骤 3），第 9 章将解析错误恢复和降级的完整策略。

---

## 速查表

| 文件 | 行号 | 角色 |
|------|------|------|
| `run_agent.py` | 7544 | `run_conversation()` 入口 |
| `run_agent.py` | 7699-7738 | 系统提示缓存与重用 |
| `run_agent.py` | 7747-7796 | 入口预压缩 |
| `run_agent.py` | 7866 | 主循环 while 条件 |
| `run_agent.py` | 7931-7978 | 消息准备流水线 |
| `run_agent.py` | 8124-8157 | API 调用（始终流式） |
| `run_agent.py` | 8180-8234 | 响应验证三分支 |
| `run_agent.py` | 8374-8378 | finish_reason 统一 |
| `run_agent.py` | 6703-6724 | `_execute_tool_calls()` 串/并行分发 |
| `run_agent.py` | 219-234 | `_PARALLEL_SAFE_TOOLS` / `_PATH_SCOPED_TOOLS` |
| `run_agent.py` | 267-313 | `_should_parallelize_tool_batch()` |
| `run_agent.py` | 6726-6788 | `_invoke_tool()` 工具路由 |
| `model_tools.py` | — | `handle_function_call()` 注册表分发 |
