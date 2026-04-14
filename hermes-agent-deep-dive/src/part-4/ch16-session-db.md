
# 第 16 章：会话存储 SessionDB

> **核心问题**：Agent 的对话记录存在哪里？谁在读写它？它如何支撑记忆、搜索、费用追踪等上层功能？

---

## 16.1 SessionDB 解决什么问题

一个 LLM Agent 在运行时把对话历史放在内存的 `messages` 列表里。但进程一退出，这些数据就消失了。如果没有持久化存储，以下场景全部无法实现：

- **会话恢复**：用户关掉终端，明天重新打开，继续昨天的对话
- **跨会话搜索**：Agent 需要在过去几百个会话中找到"上次讨论 Docker 网络配置"的上下文
- **费用追踪**：统计每个会话消耗了多少 token、花了多少钱
- **上下文压缩链**：当对话太长需要压缩时（第 7 章），新旧会话之间必须有链接关系
- **多平台共存**：Gateway 模式下 Telegram、Discord、Slack 等 15 个平台的会话需要统一管理

SessionDB 就是解决这些问题的统一存储层。它是一个 SQLite 数据库文件（`~/.hermes/state.db`），对外暴露一个 `SessionDB` 类（`hermes_state.py`），提供会话的创建、消息追加、搜索、导出、清理等全部操作。

### 谁在使用 SessionDB？

| 调用方 | 怎么用 | 章节 |
|--------|--------|------|
| 主循环 `run_conversation()` | 每轮对话后写入消息、更新 token 计数 | 第 5 章 |
| 上下文压缩 | 结束旧会话，创建子会话，用 `parent_session_id` 链接 | 第 7 章 |
| Memory 系统 | 与 SessionDB 互补——Memory 存结构化知识，SessionDB 存原始记录 | 第 17 章 |
| Session Search 工具 | 调用 `search_messages()` 做 FTS5 全文搜索 | 第 19 章 |
| `hermes sessions` CLI | 调用 `list_sessions_rich()` 展示会话列表、费用统计 | — |
| Gateway 适配器 | 多平台并发读写，用 `source` 字段区分来源 | 第 21 章 |

### 本章结构

本章从外到内逐层展开：先讲技术选型（为什么是 SQLite 而非 PostgreSQL 或文件），再讲数据模型（表结构），然后讲并发控制（写入竞争如何解决），最后讲上层 API（会话生命周期、搜索、导出）。

---

## 16.2 为什么是 SQLite

在 Hermes Agent 的早期版本中，每个会话的历史记录以 JSONL 文件的形式存储——一个会话一个文件，一行一条消息。这种方案在单用户 CLI 模式下勉强可用，但当 Gateway 模式引入多平台并发（第 21 章）之后，问题就暴露了：15 个消息平台适配器可能同时写入不同的会话文件，跨会话搜索需要遍历所有文件逐行匹配，Session 元数据（token 计数、费用追踪）散落在各处没有统一查询界面。

`hermes_state.py` 的模块文档开篇就解释了这个设计转向：

```python
# hermes_state.py:1-15
"""
SQLite State Store for Hermes Agent.

Provides persistent session storage with FTS5 full-text search, replacing
the per-session JSONL file approach. Stores session metadata, full message
history, and model configuration for CLI and gateway sessions.

Key design decisions:
- WAL mode for concurrent readers + one writer (gateway multi-platform)
- FTS5 virtual table for fast text search across all session messages
- Compression-triggered session splitting via parent_session_id chains
- Batch runner and RL trajectories are NOT stored here (separate systems)
- Session source tagging ('cli', 'telegram', 'discord', etc.) for filtering
"""
```

SQLite 被选中不是因为它"简单"，而是因为它精确匹配了 Hermes 的部署模型：单进程多线程的 Gateway 服务器，加上偶尔并发的 CLI 会话。SQLite 的 WAL 模式天然支持"一个写者 + 多个读者"的并发模式，不需要额外的数据库服务器进程。数据库文件就是 `~/.hermes/state.db`——一个文件包含所有会话历史、全文索引和元数据，备份时 `cp` 一下就行。

有一个值得注意的架构边界：batch runner 和 RL 轨迹**不**存储在 SessionDB 中。这些是 Nous Research 用于训练数据生成的独立系统（第 29 章），它们有自己的存储路径。SessionDB 只服务于面向用户的交互会话。

---

## 16.3 SessionDB 类的初始化

`SessionDB` 是整个状态存储的入口。它的初始化序列揭示了几个重要的工程决策：

```python
# hermes_state.py:138-159
def __init__(self, db_path: Path = None):
    self.db_path = db_path or DEFAULT_DB_PATH
    self.db_path.parent.mkdir(parents=True, exist_ok=True)

    self._lock = threading.Lock()
    self._write_count = 0
    self._conn = sqlite3.connect(
        str(self.db_path),
        check_same_thread=False,
        timeout=1.0,
        isolation_level=None,
    )
    self._conn.row_factory = sqlite3.Row
    self._conn.execute("PRAGMA journal_mode=WAL")
    self._conn.execute("PRAGMA foreign_keys=ON")

    self._init_schema()
```

三个配置值值得逐一解释。

第一，`check_same_thread=False`。Python 的 `sqlite3` 模块默认禁止跨线程使用同一连接对象。但 Gateway 模式下，多个平台适配器的消息处理可能在不同线程中触发数据库写入。Hermes 用自己的 `threading.Lock()` 管理线程安全，所以关闭了 SQLite 的线程检查。

第二，`isolation_level=None`。这不是"关闭事务"——恰恰相反，它意味着"我自己管理事务"。Python 的 `sqlite3` 模块有一个臭名昭著的行为：当 `isolation_level` 不是 `None` 时，它会在执行 DML 语句前自动开始一个事务。这与 Hermes 使用 `BEGIN IMMEDIATE` 显式控制事务的策略直接冲突。设为 `None` 让 Hermes 完全掌控事务的开始和提交时机。

第三，`timeout=1.0`。超时值故意设得很短——只有 1 秒。原因在下一节的写入策略中揭晓。

---

## 16.4 写入竞争与 Convoy 破解

当多个 Hermes 进程（Gateway + CLI 会话 + Worktree 子 Agent）共享同一个 `state.db` 时，WAL 写入锁的竞争会导致可见的 TUI 卡顿。SQLite 内置的 busy handler 使用确定性的睡眠调度（指数退避），在高并发下会产生 **convoy effect**（护航效应）——所有竞争者按相同的时间间隔重试，结果是它们不断在同一时刻醒来、再次撞在一起。

Hermes 的解决方案是把重试逻辑提升到应用层，用随机抖动（jitter）打破 convoy：

```python
# hermes_state.py:123-136
_WRITE_MAX_RETRIES = 15
_WRITE_RETRY_MIN_S = 0.020   # 20ms
_WRITE_RETRY_MAX_S = 0.150   # 150ms
_CHECKPOINT_EVERY_N_WRITES = 50
```

核心写入方法 `_execute_write` 实现了这个策略。它接收一个闭包 `fn`，在 `BEGIN IMMEDIATE` 事务中执行，失败后以随机间隔重试：

```python
# hermes_state.py:164-214
def _execute_write(self, fn: Callable[[sqlite3.Connection], T]) -> T:
    last_err: Optional[Exception] = None
    for attempt in range(self._WRITE_MAX_RETRIES):
        try:
            with self._lock:
                self._conn.execute("BEGIN IMMEDIATE")
                try:
                    result = fn(self._conn)
                    self._conn.commit()
                except BaseException:
                    try:
                        self._conn.rollback()
                    except Exception:
                        pass
                    raise
            self._write_count += 1
            if self._write_count % self._CHECKPOINT_EVERY_N_WRITES == 0:
                self._try_wal_checkpoint()
            return result
        except sqlite3.OperationalError as exc:
            err_msg = str(exc).lower()
            if "locked" in err_msg or "busy" in err_msg:
                last_err = exc
                if attempt < self._WRITE_MAX_RETRIES - 1:
                    jitter = random.uniform(
                        self._WRITE_RETRY_MIN_S,
                        self._WRITE_RETRY_MAX_S,
                    )
                    time.sleep(jitter)
                    continue
            raise
```

这段代码的设计有几个值得深入理解的细节。

`BEGIN IMMEDIATE` 而非普通 `BEGIN`——普通事务延迟获取写锁，直到第一条写语句才尝试获取。这意味着如果你先读了一些数据，基于读取结果决定写什么，然后写入时锁被别人抢了，你的读取结果可能已经过时。`BEGIN IMMEDIATE` 在事务开始时就获取写锁，立刻暴露竞争：要么拿到锁，要么立刻知道拿不到。

`random.uniform(0.020, 0.150)` 是真随机抖动。每次重试等待 20ms 到 150ms 的随机时间。因为是真随机而非确定性退避，多个竞争者的重试时间自然错开。最坏情况下 15 次重试全用最大值也只等 2.25 秒，远好于 SQLite 内置 busy handler 可能卡住 30 秒。

每 50 次成功写入触发一次 `PASSIVE` WAL checkpoint。WAL 模式下，已提交的帧会堆积在 WAL 文件中，直到 checkpoint 将它们合并回主数据库文件。`PASSIVE` checkpoint 从不阻塞任何读者——它只合并当前没有其他连接需要的帧。`close()` 方法在关闭连接前也尝试一次 checkpoint，确保退出的进程帮助清理 WAL 积压：

```python
# hermes_state.py:237-250
def close(self):
    with self._lock:
        if self._conn:
            try:
                self._conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
            except Exception:
                pass
            self._conn.close()
            self._conn = None
```

---

## 16.5 数据库 Schema 设计

Hermes 的数据库由三部分组成：版本追踪表、两张核心业务表、一张 FTS5 虚拟表（FTS5 在 §16.6 单独讲解）。完整定义见 `SCHEMA_SQL`（`hermes_state.py:36-91`）。

### schema_version 表

只有一列 `version INTEGER NOT NULL`，当前值为 **6**。每次迁移递增，用于 §16.8 的递增式迁移判断。

### sessions 表 — 会话元数据中心

| 列名 | 类型 | 约束 | 引入版本 | 说明 |
|------|------|------|---------|------|
| `id` | TEXT | **PK** | v1 | UUID4 会话标识 |
| `source` | TEXT | NOT NULL | v1 | 来源标签：`cli` / `telegram` / `discord` 等 |
| `user_id` | TEXT | | v1 | 用户标识（Gateway 模式下区分不同用户） |
| `model` | TEXT | | v1 | 模型名，如 `nous/hermes-3-llama-3.1-405b` |
| `model_config` | TEXT | | v1 | JSON：temperature, top_p 等参数快照 |
| `system_prompt` | TEXT | | v1 | 完整 System Prompt 快照 |
| `parent_session_id` | TEXT | FK → `sessions.id` | v1 | 压缩/委派产生的会话链（§7 章） |
| `started_at` | REAL | NOT NULL | v1 | `time.time()` epoch 时间戳 |
| `ended_at` | REAL | | v1 | 会话结束时间 |
| `end_reason` | TEXT | | v1 | `user_quit` / `compression` / `error` 等 |
| `message_count` | INTEGER | DEFAULT 0 | v5 | 消息总数 |
| `tool_call_count` | INTEGER | DEFAULT 0 | v5 | 工具调用总数 |
| `input_tokens` | INTEGER | DEFAULT 0 | v5 | 输入 token 累计 |
| `output_tokens` | INTEGER | DEFAULT 0 | v5 | 输出 token 累计 |
| `cache_read_tokens` | INTEGER | DEFAULT 0 | v5 | 缓存命中 token |
| `cache_write_tokens` | INTEGER | DEFAULT 0 | v5 | 缓存写入 token |
| `reasoning_tokens` | INTEGER | DEFAULT 0 | v5 | 推理 token |
| `billing_provider` | TEXT | | v5 | 计费提供商 |
| `billing_base_url` | TEXT | | v5 | 计费 API 地址 |
| `billing_mode` | TEXT | | v5 | 计费模式 |
| `estimated_cost_usd` | REAL | | v5 | 预估费用（基于本地定价表） |
| `actual_cost_usd` | REAL | | v5 | 实际费用（API 返回） |
| `cost_status` | TEXT | | v5 | 费用状态 |
| `cost_source` | TEXT | | v5 | 费用来源标记 |
| `pricing_version` | TEXT | | v5 | 定价表版本 |
| `title` | TEXT | UNIQUE（非 NULL 时） | v3 | 用户可选的会话标题 |

`source` 在 Gateway 模式下至关重要——Session Search 工具（第 19 章）使用它过滤搜索范围和排除内部工具会话。`parent_session_id` 形成会话链条：上下文压缩触发时（第 7 章），当前会话被结束，新的子会话以压缩摘要开始，通过这个外键链接到父会话。v5 一次性增加了 11 个计费列，支撑 `hermes sessions` 命令的费用统计视图。

`title` 的唯一性由一个**条件唯一索引**（v4 迁移添加）保证——只有非 NULL 的标题必须唯一，NULL 值可以重复（SQLite partial index 特性）：

```sql
CREATE UNIQUE INDEX idx_sessions_title_unique ON sessions(title) WHERE title IS NOT NULL
```

### messages 表 — 原始消息流

| 列名 | 类型 | 约束 | 引入版本 | 说明 |
|------|------|------|---------|------|
| `id` | INTEGER | **PK** AUTOINCREMENT | v1 | 自增消息 ID（也作为 FTS5 rowid） |
| `session_id` | TEXT | NOT NULL, FK → `sessions.id` | v1 | 所属会话 |
| `role` | TEXT | NOT NULL | v1 | `user` / `assistant` / `tool` |
| `content` | TEXT | | v1 | 消息文本（FTS5 索引此列） |
| `tool_call_id` | TEXT | | v1 | 对应 tool_use 的 ID |
| `tool_calls` | TEXT | | v1 | JSON：`[{id, type, function}…]` |
| `tool_name` | TEXT | | v1 | 工具名称 |
| `timestamp` | REAL | NOT NULL | v1 | `time.time()` epoch |
| `token_count` | INTEGER | | v1 | 该消息的 token 数 |
| `finish_reason` | TEXT | | v2 | `stop` / `tool_calls` / `length` |
| `reasoning` | TEXT | | v6 | 推理链文本 |
| `reasoning_details` | TEXT | | v6 | JSON：推理详情（provider 格式各异） |
| `codex_reasoning_items` | TEXT | | v6 | JSON：Codex 格式推理条目 |

`tool_calls` 和 `reasoning_details` 以 JSON 字符串形式存储——SQLite 没有原生 JSON 类型，序列化在写入时完成，读取时反序列化。v6 新增的三个推理列解决了一个实际问题：没有它们，推理链在会话重载时丢失，导致需要回放推理历史的提供商（OpenRouter、OpenAI、Nous）出现多轮推理断裂。

### 索引策略

| 索引名 | 目标表 | 列 | 用途 |
|--------|--------|-----|------|
| `idx_sessions_source` | sessions | `source` | 按来源过滤（Gateway 多平台查询） |
| `idx_sessions_parent` | sessions | `parent_session_id` | 会话链条遍历（压缩历史追溯） |
| `idx_sessions_started` | sessions | `started_at DESC` | 时间排序列表（最近会话优先） |
| `idx_messages_session` | messages | `(session_id, timestamp)` | 复合索引：定位会话 + 时间排序，一次扫描完成消息加载 |
| `idx_sessions_title_unique` | sessions | `title WHERE NOT NULL` | 条件唯一索引：非 NULL 标题去重 |

---

## 16.6 FTS5 全文搜索引擎

### FTS5 背景

普通 SQL 的 `LIKE '%keyword%'` 搜索需要逐行扫描全表——消息量上万条后会明显变慢。**全文搜索（Full-Text Search）** 的做法不同：它在写入时就把文本拆成词元（token），建立**倒排索引**（inverted index）——一个从"词 → 出现在哪些行"的映射表。查询时直接在索引中查找词元，不再逐行扫描，速度从 O(n) 降到近似 O(1)。

**FTS5** 是 SQLite 内置的第 5 代全文搜索扩展。它以**虚拟表**（`CREATE VIRTUAL TABLE ... USING fts5`）的形式存在——对外看起来像普通表，可以用 `SELECT ... WHERE content MATCH 'keyword'` 查询，但底层维护的是倒排索引而非 B-Tree。FTS5 内置了 BM25 排名算法（与 Elasticsearch 同族），查询结果自动按相关度排序。它还提供 `snippet()` 函数生成带高亮的匹配片段、`prefix*` 前缀匹配、`"exact phrase"` 精确短语、`AND/OR/NOT` 布尔运算等搜索语法。

对 Hermes 来说，FTS5 是 Session Search 工具（第 19 章）的物理基石——Agent 通过 `search_messages()` 在数万条历史消息中毫秒级定位相关对话。

### Hermes 的 FTS5 实现

Hermes 使用 FTS5 的 **content table** 模式构建了一个与 `messages` 表自动同步的全文索引：

```python
# hermes_state.py:93-112
FTS_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content=messages,
    content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
"""
```

`content=messages, content_rowid=id` 声明这是一个 **content table** 模式——索引内容来自 `messages` 表的 `content` 列，行 ID 对应 `messages.id`。三个触发器保证每次消息插入、删除或更新时 FTS5 索引自动同步。删除操作使用 FTS5 的特殊语法——向 FTS 表名列插入字面值 `'delete'`，这是 SQLite FTS5 文档规定的删除指令。

FTS5 表的初始化与普通表分开处理，采用"先试后建"策略：尝试查询 FTS 表，如果抛出 `OperationalError`（表不存在），再创建。这比 `CREATE VIRTUAL TABLE IF NOT EXISTS` 在 `executescript` 中的行为更可靠。

---

## 16.7 查询安全：FTS5 输入净化

FTS5 有自己的查询语法——`"exact phrase"`、`AND/OR/NOT` 布尔运算、`prefix*` 前缀匹配。直接将用户输入传给 `MATCH` 会导致语法错误。`_sanitize_fts5_query` 是一个六步净化器：

```python
# hermes_state.py:938-988
@staticmethod
def _sanitize_fts5_query(query: str) -> str:
    # Step 1: Extract balanced double-quoted phrases, protect via placeholders
    _quoted_parts: list = []
    def _preserve_quoted(m): ...
    sanitized = re.sub(r'"[^"]*"', _preserve_quoted, query)

    # Step 2: Strip remaining FTS5-special characters
    sanitized = re.sub(r'[+{}()\"^]', " ", sanitized)

    # Step 3: Collapse repeated * and remove leading *
    sanitized = re.sub(r"\*+", "*", sanitized)

    # Step 4: Remove dangling boolean operators at start/end
    sanitized = re.sub(r"(?i)^(AND|OR|NOT)\b\s*", "", sanitized.strip())

    # Step 5: Wrap unquoted dotted/hyphenated terms in double quotes
    sanitized = re.sub(r"\b(\w+(?:[.-]\w+)+)\b", r'"\1"', sanitized)

    # Step 6: Restore preserved quoted phrases
    for i, quoted in enumerate(_quoted_parts):
        sanitized = sanitized.replace(f"\x00Q{i}\x00", quoted)
    return sanitized.strip()
```

Step 1 用 NUL 字节占位符保护合法的双引号短语（如 `"docker networking"`）。Step 5 解决了一个微妙问题：FTS5 的 tokenizer 在点号和连字符处分词，把 `chat-send` 拆成 `chat AND send`，把 `my-app.config.ts` 拆成多个词元。用双引号包裹保持短语语义——这对搜索文件名和命令名至关重要。Step 4 清理悬挂的布尔运算符（如 `hello AND` 或 `OR world`），防止 FTS5 语法错误。

`search_messages` 方法在净化后的查询上执行搜索，使用 FTS5 的 `snippet()` 函数生成匹配高亮片段，`ORDER BY rank` 利用内置 BM25 排名。搜索结果经过后处理——为每个匹配添加前后各一条消息的上下文，然后删除完整 `content` 字段，只保留 snippet。这种"宽搜索、窄返回"的设计服务于 Session Search 工具（第 19 章）：它不需要原始全文，只需要足够的上下文让 LLM 生成摘要。

---

## 16.8 Schema 迁移机制

Hermes 的 schema 迁移采用最简洁的递增式方案。每个版本一个 `if current_version < N` 分支，通过 `ALTER TABLE ADD COLUMN` 添加列：

```python
# hermes_state.py:258-270
current_version = row["version"] ...
if current_version < 2:
    try:
        cursor.execute("ALTER TABLE messages ADD COLUMN finish_reason TEXT")
    except sqlite3.OperationalError:
        pass  # Column already exists
    cursor.execute("UPDATE schema_version SET version = 2")
if current_version < 3:
    try:
        cursor.execute("ALTER TABLE sessions ADD COLUMN title TEXT")
    except sqlite3.OperationalError:
        pass
    cursor.execute("UPDATE schema_version SET version = 3")
```

每个迁移步骤都用 `try/except sqlite3.OperationalError: pass` 包裹。这不是懒惰——它是**幂等性保证**。如果迁移在 v4 和 v5 之间中断，下次启动时 `current_version` 仍然是 4，但某些 v5 的列可能已经添加。`try/except` 确保重复添加已存在的列不报错。

注意所有分支都是 `if` 而不是 `elif`。从 v1 直接升级到 v6 时，全部迁移步骤链式执行。六个版本记录了功能演进：v2 添加 `finish_reason`，v3 添加 `title`，v4 添加标题唯一索引，v5 添加 11 个计费列，v6 添加推理链持久化列。

---

## 16.9 会话生命周期与标题系统

会话通过 `create_session`（`INSERT OR IGNORE`，幂等创建）、`end_session`（标记结束时间和原因）、`reopen_session`（清除结束标记，恢复活跃状态）管理。`ensure_session` 是防御性方法——用于在 `create_session` 因瞬时锁失败后、消息刷写时补救创建会话行。

标题系统支持**谱系编号**。当用户命名一个会话为 `my-project` 后，再次使用同名时 `get_next_title_in_lineage()` 自动生成 `my-project #2`。`resolve_session_by_title()` 查找时优先返回最新编号变体。`sanitize_title()` 对标题执行清洗——移除 ASCII 控制字符、零宽字符、RTL/LTR 覆盖字符（防止 Unicode 显示攻击），折叠内部空白，强制最大长度 100 字符。

删除会话时子会话被**孤立化**（`parent_session_id` 设为 NULL），而非级联删除——子会话仍可独立访问。

---

## 16.10 消息存储与会话恢复

`append_message` 在写入消息的同时更新会话计数器，两个操作在同一事务中执行。JSON 序列化在进入事务之前完成，避免在持有写锁时做 CPU 密集操作。

会话恢复有两条路径。`get_messages()` 返回完整消息列表用于导出分析。`get_messages_as_conversation()` 返回 OpenAI 格式的精简列表用于 Gateway 恢复上下文——它特别处理了推理字段的反序列化：只有 `assistant` 角色恢复推理字段，反序列化失败时回退到 `None` 而非抛异常。

Token 计数通过 `update_token_counts` 支持两种模式：增量（CLI，每次 API 调用传 delta）和绝对（Gateway，传累积总量）。费用字段使用 `COALESCE` 处理 NULL 语义——`actual_cost_usd` 只在收到非 NULL 值时更新，NULL 参数不覆盖已有数据。

---

## 16.11 富列表与导出

`list_sessions_rich` 是 `hermes sessions` 命令的后端，用一条带关联子查询的 SQL 完成了 N+2 条查询的工作——一个子查询取首条用户消息前 63 字符作预览，另一个取最后活跃时间。默认排除子会话（`parent_session_id IS NULL`），用户看到干净的顶层列表。

`export_session` 和 `export_all` 将会话及其消息打包为字典。`prune_sessions` 按时间窗口清理——只删除已结束会话，不动活跃的，子会话被孤立化而非级联删除。

---

## 16.12 与其他章节的连接

SessionDB 是 Hermes 学习闭环的物理基础。第 17 章将展示 Memory 系统如何将经验写入 MEMORY.md/USER.md——这是结构化知识沉淀，而 SessionDB 存储的是原始对话记录，两者互补。第 19 章的 Session Search 工具直接调用 `SessionDB.search_messages()` 执行 FTS5 搜索，再把匹配会话交给 LLM 摘要。第 20 章将展示 SessionDB 如何作为"经验仓库"参与 Skill 提炼和记忆持久化的完整闭环。

回顾第 7 章的上下文压缩，压缩触发会话分裂时通过 `parent_session_id` 链接新旧会话——这正是 sessions 表的外键设计所支撑的。

---

## 速查表

| 文件 / 常量 | 角色 |
|-------------|------|
| `hermes_state.py` | SessionDB 类 — SQLite 状态存储的唯一入口 |
| `DEFAULT_DB_PATH` | `~/.hermes/state.db` — 默认数据库路径 |
| `SCHEMA_VERSION = 6` | 当前 schema 版本，6 次递增迁移 |
| `SCHEMA_SQL` | sessions + messages 表定义 + 索引 |
| `FTS_SQL` | FTS5 虚拟表 + 三个同步触发器 |
| `_execute_write()` | 带 jitter 重试的写入事务管理器 |
| `_sanitize_fts5_query()` | FTS5 查询输入六步净化器 |
| `search_messages()` | FTS5 全文搜索入口（被第 19 章调用） |
| `list_sessions_rich()` | `hermes sessions` 命令的数据后端 |
| `WAL + PASSIVE checkpoint` | 并发策略：一写多读 + 定期合并 |
| `parent_session_id` | 压缩/委派产生的会话链条 |
