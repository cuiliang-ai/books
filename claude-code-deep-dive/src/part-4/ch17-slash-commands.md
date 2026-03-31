
# 第 17 章：Slash 命令与 Skill 系统 — Agent 的交互扩展

> **核心问题**：一个 CLI Agent 如何在保持核心精简的同时，支持 50+ 内置命令、用户自定义 Skill、第三方插件和 MCP prompt 扩展？

命令系统是 Agent 与用户之间的"操作面板"。用户输入 `/commit`，Agent 自动生成 git 提交；输入 `/model`，弹出交互式模型选择器；输入 `/review`，AI 开始逐段审查 PR。这背后是一套精心设计的三层类型体系、多来源注册机制和可扩展的 Skill 框架。

Claude Code 的命令系统不只是"一组快捷键" — 它是 Agent 交互能力的完整扩展层，从简单的信息查询到复杂的 AI 驱动工作流，全部统一在同一个调度框架下。本章将逐层拆解这套系统。

---

## 17.1 概述：命令系统在 Agent 交互中的角色

Agent 的核心能力是"理解意图 → 调用工具 → 生成响应"，但很多操作不需要 AI 推理 — 查看费用、切换模型、清空上下文，这些应该是**即时的、确定性的**。命令系统提供了这条"快车道"，让用户绕过 AI 推理直接触发特定行为。

```
Agent 交互的两条路径
════════════════════════════════════════════════════
                    用户输入
                      │
              ┌───────┴───────┐
              │               │
         普通消息          / 命令
              │               │
              ▼               ▼
        AI 推理循环      命令调度系统
        (Agentic Loop)   (Slash Command)
              │               │
              │          ┌────┴────┐
              │          │    │    │
              │       local  jsx  prompt
              │          │    │    │
              │          │    │    └──→ AI 推理
              │          │    │         (注入 prompt)
              ▼          ▼    ▼
           AI 响应    即时结果/交互 UI
```

命令系统的架构核心在于两个正交维度的设计：**Type**（如何执行）和 **Source**（从哪来）。

**小结**：命令系统是 Agent 交互模型的补充层 — 它为确定性操作提供直达路径，为 AI 工作流提供标准化的触发入口，为扩展能力提供统一的注册框架。

---

## 17.2 命令类型体系：local / local-jsx / prompt

三种命令类型不是任意划分的，而是由**执行模型的根本差异**驱动的。理解这三者的区别是理解整个命令系统的基础。

### 类型分发的代码证据

命令分发函数 `dB1()` (推测名: `dispatchCommand`) 使用 `switch` 精确分为 3 个 `case`：

```javascript
// cli.js - dB1() (dispatchCommand) 命令分发
switch (j.type) {
  case "local":       // --> synchronous execution, return data
  case "local-jsx":   // --> JSX rendering, return React element
  case "prompt":      // --> Skill path, inject AI prompt
}
```

没有第四种类型。

### 三种类型的对比

| 维度 | `local` | `local-jsx` | `prompt` |
|------|---------|-------------|----------|
| **返回值** | `{type, value}` 纯数据 | JSX 元素（React 组件树） | prompt 内容注入 AI |
| **生命周期** | 调用 → 返回 → 结束 | 挂载 → 交互 → 回调 → 卸载 | 构造 prompt → AI 推理 |
| **用户交互** | 无 | 键盘选择、输入、滚动 | 通过 AI 间接交互 |
| **渲染引擎** | 不需要 | Ink（React for CLI） | 不需要 |
| **典型命令** | `/cost`, `/vim`, `/clear` | `/model`, `/config`, `/permissions` | `/commit`, `/review`, `/init` |

> **设计决策**：`local` 和 `local-jsx` 的分离不是因为功能差异，而是因为**执行模型根本不同**。`local` 是同步的纯函数调用，`local-jsx` 是异步的 React 组件生命周期。这种分离让调度器可以为两者采用完全不同的调用协议。

### 执行流程对比

```
/cost 的执行流程（local）:
  load().call(args, ctx)
    --> calculate cost data
    --> return { type: "text", value: "Session cost: $0.42\n..." }
    --> display in terminal --> done

/model 的执行流程（local-jsx）:
  load().call(onDone, ctx, args)
    --> return <ModelSelector models={...} onSelect={...} />
    --> Ink mounts component --> renders selection list
    --> user presses arrow keys --> component state updates --> re-render
    --> user presses Enter --> onDone(selectedModel)
    --> Ink unmounts component --> done

/commit 的执行流程（prompt）:
  getPromptForCommand(args, ctx)
    --> build commit instructions prompt
    --> return [{ type: "text", text: "..." }]
    --> inject into AI conversation (shouldQuery: true)
    --> AI analyzes git status, stages files, creates commit
```

### Type 与 Source 的正交设计

这是理解命令系统的关键。**Type** 决定命令如何执行，**Source** 决定命令从哪来，两者是正交的：

| 维度 | 含义 | 可能取值 | 例子 |
|------|------|---------|------|
| **type** | 命令**如何执行** | `local` / `local-jsx` / `prompt` | `/cost` 是 `local`，`/model` 是 `local-jsx` |
| **source** | 命令**从哪来** | `builtin` / `bundled` / `plugin` / `mcp` / `userSettings` | `/cost` 来源 `builtin`，自定义 Skill 来源 `userSettings` |

一个命令同时拥有 `type` 和 `source` 两个属性：
- `/cost`：`type = local`，`source = builtin`
- `/commit`：`type = prompt`，`source = builtin`
- 用户自定义 Skill：`type = prompt`，`source = userSettings`

```
Type × Source 矩阵（已知组合）
═══════════════════════════════════════════
           builtin    bundled    plugin    mcp    userSettings
local        /cost       -         -        -         -
             /clear
             /vim

local-jsx    /model      -         -        -         -
             /config
             /plugin

prompt       /commit    (bundled   (plugin   MCP    user
             /review     skills)   skills)  prompts  SKILL.md
═══════════════════════════════════════════
```

所有用户自定义的 Skill（包括 plugin、mcp、userSettings 来源）的 type 都是 `prompt`。这是因为外部扩展只能通过 prompt 注入来驱动 AI 行为 — 它们无法注册原生的 `local` 或 `local-jsx` 命令。

**小结**：三层类型体系 `local` → `local-jsx` → `prompt` 从简到繁覆盖了所有交互场景。Type 和 Source 的正交设计让命令调度器只需关心执行方式，而注册机制独立管理来源。

---

## 17.3 命令注册与调度链：Tg_() → gB1() → dB1() → TH9()

命令从用户输入到最终执行，经过一条清晰的调度链。理解这条链路是理解命令系统运行时行为的关键。

### 调度链总览

```
用户输入 "/commit fix bug"
         │
         ▼
    ┌──────────┐
    │  Tg_()   │  parseSlashInput -- parse command name + args
    │          │  --> { commandName: "commit", args: "fix bug", isMcp: false }
    └────┬─────┘
         │
         ▼
    ┌──────────┐
    │  gB1()   │  handleSlashCommand -- main entry
    │          │  --> gfH() check existence
    │          │  --> dispatch to dB1()
    └────┬─────┘
         │
         ▼
    ┌──────────┐
    │  dB1()   │  dispatchCommand -- type switch
    │          │  --> case "prompt": TH9()
    └────┬─────┘
         │
         ▼
    ┌──────────┐
    │  TH9()   │  executeSkill -- build prompt, inject into AI
    │          │  --> getPromptForCommand()
    │          │  --> return { messages, shouldQuery: true }
    └──────────┘
```

### 第一步：输入解析 — `Tg_()` (parseSlashInput)

```javascript
// 13_ui_rendering.js:64436 - Tg_() (parseSlashInput)
function Tg_(H) {
    let _ = H.trim();
    if (!_.startsWith("/")) return null;   // must start with /
    let $ = _.slice(1).split(" ");
    if (!$[0]) return null;

    let K = $[0],       // command name
        O = !1,          // isMcp flag
        T = 1;

    // detect "(MCP)" marker: "/commandName (MCP) args"
    if ($.length > 1 && $[1] === "(MCP)")
        K = K + " (MCP)", O = !0, T = 2;

    let z = $.slice(T).join(" "); // arguments part
    return { commandName: K, args: z, isMcp: O }
}
```

注意 MCP 命令的特殊语法：`/promptName (MCP) args`。`(MCP)` 标记被追加到命令名中，形成如 `"deploy (MCP)"` 这样的复合名称。

### 第二步：命令查找 — `YF()` / `gfH()` / `ohH()`

```javascript
// 16_commands_slash.js:35474 - YF() (findCommand)
function YF(H, _) {
    // H = command name, _ = command list
    return _.find((q) =>
        q.name === H ||          // exact name match
        OK(q) === H ||           // userFacingName match
        q.aliases?.includes(H)   // alias match
    )
}

// gfH() (hasCommand) - boolean check
function gfH(H, _) {
    return YF(H, _) !== void 0
}

// ohH() (getCommandOrThrow) - must exist, throws if not found
function ohH(H, _) {
    let q = YF(H, _);
    if (!q) throw ReferenceError(`Command ${H} not found...`)
    return q
}
```

三层查找策略：精确名称 → 用户面向名称 → 别名。例如 `/settings` 能匹配到 `name: "config"` 的命令，因为 `"settings"` 在其 `aliases` 中。

### 第三步：主入口 — `gB1()` (handleSlashCommand)

```javascript
// 13_ui_rendering.js:64692 - gB1() (handleSlashCommand)
async function gB1(H, _, q, $, K, O, T, z, A) {
    // H = raw input, K = toolUseContext, O = setAboveFold, T = uuid

    let f = Tg_(H);  // parse "/command args"
    if (!f) {
        // not a valid command format
        return { messages: [...], shouldQuery: false }
    }

    let { commandName: w, args: Y, isMcp: D } = f;

    // check if command exists
    if (!gfH(w, K.options.commands)) {
        // unknown command handling:
        // 1. check if it's a file path (e.g., /etc/hosts)
        // 2. if looks like a command name (alphanumeric only), report error
        // 3. otherwise treat as normal user input
        let S = false;
        try {
            await f_().stat(`/${w}`);  // check filesystem
            S = true;
        } catch {}

        if (KH9(w) && !S) {
            return { messages: ["Unknown skill: " + w], shouldQuery: false }
        }
        // treat as normal user message
        return { messages: [d_({content: H})], shouldQuery: true }
    }

    // dispatch to type-specific handler
    let { messages, shouldQuery, ... } =
        await dB1(w, Y, O, K, _, q, z, A, T);
    ...
}
```

> **设计决策**：未知命令的 fallback 逻辑非常巧妙 — 它区分"看起来像命令的字符串"和"恰好以 `/` 开头的文件路径"。如果 `/etc/hosts` 在文件系统中存在，就不报错而是当作普通消息发给 AI。这避免了用户讨论 Linux 路径时的误报。

### 第四步：类型分发 — `dB1()` (dispatchCommand)

```javascript
// 13_ui_rendering.js:64830 - dB1() (dispatchCommand)
async function dB1(H, _, q, $, K, O, T, z, A) {
    let f = ohH(H, $.options.commands);  // find command object

    // intercept: skills not user-invocable
    if (f.userInvocable === false) {
        return { messages: ["This skill can only be invoked by Claude..."] }
    }

    switch (f.type) {
        case "local-jsx":
            // Promise wrapper, completed via onDone callback
            return new Promise((w) => {
                let D = (msg, opts) => {
                    w({ messages: [...],
                        shouldQuery: opts?.shouldQuery ?? false })
                };
                f.load().then((j) => j.call(D, $, _))
                 .then((j) => {
                    // return JSX element --> render in terminal
                    q({ jsx: j, shouldHidePromptInput: true })
                 })
            });

        case "local":
            // direct call, handle return value types
            let M = await (await f.load()).call(_, $);
            if (M.type === "skip")
                return { messages: [], shouldQuery: false };
            if (M.type === "compact") {
                // special: /compact returns compaction result
                return { messages: jo(M.compactionResult),
                         shouldQuery: false }
            }
            return { messages: [...], shouldQuery: false,
                     resultText: M.value };

        case "prompt":
            // Skill execution: check fork context
            if (f.context === "fork")
                return await BB1(f, _, $, K, q, z); // fork execution
            return await TH9(f, _, $, K, O, A);     // standard Skill path
    }
}
```

注意 `local` 命令的返回值有三种子类型：`skip`（无输出）、`compact`（压缩结果）和默认的文本。`/compact` 命令的特殊返回类型在这里被处理。

### 第五步：Skill 执行 — `TH9()` (executeSkill)

```javascript
// 13_ui_rendering.js:65030 - TH9() (executeSkill)
async function TH9(H, _, q, $ = [], K = [], O) {
    // H = command object, _ = user args, q = toolUseContext

    // 1. get prompt content
    let T = await H.getPromptForCommand(_, q);

    // 2. register Skill hooks if applicable
    if (H.hooks && z) {
        oe7(q.setAppState, sessionId, H.hooks, H.name, H.skillRoot)
    }

    // 3. record Skill usage for frequency sorting
    v2H(H.name, source, content, agentId);

    // 4. build loading metadata
    let w = cB1(H, _);  // "<command-name>...<loading-status>..."

    // 5. merge allowed tools
    let Y = vE(H.allowedTools ?? []);

    // 6. return message sequence (inject into AI conversation)
    return {
        messages: [
            d_({ content: w, uuid: O }),           // loading indicator
            d_({ content: D, isMeta: true }),       // prompt content
            ...j,                                    // instructions
            N7({ type: "command_permissions",        // permission override
                 allowedTools: Y, model: H.model })
        ],
        shouldQuery: true,  // trigger AI response
        allowedTools: Y,
        model: H.model,
        effort: H.effort,
        command: H
    }
}
```

Skill 执行的关键是 `shouldQuery: true` — 这告诉 Agentic Loop "这些消息注入后，请立即触发 AI 推理"。Skill 的 prompt 被作为对话消息注入，AI 看到这些指令后会自行执行相应操作。

**小结**：调度链的五个环节各司其职 — 解析 → 查找 → 入口分发 → 类型分发 → Skill 执行。整条链路清晰可追踪，每一步都有明确的输入输出契约。

---

## 17.4 50+ 内置命令完整注册表

所有内置命令在模块初始化时通过惰性求值函数 `g$8` (推测名: `getBuiltinCommands`) 组装。这意味着命令对象在首次访问时才被创建，避免启动开销。

### 注册机制

```javascript
// 16_commands_slash.js:35630 - g$8 (getBuiltinCommands)
g$8 = $6(() => [
    CT9,    // add-dir         pL9,    // advisor
    ZZ9,    // agents          rG9,    // branch
    T68,    // btw             bL9,    // chrome
    AU_,    // clear           E68,    // color
    p68,    // compact         FA9,    // config
    I68,    // copy            sz9,    // desktop
    CU_,    // cost            wf9,    // context (jsx)
    Yf9,    // context (local) bf9,    // diff
    Ow9,    // doctor          Uk9,    // effort
    A8_,    // exit            $G9,    // fast
    L98,    // files           Z88,    // help
    Uw9,    // ide             lw9,    // init
    v88,    // keybindings     aY9,    // install-github-app
    _D9,    // install-slack   _j9,    // mcp
    Rw9,    // memory          rq8,    // mobile
    jk9,    // model           Sk9,    // remote-env
    NZ9,    // plugin          jJ9,    // pr-comments
    eq8,    // release-notes   CZ9,    // reload-plugins
    VJ9,    // rename          SX9,    // resume
    x78,    // session         KW9,    // skills
    hv9,    // stats           AW9,    // status
    D$8,    // statusline      t98,    // stickers
    Wk9,    // tag             Y68,    // feedback
    fl_,    // review          lX9,    // ultrareview
    uZ9,    // rewind          $09,    // security-review
    z09,    // terminal-setup  el_,    // upgrade
    xk9,    // rate-limit      $98,    // usage
    AwK,    // insights        O98,    // vim
    // ... conditionally registered commands
    i09,    // permissions     j98,    // plan
    JG9,    // privacy         BG9,    // hooks
    GL9,    // sandbox         $Y9,    // logout
    _Y9(),  // login           fG9,    // passes
    eW9,    // tasks
])
```

### 完整命令清单

以下按功能分组列出全部命令，包含类型、别名和可见性信息。

#### 核心命令

| 命令 | 类型 | 描述 | 别名 | 可见性 |
|------|------|------|------|--------|
| `/help` | local-jsx | Show help and available commands | — | 始终可见 |
| `/clear` | local | Clear conversation history and free up context | `reset`, `new` | 始终可见 |
| `/compact` | local | Clear history but keep summary | — | 始终可见 |
| `/config` | local-jsx | Open config panel | `settings` | 始终可见 |
| `/exit` | local-jsx | Exit the REPL | `quit` | 始终可见 |
| `/model` | local-jsx | Set the AI model (dynamic description) | — | 始终可见 |
| `/status` | local-jsx | Show version, model, account, tool statuses | — | 始终可见 |
| `/cost` | local | Show total cost and duration | — | 条件隐藏 |
| `/version` | local | Print the running version | — | 已禁用 |

#### 文件与编辑

| 命令 | 类型 | 描述 | 别名 | 可见性 |
|------|------|------|------|--------|
| `/diff` | local-jsx | View uncommitted changes and per-turn diffs | — | 始终可见 |
| `/files` | local | List all files currently in context | — | 已禁用 |
| `/plan` | local-jsx | Enable plan mode or view current session plan | — | 始终可见 |
| `/rename` | local-jsx | Rename the current conversation | — | 始终可见 |
| `/copy` | local-jsx | Copy Claude's last response to clipboard | — | 始终可见 |

#### AI Skill 命令

| 命令 | 类型 | 描述 | 来源 | 可见性 |
|------|------|------|------|--------|
| `/init` | prompt | Initialize CLAUDE.md with codebase documentation | builtin | 始终可见 |
| `/init-verifiers` | prompt | Create verifier skills for automated verification | builtin | 始终可见 |
| `/review` | prompt | Review a pull request | builtin | 始终可见 |
| `/commit` | prompt | Create a git commit | builtin | 始终可见 |
| `/commit-push-pr` | prompt | Commit, push, and open a PR | builtin | 始终可见 |
| `/pr-comments` | prompt | Get comments from a GitHub pull request | builtin | 始终可见 |
| `/security-review` | prompt | Security review of pending branch changes | builtin | 始终可见 |
| `/insights` | prompt | Generate usage report analyzing sessions | builtin | 始终可见 |
| `/statusline` | prompt | Set up Claude Code's status line UI | builtin | 始终可见 |

#### 会话管理

| 命令 | 类型 | 描述 | 别名 | 可见性 |
|------|------|------|------|--------|
| `/resume` | local-jsx | Resume a previous conversation | `continue` | 始终可见 |
| `/branch` | local-jsx | Create a branch of current conversation | `fork` | 始终可见 |
| `/session` | local-jsx | Show remote session URL and QR code | `remote` | 条件显示 |
| `/rewind` | local | Restore code/conversation to a previous point | `checkpoint` | 始终可见 |
| `/tag` | local-jsx | Toggle a searchable tag on current session | — | 已禁用 |

#### 工具与权限

| 命令 | 类型 | 描述 | 别名 | 可见性 |
|------|------|------|------|--------|
| `/permissions` | local-jsx | Manage allow & deny tool permission rules | `allowed-tools` | 始终可见 |
| `/hooks` | local-jsx | View hook configurations for tool events | — | 始终可见 |
| `/sandbox` | local-jsx | Configure sandbox settings | — | 条件显示 |
| `/agents` | local-jsx | Manage agent configurations | — | 始终可见 |
| `/tasks` | local-jsx | List and manage background tasks | `bashes` | 始终可见 |

#### 插件与 Skill 管理

| 命令 | 类型 | 描述 | 别名 | 可见性 |
|------|------|------|------|--------|
| `/plugin` | local-jsx | Manage Claude Code plugins | `plugins`, `marketplace` | 始终可见 |
| `/reload-plugins` | local | Activate pending plugin changes | — | 始终可见 |
| `/skills` | local-jsx | List available skills | — | 始终可见 |
| `/mcp` | local-jsx | Manage MCP servers | — | 始终可见 |

#### 用户体验

| 命令 | 类型 | 描述 | 别名 | 可见性 |
|------|------|------|------|--------|
| `/vim` | local | Toggle between Vim and Normal editing | — | 始终可见 |
| `/theme` | local-jsx | Change color theme | — | 始终可见 |
| `/color` | local-jsx | Set prompt bar color for this session | — | 始终可见 |
| `/effort` | local-jsx | Set effort level | — | 始终可见 |
| `/fast` | local-jsx | Toggle fast mode | — | 条件显示 |
| `/btw` | local-jsx | Quick side question without interrupting | — | 始终可见 |
| `/terminal-setup` | local-jsx | Install Shift+Enter for newlines | — | 条件显示 |

#### 账户与系统

| 命令 | 类型 | 描述 | 别名 | 可见性 |
|------|------|------|------|--------|
| `/login` | local-jsx | Sign in with Anthropic account | — | 始终可见 |
| `/logout` | local-jsx | Sign out from Anthropic account | — | 始终可见 |
| `/upgrade` | local-jsx | Upgrade to Max for higher rate limits | — | 条件显示 |
| `/usage` | local-jsx | Show plan usage limits | — | 始终可见 |
| `/feedback` | local-jsx | Submit feedback about Claude Code | `bug` | 条件显示 |
| `/doctor` | local-jsx | Diagnose and verify installation | — | 始终可见 |
| `/memory` | local-jsx | Edit Claude memory files (CLAUDE.md) | — | 始终可见 |
| `/privacy-settings` | local-jsx | View and update privacy settings | — | 条件显示 |
| `/stats` | local-jsx | Show usage statistics and activity | — | 始终可见 |
| `/stickers` | local | Order Claude Code stickers | — | 始终可见 |
| `/mobile` | local-jsx | QR code for Claude mobile app | `ios`, `android` | 始终可见 |
| `/release-notes` | local | View release notes | — | 始终可见 |

#### 高级 / 远程

| 命令 | 类型 | 描述 | 别名 | 可见性 |
|------|------|------|------|--------|
| `/ultrareview` | local-jsx | ~10-20 min bug hunting in the cloud | — | 条件显示 |
| `/remote-env` | local-jsx | Configure default remote environment | — | 条件显示 |
| `/chrome` | local-jsx | Claude in Chrome (Beta) settings | — | 条件显示 |
| `/ide` | local-jsx | Manage IDE integrations | — | 始终可见 |
| `/add-dir` | local-jsx | Add a new working directory | — | 始终可见 |
| `/desktop` | local-jsx | Continue session in Claude Desktop | `app` | 条件显示 |
| `/advisor` | local | Configure the advisor model | — | 条件显示 |
| `/passes` | local-jsx | Share a free week with friends | — | 条件显示 |
| `/voice` | local | Toggle voice mode | — | 条件显示 |
| `/keybindings` | local | Open keybindings configuration file | — | 条件显示 |
| `/context` | local-jsx/local | Visualize current context usage | — | 条件显示 |

#### 内部 / 调试命令

| 命令 | 类型 | 描述 | 可见性 |
|------|------|------|--------|
| `/heapdump` | local | Memory diagnostics | 隐藏 |
| `/bridge-kick` | local | Inject bridge failure states | 隐藏 |
| `/thinkback-play` | local | Play thinkback animation | 隐藏 |
| `/output-style` | local-jsx | Deprecated: use /config | 隐藏 |
| `/rate-limit-options` | local-jsx | Show options when rate limited | 隐藏 |

### 可见性控制机制

命令的可见性由两个独立属性控制：

```javascript
// Command visibility control
{
    isEnabled: () => boolean,   // false = completely disabled, not registered
    isHidden: () => boolean,    // true = registered but hidden from /help
}
```

- **始终可见**：`isEnabled` 始终返回 true，`isHidden` 返回 false
- **条件显示**：`isHidden` 根据当前状态动态决定（如 `/cost` 在 API 登录时隐藏）
- **已禁用**：`isEnabled` 返回 false，命令不会出现在命令列表中
- **隐藏**：`isHidden` 始终返回 true，仅开发者/内部使用

**小结**：50+ 内置命令通过惰性求值列表注册，按功能清晰分组。可见性由 `isEnabled` / `isHidden` 双重机制控制，支持从完全禁用到条件显示的灵活策略。

---

## 17.5 Skill 系统：SKILL.md 解析、$ARGUMENTS 替换、4 种来源

Skill 系统是命令系统中最具扩展性的部分。它允许任何人通过编写一个 Markdown 文件来创建新的 AI 驱动工作流 — 无需修改源码，无需编译，只需一个 `SKILL.md` 文件。

### 4 种 Skill 来源

```
Skill 来源体系
══════════════════════════════════════════
来源            加载路径                   典型场景
──────────────────────────────────────────
builtin         source code hardcoded      /commit, /review, /init
bundled         Nz() registration          officially bundled workflows
userSettings    .claude/skills/*/SKILL.md  user's custom skills
plugin          plugin-dir/skills/         third-party plugins
mcp             MCP server prompts         remote prompt providers
══════════════════════════════════════════
```

#### builtin — 内置 Skill

直接在源码中定义，`source: "builtin"`：

```javascript
// 15_hooks_system.js:13638 - /commit Skill definition
Ye1 = {
    type: "prompt",
    name: "commit",
    description: "Create a git commit",
    allowedTools: [
        "Bash(git add:*)",
        "Bash(git status:*)",
        "Bash(git commit:*)"
    ],
    contentLength: 0,
    progressMessage: "creating commit",
    source: "builtin",
    async getPromptForCommand(H, _) {
        let q = we1();  // build commit prompt
        return [{ type: "text", text: await Tc(q, ...) }]
    }
}
```

内置 Skill 完整列表：`/init`, `/init-verifiers`, `/review`, `/commit`, `/commit-push-pr`, `/pr-comments`, `/security-review`, `/insights`, `/statusline`

#### userSettings — 用户自定义 Skill

从 `.claude/skills/` 目录加载：

```javascript
// 16_commands_slash.js:4308 - scan skills subdirectories
if (_) return q.filter((K) => K.isDirectory())
    .map((K) => eD.join(H, K.name, "SKILL.md"));
```

目录结构：
```
.claude/
├── skills/
│   ├── my-deploy/
│   │   └── SKILL.md          <-- entry file
│   ├── code-review/
│   │   └── SKILL.md
│   └── ...
```

#### bundled — 捆绑 Skill

通过 `Nz()` (推测名: `registerBundledSkill`) 函数注册：

```javascript
// 16_commands_slash.js:27433 - Nz() (registerBundledSkill)
function Nz(H) {
    let K = {
        type: "prompt",
        name: H.name,
        description: H.description,
        aliases: H.aliases,
        allowedTools: H.allowedTools ?? [],
        disableModelInvocation: H.disableModelInvocation ?? false,
        userInvocable: H.userInvocable ?? true,
        contentLength: 0,
        source: "bundled",
        loadedFrom: "bundled",
        hooks: H.hooks,
        skillRoot: q,
        context: H.context,
        agent: H.agent,
        ...
    };
    gL9.push(K)  // add to global list
}
```

捆绑 Skill 支持附带文件（自动解压到临时目录）：

```javascript
// if Skill definition includes files field
if (_ && Object.keys(_).length > 0) {
    q = cL9(H.name);  // generate temp path
    // wrap getPromptForCommand to inject file content
    $ = async (z, A) => {
        O ??= JTK(H.name, _);  // extract files to temp dir
        let f = await O;
        ...
    }
}
```

#### mcp — MCP 服务器 Prompt

MCP 服务器提供的 prompt 作为 Skill 暴露给用户：

```javascript
// 13_ui_rendering.js:1139 - MCP prompt as Skill
{
    type: "prompt",
    name: "serverName:promptName",  // compound naming
    disableModelInvocation: yGH(H["disable-model-invocation"]),
}
```

### SKILL.md 文件解析

#### Frontmatter 解析 — `___()` (parseSkillFile)

`___()` 函数将 SKILL.md 文件转换为命令对象：

```javascript
// 14_html_parser.js:33636 - ___() (parseSkillFile)
function ___(H, _, q, $, K, O, T = { isSkillMode: false }) {
    let { frontmatter: z, content: A } = _;

    // parse all frontmatter fields
    let f = ou(z.description, H);            // description
    let Y = z["allowed-tools"];               // allowed-tools
    let D = gg(Y);                            // parse tool rules
    let M = z["argument-hint"];               // argument-hint
    let J = cE_(z.arguments);                 // arguments list
    let P = z.when_to_use;                    // when_to_use
    let X = z.version;                        // version
    let R = z.name;                           // display name
    let W = z.model;                          // model (inherit/specific)
    let Z = z.effort;                         // effort level
    let v = yGH(z["disable-model-invocation"]); // disable-model-invocation
    let y = z["user-invocable"];              // user-invocable
    let S = yZ_(z.shell, H);                 // shell config

    return {
        type: "prompt",
        name: H,
        description: w,
        allowedTools: D,
        argumentHint: M,
        argNames: J.length > 0 ? J : undefined,
        whenToUse: P,
        model: W,
        effort: k,
        disableModelInvocation: v,
        userInvocable: E,
        source: "plugin",  // or "userSettings" depending on context
        ...
    }
}
```

#### 支持的 Frontmatter 字段

```yaml
---
description: "What this skill does"
allowed-tools: Bash(git:*), Read, Edit
argument-hint: "<pr-number>"
arguments: [arg1, arg2]
when_to_use: "When the user asks to deploy..."
version: "1.0"
name: "display-name"
model: "claude-sonnet-4-6"   # or "inherit"
effort: "high"                 # low/medium/high/max
disable-model-invocation: true # AI cannot auto-invoke
user-invocable: true
shell: "bash"
---

Your skill prompt content here...
Use $ARGUMENTS to reference user input.
```

#### `$ARGUMENTS` 变量替换

Skill 内容支持多种参数替换模式：

```javascript
// 12_computer_use.js:15962 - argument substitution

// 1. $ARGUMENTS[N] -- positional by index
H = H.replace(/\$ARGUMENTS\[(\d+)\]/g, (T, z) => {
    let A = parseInt(z, 10);
    return K[A] ?? ""
})

// 2. $N -- shorthand positional
H = H.replace(/\$(\d+)(?!\w)/g, (T, z) => {
    let A = parseInt(z, 10);
    return K[A] ?? ""
})

// 3. $ARGUMENTS -- full argument string
H = H.replaceAll("$ARGUMENTS", _)

// 4. if no substitution occurred and args exist, append
if (H === O && q && _)
    H = H + "\n\nARGUMENTS: " + _
```

替换示例：
```
用户输入: /deploy staging --force

$ARGUMENTS        --> "staging --force"
$ARGUMENTS[0]     --> "staging"
$ARGUMENTS[1]     --> "--force"
$0                --> "staging"
$1                --> "--force"
```

#### 特殊变量

除了 `$ARGUMENTS`，还支持两个环境变量：

```javascript
// 14_html_parser.js:33690
// ${CLAUDE_SKILL_DIR} -- resolves to the directory containing SKILL.md
if (T.isSkillMode) {
    let C = sD.dirname(_.filePath);
    B = B.replace(/\$\{CLAUDE_SKILL_DIR\}/g, C)
}

// ${CLAUDE_SESSION_ID} -- current session UUID
B = B.replace(/\$\{CLAUDE_SESSION_ID\}/g, v_())
```

这让 Skill 可以引用自身目录中的文件（如模板、配置），实现更复杂的工作流。

### Skill 排序与优先级

完整命令列表的组装顺序决定了同名命令的优先级：

```javascript
// 16_commands_slash.js:35631 - dN9 (getAllCommands)
dN9 = $6(async (H) => {
    let [{
        skillDirCommands: _,    // user .claude/skills/
        pluginSkills: q,        // plugin skills
        bundledSkills: $,       // bundled skills
        builtinPluginSkills: K  // builtin plugin skills
    }, O, T] = await Promise.all([
        fwK(H),               // load skill directories
        RwH(),                 // load plugin commands
        BN9 ? BN9(H) : []     // extra command sources
    ]);

    // merge order: bundled -> builtinPlugin -> skillDir -> extra -> plugin -> builtin
    return [...$, ...K, ..._, ...T, ...O, ...q, ...g$8()]
})
```

```
命令优先级（先注册的先匹配）
════════════════════════════════
bundled         <-- highest priority
builtinPlugin
skillDir        <-- user skills here
extra
plugin
builtin         <-- lowest priority
════════════════════════════════
```

### Skill 使用频率排序

用户可见的 Skill 列表按使用频率加权排序：

```javascript
// 13_ui_rendering.js:64472 - so6() (getSkillFrequencyScore)
function so6(H) {
    let q = z_().skillUsage?.[H];
    if (!q) return 0;
    let $ = (Date.now() - q.lastUsedAt) / 86400000;  // days since last use
    let K = Math.pow(0.5, $ / 7);  // 7-day half-life decay
    return q.usageCount * Math.max(K, 0.1)
}
```

> **设计决策**：使用 7 天半衰期的指数衰减函数，既考虑了使用频次也考虑了时间因素。一周前用过 10 次的命令和今天用过 5 次的命令，权重大致相当。这确保了 Skill 列表始终反映用户的**当前**工作习惯。

### Skill 可发现性

AI 自动发现 Skill 的过滤逻辑精确控制了哪些 Skill 出现在系统提示中：

```javascript
// 16_commands_slash.js:35641 - iE (getAiDiscoverableSkills)
// Skills AI can auto-invoke (via Skill tool)
iE = $6(async (H) => {
    return (await mW(H)).filter((q) =>
        q.type === "prompt" &&
        !q.disableModelInvocation &&    // not disabled for AI
        q.source !== "builtin" &&        // not builtin (handled separately)
        (q.loadedFrom === "bundled" ||
         q.loadedFrom === "skills" ||
         q.loadedFrom === "commands_DEPRECATED" ||
         q.hasUserSpecifiedDescription ||
         q.whenToUse)                    // has discoverability metadata
    )
})
```

**小结**：Skill 系统通过 SKILL.md 文件实现了"零代码扩展"。4 种来源覆盖从内置到第三方的全部场景，`$ARGUMENTS` 替换提供了参数化能力，频率衰减排序确保了最常用的 Skill 始终在最前面。

---

## 17.6 插件系统：manifest 格式、加载/验证/刷新

插件系统是 Skill 的进一步封装 — 一个插件可以同时提供多个 Skill、Agent 定义、生命周期 Hooks、MCP 服务器和 LSP 服务器。

### 插件目录结构

```
plugin-directory/
├── .claude-plugin/
│   ├── marketplace.json     <-- marketplace-published manifest
│   └── plugin.json          <-- local development manifest
├── skills/
│   ├── my-skill/
│   │   └── SKILL.md
│   └── another-skill/
│       └── SKILL.md
├── commands/                <-- legacy (commands_DEPRECATED)
│   └── my-command.md
├── agents/
│   └── my-agent.md
└── hooks/
    └── hooks.json
```

### Plugin Manifest 格式

两种 manifest 格式对应不同的分发渠道：

```javascript
// 16_commands_slash.js:25384 - marketplace.json validation schema
WOK = pH(() => h.object({
    entries: h.record(h.string(), h.string())
}))
GOK = pH(() => h.object({
    userId: h.string(),
    version: h.number(),
    lastModified: h.string(),
    checksum: h.string(),
    content: WOK()
}))
```

**marketplace.json** 包含签名信息（userId、checksum），用于验证插件来源的可信性。**plugin.json** 用于本地开发，不需要签名。

### 插件加载与刷新 — `wYH()` (refreshPlugins)

```javascript
// 16_commands_slash.js:25414 - wYH() (refreshPlugins)
async function wYH(H) {
    // 1. clear all plugin caches
    j5(), QS7();

    // 2. get enabled/disabled plugin lists
    let _ = await d2();
    let [q, $] = await Promise.all([
        RwH(),                // load plugin commands
        lE(s6())              // load agent definitions
    ]);

    // 3. for each enabled plugin, load MCP and LSP servers
    let [z, A] = await Promise.all([
        Promise.all(K.map(async (j) => {
            let M = await HqH(j, T);      // MCP servers
            if (M) j.mcpServers = M;
            return M ? Object.keys(M).length : 0
        })),
        Promise.all(K.map(async (j) => {
            let M = await LoH(j, T);      // LSP servers
            if (M) j.lspServers = M;
            return M ? Object.keys(M).length : 0
        }))
    ]);

    // 4. update app state
    H((j) => ({
        ...j,
        plugins: { enabled: K, disabled: O, commands: q, ... },
        agentDefinitions: $,
        mcp: { ...j.mcp,
               pluginReconnectKey: j.mcp.pluginReconnectKey + 1 }
    }));

    // 5. load plugin hooks
    await DF();

    return { enabled_count, disabled_count, command_count, ... }
}
```

### 插件提供的组件

| 组件 | 来源目录 | 说明 |
|------|----------|------|
| Skills | `skills/*/SKILL.md` | Prompt 型 Skill |
| Commands | `commands/*.md` | 旧式命令（deprecated） |
| Agents | `agents/*.md` | 自定义 Agent 配置 |
| Hooks | `hooks/hooks.json` | 生命周期钩子 |
| MCP Servers | manifest 中配置 | MCP 服务器连接 |
| LSP Servers | manifest 中配置 | LSP 语言服务器 |

### 插件验证

```javascript
// 16_commands_slash.js:4317 - l29() (validatePlugin)
async function l29(H) {
    let _ = [];
    let q = [
        ["skill", eD.join(H, "skills")],
        ["agent", eD.join(H, "agents")],
        ["command", eD.join(H, "commands")]
    ];
    for (let [K, O] of q) {
        let T = await Q29(O, K === "skill");
        for (let z of T) {
            let f = O7K(z, A, K);  // parse and validate
            if (f.errors.length > 0 || f.warnings.length > 0)
                _.push(f)
        }
    }
    // validate hooks.json
    let $ = await T7K(eD.join(H, "hooks", "hooks.json"));
    ...
}
```

验证检查包括：Frontmatter 必须存在、YAML 解析成功、`description` 字段必填、Hooks 配置格式正确。

### `/reload-plugins` 实现

```javascript
// 16_commands_slash.js:25508
var ZOK = async (H, _) => {
    let q = await wYH(_.setAppState);
    // output summary
    let K = `Reloaded: ${[
        YYH(q.enabled_count, "plugin"),
        YYH(q.command_count, "skill"),
        YYH(q.agent_count, "agent"),
        YYH(q.hook_count, "hook"),
        YYH(q.mcp_count, "plugin MCP server"),
        YYH(q.lsp_count, "plugin LSP server")
    ].join(" . ")}`;
    ...
}
```

`/reload-plugins` 是开发插件时的必备命令 — 它清除缓存、重新加载所有插件组件、重连 MCP/LSP 服务器，然后输出加载统计。

**小结**：插件系统将 Skill、Agent、Hooks、MCP/LSP 统一打包，通过 manifest 管理分发和验证。`/reload-plugins` 提供了开发时的热刷新能力。

---

## 17.7 记忆系统：CLAUDE.md 分层（User/Project/Local/Managed/AutoMem/TeamMem）

记忆系统是命令系统的"持久层"。用户的偏好、项目的规则、团队的约定，都通过分层的 `CLAUDE.md` 文件持久化。命令系统中的 `/memory`、`/init`、`/config` 等命令直接操作这套记忆体系。

### 记忆文件路径体系

```javascript
// 04_git_operations.js:16309 - y1H() (getMemoryFilePath)
function y1H(H) {
    let _ = s6();           // s6() = originalCwd
    switch (H) {
        case "User":        // global user memory
            return mz.join(i6(), "CLAUDE.md");   // ~/.claude/CLAUDE.md
        case "Local":       // local memory (not committed)
            return mz.join(_, "CLAUDE.local.md"); // ./CLAUDE.local.md
        case "Project":     // project memory (committable)
            return mz.join(_, "CLAUDE.md");       // ./CLAUDE.md
        case "Managed":     // managed/policy memory
            return mz.join(RM(), "CLAUDE.md");    // managed-root/CLAUDE.md
        case "AutoMem":     // auto-generated memory
            return tK_();                          // auto-memory directory
    }
    return g2$.getTeamMemEntrypoint();             // team memory entrypoint
}
```

### 6 层记忆层次

```
记忆层次（优先级从高到低）
══════════════════════════════════════════════════════════
层级            路径                           说明
──────────────────────────────────────────────────────────
Managed         <managed-root>/CLAUDE.md      organization policy
                                              cannot be excluded
                                              by claudeMdExcludes

User            ~/.claude/CLAUDE.md           global personal prefs
                                              applies to all projects

Project         ./CLAUDE.md                   project-level rules
                                              committed to Git

Local           ./CLAUDE.local.md             local overrides
                                              not committed to Git

AutoMem         ~/.claude/projects/           AI auto-generated
                <sanitized-cwd>/memory/       learns from sessions

TeamMem         team memory entrypoint        multi-user collaboration
                                              shared team rules

@-imported      @path references in           nested file inclusion
                any CLAUDE.md                 arbitrary depth
══════════════════════════════════════════════════════════
```

> **设计决策**：Managed 类型不可被 `claudeMdExcludes` 排除。这是为了确保组织级策略（如安全规则、合规要求）始终生效，即使用户试图绕过。这体现了"安全策略 > 用户偏好"的设计原则。

### 记忆加载 — `CY()` (loadMemoryFiles)

`CY()` 是记忆系统的核心加载函数，被多个模块调用：

```
CY() 调用点分布
═══════════════════════════════════════════
调用位置                        场景
───────────────────────────────────────────
14_html_parser.js:29327        Skill loading - get memory context
15_hooks_system.js:21373       /memory command - file list
15_hooks_system.js:21905       /memory UI component
13_ui_rendering.js:45544       system prompt construction
16_commands_slash.js:11570     rules/policy checking
18_sdk_examples.js:15841       SDK mode
═══════════════════════════════════════════
```

返回值包含每个记忆文件的：
- `path` — 文件绝对路径
- `content` — 文件内容
- `type` — 记忆类型（User/Project/Local/Managed/AutoMem）
- `exists` — 是否已存在
- `parent` — 父文件路径（用于 `@-import` 嵌套）
- `isNested` — 是否为嵌套导入

### 记忆在系统提示中的注入

```javascript
// 16_commands_slash.js:43874 - system prompt construction
let {claudeMd} = await Promise.all([ZoH(H), pP(_), Yz(), iA()]);
let z = K.claudeMd?.length ?? 0;
// claudeMd content injected as "# claudeMd" section
```

系统提示中，CLAUDE.md 内容以明确的来源标注注入：

```
# claudeMd
Contents of ~/.claude/CLAUDE.md (user's private global instructions):
[user memory content]

Contents of ./CLAUDE.md (project instructions, checked into the codebase):
[project memory content]
```

### `/memory` 命令 — 记忆文件编辑 UI

```javascript
// 15_hooks_system.js:21924 - /memory command
i6K = {
    type: "local-jsx",
    name: "memory",
    description: "Edit Claude memory files",
    load: () => Promise.resolve().then(() => (Gw9(), Ww9))
}
```

`/memory` 的 UI 组件 `Q6K` 渲染一个交互式选择列表：

```
/memory UI 展示的文件列表
══════════════════════════════════════
  User memory      ~/.claude/CLAUDE.md
  Project memory   ./CLAUDE.md
  Local memory     ./CLAUDE.local.md
  @-imported files (nested)
  Auto-memory folder
  Team memory folder (if enabled)
  Agent memory (if applicable)
══════════════════════════════════════
```

选择文件后，通过 `DV()` (推测名: `openInEditor`) 调用系统编辑器：

```javascript
// editor detection order: $VISUAL > $EDITOR > code > vi > nano
// YV() (detectEditor) checks availability in this order
```

### 自动记忆（Auto-Memory）

```javascript
// toggle auto-memory
J8("userSettings", { autoMemoryEnabled: RH });

// auto-memory directory configuration
autoMemoryDirectory: h.string().optional()
    .describe("Custom directory path for auto-memory storage. "
        + "Supports ~/ prefix. When unset, defaults to "
        + "~/.claude/projects/<sanitized-cwd>/memory/.")
```

- AI 在会话中自动学习并写入记忆文件
- 目录可通过 `autoMemoryDirectory` 设置自定义
- 通过 `/memory` UI 的开关切换启用/禁用

### 记忆排除：`claudeMdExcludes`

```javascript
// 04_git_operations.js:8285
claudeMdExcludes: h.array(h.string()).optional()
    .describe('Glob patterns or absolute paths of CLAUDE.md files '
        + 'to exclude. Only applies to User, Project, and Local '
        + 'memory types (Managed/policy files cannot be excluded).')
// example: "/home/user/monorepo/CLAUDE.md", "**/code/CLAUDE.md"
```

### Rules 目录

除了 CLAUDE.md 文件，还支持 `rules/` 目录存放规则文件：

```javascript
// 04_git_operations.js:16331
function H3_() {           // getUserRulesDir
    return mz.join(i6(), "rules")    // ~/.claude/rules/
}

function e5_() {           // getManagedRulesDir
    return mz.join(RM(), ".claude", "rules")  // managed rules
}
```

**小结**：记忆系统通过 6 层 CLAUDE.md 文件实现了从全局到本地的配置级联。Managed 层不可排除确保了安全策略的强制性，Auto-Memory 让 AI 自主学习用户偏好，`@-import` 支持任意深度的嵌套引用。

---

## 17.8 CLI 入口：40+ 命令行参数、yargs 解析

命令系统不仅在交互式 REPL 中运行，还通过 CLI 参数支持非交互调用。这使得 Claude Code 可以集成到 CI/CD 管道、脚本自动化和 IDE 插件中。

### 入口点：`19_tail.js`

```javascript
// 19_tail.js:1184-1209
let H = process.argv.slice(2);
let _ = H.includes("-p") || H.includes("--print");     // print mode
let q = H.includes("--init-only");                       // init only
let $ = H.some((A) => A.startsWith("--sdk-url"));       // SDK mode
let K = _ || q || $ || !process.stdout.isTTY;            // non-interactive

// entry type detection
let T = (() => {
    if (lH(process.env.GITHUB_ACTIONS))            return "github-action";
    if (process.env.CLAUDE_CODE_ENTRYPOINT === "sdk-ts")
                                                    return "sdk-typescript";
    if (process.env.CLAUDE_CODE_ENTRYPOINT === "sdk-py")
                                                    return "sdk-python";
    if (process.env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli")
                                                    return "sdk-cli";
    if (process.env.CLAUDE_CODE_ENTRYPOINT === "claude-vscode")
                                                    return "claude-vscode";
    if (process.env.CLAUDE_CODE_ENTRYPOINT === "local-agent")
                                                    return "local-agent";
    if (process.env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop")
                                                    return "claude-desktop";
    if (A) return "remote";
    return "cli";
})();
```

入口检测支持 8 种运行环境，从标准 CLI 到 GitHub Actions、VS Code 插件和桌面应用。

### Commander.js 程序定义 — `pyK()` (defineProgram)

`pyK()` 使用嵌入的 Commander.js 定义所有 CLI 选项。以下按功能分组列出完整参数清单。

#### 核心运行选项

| 参数 | 类型 | 说明 |
|------|------|------|
| `[prompt]` | positional | 初始提示文本 |
| `-p, --print` | flag | 打印模式（非交互，适合管道） |
| `-d, --debug [filter]` | optional | 调试模式，支持类别过滤 |
| `--debug-file <path>` | string | 调试日志输出到指定文件 |
| `--verbose` | flag | 详细输出模式 |
| `--bare` | flag | 极简模式（跳过 hooks/LSP/插件等） |

#### 模型与推理

| 参数 | 类型 | 说明 |
|------|------|------|
| `--model <model>` | string | 设置模型（别名或完整名） |
| `--effort <level>` | choice | 推理力度：`low`/`medium`/`high`/`max` |
| `--thinking <mode>` | choice | 思考模式：`enabled`/`adaptive`/`disabled` |
| `--fallback-model <model>` | string | 过载时的后备模型 |
| `--agent <agent>` | string | 设置当前 Agent |
| `--betas <betas...>` | array | Beta headers（API key 用户） |

#### 输入输出格式

| 参数 | 类型 | 说明 |
|------|------|------|
| `--output-format <format>` | choice | `text`/`json`/`stream-json` |
| `--input-format <format>` | choice | `text`/`stream-json` |
| `--json-schema <schema>` | string | 结构化输出的 JSON Schema |
| `--include-partial-messages` | flag | 流式输出包含部分消息 |

#### 会话管理

| 参数 | 类型 | 说明 |
|------|------|------|
| `-c, --continue` | flag | 继续最近会话 |
| `-r, --resume [id]` | optional | 恢复指定会话 |
| `--fork-session` | flag | 恢复时创建新会话 ID |
| `--session-id <uuid>` | string | 指定会话 UUID |
| `-n, --name <name>` | string | 设置会话名称 |
| `--no-session-persistence` | flag | 禁用会话持久化 |
| `--from-pr [value]` | optional | 恢复 PR 关联会话 |

#### 工具与权限

| 参数 | 类型 | 说明 |
|------|------|------|
| `--allowed-tools <tools...>` | array | 允许的工具列表 |
| `--disallowed-tools <tools...>` | array | 禁止的工具列表 |
| `--tools <tools...>` | array | 可用工具集 |
| `--dangerously-skip-permissions` | flag | 跳过所有权限检查 |
| `--permission-mode <mode>` | choice | 权限模式 |

#### 系统提示

| 参数 | 类型 | 说明 |
|------|------|------|
| `--system-prompt <prompt>` | string | 自定义系统提示 |
| `--system-prompt-file <file>` | string | 从文件读取系统提示 |
| `--append-system-prompt <prompt>` | string | 追加到默认系统提示 |
| `--append-system-prompt-file <file>` | string | 从文件追加系统提示 |

#### MCP 与插件

| 参数 | 类型 | 说明 |
|------|------|------|
| `--mcp-config <configs...>` | array | MCP 服务器配置 |
| `--strict-mcp-config` | flag | 仅使用 CLI 指定的 MCP |
| `--plugin-dir <path>` | repeatable | 额外插件目录 |
| `--settings <file-or-json>` | string | 额外设置文件 |
| `--disable-slash-commands` | flag | 禁用所有 Skill |

#### 运行限制

| 参数 | 类型 | 说明 |
|------|------|------|
| `--max-turns <n>` | number | 最大 Agent 循环轮次 |
| `--max-budget-usd <amount>` | number | 最大 API 花费（美元） |
| `--task-budget <tokens>` | number | API 端任务预算 |

#### 其他

| 参数 | 类型 | 说明 |
|------|------|------|
| `--add-dir <dirs...>` | array | 添加额外工作目录 |
| `--agents <json>` | string | 自定义 Agent 定义 |
| `--ide` | flag | 启动时连接 IDE |
| `--chrome` / `--no-chrome` | flag | 启用/禁用 Chrome 集成 |
| `--file <specs...>` | array | 启动时下载的文件 |
| `--init` / `--init-only` | flag | 执行初始化 hooks |

### `--bare` 模式

```javascript
// 19_tail.js:1268
if (w.bare) process.env.CLAUDE_CODE_SIMPLE = "1";
```

极简模式跳过的组件：

```
--bare 模式跳过的组件
══════════════════════════
  hooks              lifecycle hooks
  LSP                language servers
  plugins            plugin sync
  attribution        source attribution
  auto-memory        AI learning
  background fetch   prefetching
  keychain read      credential store
  CLAUDE.md discovery auto file loading
══════════════════════════
```

> **设计决策**：`--bare` 模式通过单个环境变量 `CLAUDE_CODE_SIMPLE=1` 控制所有简化行为。这意味着任何模块都可以通过检查这个环境变量来决定是否启用某个功能，无需传递复杂的配置对象。

### Stdin 管道输入处理

```javascript
// 19_tail.js:1210 - myK() (handleStdinInput)
async function myK(H, _) {
    if (!process.stdin.isTTY && !process.argv.includes("mcp")) {
        // non-TTY and not MCP mode
        process.stdin.setEncoding("utf8");
        let q = "";
        process.stdin.on("data", ($) => { q += $ });

        // 3-second timeout waiting for stdin
        let K = await sw8(process.stdin, 3000);
        if (K) process.stderr.write("Warning: no stdin data in 3s...");

        // merge prompt argument and stdin content
        return [H, q].filter(Boolean).join("\n");
    }
    return H;
}
```

这使得管道用法成为可能：

```bash
# pipe file content as context
cat buggy.py | claude -p "Fix the bugs in this file"

# pipe git diff as context
git diff | claude -p "Review these changes"
```

### preAction Hook

```javascript
// 19_tail.js:1240 - preAction hook
_.hook("preAction", async (f) => {
    await Promise.all([YW8(), aZq()]);    // MDM + init
    await FV9();                            // init settings
    if (!lH(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE))
        process.title = "claude";
    // load plugin directories
    let Y = f.getOptionValue("pluginDir");
    if (Array.isArray(Y) && Y.length > 0)
        wt_(Y);
    // execute migrations
    SyK();
    // remote settings
    SI7(); uF6();
});
```

preAction 在任何命令执行前运行，负责初始化设置、加载插件目录、执行数据库迁移。

### 子命令

Commander.js 还注册了几个子命令：

```bash
claude mcp     # MCP server management
claude config  # Configuration management
claude api     # Direct API calls
```

**小结**：CLI 入口通过 40+ 参数支持从简单的管道调用到复杂的自动化场景。`--bare` 模式提供最小运行环境，`--print` 模式支持管道集成，入口检测自动适配 8 种运行环境。

---

## 17.9 设计启示：命令系统的可扩展性与插件化设计

回顾整个命令系统的架构，可以提炼出几个对构建可扩展 Agent 系统具有普遍意义的设计模式。

### 启示 1：正交分类胜过层级分类

Claude Code 没有将命令分为"系统命令 / 用户命令 / AI 命令"这样的层级结构，而是采用了 Type × Source 的正交设计。这意味着：

- 添加新的来源（如 MCP）不需要修改类型分发逻辑
- 添加新的类型（如果需要）不需要修改注册机制
- 两个维度可以独立演化

```
反模式（层级分类）              正确模式（正交分类）
══════════════════              ══════════════════
SystemCommand                   Type: local | local-jsx | prompt
├── CostCommand                      ×
├── VersionCommand              Source: builtin | bundled | plugin
└── ...                                | mcp | userSettings
UserCommand
├── MySkill
└── ...
AICommand
├── CommitSkill
└── ...
```

### 启示 2：Prompt 注入是最安全的扩展方式

所有外部扩展（用户 Skill、插件 Skill、MCP prompt）都通过 `type: "prompt"` 路径执行。它们**不能注册原生的 local 或 local-jsx 命令**，只能通过 prompt 注入来驱动 AI 行为。

这有两个好处：
1. **安全**：外部代码不会直接操作系统状态，一切行为都经过 AI 的判断
2. **一致**：所有扩展的执行路径完全一致，调试和监控变得简单

### 启示 3：惰性加载是大规模命令系统的必需

50+ 命令如果在启动时全部初始化，会显著拖慢冷启动速度。Claude Code 使用两层惰性：

```
第一层：命令列表本身是惰性的
  g$8 = $6(() => [...])  // $6 = lazy evaluation wrapper

第二层：每个命令的实现是惰性的
  load: () => Promise.resolve().then(() => (init(), module))
```

只有当用户实际输入了某个命令时，对应的实现代码才会被加载和执行。

### 启示 4：频率衰减排序反映真实使用习惯

```
score = usageCount * max(0.5^(daysSinceLastUse / 7), 0.1)
```

这个简单的公式比单纯的"最近使用"或"最常使用"更准确。7 天半衰期意味着：
- 昨天用了 10 次的命令权重 ≈ 10 × 0.91 = 9.1
- 一周前用了 10 次的命令权重 ≈ 10 × 0.50 = 5.0
- 一个月前用了 10 次的命令权重 ≈ 10 × 0.10 = 1.0（底部截断）

### 启示 5：分层记忆解决了"谁说了算"问题

在多人协作的项目中，配置冲突是常见问题。Claude Code 的 6 层记忆体系通过明确的优先级解决了这个问题：

```
Managed (organization) > User (individual)
                       > Project (team)
                       > Local (personal override)
```

关键设计：Managed 层不可被排除，确保了安全策略的强制性。

### 启示 6：命令即文档

`SKILL.md` 文件既是命令的实现（prompt 内容），也是命令的文档（frontmatter 描述）。这种"代码即文档"的设计减少了维护负担 — 不存在"文档过时"的问题，因为文档就是实现本身。

```yaml
---
description: "Deploy to staging environment"  # <-- this IS the help text
allowed-tools: Bash(kubectl:*), Bash(docker:*)
when_to_use: "When the user asks to deploy"   # <-- this IS the AI hint
---

Deploy the current branch to staging...        # <-- this IS the prompt
```

**小结**：命令系统的架构展示了构建可扩展 Agent 的关键模式 — 正交分类、prompt 注入安全边界、惰性加载、频率衰减排序和分层配置。这些模式对任何需要支持大量用户自定义行为的 Agent 系统都有参考价值。

---

## 速查表

### 命令类型与执行方式

| 类型 | 执行方式 | 返回值 | 适用场景 |
|------|----------|--------|---------|
| `local` | 同步调用 `load().call(args, ctx)` | `{type, value}` 纯数据 | 信息查询、简单切换 |
| `local-jsx` | 异步 React/Ink 渲染 | JSX 元素 + onDone 回调 | 交互式 UI、多步选择 |
| `prompt` | `getPromptForCommand()` → AI 推理 | prompt 注入 + `shouldQuery: true` | AI 驱动的工作流 |

### 命令调度链函数索引

| 混淆名 | 推测英文名 | 位置 | 作用 |
|--------|-----------|------|------|
| `Tg_()` | parseSlashInput | `13_ui_rendering.js:64436` | 解析 `/command args` 格式 |
| `gB1()` | handleSlashCommand | `13_ui_rendering.js:64692` | 主入口：查找 → 分发 |
| `YF()` | findCommand | `16_commands_slash.js:35474` | name/alias 三层匹配查找 |
| `gfH()` | hasCommand | `16_commands_slash.js:35480` | 命令存在性布尔检查 |
| `ohH()` | getCommandOrThrow | `16_commands_slash.js:35484` | 查找命令（不存在抛异常） |
| `dB1()` | dispatchCommand | `13_ui_rendering.js:64830` | type switch 类型分发 |
| `TH9()` | executeSkill | `13_ui_rendering.js:65030` | Skill prompt 构造与注入 |
| `BB1()` | executeForkSkill | `13_ui_rendering.js:64586` | Fork 上下文 Skill 执行 |
| `KH9()` | looksLikeCommand | `13_ui_rendering.js:64689` | 字符串是否像命令名 |

### Skill 系统函数索引

| 混淆名 | 推测英文名 | 位置 | 作用 |
|--------|-----------|------|------|
| `g$8` | getBuiltinCommands | `16_commands_slash.js:35630` | 内置命令惰性列表 |
| `dN9` | getAllCommands | `16_commands_slash.js:35631` | 合并所有来源的命令列表 |
| `Nz()` | registerBundledSkill | `16_commands_slash.js:27433` | 注册捆绑 Skill |
| `gL9` | bundledSkillsList | `16_commands_slash.js:27455` | 捆绑 Skill 全局数组 |
| `___()` | parseSkillFile | `14_html_parser.js:33636` | SKILL.md → 命令对象转换 |
| `iE` | getAiDiscoverableSkills | `16_commands_slash.js:35641` | AI 可自动发现的 Skill |
| `MTH` | getSystemPromptSkills | `16_commands_slash.js:35650` | 系统提示中列出的 Skill |
| `so6()` | getSkillFrequencyScore | `13_ui_rendering.js:64472` | 使用频率评分（7天半衰期） |
| `fwK()` | loadSkillDirectories | `16_commands_slash.js:35644` | 加载 .claude/skills/ |

### 插件系统函数索引

| 混淆名 | 推测英文名 | 位置 | 作用 |
|--------|-----------|------|------|
| `wYH()` | refreshPlugins | `16_commands_slash.js:25414` | 插件加载/刷新主函数 |
| `RwH()` | loadPluginCommands | `16_commands_slash.js:~25400` | 加载插件命令 |
| `HqH()` | loadPluginMcpServers | `16_commands_slash.js:~25440` | 加载插件 MCP 服务器 |
| `LoH()` | loadPluginLspServers | `16_commands_slash.js:~25445` | 加载插件 LSP 服务器 |
| `l29()` | validatePlugin | `16_commands_slash.js:4317` | 插件验证 |
| `DF()` | loadPluginHooks | `16_commands_slash.js:~25450` | 加载插件 hooks |

### 记忆系统函数索引

| 混淆名 | 推测英文名 | 位置 | 作用 |
|--------|-----------|------|------|
| `CY()` | loadMemoryFiles | 多处调用 | 加载所有记忆文件（核心） |
| `y1H()` | getMemoryFilePath | `04_git_operations.js:16309` | 按类型返回记忆文件路径 |
| `i6()` | getUserConfigDir | `01_runtime_bootstrap.js:~2060` | `~/.claude/` 目录 |
| `s6()` | getOriginalCwd | `01_runtime_bootstrap.js:2076` | 原始工作目录 |
| `H3_()` | getUserRulesDir | `04_git_operations.js:16331` | `~/.claude/rules/` 目录 |
| `DV()` | openInEditor | `15_hooks_system.js:21744` | 调用系统编辑器 |
| `YV()` | detectEditor | `15_hooks_system.js:21733` | 检测可用编辑器 |

### CLI 入口函数索引

| 混淆名 | 推测英文名 | 位置 | 作用 |
|--------|-----------|------|------|
| `pyK()` | defineProgram | `19_tail.js:1227` | Commander.js 程序定义 |
| `myK()` | handleStdinInput | `19_tail.js:1210` | Stdin 管道输入处理 |
| `ty9()` | parseRemoteArgs | `16_commands_slash.js:47644` | 远程控制参数解析 |

### $ARGUMENTS 替换模式

| 模式 | 语法 | 示例输入 `/deploy staging --force` | 替换结果 |
|------|------|------|------|
| 完整参数 | `$ARGUMENTS` | — | `"staging --force"` |
| 按索引 | `$ARGUMENTS[0]` | — | `"staging"` |
| 简写位置 | `$0` | — | `"staging"` |
| 自动追加 | 无占位符时 | — | 追加 `\nARGUMENTS: staging --force` |

### Skill 扩展方式对比

| 方式 | 入口 | 组件 | 复杂度 | 适用场景 |
|------|------|------|--------|---------|
| SKILL.md | `.claude/skills/*/SKILL.md` | 单个 prompt 文件 | ★☆☆ | 简单自定义工作流 |
| Plugin | `.claude-plugin/` + manifest | Skills + Agents + Hooks + MCP/LSP | ★★☆ | 完整功能包 |
| MCP Server | `--mcp-config` | 远程 prompt provider | ★★★ | 外部工具/数据源集成 |
| Bundled | `Nz()` 代码注册 | 内嵌 Skill + 附带文件 | ★★☆ | 官方维护的扩展 |

### 记忆层次优先级

| 层级 | 路径 | 可排除 | 提交到 Git |
|------|------|--------|-----------|
| Managed | `<managed-root>/CLAUDE.md` | 不可排除 | N/A |
| User | `~/.claude/CLAUDE.md` | 可排除 | 否 |
| Project | `./CLAUDE.md` | 可排除 | 是 |
| Local | `./CLAUDE.local.md` | 可排除 | 否 |
| AutoMem | `~/.claude/projects/<cwd>/memory/` | 可排除 | 否 |
| TeamMem | team memory entrypoint | 可排除 | 是 |

---

> **本章总结**：Claude Code 的 Slash 命令系统是一个多层次、可扩展的命令框架。三层类型体系（local / local-jsx / prompt）覆盖从即时查询到 AI 驱动工作流的全部场景；Type × Source 的正交设计让执行逻辑和注册机制独立演化；SKILL.md 文件系统实现了"零代码扩展"；插件系统将多种组件统一打包；分层记忆确保了配置的一致性和安全性；CLI 入口的 40+ 参数支持从管道脚本到 IDE 集成的各种自动化场景。理解这套系统，就理解了如何为 Agent 构建一个真正可扩展的交互层。

