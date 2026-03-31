
# 第 4 章：Agentic Loop — Agent 的心跳

> **核心问题**：一个 Coding Agent 如何持续地理解需求、调用工具、处理结果、决定下一步行动 — 直到任务完成或资源耗尽？这个"持续"的能力，从何而来？

传统的 LLM 应用是"一问一答"：发送 prompt，拿回 response，完成。但 Coding Agent 面对的问题远不止一次 API 调用能解决 — 它需要先读代码、理解结构、修改文件、运行测试、检查结果，然后可能还要修修补补。这个"循环往复直到完成"的过程，就是 **Agentic Loop** — Agent 的心跳。

Claude Code 的 Agentic Loop 不是一个简单的 while 循环。它是一个精密的**流式状态机**，融合了流式 API 解析、流水线式工具执行、三级上下文压缩和多层容错恢复。本章将完整拆解这颗心脏的每一个零件。

---

## 4.1 概述：为什么 Coding Agent 需要循环

### 从单次 API 调用到 Agentic Loop

一个最简 LLM 应用的代码可能只有 3 行：

```
messages = [{ role: "user", content: "..." }]
response = api.call(messages)
print(response)
```

但 Coding Agent 的工作方式是这样的：

```
用户："帮我把 UserService 重构为单例模式"
  → Agent 调用 Grep 搜索 UserService 的定义
  → Agent 调用 Read 读取源文件
  → Agent 调用 Edit 修改构造函数
  → Agent 调用 Read 读取测试文件
  → Agent 调用 Edit 更新测试
  → Agent 调用 Bash 运行测试
  → 测试失败，Agent 读取错误输出
  → Agent 再次 Edit 修复问题
  → Agent 再次运行测试
  → 测试通过，Agent 回复"完成"
```

每一步都是一次 API 调用 + 工具执行。**Agentic Loop 就是把这些步骤串起来的引擎。**

### CC 主循环的核心设计理念

Claude Code 的 Agentic Loop 建立在四个核心理念之上：

| 理念 | 具体体现 |
|------|---------|
| **流式处理** | SSE 逐 token 解析，content block 完成即 yield |
| **工具流水线** | 模型还在生成后续 block 时，前面的工具已开始执行 |
| **自动压缩** | 三级上下文管理，在 token 超限前主动瘦身 |
| **多层容错** | 多种故障场景，每种都有专门的恢复策略 |

### 完整执行流程全景图

```
                        ┌─────────────────────────────────────────────┐
                        │            av() (agentExecute)              │
                        │  确定模型 → Agent ID → 收集上下文            │
                        │  构建 System Prompt → 创建 toolUseContext   │
                        └─────────────────┬───────────────────────────┘
                                          │
                                          ▼
                        ┌─────────────────────────────────────────────┐
                        │            zC() (agentLoop)                 │
                        │  注入 UserContext → 调用 xi1() 主循环        │
                        └─────────────────┬───────────────────────────┘
                                          │
              ┌──────────────────────────▼──────────────────────────────┐
              │            xi1() (mainLoop)                             │
              │                                                         │
          ┌───┤  ┌─ Phase 1: 上下文预处理 ──────────────┐               │
          │   │  │  c07 Content Replacement              │               │
          │   │  │  fd  Microcompact                     │               │
          │   │  │  y19 AutoCompact                      │               │
          │   │  └───────────────┬───────────────────────┘               │
          │   │                  ▼                                        │
          │   │  ┌─ Phase 2: API 调用 ──────────────────┐               │
          │   │  │  kyH callModel → TH8 vcrWrapper      │               │
          │   │  │  → Ly9 processSSEStream              │               │
          │   │  │  逐 content block yield               │               │
          │   │  └───────────────┬───────────────────────┘               │
          │   │                  ▼                                        │
          │   │  ┌─ Phase 3: 终止判断 ──────────────────┐               │
          │   │  │  无 tool_use?                         │  ──→ 终止返回  │
          │   │  │  ├─ max_tokens → 注入恢复提示         │               │
          │   │  │  ├─ end_turn → Stop Hook 检查         │               │
          │   │  │  └─ 其他终止条件                      │               │
          │   │  └───────────────┬───────────────────────┘               │
          │   │           有 tool_use                                     │
          │   │                  ▼                                        │
          │   │  ┌─ Phase 4: 工具执行 ──────────────────┐               │
          │   │  │  mH_ StreamingToolExecutor            │               │
          │   │  │  或 xh_ 传统分发                      │               │
          │   │  │  并行安全工具 / 串行写入工具           │               │
          │   │  └───────────────┬───────────────────────┘               │
          │   │                  ▼                                        │
          │   │  ┌─ Phase 5: maxTurns 检查 ─────────────┐               │
          │   │  │  turnCount > maxTurns? → 返回         │               │
          │   │  └───────────────┬───────────────────────┘               │
          │   │                  ▼                                        │
          │   │  ┌─ Phase 6: 组装下一轮 ────────────────┐               │
          │   │  │  Y = { messages, turnCount+1, ... }   │               │
          │   │  │  continue                             │               │
          │   │  └───────────────┬───────────────────────┘               │
          │   │                  │                                        │
          │   └──────────────────┼────────────────────────────────────────┘
          │                      │
          └──────── LOOP ────────┘
```

> **设计决策**：整个 Agentic Loop 使用 `async function*`（async generator）实现。每一步的中间结果通过 `yield` 实时推送给 UI 层，实现了"模型生成 → UI 渲染 → 工具执行"的全链路流式处理。这比 callback 或 event emitter 模式更自然 — generator 天然保持了执行上下文，不需要额外的状态管理。

**小结**：Agentic Loop 是 Coding Agent 从"单次问答"进化到"自主完成任务"的核心引擎。CC 的设计在流式处理、工具流水线、上下文管理和容错恢复四个维度上都做到了生产级水准。

---

## 4.2 Agent 入口 — `av()` (agentExecute)

`av()` 是整个 Agent 执行链的最外层入口。它负责**一切准备工作** — 确定用什么模型、收集上下文、构建 System Prompt、准备工具列表 — 然后把控制权交给真正的循环引擎。

### 函数签名与参数解读

```javascript
// 13_ui_rendering.js:65174
async function* av({
    agentDefinition: H,    // Agent 定义（主 Agent / SubAgent / 自定义 Agent）
    promptMessages: _,     // 用户消息列表
    toolUseContext: q,     // 工具使用上下文（权限、选项、abort 信号...）
    canUseTool: $,         // 权限检查函数
    isAsync: K,            // 是否异步执行（后台 Agent）
    canShowPermissionPrompts: O,  // 是否可以弹权限确认
    forkContextMessages: T,       // Fork 继承的上下文消息
    querySource: z,        // 调用来源（"main" / "agent" / "fork"）
    model: f,              // 指定模型（可选）
    maxTurns: w,           // 最大循环轮数（可选）
    availableTools: D,     // 可用工具列表
    allowedTools: j,       // 已授权工具列表
    // ... 更多参数
})
```

这个函数接收十几个参数，覆盖了 Agent 执行的所有配置维度。核心参数可以分为三组：

| 参数组 | 关键参数 | 作用 |
|--------|---------|------|
| **身份** | `agentDefinition`, `model`, `querySource` | 确定"我是谁"和"用什么模型" |
| **输入** | `promptMessages`, `forkContextMessages` | 确定"处理什么消息" |
| **控制** | `canUseTool`, `maxTurns`, `availableTools` | 确定"能做什么"和"做多久" |

### 初始化序列

`av()` 的初始化是一个精心编排的序列：

```
Step 1: 确定模型
    │  LvH(agentDef.model, mainLoopModel, explicitModel, defaultModel)
    │  优先级：显式指定 > Agent 定义 > 主循环配置 > 全局默认
    ▼
Step 2: 生成 Agent ID
    │  已有 agentId → 复用
    │  没有 → lx() 生成 UUID
    ▼
Step 3: 收集上下文（并行）
    │  Promise.all([
    │      Yz()   → CLAUDE.md 用户上下文
    │      iA()   → git status 系统上下文
    │  ])
    ▼
Step 4: 构建 System Prompt
    │  lB1() (buildSystemPrompt)
    ▼
Step 5: 创建 toolUseContext
    │  CeH() → 合并选项、注入 agentId、绑定消息列表
    ▼
Step 6: 进入主循环
    │  for await (let RH of zC({...})) { yield RH; }
```

注意 Step 3 中的 `Promise.all` — CLAUDE.md 加载和 git status 获取是**并行**执行的。这两个 I/O 操作彼此独立，没有理由串行等待。

```javascript
// 并行收集两类上下文
let [p, C] = await Promise.all([
    A?.userContext ?? Yz(),   // CLAUDE.md 内容
    A?.systemContext ?? iA()  // git status / 仓库信息
]);
```

### UserContext 注入 — `fc_()` (injectUserContext)

收集到的 CLAUDE.md 等用户上下文，需要以一种特殊方式注入到消息流中。`fc_()` 将其包装为 `<system-reminder>` 标签，插入到消息列表的**最前面**：

```javascript
// 17_system_prompt_full.js:3855
function fc_(H, _) {
    // 如果没有上下文，直接返回原始消息
    if (Object.entries(_).length === 0) return H;

    // 将上下文包装为 system-reminder，插入消息列表开头
    return [d_({ content: `<system-reminder>
As you answer the user's questions, you can use the following context:
${Object.entries(_).map(([q,$]) => `# ${q}\n${$}`).join('\n')}
      IMPORTANT: this context may or may not be relevant to your tasks.
</system-reminder>`, isMeta: true }), ...H]
}
```

> **设计决策**：UserContext 作为 `user` 消息而非 `system` 消息注入。这有两个好处：(1) 不破坏 System Prompt 的 Prompt Cache — System Prompt 是静态段，修改它会导致缓存失效；(2) 标记为 `isMeta: true` 的消息会在后续 compact 时被特殊处理，不会被摘要误删。

### System Prompt 构建 — `lB1()` (buildSystemPrompt)

System Prompt 的构建本身是一个复杂流水线（详见第 6 章），这里只关注 `av()` 如何调用它：

```javascript
// 13_ui_rendering.js:65445
async function lB1(H, _, q, $, K) {
    let O = new Set(K.map((T) => T.name));  // 可用工具名称集合
    try {
        let z = [H.getSystemPrompt({ toolUseContext: _ })];
        return await EeH(z, q, $, O)  // EeH: 拼装静态段 + 动态段
    } catch (T) {
        return await EeH([fH9], q, $, O)  // 出错时使用降级 prompt
    }
}
```

关键点：构建过程有 try-catch 包裹。如果 Agent 定义的 `getSystemPrompt()` 出错（比如自定义 Agent 的配置有误），会降级到一个基础 prompt `fH9`，而不是让整个 Agent 崩溃。这是**防御性编程**的典范。

**小结**：`av()` 是 Agentic Loop 的"启动器"。它的核心职责是"准备一切所需"，然后把控制权交给循环引擎 `zC()` / `xi1()`。并行上下文收集、System Prompt 构建降级、UserContext 注入方式 — 每个细节都体现了生产系统的成熟度。

---

## 4.3 主循环状态机 — `xi1()` (mainLoop)

`xi1()` 是 Agentic Loop 的**心脏** — 一个 `while(true)` 驱动的状态机，每一轮迭代对应 Agent 的一次"思考 → 行动 → 观察"循环。

### 状态对象 Y 的设计

主循环的所有状态都集中在一个对象 `Y` 中：

```javascript
// 14_html_parser.js:26373
let Y = {
    messages: H.messages,          // 当前消息列表
    toolUseContext: H.toolUseContext,  // 工具上下文
    autoCompactTracking: undefined,   // 自动压缩追踪信息
    stopHookActive: undefined,        // Stop Hook 状态
    maxOutputTokensRecoveryCount: 0,  // max_tokens 恢复计数器（上限 3）
    hasAttemptedReactiveCompact: false, // 是否已尝试 reactive compact
    turnCount: 1,                     // 当前轮数
    pendingToolUseSummary: undefined,  // 待处理的工具摘要
    transition: undefined             // 状态转换原因
};
```

每个字段都有明确职责：

| 字段 | 类型 | 作用 |
|------|------|------|
| `messages` | Array | 完整的对话消息列表（含历史） |
| `turnCount` | number | 当前轮次计数器 |
| `maxOutputTokensRecoveryCount` | number | max_tokens 错误恢复次数（上限 `ui1 = 3`） |
| `hasAttemptedReactiveCompact` | boolean | 防止 reactive compact 重复执行 |
| `autoCompactTracking` | object | 追踪上下文大小变化，决定何时 compact |
| `transition` | object | 记录进入当前状态的原因（调试用） |

### while(true) + 状态覆盖 vs 递归调用

一个直觉上更简洁的实现方式是递归：

```javascript
// 递归方式（CC 没有采用）
async function loop(state) {
    const result = await callModel(state);
    if (result.done) return result;
    const toolResult = await executeTool(result);
    return loop({ ...state, messages: [...state.messages, result, toolResult] });
}
```

递归简洁，但有两个严重问题：

1. **栈溢出** — Agent 可能运行数百轮，Node.js 的默认调用栈约 10K 帧
2. **无法 continue** — 递归调用后，无法从循环的"中间位置"重新进入

CC 选择了 `while(true)` + 状态覆盖：

```javascript
// CC 的实际方式
while (true) {
    // ... 6 个 Phase ...

    // 在需要"继续下一轮"时，直接覆盖状态对象，然后 continue
    Y = {
        messages: [...c, ...DH, ...fH],
        turnCount: yH,
        transition: { reason: "next_turn" }
    };
    // while(true) 自动回到顶部
}
```

> **设计决策**：状态覆盖而非递归。每轮结束时，把下一轮需要的所有状态打包成新的 `Y` 对象，然后 `continue` 回到循环顶部。这保证了恒定的调用栈深度（O(1)），且允许从任意 Phase 通过 `continue` 跳到下一轮。

### 6 个 Phase 的完整生命周期

以下是主循环单轮迭代的完整代码骨架（保留关键逻辑，省略错误处理细节）：

```javascript
async function* xi1(H, _) {
    let { systemPrompt: q, userContext: $, systemContext: K,
          canUseTool: O, maxTurns: A } = H;
    let w = H.deps ?? N19();  // 依赖注入：callModel / microcompact / autocompact / uuid
    let Y = { /* 初始状态 */ };

    while (true) {
        // === Phase 1: 上下文预处理 ===
        // L1: Content Replacement — 替换已持久化的 tool_result
        c = await c07(c, Z.contentReplacementState, ...);
        // L2: Microcompact — 压缩旧 tool_result 文本
        c = (await w.microcompact(c, Z, z)).messages;
        // L3: AutoCompact — 如果 token 超阈值，调用模型生成摘要
        let { compactionResult: r } = await w.autocompact(c, Z, ...);
        if (r) {
            let mH = jo(r);         // 构建压缩后消息
            for (let FH of mH) yield FH;  // yield 压缩事件给 UI
            c = mH;
        }

        // === Phase 2: API 调用 ===
        // fc_() 注入 UserContext，然后调用模型
        for await (let WH of w.callModel({
            messages: fc_(c, $),   // 注入 CLAUDE.md 等上下文
            systemPrompt: qH,
            ...
        })) {
            if (WH.type === "assistant") {
                DH.push(WH);       // 收集 assistant 响应
                let mH = WH.message.content.filter(FH => FH.type === "tool_use");
                if (mH.length > 0) {
                    vH.push(...mH);  // 收集 tool_use blocks
                    KH = true;       // 标记有工具调用
                }
            }
        }

        // === Phase 3: 终止判断 ===
        if (!KH) {  // 没有 tool_use — 模型认为任务完成（或出错）
            // 检查是否 max_tokens 被截断
            if (S19(zH) && y < 3) {
                // 注入恢复提示，继续下一轮
                Y = {
                    messages: [...c, ...DH, recoveryPrompt],
                    maxOutputTokensRecoveryCount: y + 1,
                    ...
                };
                continue;  // 回到 Phase 1
            }
            // 执行 Stop Hook
            let EH = yield* W19(c, DH, q, $, K, O, T, z);
            if (EH.preventContinuation) {
                return { reason: "stop_hook_prevented" };
            }
            return { reason: "completed" };
        }

        // === Phase 4: 工具执行 ===
        // 流式执行器或传统分发器
        let hH = l ? l.getRemainingResults() : xh_(vH, DH, O, Z);
        for await (let zH of hH) {
            if (zH.message) {
                yield zH.message;   // yield 工具结果给 UI
                fH.push(             // 收集 tool_result 消息
                    ...UM([zH.message], Z.options.tools)
                        .filter(WH => WH.type === "user")
                );
            }
        }

        // === Phase 5: maxTurns 检查 ===
        let yH = B + 1;
        if (A && yH > A) {
            return yield N7({ type: "max_turns_reached", ... }),
                   { reason: "max_turns" };
        }

        // === Phase 6: 组装下一轮状态 ===
        Y = {
            messages: [...c, ...DH, ...fH],  // 历史 + assistant + tool_result
            turnCount: yH,
            transition: { reason: "next_turn" }
        };
        // while(true) 自动回到 Phase 1
    }
}
```

让我们逐 Phase 细看关键设计：

**Phase 1 — 上下文预处理**：每轮开始前，先对消息列表做三级"瘦身"。这是在 API 调用之前执行的，因为调用时消息太大会导致 API 报错。三级策略详见 4.6 节。

**Phase 2 — API 调用**：通过依赖注入的 `w.callModel()` 调用模型。`callModel` 返回的是一个 async generator，每收到一个完整的 content block 就 yield 一次。这使得工具可以在模型还在生成时就开始执行（流式工具执行，详见 4.7 节）。

**Phase 3 — 终止判断**：当模型响应中没有 `tool_use` block 时，进入终止分支。但"没有 tool_use"不一定意味着真的完成了 — 可能是 `max_tokens` 截断了输出。此时需要注入恢复提示让模型继续。

**Phase 4 — 工具执行**：根据是否使用流式执行器 `mH_`，选择不同的分发路径。工具结果通过 `UM()` (normalizeMessages) 规范化后，作为 `user` 角色消息追加到对话历史。

**Phase 5 — maxTurns 检查**：防止 Agent 无限循环。SubAgent 通常设置 `maxTurns = 200`，主 Agent 根据配置决定。

**Phase 6 — 状态覆盖**：把当前轮的所有输出（assistant 消息 + tool_result 消息）追加到消息列表，轮次计数器 +1，然后 `continue` 回到 Phase 1。

### 消息列表的增长与演变

理解主循环的关键，是跟踪 `messages` 列表在每轮中的变化：

```
第 1 轮开始: [user_msg]
Phase 2 后: [user_msg] + [assistant_msg(text + tool_use)]
Phase 4 后: [user_msg] + [assistant_msg] + [user_msg(tool_result)]
第 2 轮开始: [user_msg, assistant_msg, user_msg(tool_result)]  ← Phase 1 会压缩
Phase 2 后: [...] + [assistant_msg_2(text + tool_use)]
Phase 4 后: [...] + [assistant_msg_2] + [user_msg(tool_result_2)]
...
第 N 轮:     消息列表持续增长，Phase 1 的三级压缩负责控制大小
```

注意 `tool_result` 是作为 `user` 角色消息添加的 — 这是 Claude API 的要求。API 的消息格式要求 `user` 和 `assistant` 严格交替出现，`tool_result` 必须作为 `user` 消息发送。

**小结**：`xi1()` 的 6-Phase 设计清晰地分离了关注点：预处理、调用、判断、执行、限流、状态转换。`while(true)` + 状态覆盖模式确保了恒定栈深度和灵活的 continue 重入。状态对象 `Y` 集中管理了所有循环状态，避免了散落的闭包变量。

---

## 4.4 API 调用与流式响应 — `Ly9()` (processSSEStream)

API 调用是 Agentic Loop 中延迟最高的环节 — 一次模型推理可能耗时数秒到数十秒。CC 通过**流式处理**把这段等待时间变成了生产力：模型一边生成 token，UI 一边渲染文本，工具一边排队执行。

### 调用链路

从主循环到实际 HTTP 请求，经过四层调用：

```
xi1() (mainLoop)
  │
  ├─→ kyH() (callModel)        // 依赖注入的模型调用函数
  │     │
  │     ├─→ TH8() (vcrWrapper)  // VCR 录制/回放包装器（可测试性）
  │     │     │
  │     │     └─→ Ly9() (processSSEStream)  // 真正的 SSE 流处理
  │     │           │
  │     │           └─→ HTTP POST /messages (SSE)
  │     │
  │     └─→ bc_() (vcrRecord)   // VCR 模式：录制 API 响应到文件
  │
  └─→ 每个 content block 完成时 yield 给 xi1()
```

`TH8()` (vcrWrapper) 是一个有趣的中间层 — 在开发/测试时，它可以将 API 响应录制到文件，之后回放，不需要真正调用 API。这是依赖注入模式带来的可测试性收益。

### 请求参数组装 — `OH()` (buildRequestParams)

在发送 API 请求前，需要把内部消息格式转换为 Claude API 格式：

```
内部消息列表
    │
    ▼
UM() (normalizeMessages)
├── 过滤 progress / system 类型消息
├── 合并相邻 user 消息（API 要求交替）
├── 分割含 thinking 的 assistant 消息
└── 输出 API 格式消息
    │
    ▼
OH() (buildRequestParams)
├── 组装 model / max_tokens / system prompt
├── 添加 tools 定义（JSON Schema 格式）
├── 设置 stream: true
├── 插入 cache breakpoint
└── 输出完整请求 body
```

### SSE 事件处理 — 6 种类型

Claude API 的 SSE 流由 6 种事件组成，`Ly9()` 对每种事件做不同处理：

```javascript
// 17_system_prompt_full.js:4795
for await (let l_ of fH) {  // fH: SSE 事件迭代器
    switch (l_.type) {
        case "message_start": {
            // 收到响应元信息（model, usage, id）
            GH = l_.message;
            jH = Date.now() - r;  // 计算 TTFT (Time To First Token)
            NH = w9H(NH, l_.message?.usage);  // 累计 token 用量
            break;
        }

        case "content_block_start":
            // 开始一个新的 content block（text / tool_use / thinking）
            switch (l_.content_block.type) {
                case "tool_use":
                    RH[l_.index] = { ...l_.content_block, input: "" };
                    break;
                case "text":
                    RH[l_.index] = { ...l_.content_block, text: "" };
                    break;
                case "thinking":
                    RH[l_.index] = { ...l_.content_block, thinking: "", signature: "" };
                    break;
            }
            break;

        case "content_block_delta": {
            // 增量更新 — 逐步拼接文本/JSON/thinking
            let x6 = RH[l_.index];
            switch (L6.type) {
                case "input_json_delta":
                    x6.input += L6.partial_json;  // 工具参数 JSON 片段
                    break;
                case "text_delta":
                    x6.text += L6.text;           // 文本片段
                    break;
                case "thinking_delta":
                    x6.thinking += L6.thinking;   // 思考过程片段
                    break;
                case "signature_delta":
                    x6.signature = L6.signature;  // thinking 签名
                    break;
            }
            break;
        }

        case "content_block_stop": {
            // ★ 关键：一个 content block 完成，立即 yield
            let L6 = {
                message: { ...GH, content: WF_([x6], $, O.agentId) },
                requestId: vH,
                type: "assistant",
                uuid: b8_.randomUUID(),
                timestamp: new Date().toISOString()
            };
            XH.push(L6);
            yield L6;  // 每完成一个 block 就推送给调用方
            break;
        }

        case "message_delta": {
            // 消息级元数据更新（总 token 用量、stop_reason）
            NH = w9H(NH, l_.usage);
            ZH = l_.delta.stop_reason;  // "end_turn" / "max_tokens" / ...
            break;
        }

        case "message_stop":
            // 整个响应结束
            break;
    }
    // 每个事件都 yield 为 stream_event（UI 用于实时渲染）
    yield { type: "stream_event", event: l_, ...ttftMs };
}
```

> **设计决策**：`content_block_stop` 时立即 yield，而非等整个 message 完成。这是**流式工具执行的基础** — 当第一个 `tool_use` block 完成时，模型可能还在生成第二个 block，但 `mH_` (StreamingToolExecutor) 已经可以开始执行第一个工具了。这实现了模型生成和工具执行的**时间重叠**。

### 流式降级 — `Gy9()` (nonStreamingFallback)

SSE 流处理可能因网络问题或 API 兼容性问题失败。CC 不会直接报错，而是自动降级到非流式模式：

```javascript
// 17_system_prompt_full.js:5031
if (N("Error streaming, falling back to non-streaming mode")) {
    bH = true;  // 标记已降级
    if (O.onStreamingFallback) O.onStreamingFallback();  // 通知 UI

    // 改用非流式 API 调用
    let D_ = yield* Gy9({...}, ...);
}
```

降级后，整个响应作为一个整体返回，失去了流式渲染和流式工具执行的优势，但至少能正常工作。这是"渐进增强"理念的体现 — 流式是增强，非流式是底线。

### 流式空闲看门狗

长时间的 SSE 流可能"卡住" — 服务端出问题但没有关闭连接。CC 使用看门狗机制检测这种情况：

```javascript
// 看门狗配置
let BH = lH(process.env.CLAUDE_ENABLE_STREAM_WATCHDOG);  // 启用开关
let EH = parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || "") || 90000;  // 90s 超时
let mH = EH / 2;  // 45s 警告阈值

// 定时器逻辑
LH();  // 初始化/重置计时器
// 每收到一个 SSE 事件就重置
dH = setTimeout(() => {
    FH = true;  // 标记超时
    l();         // 取消流（abort）
}, EH);
```

看门狗的行为分两级：
1. **45s 警告** — 在 45 秒无新事件时，通过 `console.warn` 记录警告
2. **90s 超时** — 在 90 秒无新事件时，强制取消流并触发错误恢复

每收到一个新的 SSE 事件，看门狗计时器就会重置。这确保了只有在连接**真正卡死**时才会触发超时。

**小结**：SSE 流处理是 CC 流式体验的核心。6 种事件类型覆盖了 Claude API 的完整响应协议。`content_block_stop` 时的即时 yield 实现了流式工具执行，流式降级确保了功能底线，看门狗防止了连接假死。

---

## 4.5 7 种终止条件

Agentic Loop 的退出控制是一个关键设计问题 — 循环应该在什么时候停止？太早停止会导致任务未完成，太晚停止会浪费 token 甚至陷入死循环。CC 设计了 7 种终止条件，覆盖正常完成到异常恢复的全部场景。

### 终止条件全景表

| # | 条件 | 触发方式 | 返回原因 | 可恢复 |
|---|------|---------|---------|--------|
| 1 | **end_turn** | 模型无 tool_use 输出 | `"completed"` | - |
| 2 | **maxTurns** | turnCount > maxTurns | `"max_turns"` | - |
| 3 | **用户中断** | abort signal | `"aborted_streaming"` | - |
| 4 | **max_tokens** | stop_reason = "max_tokens" | 注入恢复提示 | 最多 3 次 |
| 5 | **API 错误** | image error / model error | `"image_error"` | - |
| 6 | **上下文阻塞** | token 超阻塞限制 | `"blocking_limit"` | - |
| 7 | **Stop Hook** | Hook 返回 preventContinuation | `"stop_hook_prevented"` | Hook 决定 |

### 条件 1：end_turn — 正常完成

最常见的终止方式。当模型的响应中没有 `tool_use` block 时，意味着模型认为任务已完成（或不需要工具就能回答）。

```javascript
if (!KH) {  // KH: 是否有 tool_use
    // ... max_tokens 检查 ...
    // 执行 Stop Hook
    let EH = yield* W19(c, DH, q, $, K, O, T, z);
    if (EH.preventContinuation) {
        return { reason: "stop_hook_prevented" };
    }
    return { reason: "completed" };
}
```

注意在返回前会执行 **Stop Hook** `W19()` (checkStopHook)。Stop Hook 是一个可选的生命周期扩展点，允许外部系统在 Agent 认为完成时进行额外检查（比如运行 linter、执行测试），如果检查失败，可以阻止 Agent 停止，强制它继续修复。

Stop Hook 有三种返回结果：

| 结果 | 行为 |
|------|------|
| `preventContinuation: true` | Agent 被阻止继续，但也不能再循环 |
| `blockingErrors` 非空 | 错误信息注入消息列表，Agent **重入循环** 继续修复 |
| 无特殊标记 | Agent 正常退出 |

```
Agent 输出 "修改完成"（无 tool_use）
    │
    ├── Stop Hook 检查
    │     │
    │     ├── Hook 返回 OK → return "completed"
    │     │
    │     ├── Hook 返回 blockingErrors
    │     │     → 注入错误信息到消息列表
    │     │     → continue 回到 Phase 1（Agent 继续修复）
    │     │
    │     └── Hook 返回 preventContinuation
    │           → return "stop_hook_prevented"
    │
    └── 没有 Stop Hook → return "completed"
```

### 条件 2：maxTurns — 循环轮数限制

防止 Agent 无限循环的安全阀：

```javascript
let yH = B + 1;
if (A && yH > A) {
    return yield N7({ type: "max_turns_reached", ... }),
           { reason: "max_turns" };
}
```

不同 Agent 类型有不同的 maxTurns 限制：

| Agent 类型 | 典型 maxTurns | 说明 |
|-----------|---------------|------|
| 主 Agent | 无限制或用户配置 | 交互式使用，用户可随时中断 |
| SubAgent | 配置值 | Agent 定义中指定 |
| Fork | 200 | 高轮次但有上限 |

### 条件 3：用户中断

用户按 Ctrl+C 或 UI 触发 abort 时：

```javascript
if (Z.abortController.signal.aborted) {
    return { reason: "aborted_streaming" };
}
```

abort signal 不仅终止循环，还会传播到正在执行的工具和 HTTP 请求，实现全链路取消。

### 条件 4：max_tokens 自动恢复

当模型输出被截断（`stop_reason = "max_tokens"`）时，不一定意味着任务失败。CC 会注入一条恢复提示，让模型从断点继续：

```javascript
if (S19(zH) && y < 3) {  // S19: 是否 max_tokens; y: 已恢复次数
    // 注入恢复提示
    Y = {
        messages: [...c, ...DH,
            { role: "user", content: "Output token limit hit. Resume directly..." }
        ],
        maxOutputTokensRecoveryCount: y + 1,
        transition: { reason: "max_tokens_recovery" }
    };
    continue;  // 回到 Phase 1
}
```

恢复次数上限为 `ui1 = 3` 次。超过 3 次仍被截断，说明模型在生成异常长的输出，此时应该停止而非继续。

> **设计决策**：恢复提示的内容是 `"Output token limit hit. Resume directly..."` — 简洁且具有指令性。它告诉模型"你被截断了，直接从断点继续"。如果不注入这个提示，模型可能会重新开始整段输出，浪费 token。

### 条件 5：API 错误

某些 API 错误是不可恢复的：

```javascript
if (zH instanceof fZH || zH instanceof kd) {
    return { reason: "image_error" };
}
```

例如，消息中包含损坏的图片 block，API 返回 image 相关错误。这种错误重试也没用，直接终止。

### 条件 6：上下文窗口阻塞

当消息列表的 token 总量接近模型窗口上限时，再调用 API 也会被拒绝。CC 提前检测并退出：

```javascript
let { isAtBlockingLimit: zH } = DwH(
    RG(c) - _H,       // 当前 token 数 - System Prompt token 数
    Z.options.mainLoopModel
);
if (zH) {
    return { reason: "blocking_limit" };
}
```

阻塞限制 = 有效窗口 - `oe6`（3000 token 偏移），详见 4.6 节。

### 条件 7：Stop Hook 阻止

与条件 1 中的 Stop Hook 联动。如果 Hook 返回 `preventContinuation: true`，Agent 被阻止继续循环。

### 容错恢复矩阵

将 7 种终止条件和其他故障场景合并，CC 的完整容错策略如下：

```
┌──────────────────────────┬──────────────────────────────────┐
│ 故障场景                  │ 恢复策略                          │
├──────────────────────────┼──────────────────────────────────┤
│ max_tokens 截断           │ 注入恢复提示，最多 3 次           │
│ prompt_too_long           │ Reactive Compact 压缩后重试      │
│ SSE 流错误                │ 降级到非流式模式                  │
│ SSE 流超时(90s)           │ 看门狗取消流，触发错误恢复        │
│ 模型返回错误              │ 指数退避重试（3 层）             │
│ Stop Hook blockingErrors  │ 注入错误信息，重入循环            │
│ 上下文阻塞限制            │ 返回 blocking_limit，上层处理    │
│ 用户中断 (abort)          │ 全链路取消，立即退出              │
└──────────────────────────┴──────────────────────────────────┘
```

**小结**：7 种终止条件构成了一个完整的退出控制矩阵，从正常完成到异常恢复都有覆盖。max_tokens 自动恢复（最多 3 次）和 Stop Hook 重入循环是最有设计感的部分 — 它们让 Agent 在遇到"可恢复的中断"时能自动继续工作，而不是简单地报错退出。

---

## 4.6 三级上下文管理

随着 Agentic Loop 持续运转，消息列表不断增长。每轮迭代都会追加 assistant 响应和 tool_result，而 tool_result 可能包含完整的文件内容（几百行代码）。如果不加控制，几轮之后消息列表就会超出模型的 context window。

CC 设计了三级递进式上下文压缩策略，在 Phase 1（上下文预处理）中按顺序执行：

### L1: Content Replacement — `c07()` (replacePersistedContent)

**策略**：如果某个 `tool_result` 的内容已经被"持久化"到了其他地方（比如文件已写入磁盘），就用一个轻量的引用标记替换原始内容。

```
替换前: tool_result = "function hello() {\n  console.log('world');\n}\n... (200 行代码)"
替换后: tool_result = "[Content persisted to disk - see file: src/hello.ts]"
```

这是**无损**压缩 — 信息没有丢失，只是从消息列表移到了文件系统。Agent 需要时可以重新 Read 文件。

### L2: Microcompact — `fd()` (microcompactMessages)

**策略**：对**较旧**的 `tool_result` 做选择性文本压缩。保留结构和关键信息，去除冗余内容。

```
Microcompact 前:
  tool_result = "     1  import React from 'react';\n     2  import ...\n     (100 行带行号的代码)"

Microcompact 后:
  tool_result = "(file content, 100 lines)"  // 保留文件名和行数，去除具体内容
```

Microcompact 只作用于"旧"消息 — 最近几轮的 tool_result 保持原样，因为模型可能还需要参考它们。这是**有选择**的压缩。

### L3: AutoCompact — `y19()` (autoCompactMessages)

**策略**：当消息总 token 数超过阈值时，调用模型生成一份**结构化摘要**，替换掉大部分历史消息。

```
AutoCompact 前:
  [user_1, assistant_1, user_2(tool_result_1), assistant_2, ..., user_20(tool_result_10)]
  总计 ~180K tokens

AutoCompact 后:
  [system_summary("用户要求重构 UserService。已完成：1.读取源码 2.修改构造函数..."),
   user_19(tool_result_9), assistant_19, user_20(tool_result_10)]
  总计 ~30K tokens
```

这是**有损**压缩 — 历史细节被摘要替代。但摘要由模型自己生成，它会保留对后续工作最有价值的信息。

### 三级策略的递进关系

```
消息列表增长方向 →
[旧消息 ────────────────────────── 新消息]
   │              │                  │
   L1: 替换已     L2: 压缩旧        保持原样
   持久化内容     tool_result
   │
   超过阈值?
   └── L3: 全量摘要
```

| 级别 | 函数 | 触发时机 | 压缩方式 | 信息损失 |
|------|------|---------|---------|---------|
| L1 | `c07()` (replacePersistedContent) | 每轮开始 | 替换已持久化内容 | 无损 |
| L2 | `fd()` (microcompactMessages) | 每轮开始 | 压缩旧 tool_result | 低 |
| L3 | `y19()` (autoCompactMessages) | token 超阈值 | 模型生成全量摘要 | 中 |

### 阈值计算

L3 AutoCompact 的触发时机由一组精确的阈值计算决定：

```javascript
function ZF(H) {  // effectiveWindow: 可用于消息的有效窗口
    let _ = Math.min(iH_(H), Xn1);  // Xn1 = 20000 (max output token cap)
    let q = CX(H, Hj());            // 总窗口大小（如 200000）
    return q - _;                    // 总窗口 - 输出预留
}

function _eH(H) {  // compactThreshold: 触发 compact 的阈值
    let _ = ZF(H);
    return _ - re6;  // re6 = 13000 (安全余量)
}

function DwH(H, _) {  // checkWaterLevels: 检查水位
    let q = _eH(_);                // compact 阈值
    let Y = ZF(_) - oe6;           // oe6 = 3000 (阻塞偏移)
    return {
        isAboveAutoCompactThreshold: H >= q,   // 是否应该 compact
        isAtBlockingLimit: H >= Y,              // 是否已到阻塞限制
        ...
    };
}
```

### 以 200K 窗口为例的具体阈值

```
总窗口 (context window)     = 200,000 tokens
输出预留 (max output cap)   = min(model_output, 20,000) = 20,000
有效窗口 (effectiveWindow)  = 200,000 - 20,000 = 180,000
安全余量 (re6)              = 13,000
Compact 阈值                = 180,000 - 13,000 = 167,000  ← 超过此值触发 L3
阻塞偏移 (oe6)              = 3,000
阻塞限制                    = 180,000 - 3,000 = 177,000   ← 超过此值拒绝继续

                0                167K        177K    180K
                ├─────────────────┤─────────────┤──────┤
                │  正常工作区     │  Compact    │ 阻塞 │
                │                │  触发区     │      │
```

> **设计决策**：Compact 阈值（167K）和阻塞限制（177K）之间有 10K 的缓冲区。这留给了 Compact 操作本身的执行空间 — Compact 需要调用模型生成摘要，摘要请求本身也需要 token 预算。如果阈值和限制之间没有缓冲，可能出现"需要 compact 但已经没有空间执行 compact"的死锁。

### Compact 执行 — `ShH()` (executeCompact)

当 token 水位超过 compact 阈值时，`ShH()` 执行实际的压缩操作：

```
ShH() 执行流程
    │
    ├── 1. 执行 PreCompact Hook（可选）
    │       → 允许外部系统在压缩前做准备
    │
    ├── 2. 构造摘要请求
    │       → 使用结构化摘要模板
    │       → 包含 9 段提示（保留文件路径、保留关键决策...）
    │
    ├── 3. 调用模型生成摘要
    │       → 支持重试（模型可能超时）
    │       → max_output = 20K tokens
    │
    ├── 4. 构建压缩后消息列表
    │       → [摘要消息] + [最近 N 轮消息]
    │
    └── 5. 执行 PostCompact Hook（可选）
```

### Reactive Compact — 被动压缩

除了主动的阈值触发外，还有一种被动触发机制：当 API 返回 `prompt_too_long` 错误时，说明本地的 token 估算偏低了。此时触发 **Reactive Compact**：

```javascript
// prompt_too_long 错误处理
if (!Y.hasAttemptedReactiveCompact) {
    Y.hasAttemptedReactiveCompact = true;  // 只尝试一次
    // 强制执行 compact，然后重试 API 调用
}
```

`hasAttemptedReactiveCompact` 布尔值确保 reactive compact 只执行一次。如果 compact 后仍然报错，说明问题不在于消息大小，继续重试没有意义。

### `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 的 Prompt Cache 分割

System Prompt 中嵌入了一个特殊标记：

```
[静态内容 - Agent 身份、规则、行为指令]
__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__
[动态内容 - 环境变量、工具定义、MCP 状态]
```

标记**之前**的内容是静态的，可以被 API 的 Prompt Cache 缓存（organization 级别共享）。标记**之后**的内容每轮可能变化，不缓存。这在 compact 时尤其重要 — compact 只改变消息列表，不改变 System Prompt 的静态部分，因此 Prompt Cache 得以保持有效。

**小结**：三级上下文管理是 CC 的核心竞争力之一。L1 无损替换 → L2 选择性压缩 → L3 全量摘要，形成了从"零损失"到"有损但保留关键信息"的渐进降级。阈值计算中的安全余量（13K）和缓冲区设计（compact 阈值到阻塞限制之间的 10K 空间）体现了"宁可多 compact 一次也不要 overflow"的保守策略。

---

## 4.7 流式工具执行器 — `mH_` (StreamingToolExecutor)

在传统的 Agentic Loop 中，工具执行发生在 API 响应**完全接收之后**。但 CC 的流式设计允许**边接收边执行** — 第一个 `tool_use` block 完成时，模型可能还在生成第二个 block，此时第一个工具已经开始执行了。

`mH_` (StreamingToolExecutor) 就是实现这种流水线并行的核心类。

### 类设计

```javascript
class mH_ {
    toolDefinitions;          // 所有工具的定义
    canUseTool;               // 权限检查函数
    tools = [];               // 工具执行队列
    toolUseContext;           // 工具上下文
    hasErrored = false;       // 是否出错
    discarded = false;        // 是否被丢弃（用户中断等）
    siblingAbortController;   // 兄弟工具取消控制器

    constructor(H, _, q) {
        this.toolDefinitions = H;
        this.canUseTool = _;
        this.toolUseContext = q;
        // 创建专门的 AbortController，用于取消同级工具
        this.siblingAbortController = HC(q.abortController);
    }
}
```

`siblingAbortController` 是一个关键设计 — 当一个工具执行失败时，可以通过它取消同级别的其他工具，避免在错误状态下继续执行。

### addTool() — 入队

每当 SSE 流处理完一个 `content_block_stop` 事件（一个完整的 `tool_use` block），就调用 `addTool()` 将其加入执行队列：

```javascript
addTool(H, _) {
    // 查找工具定义
    let q = B$(this.toolDefinitions, H.name);
    // 检查并发安全性
    let K = q?.isConcurrencySafe($.data);

    this.tools.push({
        id: H.id,
        block: H,              // tool_use block（含 name + input）
        assistantMessage: _,   // 所属 assistant 消息
        status: "queued",      // 初始状态
        isConcurrencySafe: K,  // 是否可以并行执行
        pendingProgress: []    // 执行进度
    });

    this.processQueue();  // 立即尝试执行
}
```

注意最后的 `this.processQueue()` — 入队后**立即**尝试处理队列，实现了"收到就执行"的流水线效果。

### canExecuteTool() — 并发控制

不是所有工具都可以同时执行。写入工具（Edit、Write、NotebookEdit）必须串行，只读工具（Read、Grep、Glob）可以并行：

```javascript
canExecuteTool(H) {  // H: 当前工具是否并发安全
    let _ = this.tools.filter(q => q.status === "executing");
    // 没有正在执行的工具 → 可以执行
    // 或者：当前工具并发安全 AND 所有执行中的工具也并发安全 → 可以并行
    return _.length === 0 || H && _.every(q => q.isConcurrencySafe);
}
```

这实现了一个**读者-写者锁**的语义：

```
多个 Read 可以并行：  Read ──┬── Read ──┬── Read
                            │          │
一个 Edit 必须独占：        Edit ─────────────
                                              │
Edit 后可以并行 Read：                     Read ──┬── Read
```

### processQueue() — 队列处理

```javascript
async processQueue() {
    for (let H of this.tools) {
        if (H.status !== "queued") continue;          // 跳过非排队状态
        if (this.canExecuteTool(H.isConcurrencySafe)) {
            await this.executeTool(H);                // 可以执行 → 执行
        } else if (!H.isConcurrencySafe) {
            break;  // 遇到不可并行的工具 → 停止处理（等前面的完成）
        }
    }
}
```

> **设计决策**：遇到不可并行的工具时 `break` 而非 `continue`。这保证了工具的**执行顺序**与模型输出顺序一致。如果用 `continue`，可能会跳过一个 Edit 去执行后面的 Read，但这个 Read 可能依赖 Edit 的结果。

### 与传统分发 `xh_()` 的选择逻辑

CC 并不总是使用流式执行器。选择逻辑大致是：

```
是否启用流式工具执行？
├── 是 → 使用 mH_ (StreamingToolExecutor)
│        API 响应过程中就开始执行工具
│        工具结果通过 getRemainingResults() 收集
│
└── 否 → 使用 xh_ (传统分发)
          等 API 响应完全接收后，一次性分发所有工具
          按并发安全分组执行
```

流式执行的优势在于**时间重叠**：

```
传统方式:
  [===== API 响应 =====] [=== 工具 1 ===] [=== 工具 2 ===]
  总时间 = API + 工具1 + 工具2

流式方式:
  [===== API 响应 =====]
       [=== 工具 1 ===]
                [=== 工具 2 ===]
  总时间 = API + 工具2（工具1 与 API 重叠）
```

**小结**：`mH_` 通过"收到即入队，入队即处理"的设计，实现了模型生成和工具执行的流水线并行。`canExecuteTool()` 的读者-写者锁语义保证了写入工具的串行安全，同时允许只读工具充分并行。`siblingAbortController` 提供了错误时的全局取消能力。

---

## 4.8 辅助机制

除了核心的循环 → 调用 → 执行 → 压缩链路，Agentic Loop 还依赖一系列辅助机制来提升性能、可测试性和用户体验。

### 预取 — `E19()` (prefetchDirectoryContent)

工具执行时经常需要读取目录结构或 Memory 内容。如果等到工具执行时才去读取，会增加延迟。`E19()` 在后台异步预取这些内容：

```
工具执行开始
    │
    ├── 异步启动 E19() 预取
    │     ├── 读取项目目录结构
    │     └── 读取 Memory/规则文件
    │
    ├── 工具执行进行中...
    │
    └── 工具执行完成 → 消费预取结果
```

预取的关键是**不阻塞主循环** — 如果预取还没完成，工具执行会等待；如果预取已完成，工具可以立即使用缓存结果。

类似地，`he6()` (skillDiscoveryPrefetch) 异步预取 Skill 发现数据，在后续需要时直接使用。

### 模型回退

当主模型出现异常（如 rate limit、服务中断）时，CC 可以自动切换到备用模型：

```
主模型 (RTH) 调用失败
    │
    ├── 是否配置了 fallback model?
    │     ├── 是 → 切换到 fallback model → continue（回到 Phase 1）
    │     └── 否 → 抛出错误
    │
    └── fallback 也失败 → 抛出错误
```

模型回退通过重新设置 `Y` 状态中的模型参数并 `continue` 实现，复用了状态机的"重入"能力。

### Agent Summary — `KaH()` (agentSummary)

长时间运行的 Agent 需要给用户一些进度反馈。`KaH()` 在后台以 30 秒为间隔，fork 出一个轻量级对话，调用模型生成 3-5 个词的进度描述：

```
主循环运行中...
    │ (30s 后)
    ├── KaH() 后台 fork
    │     ├── 将当前消息列表传入
    │     └── 调用模型："Summarize current progress in 3-5 words"
    │           → "Refactoring UserService tests"
    │
    │ (又 30s 后)
    ├── KaH() 再次 fork
    │     → "Fixing test assertions"
    │
    └── 主循环继续...
```

这些摘要显示在 UI 的 spinner 区域，让用户知道 Agent 在做什么，而不需要阅读冗长的日志。

### 消息规范化 — `UM()` (normalizeMessages)

CC 内部使用的消息格式与 Claude API 要求的格式有差异。`UM()` 负责在调用 API 前进行格式转换：

```
内部格式                           API 格式
├── progress 消息    ─→  过滤掉    ├── (不发送)
├── system 消息      ─→  过滤掉    ├── (不发送)
├── user, user       ─→  合并      ├── user (合并后)
├── assistant        ─→  保留      ├── assistant
│   (含 thinking)    ─→  分割      ├── assistant (thinking)
│                                  └── assistant (text)
└── user(tool_result) ─→ 保留      └── user (tool_result)
```

关键规则：
- **过滤** `progress` 和 `system` 类型 — 这些是 UI 专用，不需要发送给模型
- **合并相邻 user** — API 要求 user/assistant 严格交替
- **分割含 thinking 的 assistant** — thinking block 和 text block 可能需要分开处理

### 依赖注入 — `N19()` (createDependencies)

主循环的核心操作通过依赖注入提供，而非硬编码：

```javascript
function N19() {
    return {
        callModel: kyH,       // API 调用函数
        microcompact: fd,     // L2 微压缩函数
        autocompact: y19,     // L3 自动压缩函数
        uuid: v19.randomUUID  // UUID 生成函数
    };
}
```

这带来了两个重要好处：

1. **可测试性** — 测试时可以注入 mock 函数，不需要真正调用 API
2. **VCR 模式** — `TH8()` (vcrWrapper) 和 `bc_()` (vcrRecord) 可以录制 API 响应到文件，后续回放。开发时只需要录制一次，之后的测试都不需要网络

```
正常模式:  xi1 → N19().callModel → kyH → HTTP → Claude API
VCR 录制:  xi1 → N19().callModel → kyH → TH8 → HTTP → Claude API
                                                  └→ bc_ 保存响应到文件
VCR 回放:  xi1 → mock_callModel → 从文件读取 → 返回录制的响应
```

**小结**：辅助机制虽然不是主循环的核心路径，但对生产体验至关重要。异步预取减少了延迟，模型回退增强了可靠性，Agent Summary 提供了用户反馈，消息规范化确保了 API 兼容性，依赖注入保障了可测试性。这些"配角"让主循环的"主角"能够专注于核心逻辑。

---

## 4.9 设计启示：生产级 Agentic Loop 的工程智慧

从 Claude Code 的 Agentic Loop 实现中，可以提炼出以下可迁移到自建 Agent 的工程经验：

### 1. 状态机而非递归 — 避免栈溢出 + 支持 continue 重入

`while(true)` + 状态覆盖是 Agentic Loop 的最佳实现模式。递归在逻辑上等价，但存在栈溢出风险，且无法从循环中间位置重新进入（max_tokens 恢复、Stop Hook 重入都需要这个能力）。

**可迁移经验**：任何需要"可能运行数百轮"的循环，都应该用状态覆盖而非递归。状态对象集中管理比散落的闭包变量更易于调试和序列化。

### 2. 分层上下文管理 — 渐进式降级

三级压缩策略的精髓在于**渐进** — L1 无损 → L2 有选择 → L3 全量摘要。不会在一开始就做最激进的压缩，而是根据实际需要逐步升级。

```
消息列表大小  →  0     50K    100K   167K   177K   180K
                 │      │      │      │      │      │
执行策略       正常    L1     L1+L2   L3     阻塞    溢出
```

**可迁移经验**：上下文管理不应该是"全有或全无"。分层策略让系统在大多数时候保持最大信息保真度，只在必要时做有损压缩。阈值中预留的安全余量（13K）和缓冲区（10K）是防止"来不及 compact 就 overflow"的关键。

### 3. 流式工具执行 — 模型生成和工具执行时间重叠

`mH_` (StreamingToolExecutor) 实现的流水线并行，把串行的"生成 → 执行"变成了并行的"生成 + 执行"。当模型调用 3 个工具时，第一个工具可能在模型还在生成第三个工具参数时就已经完成了。

**可迁移经验**：`async generator` + `yield` 是实现流式处理的优雅方案。每完成一个 content block 就 yield，下游可以立即开始处理。`isConcurrencySafe` 标记实现了简洁的读者-写者锁。

### 4. 多层容错矩阵

CC 为 8 种故障场景设计了各自的恢复策略，而不是用一个通用的 try-catch 处理所有错误：

| 故障类型 | 恢复策略 | 设计理念 |
|---------|---------|---------|
| 可恢复截断 | 注入恢复提示 + 有限重试 | 自动恢复但设上限 |
| 流式错误 | 降级到非流式 | 功能降级但不中断 |
| 模型过载 | 指数退避重试 | 给服务端恢复时间 |
| 上下文超限 | Reactive Compact | 被动压缩 + 重试一次 |
| 用户中断 | 全链路取消 | 尊重用户意图 |

**可迁移经验**：针对不同故障设计不同的恢复策略。通用的 "retry 3 times" 对某些故障是浪费（image error 重试没用），对另一些故障是不够（上下文超限需要 compact 而非简单重试）。

### 5. 依赖注入 — 可测试性

通过 `N19()` (createDependencies) 注入 `callModel`、`microcompact`、`autocompact` 等核心依赖，使得主循环可以在不调用真实 API 的情况下进行完整测试。VCR 模式（录制 → 回放）进一步降低了测试成本。

**可迁移经验**：Agentic Loop 的核心逻辑（状态转换、终止判断、工具分发）应该与 I/O 操作（API 调用、文件读写）解耦。依赖注入是最简单有效的解耦方式。

### 6. async generator = 流式进度的优雅解法

整个调用链 `av()` → `zC()` → `xi1()` → `kyH()` → `Ly9()` 都是 `async function*`。中间结果通过 `yield` 逐层传递，不需要 callback 或 event emitter。这让代码保持了线性可读性，同时支持全链路流式。

**可迁移经验**：如果你的系统需要"做一些事 → 返回中间结果 → 继续做 → 再返回"，`async generator` 比 callback/event 更自然。它保持了调用栈上下文，不需要手动管理状态。

---

## 速查表

### 关键常量

| 常量 | 混淆名 | 值 | 含义 |
|------|--------|-----|------|
| max_tokens 恢复上限 | `ui1` | 3 | max_tokens 截断后最多恢复 3 次 |
| 安全余量 | `re6` | 13,000 | compact 阈值预留的 token 余量 |
| 阻塞偏移 | `oe6` | 3,000 | 阻塞限制相对有效窗口的偏移 |
| 输出 token 上限 | `Xn1` | 20,000 | 单次响应最大输出 token 数 |
| SSE 空闲超时 | - | 90,000ms | 流式看门狗超时时间 |
| SSE 警告阈值 | - | 45,000ms | 流式看门狗警告时间（超时/2） |
| 200K 有效窗口 | - | 180,000 | 200K 模型的有效消息窗口 |
| 200K compact 阈值 | - | 167,000 | 200K 模型触发 AutoCompact 的阈值 |
| 200K 阻塞限制 | - | 177,000 | 200K 模型的阻塞限制 |
| Agent Summary 间隔 | - | 30s | 后台进度摘要生成间隔 |

### 关键函数索引

| 混淆名 | 推测英文名 | 位置 | 功能 |
|--------|-----------|------|------|
| `av()` | agentExecute | 13_ui_rendering.js:65174 | Agent 执行入口，初始化所有上下文 |
| `zC()` | agentLoop | 13_ui_rendering.js (av 内) | 注入 UserContext 后调用主循环 |
| `xi1()` | mainLoop | 14_html_parser.js:26373 | 主循环状态机，6-Phase 迭代 |
| `lB1()` | buildSystemPrompt | 13_ui_rendering.js:65445 | 构建 System Prompt |
| `fc_()` | injectUserContext | 17_system_prompt_full.js:3855 | 将 CLAUDE.md 包装为 system-reminder 注入 |
| `kyH()` | callModel | (依赖注入) | 调用 Claude API |
| `TH8()` | vcrWrapper | (API 层) | VCR 录制/回放包装器 |
| `Ly9()` | processSSEStream | 17_system_prompt_full.js:4795 | SSE 流事件处理 |
| `Gy9()` | nonStreamingFallback | 17_system_prompt_full.js:5031 | 非流式降级回退 |
| `OH()` | buildRequestParams | (API 层) | 组装 API 请求参数 |
| `c07()` | replacePersistedContent | (上下文管理) | L1: 替换已持久化的 tool_result |
| `fd()` | microcompactMessages | (上下文管理) | L2: 压缩旧 tool_result 文本 |
| `y19()` | autoCompactMessages | (上下文管理) | L3: 调用模型生成全量摘要 |
| `ZF()` | effectiveWindow | (阈值计算) | 计算可用于消息的有效窗口 |
| `_eH()` | compactThreshold | (阈值计算) | 计算触发 compact 的阈值 |
| `DwH()` | checkWaterLevels | (阈值计算) | 检查 token 水位（compact / 阻塞） |
| `ShH()` | executeCompact | (上下文管理) | 执行 compact（Hook + 摘要 + 构建消息） |
| `mH_` | StreamingToolExecutor | (工具执行) | 流式工具执行器类 |
| `xh_()` | dispatchTools | (工具执行) | 传统工具分发器 |
| `W19()` | checkStopHook | (终止控制) | 执行 Stop Hook 检查 |
| `S19()` | isMaxTokens | (终止控制) | 检查是否 max_tokens 截断 |
| `UM()` | normalizeMessages | (消息处理) | 内部消息格式 → API 消息格式 |
| `N19()` | createDependencies | (依赖注入) | 创建主循环依赖（callModel/compact/uuid） |
| `E19()` | prefetchDirectoryContent | (预取) | 异步预取目录结构和 Memory |
| `he6()` | skillDiscoveryPrefetch | (预取) | 异步预取 Skill 发现数据 |
| `KaH()` | agentSummary | (用户体验) | 后台 30s 间隔生成进度摘要 |
| `LvH()` | resolveModel | (初始化) | 确定使用的模型（多源优先级） |
| `Yz()` | loadUserContext | (初始化) | 加载 CLAUDE.md 用户上下文 |
| `iA()` | loadSystemContext | (初始化) | 加载 git status 系统上下文 |
| `CeH()` | createToolUseContext | (初始化) | 创建工具使用上下文 |
| `bc_()` | vcrRecord | (可测试性) | VCR 模式：录制 API 响应到文件 |
