
# 第 12 章：六种 Terminal 后端

## 统一的执行抽象

一个 Agent 需要运行 shell 命令。在你自己的笔记本上，这很简单——`subprocess.Popen("bash", "-c", command)`。但如果 Agent 运行在 Telegram 的云服务器上，命令应该在哪里执行？如果用户要求隔离的沙箱环境呢？如果执行环境是一台远程 GPU 服务器呢？

Hermes Agent 的回答是：**六种后端，一套接口**。Local、Docker、SSH、Modal、Daytona、Singularity——六种截然不同的执行环境，通过 `BaseEnvironment` 抽象基类统一为相同的调用方式。对上层的 `terminal_tool()` 而言，执行一条命令就是调用 `env.execute(command)`，不需要知道命令跑在本地进程还是远端容器里。

这一章我们拆解这个抽象层的内部机制。

---

## 12.1 BaseEnvironment：统一执行流

`tools/environments/base.py`（580 行）定义了所有后端的共同祖先。它的核心方法签名：

```python
# tools/environments/base.py:519-558
def execute(
    self,
    command: str,
    cwd: str = "",
    *,
    timeout: int | None = None,
    stdin_data: str | None = None,
) -> dict:
    """Execute a command, return {"output": str, "returncode": int}."""
```

`execute()` 不是抽象方法——它是一个**模板方法**，编排了完整的命令执行生命周期：

1. `_before_execute()` — 钩子，远程后端（SSH、Modal、Daytona）在这里触发文件同步
2. `_prepare_command()` — 处理 sudo 密码注入
3. `_wrap_command()` — 包装原始命令，添加 snapshot sourcing、cd、CWD 追踪
4. `_run_bash()` — **抽象方法**，由每个后端实现，返回 ProcessHandle
5. `_wait_for_process()` — 统一的轮询等待，处理中断、超时、activity callback
6. `_update_cwd()` — 从输出中提取新的工作目录

只有第 4 步（`_run_bash()`）和 `cleanup()` 是子类必须实现的。其余步骤在 BaseEnvironment 中统一实现，所有后端共享。

---

## 12.2 Session Snapshot：会话状态的快照-恢复

Hermes 的 terminal 采用**spawn-per-call**模型：每次 `execute()` 都 spawn 一个新的 bash 进程。这和传统的 persistent shell session（如 tmux/screen）不同。优点是进程隔离（一次命令崩溃不影响下一次），缺点是环境变量、shell 函数、别名等状态会在进程间丢失。

Session Snapshot 解决了这个问题。`init_session()` 在后端创建后调用一次，捕获登录 shell 的完整环境：

```python
# tools/environments/base.py:296-306
bootstrap = (
    f"export -p > {self._snapshot_path}\n"
    f"declare -f | grep -vE '^_[^_]' >> {self._snapshot_path}\n"
    f"alias -p >> {self._snapshot_path}\n"
    f"echo 'shopt -s expand_aliases' >> {self._snapshot_path}\n"
    f"echo 'set +e' >> {self._snapshot_path}\n"
    f"echo 'set +u' >> {self._snapshot_path}\n"
    f"pwd -P > {self._cwd_file} 2>/dev/null || true\n"
    f"printf '\\n{self._cwd_marker}%s{self._cwd_marker}\\n' \"$(pwd -P)\"\n"
)
```

这段 bootstrap 脚本做了四件事：

1. `export -p` — 导出所有环境变量到 snapshot 文件
2. `declare -f | grep -vE '^_[^_]'` — 导出 shell 函数（过滤掉内部函数）
3. `alias -p` — 导出别名
4. 添加 `shopt -s expand_aliases`（启用别名扩展）和 `set +e; set +u`（关闭 errexit 和 nounset，避免因未定义变量导致命令失败）

后续每次 `execute()` 调用，`_wrap_command()` 会在用户命令之前 source 这个 snapshot 文件：

```python
# tools/environments/base.py:338-339
if self._snapshot_ready:
    parts.append(f"source {self._snapshot_path} 2>/dev/null || true")
```

命令执行结束后，环境变量被重新导出到 snapshot 文件（第 353 行），实现了跨调用的环境变量持久化。如果用户执行了 `export MY_VAR=hello`，下一次 `execute()` 调用仍然能看到 `MY_VAR`。

如果 snapshot 创建失败（比如远程文件系统不可写），`_snapshot_ready` 保持 `False`，后续命令退化为 `bash -l`（login shell），至少用户的 `.bashrc` / `.bash_profile` 仍会被加载。这是又一个**优雅降级**的例子。

---

## 12.3 CWD 追踪：文件 vs 标记

工作目录的持久化比环境变量更棘手。用户执行 `cd /tmp` 后，下一次命令应该在 `/tmp` 中执行。但 spawn-per-call 模型意味着新进程的 CWD 默认是初始目录，不是上一次命令结束时的目录。

BaseEnvironment 使用双重追踪机制：

**文件方式**（本地后端）：命令执行后将 `pwd -P` 写入临时文件 `_cwd_file`，父进程直接读取文件内容。LocalEnvironment 重写了 `_update_cwd()`：

```python
# tools/environments/local.py:296-306
def _update_cwd(self, result: dict):
    try:
        cwd_path = open(self._cwd_file).read().strip()
        if cwd_path:
            self.cwd = cwd_path
    except (OSError, FileNotFoundError):
        pass
    self._extract_cwd_from_output(result)
```

**标记方式**（远程后端）：在命令输出的末尾注入一个唯一标记：

```python
# tools/environments/base.py:358-362
parts.append(
    f"printf '\\n{self._cwd_marker}%s{self._cwd_marker}\\n' \"$(pwd -P)\""
)
```

`_cwd_marker` 的格式是 `__HERMES_CWD_{session_id}__`，session_id 是随机生成的 12 位 hex 字符串。远程后端（Docker、SSH、Modal 等）无法直接读取远程文件系统中的临时文件，所以通过 stdout 中的标记传递 CWD 信息。

`_extract_cwd_from_output()` 负责从命令输出中解析这个标记，更新 `self.cwd`，并从输出中剥离标记行——用户不应该看到这些内部机制产生的输出。

---

## 12.4 ProcessHandle：统一进程抽象

不同后端的进程表示方式完全不同——Local 和 Docker 使用 `subprocess.Popen`，SSH 也使用 `subprocess.Popen`（ssh 客户端进程），但 Modal 和 Daytona 使用 SDK 的异步 API。`ProcessHandle` Protocol 统一了这些差异：

```python
# tools/environments/base.py:125-141
class ProcessHandle(Protocol):
    def poll(self) -> int | None: ...
    def kill(self) -> None: ...
    def wait(self, timeout: float | None = None) -> int: ...

    @property
    def stdout(self) -> IO[str] | None: ...
    @property
    def returncode(self) -> int | None: ...
```

`subprocess.Popen` 天然满足这个 Protocol（duck typing）。对于 SDK 后端，`_ThreadedProcessHandle` 适配器将阻塞的 `exec_fn() -> (output, exit_code)` 包装成 ProcessHandle 兼容接口：

```python
# tools/environments/base.py:143-209
class _ThreadedProcessHandle:
    def __init__(self, exec_fn, cancel_fn=None):
        self._cancel_fn = cancel_fn
        self._done = threading.Event()
        read_fd, write_fd = os.pipe()
        self._stdout = os.fdopen(read_fd, "r", ...)
        self._write_fd = write_fd

        def _worker():
            output, exit_code = exec_fn()
            self._returncode = exit_code
            os.write(self._write_fd, output.encode(...))
            os.close(self._write_fd)
            self._done.set()

        threading.Thread(target=_worker, daemon=True).start()
```

核心设计：后台线程执行 SDK 调用，通过 `os.pipe()` 将输出转发到 `stdout` 文件描述符。`_wait_for_process()` 中的 drain thread 从 `stdout` 读取输出，和处理 subprocess.Popen 完全相同。`cancel_fn` 用于中断支持——Modal 的 `sandbox.terminate()`、Daytona 的 `sandbox.stop()` 通过 `kill()` 方法触发。

---

## 12.5 LocalEnvironment：宿主机执行

`tools/environments/local.py`（315 行）是最简单也最常用的后端。

**安全边界：环境变量过滤**

LocalEnvironment 的关键安全机制是 `_HERMES_PROVIDER_ENV_BLOCKLIST`——一个 60+ 条目的 frozenset，列出了所有不应该泄露到子进程的环境变量：

```python
# tools/environments/local.py:43-104
blocked.update({
    "OPENAI_API_KEY", "ANTHROPIC_TOKEN", "OPENROUTER_API_KEY",
    "TELEGRAM_HOME_CHANNEL", "DISCORD_HOME_CHANNEL",
    "HASS_TOKEN", "GH_TOKEN", "MODAL_TOKEN_ID", ...
})
```

这防止了一类攻击：Agent 执行 `env | grep KEY` 可能泄露 API 密钥。blocklist 涵盖了所有 LLM provider 密钥、消息平台 token、Home Assistant token 等敏感信息。

`_sanitize_subprocess_env()` 和 `_make_run_env()` 在创建子进程环境时应用这个 blocklist。但它不是绝对的——`_HERMES_PROVIDER_ENV_FORCE_PREFIX`（`"_HERMES_FORCE_"`）前缀允许显式穿透 blocklist，用于需要在子进程中使用特定密钥的场景（如 Docker 环境需要 forward 某些 API key）。

**进程组 kill**

LocalEnvironment 重写了 `_kill_process()` 来实现进程组级别的终止：

```python
# tools/environments/local.py:278-294
def _kill_process(self, proc):
    if _IS_WINDOWS:
        proc.terminate()
    else:
        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, signal.SIGTERM)
        try:
            proc.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            os.killpg(pgid, signal.SIGKILL)
```

`os.setsid` 在 `_run_bash()` 中设置（通过 `preexec_fn`），确保子进程在自己的进程组中。timeout 或 interrupt 时，`os.killpg` 杀死整个进程组——包括子进程 spawn 的所有子子进程。没有这个机制，一个 `make -j8` 超时后可能留下 8 个孤儿进程继续消耗资源。

**Bash 查找**

`_find_bash()` 在 Unix 上按优先级检查 `shutil.which("bash")` → `/usr/bin/bash` → `/bin/bash` → `$SHELL` → `/bin/sh`。在 Windows 上，它查找 Git Bash（因为 Hermes 的 terminal 工具依赖 bash 语法），支持通过 `HERMES_GIT_BASH_PATH` 环境变量自定义路径。

---

## 12.6 DockerEnvironment：安全加固

`tools/environments/docker.py`（561 行）是安全意识最强的后端。

**_SECURITY_ARGS**

每个 Docker 容器都带有一组安全加固参数：

```python
# tools/environments/docker.py:135-145
_SECURITY_ARGS = [
    "--cap-drop", "ALL",
    "--cap-add", "DAC_OVERRIDE",
    "--cap-add", "CHOWN",
    "--cap-add", "FOWNER",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "256",
    "--tmpfs", "/tmp:rw,nosuid,size=512m",
    "--tmpfs", "/var/tmp:rw,noexec,nosuid,size=256m",
    "--tmpfs", "/run:rw,noexec,nosuid,size=64m",
]
```

- `--cap-drop ALL` 先丢弃所有 Linux capabilities
- 然后只加回 3 个最小必需的：`DAC_OVERRIDE`（root 写宿主挂载目录）、`CHOWN` 和 `FOWNER`（包管理器需要）
- `--no-new-privileges` 禁止容器内进程获取新权限（防止 setuid binary 提权）
- `--pids-limit 256` 限制容器内最大进程数（防 fork 炸弹）
- 三个 tmpfs 挂载限制了临时目录的大小和权限

**持久化 vs 临时模式**

DockerEnvironment 支持两种存储模式：

持久模式（`persistent_filesystem=True`）：通过 bind mount 将宿主机的 `~/.hermes/sandboxes/docker/{task_id}/` 目录映射到容器的 `/workspace` 和 `/root`。容器销毁后数据保留，下次重建容器时自动恢复。

临时模式（`persistent_filesystem=False`）：使用 `--tmpfs /workspace:rw,exec,size=10g` 在内存中创建工作区。容器销毁后一切消失。适合一次性任务。

**凭据文件挂载**

Docker 后端会自动挂载 Hermes 的凭据文件、skill 文件和缓存目录到容器中（只读），让容器内的脚本能访问 OAuth token 和 skill 模板：

```python
# tools/environments/docker.py:353-357
for mount_entry in get_credential_file_mounts():
    volume_args.extend([
        "-v",
        f"{mount_entry['host_path']}:{mount_entry['container_path']}:ro",
    ])
```

`:ro` 后缀确保容器只能读取这些文件，不能修改宿主机的凭据。

---

## 12.7 SSHEnvironment：连接复用与批量传输

`tools/environments/ssh.py`（259 行）为远程执行提供了高效的 SSH 后端。

**ControlMaster 连接复用**

每次 `_run_bash()` 都要建立 SSH 连接会极慢。SSHEnvironment 使用 OpenSSH 的 ControlMaster 特性，在第一次连接时创建一个持久的 UNIX domain socket，后续连接复用这个通道：

```python
# tools/environments/ssh.py:66-81
def _build_ssh_command(self, extra_args=None) -> list:
    cmd = ["ssh"]
    cmd.extend(["-o", f"ControlPath={self.control_socket}"])
    cmd.extend(["-o", "ControlMaster=auto"])
    cmd.extend(["-o", "ControlPersist=300"])  # 5分钟空闲后关闭
    cmd.extend(["-o", "BatchMode=yes"])
    cmd.extend(["-o", "StrictHostKeyChecking=accept-new"])
    cmd.extend(["-o", "ConnectTimeout=10"])
```

`ControlPersist=300` 意味着最后一次 SSH 命令结束后，控制连接保持 5 分钟。在 Agent 的典型使用模式中（高频短命令），这几乎消除了连接建立的延迟。

**FileSyncManager 与 tar 批量上传**

SSHEnvironment 使用 `FileSyncManager` 在本地和远程之间同步文件（skills、credentials、cache）。初始同步可能涉及几百个文件，逐个 scp 太慢。`_ssh_bulk_upload()` 使用 tar-over-SSH 管道一次传输所有文件：

```python
# tools/environments/ssh.py:141-217
def _ssh_bulk_upload(self, files: list[tuple[str, str]]) -> None:
    # 1. 创建本地 staging 目录，用 symlink 映射所有文件
    # 2. tar -chf - -C staging . | ssh user@host tar xf - -C /
```

核心思路：在本地创建一个临时目录，用 symlink 映射出远程路径结构，然后 `tar -c` 这个目录并通过 SSH 管道到远程的 `tar -x`。一次 TCP 流，传输所有文件。从 O(N) 次 scp 降为 O(1) 次 tar 流——注释中提到 "~580 files goes from O(N) scp round-trips to a single streaming transfer"。

---

## 12.8 ModalEnvironment：无服务器执行

`tools/environments/modal.py`（435 行）是最复杂的后端，因为它需要在同步的 BaseEnvironment 框架中驾驭 Modal 的异步 SDK。

**_AsyncWorker**

ModalEnvironment 创建了一个专用的后台线程，运行自己的 event loop：

```python
# tools/environments/modal.py:115-145
class _AsyncWorker:
    def start(self):
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def _run_loop(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._started.set()
        self._loop.run_forever()

    def run_coroutine(self, coro, timeout=600):
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=timeout)
```

所有 Modal SDK 调用（`Sandbox.create.aio()`、`sandbox.exec.aio()`、`sandbox.terminate.aio()`）都通过 `_worker.run_coroutine()` 路由到这个后台线程的 event loop 中。主线程阻塞在 `future.result()` 上等待结果。

为什么不直接在主线程用 `asyncio.run()`？因为 `asyncio.run()` 每次调用都创建并**关闭**一个 event loop。关闭 loop 会导致绑定在该 loop 上的 httpx/AsyncOpenAI 客户端在 GC 时触发 "Event loop is closed" 错误。`_AsyncWorker` 保持 loop 长期存活，解决了这个生命周期问题。

**Snapshot 持久化**

ModalEnvironment 支持通过 Modal 的 `snapshot_filesystem()` API 在 cleanup 时保存容器文件系统的快照：

```python
# tools/environments/modal.py:402-425
def cleanup(self):
    if self._persistent:
        async def _snapshot():
            img = await self._sandbox.snapshot_filesystem.aio()
            return img.object_id

        snapshot_id = self._worker.run_coroutine(_snapshot(), timeout=60)
        if snapshot_id:
            _store_direct_snapshot(self._task_id, snapshot_id)
```

Snapshot ID 被存储在本地 JSON 文件中（`~/.hermes/modal_snapshots.json`），下次创建同一 task_id 的环境时，从 snapshot 恢复而不是从基础镜像重建。这实现了跨会话的文件系统持久化——用户昨天安装的 Python 包今天仍然在。

如果 snapshot 恢复失败（snapshot 过期或损坏），代码自动回退到基础镜像，并删除无效的 snapshot 记录。

**文件上传：base64 via stdin**

Modal sandbox 的 exec API 有 64 KB 的参数大小限制（`ARG_MAX_BYTES`）。大文件不能通过命令行参数传递。ModalEnvironment 使用 base64 编码 + stdin 管道绕过这个限制：

```python
# tools/environments/modal.py:276-298
def _modal_upload(self, host_path, remote_path):
    content = Path(host_path).read_bytes()
    b64 = base64.b64encode(content).decode("ascii")
    cmd = f"mkdir -p {dir} && base64 -d > {remote_path}"

    async def _write():
        proc = await self._sandbox.exec.aio("bash", "-c", cmd)
        # 分块写入 stdin，每块 1 MB
        while offset < len(b64):
            proc.stdin.write(b64[offset:offset + chunk_size])
            await proc.stdin.drain.aio()
            offset += chunk_size
        proc.stdin.write_eof()
```

批量上传（`_modal_bulk_upload`）更进一步：先用 `tarfile` 在内存中打包所有文件，base64 编码后通过 stdin 管道到 `base64 -d | tar xzf -` 命令。

---

## 12.9 DaytonaEnvironment 与 SingularityEnvironment

**DaytonaEnvironment**（`tools/environments/daytona.py`，230 行）基于 Daytona SDK（云开发环境平台）。它的独特之处是使用 SDK 的 `process.exec()` 而不是 SSH/subprocess——执行完全通过 HTTP API 完成。持久化通过 sandbox 的 stop/resume 生命周期实现：cleanup 时 stop sandbox（保留状态），下次创建时 resume。

`_stdin_mode = "heredoc"` 表示 DaytonaEnvironment 不支持通过 pipe 传递 stdin——而是将 stdin 数据嵌入为 shell heredoc，附加到命令字符串末尾。BaseEnvironment 的 `_embed_stdin_heredoc()` 静态方法处理这个转换。

**SingularityEnvironment**（`tools/environments/singularity.py`，263 行）面向 HPC（高性能计算）集群。Singularity/Apptainer 是 HPC 领域的标准容器运行时，不需要 root 权限。

SIF（Singularity Image Format）缓存机制避免重复下载镜像：

```
~/.hermes/sandboxes/singularity/sif_cache/{image_hash}.sif
```

Overlay 持久化使用 Singularity 的 `--overlay` 特性：所有对容器文件系统的写操作被保存到一个 ext3 overlay 文件中，容器重建后 overlay 自动重新挂载。

`--containall` 标志将容器与宿主机完全隔离（不挂载 HOME、不共享 PID 命名空间），然后通过 `--bind` 显式挂载需要的目录。

---

## 12.10 terminal_tool()：编排层

`tools/terminal_tool.py`（1,778 行）是所有后端的统一入口。它读取配置（`config.yaml` 的 `terminal:` 段），决定使用哪个后端，管理后端实例的生命周期。

**环境创建**

`_create_environment()` 根据 `env_type` 配置项实例化对应的后端：

- `"local"` → `LocalEnvironment(cwd, timeout, env)`
- `"docker"` → `DockerEnvironment(image, cwd, timeout, cpu, memory, ...)`
- `"ssh"` → `SSHEnvironment(host, user, cwd, timeout, port, key)`
- `"modal"` → `ModalEnvironment(image, cwd, timeout, ...)`
- `"daytona"` → `DaytonaEnvironment(image, cwd, timeout, ...)`
- `"singularity"` → `SingularityEnvironment(image, cwd, timeout, ...)`

**空闲清理**

一个后台线程 `_cleanup_inactive_envs()` 定期扫描不活跃的环境并清理它们。每次工具调用都更新 `_last_activity[task_id]` 时间戳，超过阈值（默认 30 分钟）的环境被自动 cleanup——释放 Docker 容器、关闭 SSH 连接、终止 Modal sandbox。

**前台 vs 后台执行**

terminal schema 支持 `background: true` 参数。前台命令有 `FOREGROUND_MAX_TIMEOUT = 600` 秒的硬上限。后台命令通过 `nohup` 包装在子 shell 中异步执行，立即返回进程 PID，不阻塞 Agent 循环。

**危险命令审批**

某些命令需要用户确认才能执行（如 `rm -rf /`、`sudo` 前缀的命令）。terminal_tool 维护了一个审批系统，在 CLI 模式下弹出确认提示，在消息平台模式下通过 `clarify` 工具请求确认。

---

## 本章小结

六种 Terminal 后端看起来差异巨大——Local 是 `subprocess.Popen`，Docker 是 `docker exec`，SSH 是 `ssh bash -c`，Modal 是异步 SDK 调用，Daytona 是 HTTP API，Singularity 是 `singularity exec`。但通过 BaseEnvironment 的模板方法模式，它们共享了 80% 的代码：session snapshot、CWD 追踪、进程等待、timeout 处理、interrupt 检查。

每个后端只需要实现两个方法：`_run_bash()`（如何启动一个 bash 进程）和 `cleanup()`（如何释放资源）。`ProcessHandle` Protocol 和 `_ThreadedProcessHandle` 适配器确保 SDK 后端的异步 API 能无缝接入同步的执行框架。

这个设计的可扩展性很好：添加一个新后端只需要创建一个 `BaseEnvironment` 子类，实现 `_run_bash()` 和 `cleanup()`，然后在 `_create_environment()` 中添加一个 elif 分支。

---

## 速查表

| 文件 | 行数 | 角色 |
|------|------|------|
| `tools/environments/base.py` | 580 | BaseEnvironment 抽象基类 + ProcessHandle Protocol |
| `tools/environments/local.py` | 315 | 本地执行，env blocklist，进程组 kill |
| `tools/environments/docker.py` | 561 | Docker 沙箱，安全加固，持久化存储 |
| `tools/environments/ssh.py` | 259 | SSH 远程执行，ControlMaster，tar 批量传输 |
| `tools/environments/modal.py` | 435 | Modal 无服务器执行，_AsyncWorker，snapshot 持久化 |
| `tools/environments/daytona.py` | 230 | Daytona SDK 执行，stop/resume 持久化 |
| `tools/environments/singularity.py` | 263 | Singularity HPC 容器，SIF 缓存，overlay 持久化 |
| `tools/terminal_tool.py` | 1,778 | 统一入口，环境创建/清理/编排 |

| 概念 | 说明 |
|------|------|
| spawn-per-call | 每次执行 spawn 新进程，snapshot 恢复状态 |
| Session Snapshot | `export -p` + `declare -f` + `alias -p` 捕获 login shell 环境 |
| CWD 追踪 | 文件方式（本地）/ stdout 标记方式（远程） |
| ProcessHandle | `poll/kill/wait/stdout/returncode` 五方法 Protocol |
| _ThreadedProcessHandle | SDK 后端的同步→异步适配器，基于 `os.pipe()` |
| _SECURITY_ARGS | Docker 容器安全加固：cap-drop ALL + 最小 cap-add |
| ControlMaster | SSH 连接复用，`ControlPersist=300` 秒 |
| _AsyncWorker | Modal 后端的专用 event loop 线程 |
| Snapshot 持久化 | Modal 的 `snapshot_filesystem()` + 本地 JSON 索引 |
| tar-over-SSH | 批量文件传输从 O(N) scp → O(1) tar 管道 |
