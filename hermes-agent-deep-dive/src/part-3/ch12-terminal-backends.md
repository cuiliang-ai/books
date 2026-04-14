
# 第 12 章：六种 Terminal 后端

> **核心问题**：Local/Docker/SSH/Modal/Daytona/Singularity 六种终端后端如何通过统一抽象协作？

---

## 12.1 BaseEnvironment 抽象基类

- 源锚：`tools/environments/base.py` — `class BaseEnvironment`
- 抽象方法：`execute()`, `upload()`, `download()`, `cleanup()`
- spawn-per-call 模型

> TODO: 完整抽象接口定义

---

## 12.2 LocalEnvironment

- 本地进程执行
- `_activity_callback_local` — 超时活动检测
- 源锚：`tools/environments/local.py`

> TODO: 本地执行的安全边界

---

## 12.3 DockerEnvironment

- 容器化隔离执行
- 源锚：`tools/environments/docker.py`

> TODO: Docker 后端的镜像管理与文件映射

---

## 12.4 SSHEnvironment

- 远程 SSH 执行
- 源锚：`tools/environments/ssh.py`

> TODO: SSH 连接管理与会话复用

---

## 12.5 ModalEnvironment

- Modal 无服务器执行
- 源锚：`tools/environments/modal.py`

> TODO: Modal 的休眠-唤醒机制

---

## 12.6 Daytona 与 Singularity

- DaytonaEnvironment — 云开发环境
- SingularityEnvironment — HPC 容器
- 源锚：`tools/environments/daytona.py`, `tools/environments/singularity.py`

> TODO: 特殊后端的适用场景

---

## 12.7 终端工具编排

- `terminal_tool.py` — 统一入口
- `FOREGROUND_MAX_TIMEOUT = 600`
- 源锚：`tools/terminal_tool.py`

> TODO: 前台/后台执行的切换逻辑

---

## 速查表

| 文件 | 角色 |
|------|------|
| `tools/environments/base.py` | BaseEnvironment 抽象基类 |
| `tools/environments/local.py` | 本地执行后端 |
| `tools/environments/docker.py` | Docker 容器后端 |
| `tools/environments/ssh.py` | SSH 远程后端 |
| `tools/environments/modal.py` | Modal 无服务器后端 |
| `tools/environments/daytona.py` | Daytona 云开发后端 |
| `tools/environments/singularity.py` | Singularity HPC 后端 |
| `tools/terminal_tool.py` | 终端工具编排层 |
