
# 第 27 章：同步异步桥接与线程模型

> **核心问题**：同步代码与异步 IO 如何桥接？model_tools 的双事件循环设计为什么必要？

---

## 27.1 同步-异步桥接问题

Python 的异步编程模型有一个根本性的约束——**你不能在一个正在运行的事件循环里启动另一个 `asyncio.run()`**。这看起来像一个学术问题，但在 Hermes Agent 的架构中，它是一个每天都要面对的工程现实。

原因是这样的：Hermes 的工具处理函数（tool handlers）是同步函数——它们被 `handle_function_call()` 直接调用，返回一个字符串结果。但很多工具需要调用异步 API——httpx 的异步 HTTP 客户端、AsyncOpenAI 的 chat completions、MCP 的异步协议栈。在一个纯同步的 CLI 环境中，这不成问题——`asyncio.run(coro)` 创建一个临时事件循环，运行协程，关闭循环，返回结果。

但 Hermes 不是只有 CLI。它还在 Gateway 中运行——Gateway 是一个 asyncio 应用，有自己正在运行的事件循环。当 Gateway 在一个 executor 线程中执行工具 handler，handler 试图调用 `asyncio.run()`，就会触发 `RuntimeError: This event loop is already running`。即使 handler 在独立线程中，如果这个线程继承了 Gateway 线程的事件循环上下文，问题依然存在。

更糟的是，`asyncio.run()` 有一个隐蔽的副作用——它在完成后**关闭**事件循环。如果工具 handler 中有缓存的 httpx `AsyncClient` 或 `AsyncOpenAI` 客户端绑定到了这个循环，循环关闭后，这些客户端在垃圾回收时会尝试在已关闭的循环上执行清理操作，抛出 `RuntimeError: Event loop is closed`。这个错误可能在工具执行完成很久之后才出现——在 GC 清理 `AsyncClient` 的 `__del__` 方法时——使得调试极其困难。

`model_tools.py` 中的 `_run_async()` 函数是 Hermes 对这个问题的统一解决方案。

---

## 27.2 双事件循环设计

Hermes 的解决方案不是"用一个事件循环"，而是维护**多个长寿命的事件循环**，每个服务于不同的执行上下文。

### 主线程工具循环

```python
# model_tools.py:39-56
_tool_loop = None
_tool_loop_lock = threading.Lock()

def _get_tool_loop():
    """Return a long-lived event loop for running async tool handlers.

    Using a persistent loop (instead of asyncio.run() which creates and
    *closes* a fresh loop every time) prevents "Event loop is closed"
    errors that occur when cached httpx/AsyncOpenAI clients attempt to
    close their transport on a dead loop during garbage collection.
    """
    global _tool_loop
    with _tool_loop_lock:
        if _tool_loop is None or _tool_loop.is_closed():
            _tool_loop = asyncio.new_event_loop()
        return _tool_loop
```

`_tool_loop` 是主线程（CLI）的共享事件循环。它的关键属性是**长寿命**——它在整个进程生命周期内保持打开状态。当工具 handler 需要运行一个异步协程时，它调用 `_tool_loop.run_until_complete(coro)` 而不是 `asyncio.run(coro)`。`run_until_complete()` 不会在完成后关闭循环，所以绑定到这个循环的异步客户端可以安全地复用。

`threading.Lock` 保护循环的创建——虽然在正常的 CLI 流程中只有主线程会使用这个循环，但防御性锁确保了在边缘情况下（如 atexit handler 或 signal handler）的安全性。

### Worker 线程循环

```python
# model_tools.py:59-79
_worker_thread_local = threading.local()

def _get_worker_loop():
    """Return a persistent event loop for the current worker thread.

    Each worker thread gets its own long-lived loop stored in
    thread-local storage.  This prevents "Event loop is closed" errors
    and avoids contention with the main thread's shared loop.
    """
    loop = getattr(_worker_thread_local, 'loop', None)
    if loop is None or loop.is_closed():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        _worker_thread_local.loop = loop
    return loop
```

当工具在 worker 线程中执行（比如 `delegate_task` 的 `ThreadPoolExecutor` 线程），它不能使用主线程的 `_tool_loop`——那会造成跨线程的事件循环共享，这在 asyncio 中是未定义行为。解决方案是用 `threading.local()` 为每个 worker 线程维护一个独立的事件循环。

`threading.local()` 的语义保证每个线程看到不同的 `_worker_thread_local` 实例，所以不需要额外的锁。循环也是长寿命的——只要线程存活，循环就存活，缓存的异步客户端始终有一个活的循环可用。

为什么不给所有线程（包括主线程）都用 `threading.local()`？因为主线程的循环可能被多个地方引用——CLI 的配置加载、工具注册、MCP 初始化等模块级代码都可能通过 `_get_tool_loop()` 获取并缓存它。把主线程的循环放在 `threading.local()` 中会增加意外的可见性问题。分离主线程和 worker 线程的循环管理是更清晰的设计。

---

## 27.3 线程模型

`_run_async()` 是所有同步→异步桥接的单一入口点。它的决策逻辑形成一棵三分支的决策树：

```python
# model_tools.py:81-125
def _run_async(coro):
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        # Branch 1: Inside an async context (Gateway, RL env)
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(asyncio.run, coro)
            return future.result(timeout=300)

    if threading.current_thread() is not threading.main_thread():
        # Branch 2: Worker thread (delegate_task, parallel tools)
        worker_loop = _get_worker_loop()
        return worker_loop.run_until_complete(coro)

    # Branch 3: Main thread, no running loop (CLI)
    tool_loop = _get_tool_loop()
    return tool_loop.run_until_complete(coro)
```

**Branch 1：异步上下文**（Gateway、RL 环境）。检测到已有运行中的事件循环时，在一个临时的单线程 `ThreadPoolExecutor` 中执行 `asyncio.run(coro)`。这个临时线程有自己的事件循环——`asyncio.run()` 在里面安全地创建、运行、关闭循环。300 秒超时防止永远阻塞。这是唯一使用 `asyncio.run()`（而非持久循环）的路径，因为这些临时线程不持有缓存的异步客户端。

**Branch 2：Worker 线程**（并行工具执行、delegate_task）。使用 `_get_worker_loop()` 获取当前线程的持久循环，调用 `run_until_complete()`。

**Branch 3：主线程**（CLI 模式）。使用 `_get_tool_loop()` 获取共享的主线程持久循环。

这三条路径覆盖了 Hermes 的所有执行环境：

```
┌──────────────────────────────────────────────────────────┐
│                     _run_async(coro)                      │
│                                                          │
│  ┌─ Branch 1: Gateway/RL ──────────────────────────┐     │
│  │  has running loop → ThreadPoolExecutor(1)       │     │
│  │  → asyncio.run(coro) in fresh thread            │     │
│  └─────────────────────────────────────────────────┘     │
│                                                          │
│  ┌─ Branch 2: Worker thread ───────────────────────┐     │
│  │  not main thread → _get_worker_loop()           │     │
│  │  → loop.run_until_complete(coro)                │     │
│  └─────────────────────────────────────────────────┘     │
│                                                          │
│  ┌─ Branch 3: Main thread (CLI) ───────────────────┐     │
│  │  main thread, no loop → _get_tool_loop()        │     │
│  │  → loop.run_until_complete(coro)                │     │
│  └─────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────┘
```

### MCP 后台线程

MCP 工具系统有自己的线程模型，独立于 `_run_async()`。`tools/mcp_tool.py` 维护一个专用的后台事件循环：

```python
# tools/mcp_tool.py:56-69 (from architecture docstring)
# A dedicated background event loop (_mcp_loop) runs in a daemon thread.
# Each MCP server runs as a long-lived asyncio Task on this loop, keeping
# its transport context alive.  Tool call coroutines are scheduled onto the
# loop via run_coroutine_threadsafe().
```

MCP 服务器连接是长寿命的异步上下文（`async with stdio_client(...) as ...`）。它们不能在 `_run_async()` 的短暂 `run_until_complete()` 中运行，因为连接上下文需要在多次工具调用之间保持打开。解决方案是一个永远运行的后台事件循环和 daemon 线程，MCP 服务器作为长寿命 Task 在这个循环上运行。

当工具 handler 需要调用 MCP 工具时，它使用 `asyncio.run_coroutine_threadsafe(coro, _mcp_loop)` 将协程提交到 MCP 循环上执行，然后 `.result(timeout=...)` 阻塞等待结果。这个模式让 MCP 调用在任何线程上下文中都能工作——主线程、worker 线程、Gateway 线程——因为提交者和执行者在不同的线程上。

关闭时，每个 MCP 服务器 Task 被信号通知退出其 `async with` 块，确保 anyio 的 cancel-scope 清理发生在**打开连接的同一个 Task** 中（这是 anyio 的要求）。

---

## 27.4 并发安全

Hermes 在多个地方使用并发执行——并行工具调用、并行子 Agent、MCP 后台连接。每个并发场景都需要不同的安全保障。

### 并行工具执行

当模型返回多个工具调用时，`run_agent.py` 评估是否可以安全地并行执行它们：

```python
# run_agent.py:219-237
_NEVER_PARALLEL_TOOLS = frozenset({"clarify"})

_PARALLEL_SAFE_TOOLS = frozenset({
    "ha_get_state", "ha_list_entities", "ha_list_services",
    "read_file", "search_files", "session_search",
    "skill_view", "skills_list", "vision_analyze",
    "web_extract", "web_search",
})

_PATH_SCOPED_TOOLS = frozenset({"read_file", "write_file", "patch"})

_MAX_TOOL_WORKERS = 8
```

`_should_parallelize_tool_batch()` 实现了安全性分析算法：

```python
# run_agent.py:267-308
def _should_parallelize_tool_batch(tool_calls) -> bool:
    if len(tool_calls) <= 1:
        return False

    tool_names = [tc.function.name for tc in tool_calls]
    if any(name in _NEVER_PARALLEL_TOOLS for name in tool_names):
        return False

    reserved_paths: list[Path] = []
    for tool_call in tool_calls:
        tool_name = tool_call.function.name

        if tool_name in _PATH_SCOPED_TOOLS:
            scoped_path = _extract_parallel_scope_path(tool_name, function_args)
            if scoped_path is None:
                return False
            if any(_paths_overlap(scoped_path, existing) for existing in reserved_paths):
                return False
            reserved_paths.append(scoped_path)
            continue

        if tool_name not in _PARALLEL_SAFE_TOOLS:
            return False

    return True
```

这个算法有三层逻辑：

**黑名单层**：`_NEVER_PARALLEL_TOOLS` 包含绝对不能并行的工具。`clarify` 是一个交互式工具——它需要与用户对话，并发执行多个 clarify 会导致 UI 混乱。

**白名单层**：`_PARALLEL_SAFE_TOOLS` 是一个只读工具的精选列表——`read_file`、`search_files`、`web_search` 等。这些工具没有共享的可变会话状态，并发执行是安全的。任何不在白名单中的工具（如 `terminal`、`write_file`、`memory`）都会导致整个批次回退到顺序执行。

**路径作用域层**：`_PATH_SCOPED_TOOLS`（`read_file`、`write_file`、`patch`）可以并行执行，但前提是它们操作**不同的文件路径**。`_extract_parallel_scope_path()` 从工具参数中提取目标文件路径，`_paths_overlap()` 检查两个路径是否可能指向同一个文件或目录：

```python
# run_agent.py:328-335
def _paths_overlap(left: Path, right: Path) -> bool:
    """Return True when two paths may refer to the same subtree."""
```

如果两个 `write_file` 调用指向同一个文件，批次回退到顺序执行；如果它们指向不同的文件，可以安全并行。这让"同时读取 5 个文件"的场景获得线性加速，同时防止"同时写同一个文件"的竞态条件。

`terminal` 工具还有额外的析构性检测——`_is_destructive_command()` 使用正则匹配检查命令是否可能修改文件（rm、mv、sed -i 等）。虽然这个检测结果目前主要用于检查点（checkpoint）系统（在第 25 章提到的文件系统快照功能），但它与并行安全分析共享了"静态分析命令意图"的设计模式。

### 共享状态保护

Hermes 中的共享可变状态通过几种机制保护：

**threading.Lock**——`CredentialPool._lock`（第 25 章）保护凭据列表和租约计数器的原子性。`tools/approval.py` 的模块级 `_lock` 保护审批状态字典。`_tool_loop_lock` 保护主线程事件循环的创建。

**contextvars**——在第 26 章中我们看到 `_approval_session_key` 使用 `contextvars.ContextVar` 而不是全局变量来存储 session key。这在 Gateway 的 executor 线程模型中是必要的——每个并发的 Agent 运行有自己的 context，而全局变量在所有线程间共享。

**threading.local**——`_worker_thread_local` 存储 per-worker 事件循环。线程局部存储比锁更高效——没有竞争，没有等待，每个线程直接访问自己的数据。

**Immutable 数据结构**——`_PARALLEL_SAFE_TOOLS`、`_NEVER_PARALLEL_TOOLS`、`_PATH_SCOPED_TOOLS` 使用 `frozenset`，`SANDBOX_ALLOWED_TOOLS` 也是 `frozenset`，`CommandDef` 使用 `frozen=True`。不可变数据结构天然线程安全——无需任何同步原语。

这些机制的选择不是随意的——每个都匹配了它保护的数据的访问模式。高竞争的共享状态（凭据池）用锁，per-task 的上下文数据（session key）用 contextvars，per-thread 的私有数据（事件循环）用 threading.local，配置性的只读数据（工具列表）用 frozenset。

### MCP 线程安全

MCP 模块的线程安全声明值得引用：

```python
# tools/mcp_tool.py:65-69 (from docstring)
# Thread safety:
#     _servers and _mcp_loop/_mcp_thread are accessed from both the MCP
#     background thread and caller threads.  All mutations are protected by
#     _lock so the code is safe regardless of GIL presence (e.g. Python 3.13+
#     free-threading).
```

注意 "regardless of GIL presence" 的措辞——这是对 Python 3.13 引入的 free-threading 模式（PEP 703）的前瞻性设计。在 free-threading Python 中，GIL 不再保证 dict 操作的原子性，所以所有共享状态的修改都通过显式锁保护，而不是依赖 GIL 的隐式保护。

这种前瞻性的设计理念贯穿了 Hermes 的并发架构——`_tool_loop_lock` 保护一个简单的全局变量赋值，在 CPython 中 GIL 已经保证了安全性，但显式锁确保了在任何 Python 实现中都正确。

---

## 速查表

| 文件 | 角色 | 关键机制 |
|------|------|----------|
| `model_tools.py` | 同步-异步桥接 | _run_async() 三分支决策, _get_tool_loop() 持久主线程循环, _get_worker_loop() per-thread 循环 |
| `run_agent.py` | 并行工具执行 | _PARALLEL_SAFE_TOOLS 白名单, _PATH_SCOPED_TOOLS 路径作用域, _should_parallelize_tool_batch() 安全分析 |
| `tools/mcp_tool.py` | MCP 后台事件循环 | daemon 线程 + 专用 asyncio 循环, run_coroutine_threadsafe() 跨线程提交, Task-level 生命周期管理 |
| `agent/credential_pool.py` | 并发凭据管理 | threading.Lock 保护, Lease 机制分散负载 |
| `tools/approval.py` | 并发审批状态 | contextvars.ContextVar per-session, threading.Event 阻塞队列 |
