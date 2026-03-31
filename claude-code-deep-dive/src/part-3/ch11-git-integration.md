
# 第 11 章：Git 集成 — Agent 的版本控制中枢

> **核心问题**：一个 AI 编码 Agent 需要多深地理解 Git？它如何在安全地执行 Git 操作的同时，利用仓库信息为 LLM 提供上下文？

Git 对 Claude Code 而言不仅仅是"可以执行的一组命令" — 它是 Agent 理解项目结构、追踪代码变更、管理配置规则、隔离并行工作的**核心基础设施**。与 Bash/Read/Write 等通用工具不同，Git 集成深入渗透到系统的几乎每一个层面：从系统提示词的构建（注入仓库状态），到 CLAUDE.md 配置的五级加载，再到 Worktree 级别的会话隔离。

本章将完整解析 Claude Code 的 Git 集成体系 — 7 个紧密协作的子系统，分布在 5 个模块、超过 40 个关键函数中，构成了一个安全、高效、上下文感知的版本控制中枢。

---

## 11.1 概述：Git 在 Agent 中的核心角色

### 7 个子系统全景

Claude Code 的 Git 集成并非一个单一模块，而是由 7 个功能子系统组成的协作网络：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Git 集成 · 7 大子系统                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [1] 命令执行基础设施        t_() / u8()                        │
│       └─ 所有 Git 操作的底层执行层                               │
│                                                                 │
│  [2] 仓库信息快照 & Diff     D_6() / g5$() / ej8()             │
│       └─ 并行获取仓库状态，生成 diff/patch                      │
│                                                                 │
│  [3] CLAUDE.md 五级加载      y1H() / rr1() / O59()             │
│       └─ User → Local → Project → Rules → Managed              │
│                                                                 │
│  [4] .claude/rules/ 条件规则  AV6() / yY()                     │
│       └─ frontmatter paths 匹配 + 按需激活                      │
│                                                                 │
│  [5] Worktree 管理           kH_() / v48() / byH()             │
│       └─ 会话级隔离 + 符号链接 + 稀疏检出                       │
│                                                                 │
│  [6] 安全机制                pQH 白名单 / Flag 拦截 / .git 保护 │
│       └─ 只读子命令白名单 + 危险 flag 拦截                      │
│                                                                 │
│  [7] 文件监视                chokidar / FileChanged Hook        │
│       └─ 外部变更检测 + CWD 联动                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 代码分布：跨 5 大模块

Git 集成的代码不集中在单一文件中，而是散布在整个代码库的多个模块里。这种分布反映了 Git 的"基础设施"本质 — 它为各个上层功能提供支撑：

| 模块 | 主要职责 | 关键函数 |
|------|----------|----------|
| `03_file_system` | 文件监视、路径解析 | `yW7()`, `hW7()`, `Pm6()`, `SW7()` |
| `04_git_operations` | Git 命令执行、仓库状态、diff | `t_()`, `u8()`, `D_6()`, `g5$()`, `ej8()` |
| `09_data_processing` | CLAUDE.md 加载、rules 解析 | `y1H()`, `rr1()`, `O59()`, `AV6()`, `yY()` |
| `11_api_streaming` | 系统提示词注入 Git 信息 | 系统提示词构建中引用 Git 状态 |
| `17_system_prompt_full` | Git 安全规则、Worktree 指令 | 安全白名单、操作指南 |

### 数据流全景图

```
                         ┌──────────────────────┐
                         │    用户请求           │
                         │  "帮我提交这个修复"    │
                         └──────────┬───────────┘
                                    │
                    ┌───────────────▼───────────────┐
                    │       Agentic Loop            │
                    │  ┌─────────────────────────┐  │
                    │  │   系统提示词构建         │  │
                    │  │   ├─ D_6() 仓库快照     │  │
                    │  │   ├─ CLAUDE.md 加载     │  │
                    │  │   └─ 安全规则注入       │  │
                    │  └─────────────────────────┘  │
                    │              │                 │
                    │  ┌───────────▼─────────────┐  │
                    │  │   LLM 生成 tool_use     │  │
                    │  │   tool: "Bash"          │  │
                    │  │   args: "git commit..." │  │
                    │  └───────────┬─────────────┘  │
                    │              │                 │
                    │  ┌───────────▼─────────────┐  │
                    │  │   安全检查 (pQH 白名单)  │  │
                    │  │   Flag 拦截 + 权限判断   │  │
                    │  └───────────┬─────────────┘  │
                    │              │                 │
                    │  ┌───────────▼─────────────┐  │
                    │  │   t_() → u8() 执行      │  │
                    │  │   结果回注对话           │  │
                    │  └─────────────────────────┘  │
                    │                               │
                    │  ┌─────────────────────────┐  │
                    │  │  文件监视 FileChanged    │  │
                    │  │  → 刷新仓库状态         │  │
                    │  └─────────────────────────┘  │
                    └───────────────────────────────┘
```

**小结**：Git 集成是 Claude Code 中最"分散"却最"无处不在"的子系统。它的 7 个子系统从底层命令执行到上层配置加载，从安全拦截到文件监视，构成了一个完整的版本控制中枢。理解这个全景后，我们逐一深入每个子系统。

---

## 11.2 Git 命令执行基础设施

### 问题：如何安全、可靠地执行 Git 命令？

Agent 需要频繁执行 Git 命令 — 获取状态、生成 diff、检查分支。这些命令必须满足几个要求：自动使用正确的工作目录、有合理的超时限制、不能因命令失败而崩溃。Claude Code 为此构建了两层封装。

### t_() — 高级封装

`t_()` 是所有 Git 操作的标准入口。它在底层执行器 `u8()` 之上添加了两个关键默认值：

```javascript
// t_() — Git 命令高级封装
// H: 命令名(如 "git"), _: 参数数组, q: 配置选项
function t_(H, _, q = {
    timeout: 10 * 60 * 1000,        // 默认 10 分钟超时
    preserveOutputOnError: true,     // 失败时保留输出（用于诊断）
    useCwd: true                     // 自动注入当前工作目录
}) {
    return u8(H, _, {
        ...q,
        cwd: q.useCwd ? X_() : undefined,  // X_() 返回当前 CWD
        timeout: q.timeout,
        preserveOutputOnError: q.preserveOutputOnError
    })
}
```

三个默认值的设计意图：

| 参数 | 默认值 | 原因 |
|------|--------|------|
| `timeout` | 10 分钟 | Git 操作可能很慢（大仓库 clone、大文件 diff），但不能无限等待 |
| `preserveOutputOnError` | `true` | 命令失败时 stdout/stderr 仍然有诊断价值 |
| `useCwd` | `true` | 确保 Git 命令在用户的项目目录下执行，而非 Agent 进程目录 |

### u8() — 底层执行器

`u8()` 是真正的命令执行层，基于 `execa` 库（通过 `p1` 函数引用）：

```javascript
// u8() — 底层命令执行器
function u8(H, _, { timeout, cwd, preserveOutputOnError, ...rest } = {}) {
    return new Promise((resolve) => {
        // p1 = execa，注意 reject: false
        p1(H, _, {
            ...rest,
            cwd,
            timeout,
            reject: false    // <-- 关键设计决策
        }).then((result) => {
            const { stdout, stderr, exitCode, failed } = result;
            if (result.failed) {
                // 失败时：返回结构化错误，而非抛异常
                resolve({
                    stdout: preserveOutputOnError ? stdout : "",
                    stderr: preserveOutputOnError ? stderr : "",
                    code: exitCode,
                    error: true
                });
            } else {
                resolve({
                    stdout,
                    stderr,
                    code: 0
                });
            }
        });
    });
}
```

> **设计决策：为什么 `reject: false`？**
>
> 在 Agent 场景中，Git 命令失败是**常态**，而非异常：
> - `git status` 在非 Git 仓库中会失败 — 这不是错误，是信息
> - `git diff` 找不到指定 commit 会失败 — Agent 需要回退到其他策略
> - `git merge-base` 在浅克隆中可能失败 — 需要优雅降级
>
> 使用 `reject: false` 让所有命令都返回结构化结果而非抛异常，调用方可以通过 `code` 字段判断成功与否，实现优雅的错误处理和多级回退策略。这与传统 CLI 工具"非零退出码 = 异常"的思维方式截然不同。

### 执行流程

```
调用方 (如 D_6)
    │
    ▼
  t_(  "git", ["status", "--porcelain"]  )
    │
    ├─ 注入 cwd = X_()         ← 当前工作目录
    ├─ 注入 timeout = 600000   ← 10 分钟
    │
    ▼
  u8(  "git", ["status", "--porcelain"], { cwd, timeout, reject: false }  )
    │
    ├─ execa 执行子进程
    │
    ├─ 成功 → { stdout: "M  src/app.ts\n...", stderr: "", code: 0 }
    │
    └─ 失败 → { stdout: "", stderr: "fatal: not a git repo", code: 128, error: true }
                不抛异常，调用方自行处理
```

**小结**：两层封装（`t_()` + `u8()`）实现了"安全默认值 + 永不抛异常"的设计。这个基础设施让上层的仓库信息获取和 diff 生成可以放心地并行调用多个 Git 命令，无需担心任何一个失败会导致整个流程崩溃。

---

## 11.3 仓库信息快照与 Diff/Patch 生成

### 问题：如何高效获取仓库全貌？

LLM 需要了解当前仓库的状态才能做出正确决策 — 当前在哪个分支？有哪些未提交的修改？远程分支是什么？但逐个执行 Git 命令获取这些信息太慢了。Claude Code 的解决方案是**并行快照**。

### D_6() — 并行获取 6 项仓库信息

`D_6()` 是仓库状态的"快照函数"，一次调用获取 6 项关键信息：

```javascript
// D_6() — 并行获取仓库完整状态
async function D_6() {
    // Promise.all 并行执行 6 个 Git 命令
    const [
        branchResult,          // 当前分支名
        statusResult,          // 工作区状态 (porcelain 格式)
        logResult,             // 最近提交历史
        remoteResult,          // 远程仓库列表
        stashResult,           // stash 列表
        mergeBaseResult        // 与远程的分叉点
    ] = await Promise.all([
        t_("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
        t_("git", ["status", "--porcelain"]),
        t_("git", ["log", "--oneline", "-20"]),
        t_("git", ["remote", "-v"]),
        t_("git", ["stash", "list"]),
        // mergeBase 可能失败(浅克隆), 不影响其他结果
        t_("git", ["merge-base", "HEAD", remoteBranch])
    ]);

    return {
        branch: branchResult.stdout.trim(),
        status: statusResult.stdout,
        log: logResult.stdout,
        remote: remoteResult.stdout,
        stash: stashResult.stdout,
        mergeBase: mergeBaseResult.code === 0
            ? mergeBaseResult.stdout.trim()
            : null     // 优雅降级
    };
}
```

> **设计决策：为什么使用 `Promise.all` 而非顺序执行？**
>
> 6 个 Git 命令之间没有数据依赖关系，并行执行可以将总耗时从 6 x T 降低到 max(T)。在大型仓库中，`git log` 和 `git merge-base` 各自可能耗时数百毫秒，并行化带来的加速非常显著。而 `reject: false` 的设计保证了任何一个命令失败都不会导致 `Promise.all` 整体 reject。

### ej8() — 远程基准分支的三级回退

获取"远程基准分支"（upstream branch）看似简单，实际上充满陷阱。不同的仓库配置、不同的 clone 方式，可能导致常规方法失败。`ej8()` 实现了三级回退策略：

```javascript
// ej8() — 远程基准分支三级回退
async function ej8() {
    // Level 1: 尝试 upstream tracking branch
    const upstream = await t_("git", [
        "rev-parse", "--abbrev-ref", "@{upstream}"
    ]);
    if (upstream.code === 0) return upstream.stdout.trim();

    // Level 2: 通过 remote show 获取 HEAD branch
    const remoteShow = await t_("git", [
        "remote", "show", "origin"
    ]);
    if (remoteShow.code === 0) {
        const match = remoteShow.stdout.match(/HEAD branch:\s*(\S+)/);
        if (match) return `origin/${match[1]}`;
    }

    // Level 3: 硬编码常见分支名回退
    for (const candidate of ["main", "master", "develop"]) {
        const check = await t_("git", [
            "rev-parse", "--verify", `origin/${candidate}`
        ]);
        if (check.code === 0) return `origin/${candidate}`;
    }

    return null;  // 所有策略都失败
}
```

三级回退的覆盖场景：

| 级别 | 方法 | 覆盖场景 |
|------|------|----------|
| Level 1 | `@{upstream}` | 正常 clone 并设置了 tracking 的分支 |
| Level 2 | `remote show origin` | fork 仓库、手动添加的 remote |
| Level 3 | 硬编码列表 | 浅克隆、HEAD detached、CI 环境 |

### g5$() — 三种 Diff 模式

Claude Code 需要在不同场景下生成不同粒度的 diff。`g5$()` 支持三种模式：

```javascript
// g5$() — 三种 diff 模式
async function g5$(mode, options = {}) {
    switch (mode) {
        case "staged":
            // 模式 1: 仅已暂存的变更 (用于 commit 前预览)
            return t_("git", ["diff", "--cached"]);

        case "unstaged":
            // 模式 2: 仅未暂存的变更 (用于工作区状态检查)
            return t_("git", ["diff"]);

        case "full":
            // 模式 3: 与远程基准分支的完整差异 (用于 PR 描述生成)
            const base = await ej8();  // 获取基准分支
            if (!base) return { stdout: "", code: 1 };
            return t_("git", [
                "diff",
                `${base}...HEAD`,      // 三点 diff: 从分叉点开始
                "--stat",              // 包含统计摘要
                "--patch"              // 包含完整 patch
            ]);
    }
}
```

三种模式的使用场景：

```
staged   ──→ 系统提示词注入 "当前暂存的修改"
unstaged ──→ 系统提示词注入 "当前未暂存的修改"
full     ──→ PR 描述生成、代码审查
```

### z1_() — 未跟踪文件收集（多重保护）

未跟踪文件（untracked files）的收集看似简单（`git ls-files --others`），但有两个隐患：大型仓库可能有数万个未跟踪文件，以及 `.gitignore` 之外的文件可能包含敏感信息。`z1_()` 实施了多重保护：

```javascript
// z1_() — 未跟踪文件收集（多重保护）
async function z1_() {
    const result = await t_("git", [
        "ls-files",
        "--others",              // 未跟踪文件
        "--exclude-standard",    // 排除 .gitignore 匹配的文件
    ]);

    if (result.code !== 0) return [];

    const files = result.stdout.split("\n").filter(Boolean);

    // 保护 1: 数量上限，避免 token 爆炸
    if (files.length > 100) {
        return files.slice(0, 100);  // 截断 + 提示 "... and N more"
    }

    // 保护 2: 过滤大文件（避免二进制/生成文件污染上下文）
    // 保护 3: 过滤敏感路径模式 (.env, credentials, etc.)

    return files;
}
```

> **设计决策：为什么限制 100 个文件？**
>
> 未跟踪文件列表会被注入到系统提示词中，作为 LLM 的上下文。100 个文件名大约占 2000-3000 tokens，这是一个在"信息充分"和"上下文节约"之间的平衡点。超过 100 个通常意味着仓库有 `node_modules` 等目录未被 `.gitignore` 排除，此时完整列表对 LLM 也没有实际价值。

### 仓库信息的流向

```
D_6() ─────────────────────────────────────────┐
  ├─ branch: "feature/auth"                    │
  ├─ status: "M  src/auth.ts\nA  src/login.ts" │
  ├─ log: "abc1234 Add login page\n..."        │   注入到
  ├─ remote: "origin  git@github.com:..."      ├──────────→ 系统提示词
  ├─ stash: ""                                 │
  └─ mergeBase: "def5678"                      │
                                               │
g5$("staged")  ──→ staged diff ────────────────┤
g5$("unstaged") ──→ unstaged diff ─────────────┤
z1_() ──→ untracked files list ────────────────┘
```

这些信息最终被系统提示词构建模块（第 6 章）组装成类似以下格式，注入到 LLM 上下文中：

```
Current branch: feature/auth
Recent commits:
  abc1234 Add login page
  def5678 Set up auth module
Staged changes:
  M  src/auth.ts
  A  src/login.ts
Unstaged changes:
  (none)
Untracked files:
  src/auth.test.ts
```

**小结**：仓库信息获取系统的核心设计原则是**并行 + 回退 + 保护**。`D_6()` 通过 `Promise.all` 并行获取 6 项信息；`ej8()` 通过三级回退确保在各种 Git 配置下都能找到基准分支；`z1_()` 通过数量限制和路径过滤避免上下文爆炸。这些信息是 LLM 理解仓库状态、做出正确 Git 操作决策的基础。

---

## 11.4 CLAUDE.md 五级加载体系

### 问题：如何让不同层级的用户都能定制 Agent 行为？

一个团队项目中，存在多个层级的配置需求：个人有自己的偏好（编辑器风格、语言）、项目有共享规范（代码风格、测试要求）、组织有安全策略。Claude Code 通过 **CLAUDE.md 五级加载体系** 解决这个问题 — 从用户个人配置到系统管理配置，逐级叠加。

### 五层优先级结构

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 4: Managed (托管层)                                    │
│  路径: 内部管理                                               │
│  特点: 不可被用户排除，强制生效                                │
│  用途: AutoMemory / TeamMemory                               │
├──────────────────────────────────────────────────────────────┤
│  Layer 3: Rules (规则层)                                      │
│  路径: .claude/rules/*.md                                    │
│  特点: 支持 paths frontmatter 条件激活                        │
│  用途: 按文件类型/路径应用不同规则                              │
├──────────────────────────────────────────────────────────────┤
│  Layer 2: Project (项目层)                                    │
│  路径: CLAUDE.md (项目根目录) + 各子目录 CLAUDE.md             │
│  特点: 版本控制共享，团队成员共用                               │
│  用途: 项目规范、代码风格、测试要求                             │
├──────────────────────────────────────────────────────────────┤
│  Layer 1: Local (本地层)                                      │
│  路径: CLAUDE.local.md                                       │
│  特点: 被 .gitignore 忽略，仅本地生效                          │
│  用途: 个人偏好、本地环境变量                                   │
├──────────────────────────────────────────────────────────────┤
│  Layer 0: User (用户层)                                       │
│  路径: ~/.claude/CLAUDE.md                                   │
│  特点: 跨所有项目生效                                         │
│  用途: 全局偏好（语言、风格、Memory 系统指令）                   │
└──────────────────────────────────────────────────────────────┘

  优先级: Layer 4 > Layer 3 > Layer 2 > Layer 1 > Layer 0
  (高层级覆盖低层级的冲突指令)
```

### 路径映射 y1H()

`y1H()` 负责将层级标识映射到具体的文件路径：

```javascript
// y1H() — 路径映射
function y1H(layerType, projectRoot) {
    switch (layerType) {
        case "user":
            // Layer 0: 用户全局配置
            return path.join(os.homedir(), ".claude", "CLAUDE.md");

        case "local":
            // Layer 1: 项目本地配置 (不进版本控制)
            return path.join(projectRoot, "CLAUDE.local.md");

        case "project":
            // Layer 2: 项目共享配置
            return path.join(projectRoot, "CLAUDE.md");

        case "managed":
            // Layer 4: 托管配置 (AutoMemory / TeamMemory)
            return {
                autoMemory: path.join(projectRoot,
                    ".claude", "automemory.md"),
                teamMemory: path.join(projectRoot,
                    ".claude", "settings", "team-memory.md")
            };
    }
}
```

### 向上遍历 rr1()

CLAUDE.md 不仅在项目根目录生效 — 它支持"向上遍历"：从当前工作目录开始，一直到项目根目录（或文件系统根目录），每一级目录的 CLAUDE.md 都会被加载：

```javascript
// rr1() — 向上遍历加载 CLAUDE.md
async function rr1(startDir, projectRoot) {
    const results = [];
    let current = startDir;

    // 从当前目录向上遍历到项目根目录
    while (current !== path.dirname(current)) {
        const claudePath = path.join(current, "CLAUDE.md");
        const localPath = path.join(current, "CLAUDE.local.md");

        // 每个目录检查两个文件
        if (await fileExists(claudePath)) {
            const content = await readFile(claudePath);
            results.push({
                path: claudePath,
                content,
                layer: current === projectRoot ? "project" : "project-parent",
                depth: pathDepth(current, startDir)
            });
        }
        if (await fileExists(localPath)) {
            const content = await readFile(localPath);
            results.push({
                path: localPath,
                content,
                layer: "local",
                depth: pathDepth(current, startDir)
            });
        }

        // 到达项目根目录时停止
        if (current === projectRoot) break;
        current = path.dirname(current);
    }

    return results;
}
```

这意味着以下目录结构中，在 `src/components/` 下工作时，三个 CLAUDE.md 都会被加载：

```
my-project/
├── CLAUDE.md              ← Layer 2 (项目级: "Use TypeScript strict mode")
├── src/
│   ├── CLAUDE.md          ← Layer 2 (子目录级: "Components use React FC")
│   └── components/
│       ├── CLAUDE.md      ← Layer 2 (子子目录: "Use CSS Modules")
│       └── Button.tsx
└── .claude/
    └── rules/
        └── testing.md     ← Layer 3 (规则: "All components need tests")
```

### 嵌套加载 O59() 与 @path 导入语法

CLAUDE.md 支持 `@path` 导入语法，允许一个 CLAUDE.md 引用另一个文件的内容：

```markdown
<!-- CLAUDE.md 内容 -->
# 项目规范

请遵循以下编码规范：
@docs/coding-standards.md
@.claude/prompts/review-checklist.md
```

`O59()` 负责解析并加载这些引用：

```javascript
// O59() — 嵌套加载 @path 引用
async function O59(content, basePath, visited = new Set()) {
    const lines = content.split("\n");
    const resolved = [];

    for (const line of lines) {
        const match = line.match(/^@(.+)$/);
        if (match) {
            const importPath = path.resolve(basePath, match[1]);

            // 安全检查 1: 循环引用检测
            if (visited.has(importPath)) {
                resolved.push(`<!-- Circular import: ${importPath} -->`);
                continue;
            }

            // 安全检查 2: 外部导入安全检查
            // 被引用文件必须在项目目录内
            if (!importPath.startsWith(projectRoot)) {
                resolved.push(`<!-- Blocked external import: ${importPath} -->`);
                continue;
            }

            visited.add(importPath);
            const imported = await readFile(importPath);
            // 递归解析被导入文件中的 @path
            const expanded = await O59(imported, path.dirname(importPath), visited);
            resolved.push(expanded);
        } else {
            resolved.push(line);
        }
    }

    return resolved.join("\n");
}
```

> **设计决策：外部导入安全检查**
>
> `@path` 导入必须限制在项目目录内。如果允许 `@/etc/passwd` 或 `@../../other-project/secrets.md`，恶意的 CLAUDE.md 就能窃取系统文件或其他项目的敏感信息。这是一个典型的"路径穿越"防护。

### 加载触发条件

CLAUDE.md 的加载不是一次性的，而是在多个时机触发：

| 触发条件 | 说明 |
|----------|------|
| 会话启动 | 初始化时加载所有层级 |
| CWD 变更 | 切换目录后重新遍历加载 |
| 文件监视触发 | CLAUDE.md 文件被外部修改时热重载 |
| Worktree 切换 | 进入/退出 worktree 时重新加载 |
| 手动刷新 | 用户通过 `/refresh` 命令触发 |

### claudeMdExcludes 排除机制

用户可以在 settings 中配置 `claudeMdExcludes` 来排除特定的 CLAUDE.md 文件。但有一个重要例外 — **Layer 4 (Managed) 不可被排除**：

```javascript
// 排除检查
function shouldLoadClaudeMd(filePath, layer, excludes) {
    // Managed 层级永远加载，不受排除影响
    if (layer === "managed") return true;

    // 检查是否在排除列表中
    for (const pattern of excludes) {
        if (minimatch(filePath, pattern)) return false;
    }
    return true;
}
```

### Token 统计 vn1()

加载完所有 CLAUDE.md 后，`vn1()` 会统计总 token 数，并在系统提示词中记录：

```javascript
// vn1() — CLAUDE.md token 统计
function vn1(loadedFiles) {
    let totalTokens = 0;
    const stats = [];

    for (const file of loadedFiles) {
        const tokens = estimateTokens(file.content);
        totalTokens += tokens;
        stats.push({
            path: file.path,
            layer: file.layer,
            tokens
        });
    }

    return { totalTokens, stats };
    // 典型输出: { totalTokens: 1500, stats: [...] }
    // 这些信息会被记录到系统提示词中，帮助 LLM 了解
    // "我被给予了哪些指令，分别来自哪里"
}
```

**小结**：CLAUDE.md 五级加载体系是 Claude Code 最精巧的配置系统之一。它通过 User → Local → Project → Rules → Managed 的五层结构，满足了从个人偏好到组织策略的全部配置需求。向上遍历（`rr1()`）让子目录可以有自己的规则，`@path` 导入（`O59()`）实现了配置的模块化复用，而外部导入安全检查和循环引用检测则防止了潜在的安全风险。

---

## 11.5 .claude/rules/ 条件规则

### 问题：如何让规则按文件类型/路径条件性地激活？

CLAUDE.md 的五层结构解决了"谁的配置"的问题，但还有一个需求：**按文件类型或路径模式激活不同的规则**。例如，"所有 `.test.ts` 文件必须使用 `describe/it` 格式"，"所有 `src/api/` 下的文件必须有 JSDoc"。`.claude/rules/` 目录正是为此设计的。

### AV6() — 递归发现规则文件

```javascript
// AV6() — 递归发现 .claude/rules/ 下的所有 .md 文件
async function AV6(projectRoot) {
    const rulesDir = path.join(projectRoot, ".claude", "rules");

    if (!await dirExists(rulesDir)) return [];

    // 递归扫描所有 .md 文件
    const files = await glob("**/*.md", { cwd: rulesDir });

    return files.map(f => ({
        path: path.join(rulesDir, f),
        relativePath: f
    }));
}
```

### 三源并行加载 + inode 去重

规则文件可能来自三个来源：项目根目录的 `.claude/rules/`、worktree 中的 `.claude/rules/`（通过符号链接）、以及通过 `@path` 引入的外部规则。为避免同一文件被加载两次（特别是符号链接场景），系统使用 **inode 去重**：

```javascript
// 三源并行加载 + inode 去重
async function loadAllRules(sources) {
    const seen = new Set();  // inode 去重集合
    const rules = [];

    // 并行加载所有来源
    const allFiles = await Promise.all(
        sources.map(source => AV6(source))
    );

    for (const file of allFiles.flat()) {
        // 获取文件 inode (唯一标识，不受符号链接影响)
        const stat = await fs.stat(file.path);
        const inode = stat.ino;

        if (seen.has(inode)) continue;  // 跳过重复文件
        seen.add(inode);

        const content = await readFile(file.path);
        const { frontmatter, body } = yY(content);
        rules.push({ ...file, frontmatter, body });
    }

    return rules;
}
```

### yY() — frontmatter 解析

每个规则文件可以包含 YAML frontmatter，指定激活条件：

```markdown
---
paths:
  - "src/**/*.test.ts"
  - "src/**/*.spec.ts"
---

# Testing Rules

- All test files must use describe/it blocks
- Use jest.mock() for external dependencies
- Minimum 80% coverage for new code
```

`yY()` 解析这个 frontmatter：

```javascript
// yY() — frontmatter 解析
function yY(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    if (!match) {
        // 没有 frontmatter，整个内容都是规则体
        return { frontmatter: {}, body: content };
    }

    const frontmatter = yamlParse(match[1]);  // 解析 YAML
    const body = match[2];

    return { frontmatter, body };
}
```

### paths frontmatter + picomatch 条件激活

当规则文件有 `paths` frontmatter 时，它只在当前操作涉及匹配路径时才被激活。匹配使用 `picomatch` 库（高性能 glob 匹配）：

```javascript
// 条件激活检查
function shouldActivateRule(rule, activeFiles) {
    // 没有 paths 条件的规则始终激活
    if (!rule.frontmatter.paths || rule.frontmatter.paths.length === 0) {
        return true;
    }

    // 使用 picomatch 创建匹配器
    const matchers = rule.frontmatter.paths.map(p => picomatch(p));

    // 检查当前活跃文件是否有任何一个匹配
    return activeFiles.some(file =>
        matchers.some(match => match(file))
    );
}
```

完整的激活流程：

```
.claude/rules/
├── general.md          ← 无 paths, 始终激活
├── testing.md          ← paths: ["**/*.test.ts"], 仅测试文件时激活
├── api-docs.md         ← paths: ["src/api/**"], 仅 API 代码时激活
└── security/
    └── auth.md         ← paths: ["src/auth/**"], 仅认证模块时激活

当前编辑: src/api/users.ts
  激活: general.md + api-docs.md
  未激活: testing.md, auth.md
```

### InstructionsLoaded Hook

规则加载完成后，会触发 `InstructionsLoaded` Hook，允许外部系统（如 MCP 服务器）在规则加载后执行自定义逻辑：

```javascript
// 触发 InstructionsLoaded Hook
await hookManager.emit("InstructionsLoaded", {
    rules: loadedRules,
    layers: allLayers,
    totalTokens: vn1(allContent).totalTokens
});
```

**小结**：`.claude/rules/` 条件规则系统为 CLAUDE.md 体系增加了"路径感知"能力。通过 frontmatter 中的 `paths` 字段和 `picomatch` 匹配，规则可以按需激活，避免不相关的指令污染 LLM 上下文。inode 去重解决了符号链接场景下的重复加载问题，而 `InstructionsLoaded` Hook 则为外部集成提供了扩展点。

---

## 11.6 Worktree 管理

### 问题：如何让 Agent 在不影响主工作区的情况下安全地进行实验性操作？

当 Agent 需要尝试一个不确定是否正确的修复方案，或者用户想在保持当前工作的同时让 Agent 探索另一个方向时，直接在主工作区操作是危险的。Git Worktree 提供了完美的解决方案 — 在同一个仓库的不同分支上创建独立的工作目录。

Claude Code 对 Git Worktree 进行了深度封装，提供了**会话级隔离**：每个 Worktree 有自己的工作目录、分支、配置，但共享同一个 Git 对象库。

### 配置参数

Worktree 行为通过项目设置进行配置：

```javascript
// Worktree 相关配置
{
    // 需要符号链接到 worktree 的目录（避免重复安装依赖）
    "symlinkDirectories": [
        "node_modules",
        ".venv",
        "vendor"
    ],
    // 稀疏检出路径（大型 monorepo 中只检出需要的子目录）
    "sparsePaths": [
        "packages/my-package",
        "shared/utils"
    ]
}
```

### 路径结构

```
my-project/                           ← 主工作区
├── .claude/
│   └── worktrees/
│       └── fix-auth-bug/             ← Worktree 工作目录
│           ├── .git                  ← 指向主仓库 .git 的引用
│           ├── src/                  ← 独立的工作文件
│           ├── node_modules → ../../node_modules  ← 符号链接
│           └── .worktreeinclude      ← 稀疏检出配置
├── .git/
│   └── worktrees/
│       └── fix-auth-bug/             ← Git 内部 worktree 记录
├── src/
└── node_modules/
```

### 创建流程：kH_() → v48() → N48()

Worktree 创建是一个三阶段流程：

```
kH_() 入口函数
  │
  ├─ 1. 生成 worktree 名称和路径
  │     路径: .claude/worktrees/{name}/
  │     分支: worktree-{name}-{timestamp}
  │
  ├─ 2. v48() 执行 git worktree add
  │     git worktree add -b {branch} {path} HEAD
  │
  └─ 3. N48() 后处理
        ├─ 复制 settings 到 worktree
        ├─ 设置 hooks path
        ├─ 创建符号链接 (symlinkDirectories)
        ├─ 配置稀疏检出 (sparsePaths)
        └─ 写入 .worktreeinclude
```

详细的创建代码：

```javascript
// kH_() — Worktree 创建入口
async function kH_(name) {
    const projectRoot = getProjectRoot();
    const worktreePath = path.join(
        projectRoot, ".claude", "worktrees", name
    );
    const branchName = `worktree-${name}-${Date.now()}`;

    // 阶段 1: 创建 worktree
    const result = await v48(worktreePath, branchName);
    if (result.error) throw new Error(`Worktree creation failed: ${result.stderr}`);

    // 阶段 2: 后处理
    await N48(worktreePath, projectRoot);

    return { worktreePath, branchName };
}

// v48() — 执行 git worktree add
async function v48(worktreePath, branchName) {
    return t_("git", [
        "worktree", "add",
        "-b", branchName,    // 创建新分支
        worktreePath,        // worktree 路径
        "HEAD"               // 基于当前 HEAD
    ]);
}

// N48() — 后处理
async function N48(worktreePath, projectRoot) {
    // 1. 复制 settings
    const settingsSource = path.join(projectRoot, ".claude", "settings");
    const settingsDest = path.join(worktreePath, ".claude", "settings");
    if (await dirExists(settingsSource)) {
        await copyDir(settingsSource, settingsDest);
    }

    // 2. 设置 hooks path（指向主仓库的 hooks）
    await t_("git", [
        "-C", worktreePath,
        "config", "core.hooksPath",
        path.join(projectRoot, ".git", "hooks")
    ]);

    // 3. 创建符号链接（避免重复安装依赖）
    const settings = await loadSettings(projectRoot);
    for (const dir of settings.symlinkDirectories || []) {
        const source = path.join(projectRoot, dir);
        const target = path.join(worktreePath, dir);
        if (await dirExists(source)) {
            await fs.symlink(source, target, "junction");
        }
    }

    // 4. 配置稀疏检出
    if (settings.sparsePaths && settings.sparsePaths.length > 0) {
        await t_("git", [
            "-C", worktreePath,
            "sparse-checkout", "set",
            ...settings.sparsePaths
        ]);

        // 写入 .worktreeinclude 供其他工具参考
        await writeFile(
            path.join(worktreePath, ".worktreeinclude"),
            settings.sparsePaths.join("\n")
        );
    }
}
```

> **设计决策：为什么符号链接 `node_modules`？**
>
> 在 Node.js 项目中，`node_modules` 可能包含数百 MB 甚至数 GB 的依赖。如果每个 Worktree 都完整复制一份，不仅浪费磁盘空间，`npm install` 还需要额外时间。通过符号链接，Worktree 直接使用主工作区的依赖目录，实现了零成本的依赖共享。

### 清理 byH()

Worktree 清理需要处理三种情况：正常清理、强制清理（有未提交的修改）、以及 Git worktree 命令本身失败的情况：

```javascript
// byH() — Worktree 清理（三级回退）
async function byH(worktreePath, branchName) {
    // Level 1: git worktree remove --force
    const result = await t_("git", [
        "worktree", "remove", "--force", worktreePath
    ]);

    if (result.code !== 0) {
        // Level 2: 如果 git 命令失败，直接删除目录
        try {
            await fs.rm(worktreePath, { recursive: true, force: true });
        } catch (e) {
            // 即使 rm 失败也继续
        }

        // 清理 git worktree 的内部记录
        await t_("git", ["worktree", "prune"]);
    }

    // Level 3: 删除关联分支
    if (branchName) {
        await t_("git", ["branch", "-D", branchName]);
    }
}
```

### EnterWorktree / ExitWorktree 工具

Claude Code 将 Worktree 操作暴露为两个 Agent 工具，让 LLM 可以直接使用：

```
EnterWorktree
  ├─ 输入: { name?: string }
  ├─ 行为: kH_() 创建 worktree → 切换 CWD
  ├─ 输出: "Entered worktree at .claude/worktrees/{name}/"
  └─ 副作用: CWD 变更 → 触发 CLAUDE.md 重新加载

ExitWorktree
  ├─ 输入: { action: "keep" | "remove", discard_changes?: boolean }
  ├─ 行为:
  │   ├─ "keep": 保留 worktree，仅切换回主工作区
  │   └─ "remove": byH() 清理 worktree → 切换回主工作区
  ├─ 安全检查: 有未提交修改时，要求 discard_changes: true
  └─ 副作用: CWD 变更 → 触发 CLAUDE.md 重新加载
```

### Team 级清理

在团队场景中，过期或废弃的 Worktree 可能会积累。系统提供了 Team 级别的清理机制：

```javascript
// Team 级 worktree 清理
async function cleanupStaleWorktrees(projectRoot, maxAgeMs = 7 * 24 * 3600 * 1000) {
    const worktreeDir = path.join(projectRoot, ".claude", "worktrees");

    if (!await dirExists(worktreeDir)) return;

    const entries = await fs.readdir(worktreeDir);
    for (const entry of entries) {
        const worktreePath = path.join(worktreeDir, entry);
        const stat = await fs.stat(worktreePath);

        // 超过 7 天的 worktree 自动清理
        if (Date.now() - stat.mtimeMs > maxAgeMs) {
            await byH(worktreePath);
        }
    }
}
```

**小结**：Worktree 管理系统为 Claude Code 提供了会话级的工作区隔离能力。三阶段创建流程（`kH_()` → `v48()` → `N48()`）确保了 Worktree 拥有完整的配置和依赖；符号链接避免了依赖重复安装；三级回退清理（`byH()`）保证了资源的可靠回收。这个系统让 Agent 可以安全地进行实验性操作，而不影响用户的主工作区。

---

## 11.7 安全机制

### 问题：如何让 Agent 使用 Git 而不破坏仓库？

Git 是一个强大但危险的工具。`git reset --hard` 可以丢弃所有未提交的修改，`git push --force` 可以覆盖远程历史，`git clean -fd` 可以删除未跟踪的文件。一个 AI Agent 如果无限制地使用 Git，可能造成不可逆的数据丢失。Claude Code 构建了一套**多层安全机制**，在允许 Agent 使用 Git 能力的同时，防止危险操作。

### pQH 白名单：23+ 安全子命令

安全机制的第一层是**子命令白名单**。只有被明确列入白名单的 Git 子命令才能被自动执行（不需要用户确认）：

```javascript
// pQH — Git 安全子命令白名单
const pQH = new Set([
    // 查看类 — 只读操作，不修改仓库状态
    "diff",             // 查看差异
    "log",              // 查看提交历史
    "show",             // 查看对象内容
    "status",           // 查看工作区状态
    "blame",            // 查看行级历史

    // 分支/标签查询
    "branch",           // 查看分支 (受 flag 限制)
    "tag",              // 查看标签 (受 flag 限制)

    // 引用解析
    "rev-parse",        // 解析引用为 SHA
    "rev-list",         // 列出 commit
    "merge-base",       // 查找公共祖先
    "describe",         // 从 tag 描述 commit

    // 文件查询
    "ls-files",         // 列出跟踪的文件
    "ls-remote",        // 查看远程引用
    "cat-file",         // 查看对象内容

    // 配置查询
    "config --get",     // 只读取配置 (不允许 --set)
    "remote",           // 查看远程列表
    "remote show",      // 查看远程详情

    // 遍历与搜索
    "for-each-ref",     // 遍历引用
    "grep",             // 搜索内容

    // 其他安全命令
    "stash list",       // 查看 stash 列表
    "stash show",       // 查看 stash 内容
    "worktree list",    // 查看 worktree 列表
    "shortlog",         // 提交摘要统计
    "reflog",           // 引用日志
]);
```

> **设计决策：白名单而非黑名单**
>
> 安全领域的基本原则是"默认拒绝，显式允许"（deny by default, allow explicitly）。黑名单（禁止 `reset`, `push --force` 等）总会遗漏新的危险命令或参数组合。白名单则确保只有经过安全审计的命令才能自动执行。不在白名单中的命令（如 `git commit`, `git push`, `git rebase`）需要用户显式确认。

### Flag 类型系统与共享 Flag 集合

仅仅白名单子命令还不够 — `git branch` 是安全的（查看分支），但 `git branch -D main` 是危险的（删除 main 分支）。因此，系统对每个白名单子命令的 **flag** 也进行了分类：

```javascript
// Flag 类型系统
const FlagType = {
    SAFE: "safe",           // 安全 flag，不需要额外检查
    NEEDS_REVIEW: "review", // 需要用户确认的 flag
    BLOCKED: "blocked"      // 始终禁止的 flag
};

// 共享的安全 Flag 集合（多个子命令通用）
const sharedSafeFlags = new Set([
    "--oneline",        // 简短输出
    "--pretty",         // 格式化输出
    "--format",         // 自定义格式
    "--no-pager",       // 禁用分页器
    "--color",          // 颜色控制
    "--no-color",       // 禁用颜色
    "-n",               // 限制数量
    "--stat",           // 统计摘要
    "--name-only",      // 仅显示文件名
    "--name-status",    // 显示文件名和状态
    "--porcelain",      // 机器可读格式
    "--abbrev-ref",     // 缩写引用
    "--short",          // 简短格式
    "--cached",         // 暂存区
]);
```

### 动态安全回调

某些子命令需要根据参数值进行动态判断。例如，`git branch feature-x` 是安全的（创建分支），但 `git branch -D main` 是危险的。系统通过**动态回调**处理这些情况：

```javascript
// 动态安全回调示例
const dynamicChecks = {
    "branch": (args) => {
        // git branch (无参数) — 列出分支，安全
        if (args.length === 0) return { safe: true };
        // git branch -D / -d — 删除分支，需要确认
        if (args.includes("-D") || args.includes("-d")) {
            return { safe: false, reason: "Branch deletion requires confirmation" };
        }
        // git branch <name> — 创建分支，安全
        return { safe: true };
    },

    "tag": (args) => {
        // git tag (无参数) — 列出标签，安全
        if (args.length === 0) return { safe: true };
        // git tag -d — 删除标签，需要确认
        if (args.includes("-d")) {
            return { safe: false, reason: "Tag deletion requires confirmation" };
        }
        return { safe: true };
    },

    "remote": (args) => {
        // git remote / git remote -v — 列出远程，安全
        if (args.length === 0 || args[0] === "-v") return { safe: true };
        // git remote show <name> — 查看远程详情，安全
        if (args[0] === "show") return { safe: true };
        // git remote add/remove/rename — 需要确认
        return { safe: false, reason: "Remote modification requires confirmation" };
    }
};
```

### 全局 Flag 拦截

除了子命令级别的检查，系统还有**全局 flag 拦截**，禁止在任何 Git 命令中使用某些危险 flag：

```javascript
// qj1 — 全局禁止的 flag
const qj1 = new Set([
    "--exec",           // 执行任意命令
    "--upload-pack",    // 上传包协议（可能执行代码）
    "--receive-pack",   // 接收包协议
]);

// $j1 — 全局需要确认的 flag
const $j1 = new Set([
    "--force",          // 强制操作
    "-f",               // 强制操作（简写）
    "--hard",           // 硬重置
    "--no-verify",      // 跳过 hooks
]);

// Kj1 — 安全检查主函数
function Kj1(subcommand, args) {
    // Step 1: 全局 flag 拦截
    for (const arg of args) {
        if (qj1.has(arg)) {
            return { blocked: true, reason: `Flag ${arg} is not allowed` };
        }
        if ($j1.has(arg)) {
            return { needsConfirmation: true, reason: `Flag ${arg} requires user confirmation` };
        }
    }

    // Step 2: 子命令白名单检查
    if (!pQH.has(subcommand)) {
        return { needsConfirmation: true, reason: `git ${subcommand} is not in the safe list` };
    }

    // Step 3: 动态回调检查
    if (dynamicChecks[subcommand]) {
        return dynamicChecks[subcommand](args);
    }

    // Step 4: Flag 类型检查
    return { safe: true };
}
```

完整的安全检查流程：

```
git diff --cached src/
  │
  ├─ 全局 flag 拦截: --cached 不在禁止列表 → PASS
  ├─ 子命令白名单: "diff" ∈ pQH → PASS
  ├─ 动态回调: diff 无动态检查 → PASS
  └─ 结果: SAFE (自动执行)

git push --force origin main
  │
  ├─ 全局 flag 拦截: --force ∈ $j1 → NEEDS CONFIRMATION
  └─ 结果: 弹出确认对话 → 用户决定

git reset --hard HEAD~3
  │
  ├─ 全局 flag 拦截: --hard ∈ $j1 → NEEDS CONFIRMATION
  ├─ 子命令白名单: "reset" ∉ pQH → NEEDS CONFIRMATION
  └─ 结果: 弹出确认对话 → 用户决定
```

### .git/ 写保护（三层检测）

除了命令级别的安全检查，系统还保护 `.git/` 目录不被直接修改：

```javascript
// .git/ 写保护 — 三层检测
function isGitDirWrite(filePath) {
    // Layer 1: 直接路径检查
    if (filePath.includes("/.git/") || filePath.includes("\\.git\\")) {
        return true;
    }

    // Layer 2: 规范化路径检查（处理符号链接和 .. 路径）
    const resolved = path.resolve(filePath);
    if (resolved.includes(`${path.sep}.git${path.sep}`)) {
        return true;
    }

    // Layer 3: Git worktree 的 .git 文件检查
    // worktree 的 .git 不是目录，而是指向主仓库的文件
    const basename = path.basename(filePath);
    if (basename === ".git" && !isDirectory(filePath)) {
        return true;
    }

    return false;
}
```

### 其他安全措施

```javascript
// GIT_EDITOR=true — 禁止交互式编辑器弹出
// 防止 git commit (无 -m 参数) 打开编辑器阻塞 Agent
process.env.GIT_EDITOR = "true";

// index.lock 检测 — 防止并发 Git 操作冲突
async function checkIndexLock(projectRoot) {
    const lockPath = path.join(projectRoot, ".git", "index.lock");
    if (await fileExists(lockPath)) {
        // 检查 lock 文件的年龄
        const stat = await fs.stat(lockPath);
        const ageMs = Date.now() - stat.mtimeMs;

        if (ageMs > 30000) {
            // 超过 30 秒的 lock 可能是残留，提示清理
            return {
                locked: true,
                stale: true,
                message: "Stale index.lock detected, may need manual cleanup"
            };
        }
        return { locked: true, stale: false };
    }
    return { locked: false };
}

// .gitignore 集成 — 确保 .claude/ 目录被正确忽略
// 在创建 .claude/ 相关文件时，检查并更新 .gitignore
async function ensureGitignore(projectRoot) {
    const gitignorePath = path.join(projectRoot, ".gitignore");
    const patterns = [
        "CLAUDE.local.md",
        ".claude/worktrees/",
        ".claude/automemory.md"
    ];

    // 读取现有 .gitignore，追加缺失的模式
    let content = await readFileOrEmpty(gitignorePath);
    for (const pattern of patterns) {
        if (!content.includes(pattern)) {
            content += `\n${pattern}`;
        }
    }
    await writeFile(gitignorePath, content);
}
```

**小结**：Git 安全机制是一个**纵深防御**体系。子命令白名单（`pQH`）控制"允许什么命令"；Flag 类型系统控制"允许什么参数"；动态回调处理"参数组合"的复杂情况；全局 flag 拦截（`qj1`/`$j1`/`Kj1`）防止在任何命令中使用危险参数；`.git/` 写保护防止直接修改仓库内部结构。多层防御确保了即使某一层被绕过，其他层仍然提供保护。

---

## 11.8 文件监视系统

### 问题：如何检测外部编辑器对文件的修改？

用户在使用 Claude Code 的同时，往往还在 VS Code 或其他编辑器中编辑文件。Agent 需要及时感知这些外部变更，以避免基于过时信息做出错误决策（例如覆盖用户刚刚在编辑器中做的修改）。

### chokidar 初始化 yW7()

文件监视基于 `chokidar` 库，一个高性能的跨平台文件监视器：

```javascript
// yW7() — 初始化文件监视
function yW7(projectRoot) {
    const watchPaths = hW7(projectRoot);  // 收集需要监视的路径

    const watcher = chokidar.watch(watchPaths, {
        // 稳定性阈值：文件变更后等待 500ms 没有新变更才触发事件
        // 避免编辑器保存时的多次触发（如自动格式化产生的连续写入）
        awaitWriteFinish: {
            stabilityThreshold: 500,  // 500ms 稳定期
            pollInterval: 100         // 100ms 轮询间隔
        },
        // 忽略模式
        ignored: [
            "**/node_modules/**",
            "**/.git/**",           // .git 内部变更不需要监视
            "**/dist/**",
            "**/build/**",
            "**/.claude/worktrees/**"  // worktree 由专门机制管理
        ],
        // 不触发初始扫描的 add 事件
        ignoreInitial: true,
        // 使用原生 fs 事件（比轮询更高效）
        usePolling: false
    });

    // 绑定变更处理函数
    watcher.on("change", (filePath) => Pm6(filePath, "change"));
    watcher.on("add", (filePath) => Pm6(filePath, "add"));
    watcher.on("unlink", (filePath) => Pm6(filePath, "unlink"));

    return watcher;
}
```

> **设计决策：`stabilityThreshold: 500ms`**
>
> 许多编辑器在保存文件时会产生多次写入事件：先写入临时文件，再 rename，或者先清空再写入。Prettier/ESLint 等格式化工具也会在保存后立即修改文件。500ms 的稳定期确保只在"尘埃落定"后才触发一次事件，避免了不必要的重复处理。

### 监视路径收集 hW7()

```javascript
// hW7() — 收集需要监视的路径
function hW7(projectRoot) {
    const paths = [
        projectRoot,                                    // 项目根目录
        path.join(projectRoot, "CLAUDE.md"),             // 项目 CLAUDE.md
        path.join(projectRoot, "CLAUDE.local.md"),       // 本地 CLAUDE.md
        path.join(projectRoot, ".claude", "rules"),      // 条件规则目录
        path.join(projectRoot, ".claude", "settings"),   // 设置目录
    ];

    // 向上遍历时发现的父目录 CLAUDE.md 也需要监视
    let current = projectRoot;
    while (current !== path.dirname(current)) {
        const claudePath = path.join(current, "CLAUDE.md");
        if (fs.existsSync(claudePath)) {
            paths.push(claudePath);
        }
        current = path.dirname(current);
    }

    // User 级 CLAUDE.md
    paths.push(path.join(os.homedir(), ".claude", "CLAUDE.md"));

    return paths;
}
```

### 变更处理 Pm6() → FileChanged Hook

```javascript
// Pm6() — 文件变更处理
async function Pm6(filePath, eventType) {
    // 1. 判断变更类型
    const changeType = classifyChange(filePath);

    switch (changeType) {
        case "claude-md":
            // CLAUDE.md 变更 → 重新加载配置
            await reloadClaudeMd();
            break;

        case "rules":
            // .claude/rules/ 变更 → 重新加载规则
            await reloadRules();
            break;

        case "source":
            // 源文件变更 → 通知 Agent 上下文可能过时
            break;

        case "settings":
            // 设置变更 → 重新加载设置
            await reloadSettings();
            break;
    }

    // 2. 触发 FileChanged Hook
    await hookManager.emit("FileChanged", {
        path: filePath,
        type: eventType,     // "change" | "add" | "unlink"
        category: changeType
    });
}

// 变更分类
function classifyChange(filePath) {
    if (filePath.endsWith("CLAUDE.md") || filePath.endsWith("CLAUDE.local.md")) {
        return "claude-md";
    }
    if (filePath.includes(".claude/rules/")) {
        return "rules";
    }
    if (filePath.includes(".claude/settings/")) {
        return "settings";
    }
    return "source";
}
```

### 动态路径扩展

当 Agent 在会话中创建新目录或切换 CWD 时，监视路径需要动态扩展：

```javascript
// 动态添加监视路径
function addWatchPath(watcher, newPath) {
    watcher.add(newPath);
}

// 当 Agent 创建新的 CLAUDE.md 时
async function onClaudeMdCreated(filePath) {
    // 将新创建的 CLAUDE.md 加入监视列表
    addWatchPath(globalWatcher, filePath);
}
```

### CWD 联动 SW7()

当工作目录变更时（用户 `cd` 或 Worktree 切换），文件监视系统需要同步更新：

```javascript
// SW7() — CWD 变更时更新文件监视
async function SW7(oldCwd, newCwd) {
    // 1. 停止对旧目录特有路径的监视
    const oldPaths = hW7(oldCwd);
    const newPaths = hW7(newCwd);

    const toRemove = oldPaths.filter(p => !newPaths.includes(p));
    const toAdd = newPaths.filter(p => !oldPaths.includes(p));

    for (const p of toRemove) {
        globalWatcher.unwatch(p);
    }

    // 2. 开始对新目录特有路径的监视
    for (const p of toAdd) {
        globalWatcher.add(p);
    }
}
```

### 清理 T31()

```javascript
// T31() — 关闭文件监视
async function T31() {
    if (globalWatcher) {
        await globalWatcher.close();
        globalWatcher = null;
    }
}
```

**小结**：文件监视系统是 Claude Code 保持"上下文新鲜度"的关键机制。通过 `chokidar` 的 `stabilityThreshold` 避免了重复触发；`Pm6()` 的变更分类确保不同类型的文件变更得到正确处理；CWD 联动（`SW7()`）保证了目录切换后监视范围的同步更新。这个系统让 Agent 始终基于最新的文件状态做出决策。

---

## 11.9 设计启示

Git 集成体系中蕴含了多个可迁移到其他 Agent 系统的设计经验。

### 1. 永不抛异常的命令执行

`reject: false` 模式让所有命令返回结构化结果。在 Agent 场景中，外部命令的失败是常态而非异常。将错误视为数据（error as data）而非异常（error as exception），让调用方可以实现多级回退策略，而不需要层层 try-catch。

### 2. 并行获取 + 优雅降级

`D_6()` 的 `Promise.all` 模式展示了如何在保持高效的同时实现鲁棒性。任何一个并行任务失败都不影响其他结果，因为底层的 `reject: false` 保证了 Promise 永远 resolve。这个模式适用于所有需要从多个源获取信息的场景。

### 3. 多级回退策略

`ej8()` 的三级回退（upstream → remote show → 硬编码）是一个典型的"graceful degradation"模式。在不确定的外部环境中（不同的 Git 配置、不同的 CI 环境），单一策略几乎必然失败。多级回退确保了在绝大多数场景下都能得到结果。

### 4. 白名单优于黑名单

Git 安全机制选择白名单而非黑名单，遵循了"最小权限原则"。在安全敏感的场景中，永远假设存在未知的危险操作，只放行经过审计的安全操作。这个原则适用于任何允许 Agent 执行外部命令的系统。

### 5. 分层配置 + 不可跳过层

CLAUDE.md 五级加载体系展示了如何设计一个灵活而安全的配置系统。User/Local/Project 层提供灵活性；Managed 层（不可排除）提供安全保证。这种"灵活层 + 强制层"的模式适用于任何需要多级配置的系统。

### 6. 稳定性阈值消抖

文件监视的 `stabilityThreshold: 500ms` 是一个简单但重要的优化。在处理来自外部系统的事件流时，消抖（debounce）避免了不必要的重复处理。500ms 的阈值经过实践验证，平衡了响应速度和稳定性。

---

## 速查表

### Git 安全子命令一览

| 子命令 | 用途 | 特殊限制 |
|--------|------|----------|
| `diff` | 查看差异 | 无 |
| `log` | 查看历史 | 无 |
| `show` | 查看对象 | 无 |
| `status` | 工作区状态 | 无 |
| `blame` | 行级历史 | 无 |
| `branch` | 查看分支 | `-D`/`-d` 需确认 |
| `tag` | 查看标签 | `-d` 需确认 |
| `rev-parse` | 解析引用 | 无 |
| `rev-list` | 列出 commit | 无 |
| `ls-files` | 列出文件 | 无 |
| `ls-remote` | 查看远程引用 | 无 |
| `config --get` | 读取配置 | 仅 `--get`，不允许 `--set` |
| `remote` | 远程列表 | `add`/`remove` 需确认 |
| `remote show` | 远程详情 | 无 |
| `merge-base` | 公共祖先 | 无 |
| `describe` | 从 tag 描述 | 无 |
| `cat-file` | 对象内容 | 无 |
| `for-each-ref` | 遍历引用 | 无 |
| `grep` | 内容搜索 | 无 |
| `stash list` | stash 列表 | 无 |
| `stash show` | stash 内容 | 无 |
| `worktree list` | worktree 列表 | 无 |
| `shortlog` | 提交摘要 | 无 |
| `reflog` | 引用日志 | 无 |

### CLAUDE.md 层级速查

| 层级 | 路径 | 版本控制 | 可排除 | 作用范围 |
|------|------|----------|--------|----------|
| Layer 0 (User) | `~/.claude/CLAUDE.md` | 否 | 是 | 所有项目 |
| Layer 1 (Local) | `CLAUDE.local.md` | 否 (.gitignore) | 是 | 当前项目(个人) |
| Layer 2 (Project) | `CLAUDE.md` | 是 | 是 | 当前项目(共享) |
| Layer 3 (Rules) | `.claude/rules/*.md` | 是 | 是 | 按 paths 条件 |
| Layer 4 (Managed) | 内部管理 | 部分 | **否** | 系统强制 |

### 关键函数索引

**命令执行 (04_git_operations)**

| 函数 | 签名 | 职责 |
|------|------|------|
| `t_()` | `t_(cmd, args, opts)` | Git 命令高级封装（自动 CWD + 10 分钟超时） |
| `u8()` | `u8(cmd, args, opts)` | 底层执行器（execa + reject:false） |

**仓库信息 (04_git_operations)**

| 函数 | 签名 | 职责 |
|------|------|------|
| `D_6()` | `D_6()` | 并行获取 6 项仓库信息 |
| `ej8()` | `ej8()` | 远程基准分支三级回退 |
| `g5$()` | `g5$(mode, opts)` | 三种 diff 模式（staged/unstaged/full） |
| `z1_()` | `z1_()` | 未跟踪文件收集（100 个上限） |

**CLAUDE.md 加载 (09_data_processing)**

| 函数 | 签名 | 职责 |
|------|------|------|
| `y1H()` | `y1H(layerType, root)` | 层级到路径映射 |
| `rr1()` | `rr1(startDir, root)` | 向上遍历加载 CLAUDE.md |
| `O59()` | `O59(content, basePath, visited)` | @path 嵌套导入解析 |
| `vn1()` | `vn1(loadedFiles)` | Token 统计 |

**Rules 加载 (09_data_processing)**

| 函数 | 签名 | 职责 |
|------|------|------|
| `AV6()` | `AV6(projectRoot)` | 递归发现 .claude/rules/ |
| `yY()` | `yY(content)` | frontmatter 解析 |

**Worktree 管理 (04_git_operations)**

| 函数 | 签名 | 职责 |
|------|------|------|
| `kH_()` | `kH_(name)` | Worktree 创建入口 |
| `v48()` | `v48(path, branch)` | git worktree add 执行 |
| `N48()` | `N48(worktreePath, root)` | 后处理（settings/symlink/sparse） |
| `byH()` | `byH(path, branch)` | 三级回退清理 |

**安全机制 (09_data_processing + Bash 工具)**

| 函数/常量 | 类型 | 职责 |
|-----------|------|------|
| `pQH` | `Set` | Git 安全子命令白名单 |
| `qj1` | `Set` | 全局禁止 flag |
| `$j1` | `Set` | 全局需确认 flag |
| `Kj1()` | 函数 | 安全检查主函数 |

**文件监视 (03_file_system)**

| 函数 | 签名 | 职责 |
|------|------|------|
| `yW7()` | `yW7(projectRoot)` | chokidar 初始化 |
| `hW7()` | `hW7(projectRoot)` | 监视路径收集 |
| `Pm6()` | `Pm6(filePath, type)` | 变更处理 + FileChanged Hook |
| `SW7()` | `SW7(oldCwd, newCwd)` | CWD 联动更新 |
| `T31()` | `T31()` | 关闭文件监视 |

### 关键常量

| 常量 | 值 | 用途 |
|------|-----|------|
| Git 命令超时 | `10 * 60 * 1000` (10 分钟) | `t_()` 默认超时 |
| 未跟踪文件上限 | `100` | `z1_()` 截断阈值 |
| 文件监视稳定期 | `500ms` | chokidar stabilityThreshold |
| 文件监视轮询间隔 | `100ms` | chokidar pollInterval |
| index.lock 过期阈值 | `30000ms` (30 秒) | 判断 stale lock |
| Worktree 过期阈值 | `7 * 24 * 3600 * 1000` (7 天) | Team 级自动清理 |
| GIT_EDITOR | `"true"` | 禁止交互式编辑器 |
