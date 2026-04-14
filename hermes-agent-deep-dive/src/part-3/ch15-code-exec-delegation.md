
# 第 15 章：代码执行与子 Agent 委派

> **核心问题**：PTC 的 UDS RPC 如何工作？delegate_task 的隔离模型与深度限制如何设计？

---

## 15.1 程序化工具调用（PTC）

- 源锚：`tools/code_execution_tool.py`
- execute_code — 在 Agent 进程内执行代码
- `SANDBOX_ALLOWED_TOOLS` — 沙箱中允许的 7 种工具

> TODO: PTC 的设计动机与安全模型

---

## 15.2 UDS RPC 通信

- Unix Domain Socket RPC — 本地后端
- 文件 RPC — 远程后端（Docker/SSH）
- 源锚：`tools/code_execution_tool.py`

> TODO: 两种 RPC 的协议格式与选择逻辑

---

## 15.3 资源限制

- 执行超时
- 内存限制
- 输出大小限制

> TODO: 资源限制的配置与实现

---

## 15.4 子 Agent 委派

- 源锚：`tools/delegate_tool.py`
- `delegate_task()` — 创建子 Agent 处理子任务
- `MAX_DEPTH = 2` — 委派深度限制
- `DELEGATE_BLOCKED_TOOLS` — 子 Agent 禁用的工具

> TODO: 委派的完整生命周期

---

## 15.5 并发控制

- `_DEFAULT_MAX_CONCURRENT_CHILDREN = 3`
- `DEFAULT_MAX_ITERATIONS = 50`
- ThreadPoolExecutor 并发执行
- 源锚：`tools/delegate_tool.py`

> TODO: 并发控制的实现细节

---

## 15.6 子 Agent 隔离模型

- 工具集继承与过滤
- 上下文隔离
- 结果聚合

> TODO: 隔离边界与信息流

---

## 速查表

| 文件 | 角色 |
|------|------|
| `tools/code_execution_tool.py` | PTC 代码执行 |
| `tools/delegate_tool.py` | 子 Agent 委派 |
