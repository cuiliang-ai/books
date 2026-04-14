
# 第 19 章：Session Search 与跨会话召回

> **核心问题**：FTS5 全文检索 + LLM 摘要如何实现跨会话的长期记忆？

---

## 19.1 第三种记忆形式

第 17 章的 Memory 系统提供了精炼的知识条目，第 18 章的 Skills 系统提供了程序化的操作指南。但有一类回忆需求这两者都无法满足：**原始对话回忆**。"上次我们调试那个 Docker 网络问题时，最后用了什么方案？""我之前让你给我做的那个脚本在哪里？""上周讨论的 API 设计最终定的是哪个方案？"

这些问题需要搜索具体的对话历史——不是提炼后的知识，而是原始的对话记录。Session Search 工具就是为此设计的。它构建在第 16 章的 SessionDB 之上，利用 FTS5 全文索引快速定位相关会话，然后用辅助 LLM（Gemini Flash 等轻量模型）生成聚焦的摘要，将长对话压缩成可以注入上下文窗口的精炼回忆。

```python
# tools/session_search_tool.py:1-16
"""
Session Search Tool - Long-Term Conversation Recall

Searches past session transcripts in SQLite via FTS5, then summarizes the
top matching sessions using a cheap/fast model (same pattern as web_extract).
Returns focused summaries of past conversations rather than raw transcripts,
keeping the main model's context window clean.

Flow:
  1. FTS5 search finds matching messages ranked by relevance
  2. Groups by session, takes the top N unique sessions (default 3)
  3. Loads each session's conversation, truncates to ~100k chars
  4. Sends to Gemini Flash with a focused summarization prompt
  5. Returns per-session summaries with metadata
"""
```

这个五步流程是 Session Search 的架构核心。它不是把原始对话塞进上下文窗口（那会消耗大量 token），而是通过"搜索 → 摘要 → 注入"的三步管道，将历史对话变成紧凑的回忆片段。

---

## 19.2 两种搜索模式

Session Search 工具提供两种操作模式，通过 `query` 参数是否为空来区分。

**近期浏览模式**（空查询）返回最近的会话元数据——标题、预览、时间戳——不涉及任何 LLM 调用，零成本，即时响应。当用户问"我们最近做了什么"或"之前在搞什么"时，Agent 使用这种模式：

```python
# tools/session_search_tool.py:247-268
def session_search(query: str, role_filter: str = None, limit: int = 3,
                   db=None, current_session_id: str = None) -> str:
    if db is None:
        return tool_error("Session database not available.", success=False)

    limit = min(limit, 5)  # Cap at 5 sessions

    # Recent sessions mode: when query is empty, return metadata.
    # No LLM calls — just DB queries.
    if not query or not query.strip():
        return _list_recent_sessions(db, limit, current_session_id)
```

`_list_recent_sessions` 调用 SessionDB 的 `list_sessions_rich()` 方法（第 16 章），返回会话 ID、标题、来源、时间戳、消息数和首条用户消息的预览。当前会话及其谱系链被排除——Agent 已经有当前会话的上下文，搜索它没有意义。

**关键词搜索模式**（有查询）使用 FTS5 全文检索定位相关消息，然后用 LLM 生成摘要。这是 Session Search 的核心能力。

---

## 19.3 FTS5 搜索与会话去重

关键词搜索的第一步是调用 SessionDB 的 `search_messages` 方法（第 16 章详述），获取最多 50 条匹配消息：

```python
# tools/session_search_tool.py:278-285
raw_results = db.search_messages(
    query=query,
    role_filter=role_list,
    exclude_sources=list(_HIDDEN_SESSION_SOURCES),
    limit=50,  # Get more matches to find unique sessions
    offset=0,
)
```

搜索获取 50 条匹配是因为需要从中提取足够多的**唯一会话**。多条匹配可能来自同一个会话——比如用户在一次会话中多次提到 "docker"。搜索结果按 BM25 相关性排序，然后需要去重到会话级别。

去重过程有一个微妙的复杂性：**委派链条解析**。当 Agent 将任务委派给子 Agent 时（第 15 章），子 Agent 的工作存储在独立的子会话中。FTS5 可能在子会话中找到匹配，但用户关心的是包含完整上下文的父会话。`_resolve_to_parent` 沿着 `parent_session_id` 链条上溯到根会话：

```python
# tools/session_search_tool.py:298-321
def _resolve_to_parent(session_id: str) -> str:
    """Walk delegation chain to find the root parent session ID."""
    visited = set()
    sid = session_id
    while sid and sid not in visited:
        visited.add(sid)
        try:
            session = db.get_session(sid)
            if not session:
                break
            parent = session.get("parent_session_id")
            if parent:
                sid = parent
            else:
                break
        except Exception as e:
            logging.debug(
                "Error resolving parent for session %s: %s",
                sid, e, exc_info=True,
            )
            break
    return sid
```

`visited` 集合防止循环引用——虽然正常情况下不应该出现，但防御性编程在处理持久化数据时是必要的。

当前会话的排除也通过谱系解析实现。如果当前会话是一个子会话（比如压缩后的延续会话），排除逻辑会追溯到根会话，然后排除整个谱系链中的所有会话。这确保了 Agent 不会"搜索到自己正在进行的对话"。

```python
# tools/session_search_tool.py:323-345
current_lineage_root = (
    _resolve_to_parent(current_session_id) if current_session_id else None
)

seen_sessions = {}
for result in raw_results:
    raw_sid = result["session_id"]
    resolved_sid = _resolve_to_parent(raw_sid)
    if current_lineage_root and resolved_sid == current_lineage_root:
        continue
    if current_session_id and raw_sid == current_session_id:
        continue
    if resolved_sid not in seen_sessions:
        result = dict(result)
        result["session_id"] = resolved_sid
        seen_sessions[resolved_sid] = result
    if len(seen_sessions) >= limit:
        break
```

隐藏会话源（`_HIDDEN_SESSION_SOURCES = ("tool",)`）也被排除。第三方集成（如 Paperclip agents）用 `source="tool"` 标记它们的会话，这些内部工具会话不应出现在用户的搜索结果中。

---

## 19.4 对话格式化与截断

确定了目标会话后，下一步是加载每个会话的完整对话历史并格式化为可摘要的文本。`_format_conversation` 将消息列表转换为人类可读的 transcript：

```python
# tools/session_search_tool.py:55-86
def _format_conversation(messages: List[Dict[str, Any]]) -> str:
    parts = []
    for msg in messages:
        role = msg.get("role", "unknown").upper()
        content = msg.get("content") or ""
        tool_name = msg.get("tool_name")

        if role == "TOOL" and tool_name:
            if len(content) > 500:
                content = content[:250] + "\n...[truncated]...\n" + content[-250:]
            parts.append(f"[TOOL:{tool_name}]: {content}")
        elif role == "ASSISTANT":
            tool_calls = msg.get("tool_calls")
            if tool_calls and isinstance(tool_calls, list):
                tc_names = [...]
                if tc_names:
                    parts.append(f"[ASSISTANT]: [Called: {', '.join(tc_names)}]")
                if content:
                    parts.append(f"[ASSISTANT]: {content}")
            else:
                parts.append(f"[{role}]: {content}")
        else:
            parts.append(f"[{role}]: {content}")

    return "\n\n".join(parts)
```

工具输出被截断到 500 字符（保留首尾各 250 字符），因为工具输出通常很长但对摘要价值有限。Assistant 的工具调用只保留函数名，不保留参数——摘要模型需要知道 Agent 做了什么，但不需要具体参数。

格式化后的对话可能非常长。`_truncate_around_matches` 将其截断到 `MAX_SESSION_CHARS = 100_000` 字符，截断窗口**以匹配位置为中心**：

```python
# tools/session_search_tool.py:89-122
def _truncate_around_matches(
    full_text: str, query: str, max_chars: int = MAX_SESSION_CHARS
) -> str:
    if len(full_text) <= max_chars:
        return full_text

    query_terms = query.lower().split()
    text_lower = full_text.lower()
    first_match = len(full_text)
    for term in query_terms:
        pos = text_lower.find(term)
        if pos != -1 and pos < first_match:
            first_match = pos

    if first_match == len(full_text):
        first_match = 0

    half = max_chars // 2
    start = max(0, first_match - half)
    end = min(len(full_text), start + max_chars)
    if end - start < max_chars:
        start = max(0, end - max_chars)

    truncated = full_text[start:end]
    prefix = "...[earlier conversation truncated]...\n\n" if start > 0 else ""
    suffix = "\n\n...[later conversation truncated]..." if end < len(full_text) else ""
    return prefix + truncated + suffix
```

截断策略是以第一个匹配项为中心开一个窗口——前后各 50K 字符。这确保了与查询最相关的对话内容被保留在截断窗口中，而不是简单地从头开始截断（那可能把最相关的内容切掉）。如果没有找到匹配项（理论上不应该发生，因为 FTS5 已经匹配过了），回退到从开头截断。

---

## 19.5 LLM 辅助摘要

截断后的对话被发送给辅助 LLM（通过 `agent/auxiliary_client.py` 的 `async_call_llm`）生成聚焦摘要。摘要的 system prompt 明确指导模型关注五个维度：

```python
# tools/session_search_tool.py:125-138
system_prompt = (
    "You are reviewing a past conversation transcript to help recall "
    "what happened. Summarize the conversation with a focus on the "
    "search topic. Include:\n"
    "1. What the user asked about or wanted to accomplish\n"
    "2. What actions were taken and what the outcomes were\n"
    "3. Key decisions, solutions found, or conclusions reached\n"
    "4. Any specific commands, files, URLs, or technical details\n"
    "5. Anything left unresolved or notable\n\n"
    "Be thorough but concise. Preserve specific details (commands, "
    "paths, error messages) that would be useful to recall. Write in "
    "past tense as a factual recap."
)
```

这个 prompt 的设计反映了 Session Search 的核心价值主张：不是返回原始对话（太长），也不是返回一句话摘要（太短），而是生成一个**可操作的回忆**——保留具体的命令、路径、错误信息，这些是用户在回忆过去工作时最需要的细节。

`_summarize_session` 是异步函数，支持重试。最多重试 3 次，每次间隔递增（1s、2s、3s）。如果辅助模型不可用（`RuntimeError`），直接返回 None 而不重试——这种情况说明没有配置辅助模型，重试也没用：

```python
# tools/session_search_tool.py:153-186
async def _summarize_session(
    conversation_text: str, query: str, session_meta: Dict[str, Any]
) -> Optional[str]:
    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = await async_call_llm(
                task="session_search",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.1,
                max_tokens=MAX_SUMMARY_TOKENS,
            )
            content = extract_content_or_reasoning(response)
            if content:
                return content
            ...
        except RuntimeError:
            logging.warning("No auxiliary model available")
            return None
```

`temperature=0.1` 确保摘要的一致性——对于事实性回忆，不需要创造性。`MAX_SUMMARY_TOKENS = 10000` 允许生成足够详细的摘要。

---

## 19.6 并行摘要生成

多个会话的摘要可以并行生成——它们之间没有依赖关系。`_summarize_all` 使用 `asyncio.gather` 并行执行所有摘要任务：

```python
# tools/session_search_tool.py:367-383
async def _summarize_all() -> List[Union[str, Exception]]:
    coros = [
        _summarize_session(text, query, meta)
        for _, _, text, meta in tasks
    ]
    return await asyncio.gather(*coros, return_exceptions=True)

try:
    from model_tools import _run_async
    results = _run_async(_summarize_all())
except concurrent.futures.TimeoutError:
    logging.warning("Session summarization timed out after 60 seconds")
    return json.dumps({
        "success": False,
        "error": "Session summarization timed out. Try a more specific "
                 "query or reduce the limit.",
    }, ...)
```

`return_exceptions=True` 确保一个会话的摘要失败不会影响其他会话。失败的摘要在最终结果组装时被检测，回退到原始对话的前 500 字符预览：

```python
# tools/session_search_tool.py:395-416
for (session_id, match_info, conversation_text, _), result in zip(tasks, results):
    if isinstance(result, Exception):
        result = None

    entry = {
        "session_id": session_id,
        "when": _format_timestamp(match_info.get("session_started")),
        "source": match_info.get("source", "unknown"),
        "model": match_info.get("model"),
    }

    if result:
        entry["summary"] = result
    else:
        preview = (conversation_text[:500] + "\n…[truncated]") if conversation_text else "No preview available."
        entry["summary"] = f"[Raw preview — summarization unavailable]\n{preview}"

    summaries.append(entry)
```

这个 fallback 设计确保了当辅助模型不可用时（比如没有配置 Gemini API Key），Session Search 仍然返回有用的结果——虽然是原始预览而非摘要，但总比什么都不返回好。这体现了 Hermes 全局遵循的"优雅降级"原则。

`_run_async` 的使用值得注意——它不是简单的 `asyncio.run()`。直接的 `asyncio.run()` 会创建一个新的 event loop，这在 Gateway 模式下会与缓存的 `AsyncOpenAI`/`httpx` 客户端（绑定到不同 loop）冲突，导致死锁。`_run_async` 正确地管理了 CLI、Gateway 和 worker-thread 三种上下文中的 event loop。

---

## 19.7 工具 Schema 与行为引导

Session Search 的 schema 描述包含了详细的使用指导，告诉模型何时应该主动搜索：

```python
# tools/session_search_tool.py:442-486
SESSION_SEARCH_SCHEMA = {
    "name": "session_search",
    "description": (
        "Search your long-term memory of past conversations, or browse "
        "recent sessions. This is your recall -- every past session is "
        "searchable, and this tool summarizes what happened.\n\n"
        "TWO MODES:\n"
        "1. Recent sessions (no query): Call with no arguments to see "
        "what was worked on recently. Returns titles, previews, and "
        "timestamps. Zero LLM cost, instant.\n"
        "2. Keyword search (with query): Search for specific topics.\n\n"
        "USE THIS PROACTIVELY when:\n"
        "- The user says 'we did this before', 'remember when'\n"
        "- The user asks about a topic you worked on before\n"
        "- You want to check if you've solved a similar problem before\n"
        "- The user asks 'what did we do about X?'\n\n"
        "Search syntax: keywords joined with OR for broad recall, "
        "phrases for exact match, boolean (python NOT java), "
        "prefix (deploy*). IMPORTANT: Use OR between keywords for "
        "best results — FTS5 defaults to AND which misses sessions "
        "that only mention some terms."
    ),
    ...
}
```

Schema 中有一个关键的搜索语法建议：使用 `OR` 而非默认的 `AND`。FTS5 的默认行为是 AND——`docker networking` 只匹配同时包含两个词的消息。对于回忆搜索，`OR` 更合适——`docker OR networking` 匹配任意一个词，提高召回率。如果宽泛的 OR 查询返回太多结果，Agent 可以用引号改为精确短语匹配：`"docker networking"`。

---

## 19.8 完整的召回流程

综合以上各节，Session Search 的完整数据流如下：

```
用户提问 "上次我们怎么解决那个 CORS 问题的？"
    │
    ▼
Agent 调用 session_search(query="CORS")
    │
    ▼
SessionDB.search_messages() — FTS5 MATCH "CORS"
    │ 返回最多 50 条匹配消息（按 BM25 排名）
    ▼
_resolve_to_parent() — 将子会话/委派会话映射到根会话
    │
    ▼
去重到会话级别，排除当前会话谱系，取前 N 个
    │
    ▼
对每个匹配会话：
    ├─ db.get_messages_as_conversation() — 加载完整对话
    ├─ _format_conversation() — 格式化为 transcript
    └─ _truncate_around_matches() — 以匹配点为中心截断到 100K 字符
    │
    ▼
asyncio.gather() — 并行发送给辅助 LLM
    │ system prompt: "Summarize with focus on CORS"
    │ temperature: 0.1, max_tokens: 10000
    ▼
返回结构化结果：
    [{session_id, when, source, model, summary}, ...]
```

这个流程中，FTS5 负责速度（毫秒级在全部历史消息中定位匹配），LLM 负责质量（将长对话压缩为聚焦的回忆）。两者的分工使得 Session Search 既快又准——FTS5 过滤掉 99% 的无关会话，LLM 只处理少数几个最相关的。

---

## 19.9 与其他章节的连接

Session Search 构建在第 16 章的 SessionDB 之上——它直接调用 `search_messages()` 和 `get_messages_as_conversation()`，利用 FTS5 索引和 WAL 并发读取能力。FTS5 查询净化（`_sanitize_fts5_query`，第 16.6 节）确保了用户输入不会导致搜索崩溃。

与第 17 章的 Memory 系统的关系是互补的。Memory 存储精炼的知识条目（"用户用的是 macOS"），Session Search 提供原始的对话回忆（"上次我们花了两个小时调试 CORS，最后发现是 nginx 配置问题"）。Memory 的 schema 描述明确说"不要把任务进度和完成记录存到 memory，用 session_search 去找那些东西"。

第 20 章将展示 Session Search 如何参与完整的学习闭环——当 Agent 在新任务中遇到类似问题时，它可以搜索历史会话找到之前的解决方案，然后判断是否值得提炼为 Skill（第 18 章）或更新 Memory（第 17 章）。

---

## 速查表

| 文件 / 常量 | 角色 |
|-------------|------|
| `tools/session_search_tool.py` | Session Search 工具主逻辑 |
| `hermes_state.py` | SessionDB — FTS5 搜索后端（第 16 章） |
| `agent/auxiliary_client.py` | 辅助 LLM 调用（Gemini Flash 等） |
| `MAX_SESSION_CHARS = 100_000` | 单会话截断上限 |
| `MAX_SUMMARY_TOKENS = 10_000` | 摘要最大 token 数 |
| `_HIDDEN_SESSION_SOURCES` | 排除的内部会话源（`"tool"`） |
| `_format_conversation()` | 消息列表 → 可读 transcript |
| `_truncate_around_matches()` | 以匹配点为中心的窗口截断 |
| `_summarize_session()` | 异步 LLM 摘要（3 次重试） |
| `_resolve_to_parent()` | 委派/压缩链条上溯到根会话 |
| 近期浏览模式 | 空查询 → 会话元数据（零 LLM 成本） |
| 关键词搜索模式 | FTS5 搜索 → LLM 摘要 → 结构化结果 |
