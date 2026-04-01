
# 第 22 章：终端交互增强 — 快捷键、Vim 与语音

> **核心问题**：一个运行在终端中的 AI Agent 如何提供接近原生编辑器的交互体验？Claude Code 如何实现可配置的快捷键系统、完整的 Vim 模式和语音输入？

终端应用的交互手段天然受限 —— 没有鼠标悬停、没有右键菜单、没有多点触控。用户与 Agent 之间的所有交互，最终都归结为键盘输入。Claude Code 在这个约束下构建了三套互补的交互增强系统：一套支持 18 种上下文、Chord 多键序列和用户自定义的快捷键引擎；一套实现了 Motion/Operator/TextObject 三层组合模型的 Vim 模式；以及一套基于 Push-to-Talk 和 Anthropic OAuth 的语音输入系统。

本章将从源码层面完整解析这三套系统的架构与实现。

---

## 22.1 概述：终端交互的三大增强维度

在深入每个子系统之前，先看它们如何协同工作：

```
┌─────────────────────────────────────────────────────────┐
│                    终端 stdin                            │
│              (原始键盘事件 / ANSI 序列)                   │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│  Ink useInput (事件分发)                                  │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ ChordInterceptor — 最先注册，拦截 Chord 序列         │ │
│  └─────────────────────────┬───────────────────────────┘ │
│                            │ stopImmediatePropagation    │
│  ┌─────────────────────────┼───────────────────────────┐ │
│  │  快捷键系统              │  Vim 模式      语音模式    │ │
│  │  (Keybinding           │  (useVimInput) (useVoice)  │ │
│  │   Resolver)            │                            │ │
│  │  ┌──────────┐          │  ┌──────────┐ ┌─────────┐ │ │
│  │  │ 18 种    │          │  │ INSERT/  │ │ Hold-to │ │ │
│  │  │ Context  │◄─────────┤  │ NORMAL   │ │ -Talk   │ │ │
│  │  │ 解析器   │          │  │ 状态机   │ │ Space键 │ │ │
│  │  └──────────┘          │  └──────────┘ └─────────┘ │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │ Action 分发     │
              │ app:toggleTodos │
              │ chat:submit     │
              │ vim:motion      │
              │ voice:pushToTalk│
              └─────────────────┘
```

三大系统各自独立但互不冲突：

| 维度 | 快捷键系统 | Vim 模式 | 语音模式 |
|------|-----------|---------|---------|
| **定位** | 全局导航与操作 | 文本编辑增强 | 输入方式替代 |
| **核心文件** | `src/keybindings/` (16 文件) | `src/vim/` (5 文件) | `src/voice/`, `src/hooks/useVoice.ts` |
| **状态复杂度** | Chord 待定序列 | 11 种 CommandState | 录音/转写/空闲 |
| **可配置性** | `~/.claude/keybindings.json` | `/vim` 开关 | `/voice` + `/config` |
| **平台差异** | Windows vs macOS 键位映射 | 无 | macOS/Linux/Windows 录音后端 |

---

## 22.2 快捷键系统架构

整个快捷键系统的数据流可以表示为一条清晰的管线：

```
keybindings.json        defaultBindings.ts
      │                        │
      ▼                        ▼
 loadUserBindings ─────► parseBindings()
      │                        │
      │    合并 (user 覆盖 default)
      ▼                        │
 ParsedBinding[]  ◄────────────┘
      │
      ├──► validate() ──► KeybindingWarning[]
      │
      ▼
 KeybindingProvider (React Context)
      │
      ├──► resolveKeyWithChordState()  ← 每次按键
      │         │
      │         ├── match    → 触发 Action
      │         ├── chord_started → 等待后续按键
      │         ├── chord_cancelled → 清除状态
      │         ├── unbound  → 吞掉按键
      │         └── none     → 继续传播
      │
      └──► getBindingDisplayText()  ← UI 显示快捷键
```

### 22.2.1 数据模型：从字符串到结构化表示

快捷键的核心数据结构定义在 `types.ts` 中，但理解它们的最佳方式是看解析过程。用户或默认配置中的快捷键字符串（如 `"ctrl+x ctrl+k"`）经过两层解析：

**第一层：Keystroke 解析**（`parser.ts`）

```typescript
// 将 "ctrl+shift+k" 解析为结构化对象
export function parseKeystroke(input: string): ParsedKeystroke {
  const parts = input.split('+')
  const keystroke: ParsedKeystroke = {
    key: '', ctrl: false, alt: false,
    shift: false, meta: false, super: false,
  }
  for (const part of parts) {
    const lower = part.toLowerCase()
    switch (lower) {
      case 'ctrl': case 'control':
        keystroke.ctrl = true; break
      case 'alt': case 'opt': case 'option':
        keystroke.alt = true; break
      case 'cmd': case 'command': case 'super': case 'win':
        keystroke.super = true; break
      // ...
      default:
        keystroke.key = lower; break
    }
  }
  return keystroke
}
```

注意修饰键的别名处理 —— `ctrl`/`control`、`alt`/`opt`/`option`、`cmd`/`command`/`super`/`win` 都映射到同一个内部标志。这确保了跨平台的一致性：macOS 用户写 `cmd+c`，Linux 用户写 `super+c`，解析结果相同。

**第二层：Chord 解析**

```typescript
// 将 "ctrl+x ctrl+k" 解析为两个 Keystroke 的序列
export function parseChord(input: string): Chord {
  if (input === ' ') return [parseKeystroke('space')]  // 特殊处理空格键
  return input.trim().split(/\s+/).map(parseKeystroke)
}
```

Chord 支持让 Claude Code 可以定义类 VS Code 的多步快捷键：`ctrl+x ctrl+k` 表示先按 `ctrl+x`，再按 `ctrl+k`。空格字符串 `' '` 需要特殊处理，因为 `split(/\s+/)` 会把它拆成空数组。

> **设计决策**：Chord 使用空格作为步骤分隔符（`"ctrl+x ctrl+k"`），而非 `→` 或其他符号。这与 VS Code 的约定一致，降低了用户的认知负担。但它引入了"空格键作为绑定"的边界情况 —— 代码用 `if (input === ' ')` 前置检查来解决。

### 22.2.2 18 种上下文：分层的按键语义

Claude Code 定义了 18 种快捷键上下文（`schema.ts`），每种上下文对应一个 UI 状态：

```typescript
export const KEYBINDING_CONTEXTS = [
  'Global',           // 全局生效，无论焦点在哪里
  'Chat',             // 聊天输入框获焦时
  'Autocomplete',     // 自动补全菜单可见时
  'Settings',         // 设置面板打开时
  'Confirmation',     // 权限/确认对话框显示时
  'Tabs',             // Tab 导航激活时
  'Transcript',       // 查看对话转录时
  'HistorySearch',    // ctrl+r 搜索历史时
  'Task',             // 前台任务运行中
  'ThemePicker',      // 主题选择器打开时
  'Help',             // 帮助浮层打开时
  'Attachments',      // 附件导航模式
  'Footer',           // 页脚指示器获焦时
  'MessageSelector',  // 消息回退选择器
  'DiffDialog',       // Diff 对话框
  'ModelPicker',      // 模型选择器
  'Select',           // 通用列表组件
  'Plugin',           // 插件对话框
] as const
```

相同的按键在不同上下文中触发不同行为：

| 按键 | Global 上下文 | Chat 上下文 | Settings 上下文 | Autocomplete |
|------|--------------|------------|----------------|-------------|
| `enter` | — | `chat:submit` | `settings:close` | — |
| `escape` | — | `chat:cancel` | `confirm:no` | `autocomplete:dismiss` |
| `up` | — | `history:previous` | `select:previous` | `autocomplete:previous` |
| `j` | — | — | `select:next` | — |
| `ctrl+t` | `app:toggleTodos` | — | — | — |

上下文的激活通过 React 生命周期管理。每个需要特定上下文的组件在挂载时注册、卸载时注销：

```tsx
// KeybindingContext.tsx — 组件挂载时自动激活上下文
export function useRegisterKeybindingContext(
  context: KeybindingContextName,
  isActive: boolean = true,
): void {
  const keybindingContext = useOptionalKeybindingContext()
  useLayoutEffect(() => {
    if (!keybindingContext || !isActive) return
    keybindingContext.registerActiveContext(context)
    return () => {
      keybindingContext.unregisterActiveContext(context)
    }
  }, [context, keybindingContext, isActive])
}
```

> **设计决策**：使用 `useLayoutEffect`（而非 `useEffect`）注册上下文。这确保了在首次渲染周期内，上下文已经激活。如果使用 `useEffect`，在 React 渲染和 Effect 执行之间的间隙按下快捷键，可能会因上下文尚未激活而丢失事件。

### 22.2.3 解析器：last-wins 策略与 Chord 状态机

快捷键解析是整个系统的核心，实现在 `resolver.ts` 中。它需要处理两个维度的复杂性：多上下文优先级和 Chord 多步序列。

**单步解析（无 Chord）**：

```typescript
export function resolveKey(
  input: string, key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
): ResolveResult {
  let match: ParsedBinding | undefined
  const ctxSet = new Set(activeContexts)

  for (const binding of bindings) {
    if (binding.chord.length !== 1) continue
    if (!ctxSet.has(binding.context)) continue
    if (matchesBinding(input, key, binding)) {
      match = binding  // last-wins: 后面的绑定覆盖前面的
    }
  }
  // ...
}
```

关键的 **last-wins** 策略：遍历所有绑定时不在找到第一个匹配就停止，而是让后面的匹配覆盖前面的。这使得用户自定义绑定（追加在默认绑定之后）自然地覆盖默认值。

**Chord 状态机（多步序列）**：

```typescript
export function resolveKeyWithChordState(
  input: string, key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
  pending: ParsedKeystroke[] | null,  // 当前待定的 Chord 前缀
): ChordResolveResult {
  // 1. Escape 取消 Chord
  if (key.escape && pending !== null) {
    return { type: 'chord_cancelled' }
  }

  // 2. 构建完整的测试序列
  const testChord = pending
    ? [...pending, currentKeystroke]
    : [currentKeystroke]

  // 3. 检查是否可能是更长 Chord 的前缀
  // （关键：null-override 的 Chord 不阻塞前缀匹配）
  const chordWinners = new Map<string, string | null>()
  for (const binding of contextBindings) {
    if (binding.chord.length > testChord.length &&
        chordPrefixMatches(testChord, binding)) {
      chordWinners.set(chordToString(binding.chord), binding.action)
    }
  }
  // 只有非 null action 才算"有更长的 Chord"
  let hasLongerChords = false
  for (const action of chordWinners.values()) {
    if (action !== null) { hasLongerChords = true; break }
  }

  // 4. 如果可能是更长 Chord 的开始，进入等待
  if (hasLongerChords) {
    return { type: 'chord_started', pending: testChord }
  }

  // 5. 检查精确匹配
  // 6. 无匹配时取消 Chord
}
```

Chord 状态机有一个精妙的细节：**null-unbinding 感知**。当用户将 `ctrl+x ctrl+k` 解绑（设为 `null`），按下 `ctrl+x` 时不应再进入 Chord 等待状态，否则单键绑定 `ctrl+x` 永远无法触发。代码通过 `chordWinners` Map 跟踪每个 Chord 的最终 action，只有存在非 null action 的更长 Chord 时才进入等待。

Chord 超时设置为 **1000ms**（`KeybindingProviderSetup.tsx`）：

```typescript
const CHORD_TIMEOUT_MS = 1000
```

如果用户按下 `ctrl+x` 后 1 秒内没有按第二个键，Chord 自动取消。

### 22.2.4 ChordInterceptor：事件拦截器

`ChordInterceptor` 是整个快捷键系统的"守门人"。它作为 `KeybindingProvider` 的第一个子组件，比所有其他 `useInput` 注册更早，确保它能在其他处理器之前拦截按键：

```tsx
// KeybindingProviderSetup.tsx
return (
  <KeybindingProvider ...>
    <ChordInterceptor ... />  {/* 最先注册，最先处理 */}
    {children}                 {/* 其他组件的 useInput 后注册 */}
  </KeybindingProvider>
)
```

当 Chord 正在进行时，`ChordInterceptor` 通过 `event.stopImmediatePropagation()` 阻止按键传播到 `PromptInput` 等组件 —— 否则 `ctrl+x ctrl+k` 的第二步 `ctrl+k` 会被输入框捕获。

### 22.2.5 平台自适应

`defaultBindings.ts` 在模块加载时检测平台，动态调整默认绑定：

```typescript
// 图片粘贴：Windows 上 ctrl+v 是系统粘贴，改用 alt+v
const IMAGE_PASTE_KEY = getPlatform() === 'windows' ? 'alt+v' : 'ctrl+v'

// 模式切换：Windows Terminal 不支持 VT 模式时 shift+tab 不可靠
const SUPPORTS_TERMINAL_VT_MODE =
  getPlatform() !== 'windows' ||
  (isRunningWithBun()
    ? satisfies(process.versions.bun, '>=1.2.23')
    : satisfies(process.versions.node, '>=22.17.0 <23.0.0 || >=24.2.0'))

const MODE_CYCLE_KEY = SUPPORTS_TERMINAL_VT_MODE ? 'shift+tab' : 'meta+m'
```

VT 模式的检测尤为精细 —— 它不仅区分 Windows 与其他平台，还检查 Node.js/Bun 的具体版本，因为 VT 模式支持是在特定版本中添加的（Node 24.2.0 / Bun 1.2.23）。

显示层面同样区分平台（`parser.ts`）：

```typescript
export function keystrokeToDisplayString(
  ks: ParsedKeystroke,
  platform: DisplayPlatform = 'linux',
): string {
  const parts: string[] = []
  if (ks.ctrl) parts.push('ctrl')
  if (ks.alt || ks.meta) {
    parts.push(platform === 'macos' ? 'opt' : 'alt')  // macOS 显示 opt
  }
  if (ks.super) {
    parts.push(platform === 'macos' ? 'cmd' : 'super')  // macOS 显示 cmd
  }
  // ...
}
```

### 22.2.6 保留快捷键与验证

`reservedShortcuts.ts` 定义了三类不可覆盖的快捷键：

```typescript
// 1. 硬编码绑定 —— 绝对不可覆盖
export const NON_REBINDABLE: ReservedShortcut[] = [
  { key: 'ctrl+c', reason: 'Cannot be rebound - interrupt/exit (hardcoded)' },
  { key: 'ctrl+d', reason: 'Cannot be rebound - exit (hardcoded)' },
  { key: 'ctrl+m', reason: 'Identical to Enter in terminals (both send CR)' },
]

// 2. 终端保留 —— OS/终端截获，应用收不到
export const TERMINAL_RESERVED: ReservedShortcut[] = [
  { key: 'ctrl+z', reason: 'Unix process suspend (SIGTSTP)' },
  { key: 'ctrl+\\', reason: 'Terminal quit signal (SIGQUIT)' },
]

// 3. macOS 保留 —— 系统级截获
export const MACOS_RESERVED: ReservedShortcut[] = [
  { key: 'cmd+c', reason: 'macOS system copy' },
  { key: 'cmd+v', reason: 'macOS system paste' },
  // ...
]
```

验证系统（`validate.ts`）在加载用户配置时运行完整检查：

- **结构验证**：JSON 格式、必须包含 `context` 和 `bindings` 字段
- **上下文验证**：`context` 必须是 18 个合法值之一
- **Action 验证**：支持 `namespace:action` 格式或 `command:xxx` 调用斜杠命令
- **重复检测**：同一 Context 内的重复绑定（包括 JSON 原始字符串中的重复键）
- **保留键冲突**：用户绑定与保留键的冲突
- **语音绑定安全**：`voice:pushToTalk` 绑定到裸字母键会在录音预热时输入字符

```typescript
// 语音绑定的特殊验证
if (action === 'voice:pushToTalk') {
  const ks = parseChord(key)[0]
  if (ks && !ks.ctrl && !ks.alt && !ks.shift && !ks.meta && !ks.super
      && /^[a-z]$/.test(ks.key)) {
    warnings.push({
      type: 'invalid_action',
      severity: 'warning',
      message: `Binding "${key}" to voice:pushToTalk prints into the input
                during warmup; use space or a modifier combo like meta+k`,
    })
  }
}
```

### 22.2.7 用户自定义：覆盖与热重载

用户配置文件位于 `~/.claude/keybindings.json`，使用 Object Wrapper 格式：

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "$docs": "https://code.claude.com/docs/en/keybindings",
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "ctrl+enter": "chat:submit",
        "enter": "chat:newline",
        "meta+k": "command:compact"
      }
    }
  ]
}
```

`loadUserBindings.ts` 实现了完整的加载和热重载流程：

1. **同步初始加载**：`loadKeybindingsSyncWithWarnings()` 在 React `useState` 初始化器中调用，确保首次渲染即有绑定数据
2. **异步热重载**：`chokidar` 文件监听器检测 `keybindings.json` 的修改/创建/删除
3. **合并策略**：`[...defaultBindings, ...userParsed]` —— 用户绑定追加在默认之后，利用 last-wins 实现覆盖
4. **解绑支持**：将 action 设为 `null` 可以禁用默认绑定

```typescript
// 合并策略：简单追加，last-wins
const mergedBindings = [...defaultBindings, ...userParsed]
```

文件监听使用 `awaitWriteFinish` 确保写入稳定后才重载：

```typescript
watcher = chokidar.watch(userPath, {
  awaitWriteFinish: {
    stabilityThreshold: 500,   // 等待 500ms 写入稳定
    pollInterval: 200,          // 每 200ms 检查一次
  },
})
```

### 22.2.8 React Hooks：useKeybinding 与 useShortcutDisplay

消费端通过两个 Hook 使用快捷键系统：

**useKeybinding** —— 注册单个 Action 的处理器：

```tsx
// 使用示例
useKeybinding('app:toggleTodos', () => {
  setShowTodos(prev => !prev)
}, { context: 'Global' })
```

**useKeybindings** —— 批量注册多个 Action（减少 `useInput` 调用次数）：

```tsx
useKeybindings({
  'chat:submit': () => handleSubmit(),
  'chat:cancel': () => handleCancel(),
  'chat:undo': () => handleUndo(),
}, { context: 'Chat' })
```

处理器返回 `false` 表示"未消费"，事件继续传播；返回 `void` 或 `Promise<void>` 表示已消费，调用 `stopImmediatePropagation()`。这个模式在 `ScrollKeybindingHandler` 中使用 —— 当内容不需要滚动时，滚轮事件应该传播给子组件的列表导航。

**useShortcutDisplay** —— 获取用于 UI 显示的快捷键文本：

```tsx
const expandShortcut = useShortcutDisplay(
  'app:toggleTranscript', 'Global', 'ctrl+o'
)
// 返回用户自定义的绑定，或 'ctrl+o' 作为 fallback
```

`fallback` 参数是迁移期间的安全网。当系统检测到 Action 在绑定表中找不到时，会记录一次 `tengu_keybinding_fallback_used` 遥测事件，帮助团队发现配置问题。

---

## 22.3 Vim 状态机

### 22.3.1 架构概览

Claude Code 的 Vim 模式不是简单的键映射，而是一个完整的 **分层状态机**。`src/vim/` 目录的 5 个文件各自承担一个清晰的职责：

```
src/vim/
├── types.ts        ── 状态定义（类型即文档）
├── motions.ts      ── 纯函数：键 → 光标位置
├── operators.ts    ── 纯函数：操作符 × 范围 → 文本变换
├── textObjects.ts  ── 纯函数：位置 → 文本范围
└── transitions.ts  ── 状态转换表：(State, Input) → (NextState, Effect)
```

以及 `src/hooks/useVimInput.ts` 将这些纯函数组装成 React Hook。

> **设计决策**：Vim 实现刻意将**纯计算**和**副作用**分离。`motions.ts`、`operators.ts`、`textObjects.ts` 都是纯函数，不修改任何状态；`transitions.ts` 返回 `{ next, execute }` 结构而非直接执行；副作用（修改文本、移动光标）集中在 `useVimInput` 的 `OperatorContext` 回调中。这使得核心逻辑可以轻松单元测试。

### 22.3.2 VimState：双模式状态

```typescript
export type VimState =
  | { mode: 'INSERT'; insertedText: string }
  | { mode: 'NORMAL'; command: CommandState }
```

两个模式携带不同的数据：

- **INSERT**：跟踪 `insertedText`（已输入文本），用于 Dot-Repeat（`.` 命令）
- **NORMAL**：跟踪 `CommandState`（正在解析的命令）

### 22.3.3 CommandState：11 种子状态

CommandState 是 NORMAL 模式下的命令解析状态机。源码中的 ASCII 状态图精确描述了转换关系：

```
idle ──┬─[d/c/y]──► operator
       ├─[1-9]────► count
       ├─[fFtT]───► find
       ├─[g]──────► g
       ├─[r]──────► replace
       └─[><]─────► indent

operator ─┬─[motion]──► execute
           ├─[0-9]────► operatorCount
           ├─[ia]─────► operatorTextObj
           └─[fFtT]───► operatorFind
```

TypeScript 的联合类型让每个状态精确描述自己"在等什么"：

```typescript
export type CommandState =
  | { type: 'idle' }
  | { type: 'count'; digits: string }
  | { type: 'operator'; op: Operator; count: number }
  | { type: 'operatorCount'; op: Operator; count: number; digits: string }
  | { type: 'operatorFind'; op: Operator; count: number; find: FindType }
  | { type: 'operatorTextObj'; op: Operator; count: number; scope: TextObjScope }
  | { type: 'find'; find: FindType; count: number }
  | { type: 'g'; count: number }
  | { type: 'operatorG'; op: Operator; count: number }
  | { type: 'replace'; count: number }
  | { type: 'indent'; dir: '>' | '<'; count: number }
```

每个状态都携带足够的上下文信息，使得转换函数可以无歧义地决定下一步。例如 `operatorFind` 状态知道自己需要一个字符来完成 `df<char>` 命令，所以下一个输入直接作为查找字符。

### 22.3.4 Motion/Operator/TextObject 三层组合

Vim 的强大之处在于 **Motion × Operator × TextObject** 的组合爆炸。Claude Code 用三个独立模块实现这一模型：

**Motion（移动命令）** —— `motions.ts`：

```typescript
export function resolveMotion(key: string, cursor: Cursor, count: number): Cursor {
  let result = cursor
  for (let i = 0; i < count; i++) {
    const next = applySingleMotion(key, result)
    if (next.equals(result)) break  // 到达边界时停止
    result = next
  }
  return result
}

function applySingleMotion(key: string, cursor: Cursor): Cursor {
  switch (key) {
    case 'h': return cursor.left()
    case 'l': return cursor.right()
    case 'w': return cursor.nextVimWord()
    case 'b': return cursor.prevVimWord()
    case '$': return cursor.endOfLogicalLine()
    case 'G': return cursor.startOfLastLine()
    // ...
  }
}
```

注意 `count` 的实现 —— 不是简单地将位移乘以 count，而是循环执行单步 Motion，并在到达边界（`next.equals(result)`）时提前退出。这确保了 `999w` 不会跳出文本范围。

**Operator（操作符）** —— `operators.ts`：

Operator 接收一个范围（Motion 或 TextObject 产生），执行对应的文本变换：

```typescript
export function executeOperatorMotion(
  op: Operator, motion: string, count: number, ctx: OperatorContext,
): void {
  const target = resolveMotion(motion, ctx.cursor, count)
  if (target.equals(ctx.cursor)) return

  const range = getOperatorRange(ctx.cursor, target, motion, op, count)
  applyOperator(op, range.from, range.to, ctx, range.linewise)
  ctx.recordChange({ type: 'operator', op, motion, count })  // 记录用于 dot-repeat
}
```

三种 Operator（`delete`/`change`/`yank`）的行为差异集中在 `applyOperator` 中：

```typescript
function applyOperator(op, from, to, ctx, linewise) {
  let content = ctx.text.slice(from, to)
  if (linewise && !content.endsWith('\n')) content += '\n'
  ctx.setRegister(content, linewise)   // 所有 operator 都写入寄存器

  if (op === 'yank') {
    ctx.setOffset(from)                // yank: 只移动光标
  } else if (op === 'delete') {
    const newText = ctx.text.slice(0, from) + ctx.text.slice(to)
    ctx.setText(newText)               // delete: 删除文本
    ctx.setOffset(Math.min(from, maxOff))
  } else if (op === 'change') {
    const newText = ctx.text.slice(0, from) + ctx.text.slice(to)
    ctx.setText(newText)               // change: 删除文本 + 进入 INSERT
    ctx.enterInsert(from)
  }
}
```

> **设计决策**：`cw` 和 `dw` 有不同的语义 —— `dw` 删除到下一个词开头，`cw` 删除到当前词尾。这是 Vim 的传统行为（`:help cw`）。源码在 `getOperatorRange` 中用一个特殊分支处理。

**TextObject（文本对象）** —— `textObjects.ts`：

文本对象返回 `{ start, end }` 范围：

```typescript
export function findTextObject(
  text: string, offset: number, objectType: string, isInner: boolean,
): TextObjectRange {
  if (objectType === 'w') return findWordObject(text, offset, isInner, isVimWordChar)
  if (objectType === 'W') return findWordObject(text, offset, isInner, ch => !isVimWhitespace(ch))

  const pair = PAIRS[objectType]  // '(' → ['(', ')'], '"' → ['"', '"']
  if (pair) {
    const [open, close] = pair
    return open === close
      ? findQuoteObject(text, offset, open, isInner)      // 引号对象
      : findBracketObject(text, offset, open, close, isInner)  // 括号对象
  }
  return null
}
```

支持的 TextObject 类型覆盖了 Vim 的常用子集：

| 类型 | inner 示例 | around 示例 | 说明 |
|------|-----------|------------|------|
| `w` / `W` | `ciw` | `daw` | 单词/WORD |
| `"` / `'` / `` ` `` | `ci"` | `da'` | 引号 |
| `(` / `)` / `b` | `ci(` | `da)` | 圆括号 |
| `[` / `]` | `ci[` | `da]` | 方括号 |
| `{` / `}` / `B` | `ci{` | `da}` | 花括号 |
| `<` / `>` | `ci<` | `da>` | 尖括号 |

### 22.3.5 状态转换表

`transitions.ts` 是状态机的"转换表"，用一个主分发函数将每种状态分派到对应的处理函数：

```typescript
export function transition(
  state: CommandState, input: string, ctx: TransitionContext,
): TransitionResult {
  switch (state.type) {
    case 'idle':         return fromIdle(input, ctx)
    case 'count':        return fromCount(state, input, ctx)
    case 'operator':     return fromOperator(state, input, ctx)
    case 'operatorCount': return fromOperatorCount(state, input, ctx)
    // ... 11 种状态各有处理函数
  }
}
```

`TransitionResult` 只有两个可选字段：

```typescript
export type TransitionResult = {
  next?: CommandState      // 下一个状态（未设置 = 回到 idle）
  execute?: () => void     // 要执行的副作用
}
```

这个设计非常优雅 —— 返回 `{ next }` 表示状态变化无副作用，返回 `{ execute }` 表示执行命令后回到 idle，返回 `{}` 空对象表示未识别的输入被忽略。

`handleNormalInput` 和 `handleOperatorInput` 两个共享函数分别处理"idle/count 状态"和"operator-waiting 状态"下的通用输入，避免代码重复。

### 22.3.6 Dot-Repeat 与寄存器：PersistentState

Vim 的 `.` 命令需要跨命令记忆上一次编辑操作。`PersistentState` 是这个"记忆"：

```typescript
export type PersistentState = {
  lastChange: RecordedChange | null  // 最后一次修改（用于 dot-repeat）
  lastFind: { type: FindType; char: string } | null  // 最后一次 f/F/t/T
  register: string         // 寄存器内容（剪贴板）
  registerIsLinewise: boolean  // 寄存器内容是否是行级
}
```

`RecordedChange` 记录了重放一个命令所需的全部信息：

```typescript
export type RecordedChange =
  | { type: 'insert'; text: string }
  | { type: 'operator'; op: Operator; motion: string; count: number }
  | { type: 'operatorTextObj'; op: Operator; objType: string; scope: TextObjScope; count: number }
  | { type: 'operatorFind'; op: Operator; find: FindType; char: string; count: number }
  | { type: 'replace'; char: string; count: number }
  | { type: 'x'; count: number }
  | { type: 'toggleCase'; count: number }
  | { type: 'indent'; dir: '>' | '<'; count: number }
  | { type: 'openLine'; direction: 'above' | 'below' }
  | { type: 'join'; count: number }
```

Dot-Repeat 的实现在 `useVimInput.ts` 中：

```typescript
function replayLastChange(): void {
  const change = persistentRef.current.lastChange
  if (!change) return

  const cursor = Cursor.fromText(props.value, props.columns, textInput.offset)
  const ctx = createOperatorContext(cursor, true)  // isReplay=true: 不再次记录

  switch (change.type) {
    case 'insert':
      if (change.text) {
        const newCursor = cursor.insert(change.text)
        props.onChange(newCursor.text)
        textInput.setOffset(newCursor.offset)
      }
      break
    case 'operator':
      executeOperatorMotion(change.op, change.motion, change.count, ctx)
      break
    // ... 其他类型
  }
}
```

注意 `createOperatorContext(cursor, true)` 的 `isReplay=true` 参数 —— replay 时 `recordChange` 是空操作，避免 `.` 命令重放时覆盖 `lastChange`。

### 22.3.7 useVimInput：Hook 的组装

`useVimInput` 将 Vim 层叠加在基础文本输入 `useTextInput` 之上：

```typescript
export function useVimInput(props: UseVimInputProps): VimInputState {
  const vimStateRef = React.useRef<VimState>(createInitialVimState())
  const persistentRef = React.useRef<PersistentState>(createInitialPersistentState())
  const textInput = useTextInput({ ...props, inputFilter: undefined })

  // ...

  function handleVimInput(rawInput: string, key: Key): void {
    const state = vimStateRef.current

    // Ctrl 组合键直接传给底层（readline 兼容）
    if (key.ctrl) { textInput.onInput(input, key); return }

    // Escape: INSERT → NORMAL（不可配置，Vim 语义）
    if (key.escape && state.mode === 'INSERT') { switchToNormalMode(); return }

    // Enter: 无论模式都传给底层（允许 NORMAL 模式提交）
    if (key.return) { textInput.onInput(input, key); return }

    if (state.mode === 'INSERT') {
      // 跟踪已输入文本，传给底层
      vimStateRef.current = { mode: 'INSERT', insertedText: state.insertedText + input }
      textInput.onInput(input, key)
      return
    }

    // NORMAL 模式：运行状态转换
    const result = transition(state.command, vimInput, ctx)
    if (result.execute) result.execute()
    // 更新命令状态
    if (vimStateRef.current.mode === 'NORMAL') {
      vimStateRef.current = { mode: 'NORMAL',
        command: result.next ?? (result.execute ? { type: 'idle' } : state.command)
      }
    }
  }

  return { ...textInput, onInput: handleVimInput, mode, setMode }
}
```

关键设计点：

1. **Ctrl 组合键直通**：在 Vim 的 NORMAL 模式下，`ctrl+c`、`ctrl+d` 等系统快捷键不被 Vim 拦截
2. **Enter 直通**：允许在 NORMAL 模式下按 Enter 提交消息
3. **Arrow keys 映射**：在 idle 状态下，方向键传给底层处理历史导航；在其他状态下，映射为 hjkl
4. **inputFilter 策略**：所有模式都运行 filter（保证有状态的 filter 不会因模式切换而"卡住"），但只在 INSERT 模式应用结果

---

## 22.4 语音模式

### 22.4.1 启用条件

语音模式的启用需要通过三重检查（`voiceModeEnabled.ts`）：

```
isVoiceModeEnabled() = hasVoiceAuth() && isVoiceGrowthBookEnabled()

hasVoiceAuth():
  ├── isAnthropicAuthEnabled()  ─── 使用 Anthropic OAuth（非 API Key / Bedrock / Vertex）
  └── getClaudeAIOAuthTokens()  ─── 有有效的 accessToken

isVoiceGrowthBookEnabled():
  └── !tengu_amber_quartz_disabled ─── GrowthBook 紧急开关未触发
```

> **设计决策**：语音模式使用 `claude.ai` 的 `voice_stream` 端点进行 STT（Speech-to-Text），因此必须有 Anthropic OAuth 令牌。API Key、AWS Bedrock、Google Vertex 等其他认证方式不支持语音。这是一个有意的架构约束 —— STT 服务与 Claude API 调用使用不同的端点和认证机制。

### 22.4.2 /voice 命令：预检与开启

`/voice` 命令实现了详尽的预检流程（`commands/voice/voice.ts`）：

```
/voice 执行流程：
  1. isVoiceModeEnabled() — 检查 auth + kill-switch
  2. 如果已开启 → 关闭语音 → 返回
  3. isVoiceStreamAvailable() — 检查 API 可用性
  4. checkVoiceDependencies() — 检查录音工具（SoX / arecord / 原生模块）
  5. requestMicrophonePermission() — 触发 OS 权限对话框
  6. updateSettingsForSource('userSettings', { voiceEnabled: true })
  7. 返回 "Voice mode enabled. Hold Space to record."
```

录音后端根据平台选择（`services/voice.ts`）：

| 平台 | 首选后端 | 备选后端 |
|------|---------|---------|
| macOS | cpal 原生模块 (`audio-capture-napi`) | SoX `rec` |
| Linux | cpal 原生模块 | arecord (ALSA) / SoX |
| Windows | cpal 原生模块 | — |

原生音频模块 `audio-capture-napi` 链接 CoreAudio.framework（macOS），dlopen 是同步阻塞的，首次加载可能需要 1-8 秒。因此采用**懒加载策略** —— 不在启动时预加载，而是在首次按下语音键时加载：

```typescript
let audioNapi: AudioNapi | null = null
let audioNapiPromise: Promise<AudioNapi> | null = null

function loadAudioNapi(): Promise<AudioNapi> {
  audioNapiPromise ??= (async () => {
    const mod = await import('audio-capture-napi')
    mod.isNativeAudioAvailable()  // 触发真正的 dlopen
    audioNapi = mod
    return mod
  })()
  return audioNapiPromise
}
```

### 22.4.3 Push-to-Talk 交互

语音输入使用 Push-to-Talk 模式：按住 Space 录音，松开 Space 提交。`useVoice.ts` Hook 实现了基于键盘自动重复的"松开检测"：

```
按住 Space:
  ┌─────────────────────────────────────────────────────┐
  │ keydown → keydown(repeat) → keydown(repeat) → ...  │
  │            每次重复重置 RELEASE_TIMEOUT_MS 计时器    │
  └─────────────────────────────────────────────────────┘
                                                   │
                                           超时未收到重复
                                                   │
                                                   ▼
                                            判定为"松开"
                                            停止录音 → STT
```

这是终端环境下的巧妙设计 —— 终端没有 `keyup` 事件，但 OS 的键盘自动重复会在按键持续按下时产生连续的 `keydown` 事件。通过监测重复事件的间隔，可以推断用户何时松开了按键。

### 22.4.4 语言配置

STT 支持 20+ 种语言，通过 `/config` 设置 `language` 字段选择。`useVoice.ts` 中的 `normalizeLanguageForSTT` 函数将用户设置的语言映射为 STT 后端支持的 BCP-47 代码：

```typescript
const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  english: 'en',    español: 'es',     français: 'fr',
  japanese: 'ja',   日本語: 'ja',       deutsch: 'de',
  português: 'pt',  italiano: 'it',    한국어: 'ko',
  हिन्दी: 'hi',      русский: 'ru',     polski: 'pl',
  // ... 共 20+ 种映射
}
```

如果用户设置了不支持的语言，系统回退到英语并在启用时提示。

---

## 22.5 命令入口

三个交互增强系统各有一个斜杠命令入口：

### /vim

```typescript
// commands/vim/vim.ts — 极其简洁
export const call: LocalCommandCall = async () => {
  const config = getGlobalConfig()
  let currentMode = config.editorMode || 'normal'
  if (currentMode === 'emacs') currentMode = 'normal'  // 兼容旧值

  const newMode = currentMode === 'normal' ? 'vim' : 'normal'
  saveGlobalConfig(current => ({ ...current, editorMode: newMode }))

  return {
    type: 'text',
    value: `Editor mode set to ${newMode}. ${
      newMode === 'vim'
        ? 'Use Escape key to toggle between INSERT and NORMAL modes.'
        : 'Using standard (readline) keyboard bindings.'
    }`,
  }
}
```

`/vim` 只是一个 toggle —— 在全局配置中切换 `editorMode` 字段。Vim 模式的实际激活由 PromptInput 组件根据 `editorMode` 选择使用 `useTextInput` 还是 `useVimInput`。

### /keybindings

```typescript
// commands/keybindings/keybindings.ts
export async function call() {
  // 1. 检查功能开关
  if (!isKeybindingCustomizationEnabled()) {
    return { type: 'text', value: 'Feature is in preview.' }
  }

  // 2. 使用 'wx' 标志原子创建（避免 TOCTOU 竞争）
  await mkdir(dirname(keybindingsPath), { recursive: true })
  try {
    await writeFile(keybindingsPath, generateKeybindingsTemplate(), {
      encoding: 'utf-8', flag: 'wx',  // exclusive create
    })
  } catch (e) {
    if (getErrnoCode(e) === 'EEXIST') fileExists = true
    else throw e
  }

  // 3. 在外部编辑器中打开
  const result = await editFileInEditor(keybindingsPath)
}
```

`/keybindings` 使用 `wx` 文件标志（exclusive create）来原子地检测和创建文件，避免了先 `stat` 再 `writeFile` 的 TOCTOU（Time-of-check to time-of-use）竞争条件。

### /voice

`/voice` 命令的实现已在 22.4.2 节详述。它是三个命令中最复杂的，因为涉及系统级资源（麦克风权限、音频驱动、网络连接）的多重检查。

---

## 22.6 设计启示

### 启示 1：配置即数据，验证即安全

快捷键系统将"配置"视为需要严格验证的输入数据。从 JSON 解析到保留键检测，每一步都有明确的错误处理和用户提示。这比"静默忽略无效配置"的做法更健壮 —— 用户不会因为一个 typo 而困惑"为什么我的快捷键没生效"。

### 启示 2：类型即文档

Vim 状态机的 `CommandState` 联合类型是"类型即文档"的典范。11 个状态变体，每个携带恰好足够的字段，TypeScript 的穷尽检查确保 `switch` 语句不遗漏任何分支。当你阅读 `{ type: 'operatorFind'; op: Operator; count: number; find: FindType }` 时，你已经知道这个状态在等什么输入。

### 启示 3：纯函数与副作用分离

Vim 实现将 Motion、Operator、TextObject 全部实现为纯函数。所有文本修改、光标移动、模式切换的副作用通过 `OperatorContext` 回调注入。这使得 Vim 核心逻辑可以在不依赖 React 或 DOM 的环境下独立测试。

### 启示 4：平台差异的显式处理

快捷键系统不是简单地"假设所有终端行为一致"，而是显式地检测平台、终端协议支持、运行时版本。`SUPPORTS_TERMINAL_VT_MODE` 的版本检查精确到 Node.js 和 Bun 的具体补丁版本。这种精细的平台适配是 CLI 应用稳定性的关键。

### 启示 5：终端限制的创造性解决

语音模式的 Push-to-Talk 检测是终端限制下的创造性解决方案。没有 `keyup` 事件？利用 OS 键盘自动重复的 `keydown` 连发来推断松开时机。这种 "work with what you have" 的工程思维值得借鉴。

---

## 章末速查表

| 组件 | 源码位置 | 核心职责 |
|------|---------|---------|
| `defaultBindings.ts` | `src/keybindings/` | 定义 18 个上下文的默认快捷键绑定 |
| `parser.ts` | `src/keybindings/` | 字符串 → ParsedKeystroke/Chord |
| `match.ts` | `src/keybindings/` | Ink Key 事件与 ParsedKeystroke 的匹配 |
| `resolver.ts` | `src/keybindings/` | 多上下文 + Chord 状态的解析引擎 |
| `validate.ts` | `src/keybindings/` | 用户配置的完整性验证 |
| `reservedShortcuts.ts` | `src/keybindings/` | 平台相关的保留键定义 |
| `loadUserBindings.ts` | `src/keybindings/` | 用户配置加载 + chokidar 热重载 |
| `KeybindingContext.tsx` | `src/keybindings/` | React Context + Provider |
| `KeybindingProviderSetup.tsx` | `src/keybindings/` | 初始化 + ChordInterceptor |
| `useKeybinding.ts` | `src/keybindings/` | 消费端 Hook（单个/批量） |
| `useShortcutDisplay.ts` | `src/keybindings/` | UI 快捷键文本显示 |
| `shortcutFormat.ts` | `src/keybindings/` | 非 React 上下文的快捷键文本 |
| `template.ts` | `src/keybindings/` | 生成 keybindings.json 模板 |
| `schema.ts` | `src/keybindings/` | Zod Schema + 上下文/Action 枚举 |
| `types.ts` | `src/vim/` | VimState + CommandState + PersistentState |
| `motions.ts` | `src/vim/` | 纯函数：vim motion → 目标位置 |
| `operators.ts` | `src/vim/` | 纯函数：operator × range → 文本变换 |
| `textObjects.ts` | `src/vim/` | 纯函数：cursor → 文本对象范围 |
| `transitions.ts` | `src/vim/` | 状态转换表：(State, Input) → Result |
| `useVimInput.ts` | `src/hooks/` | 组装 Vim 层的 React Hook |
| `voiceModeEnabled.ts` | `src/voice/` | Auth + GrowthBook 三重检查 |
| `useVoice.ts` | `src/hooks/` | Push-to-Talk 录音 + STT Hook |
| `useVoiceEnabled.ts` | `src/hooks/` | React 端的语音启用状态 |
| `/vim` | `src/commands/vim/` | 切换 editor mode |
| `/voice` | `src/commands/voice/` | 预检 + 开关语音模式 |
| `/keybindings` | `src/commands/keybindings/` | 创建/打开自定义配置文件 |

**关键常量**：

| 常量 | 值 | 位置 | 说明 |
|------|---|------|------|
| `CHORD_TIMEOUT_MS` | 1000 | `KeybindingProviderSetup.tsx` | Chord 超时时间 |
| `MAX_VIM_COUNT` | 10000 | `vim/types.ts` | Vim 数字前缀上限 |
| `FILE_STABILITY_THRESHOLD_MS` | 500 | `loadUserBindings.ts` | 热重载文件稳定等待 |
| `KEYBINDING_CONTEXTS` | 18 个 | `schema.ts` | 上下文类型枚举 |
| `KEYBINDING_ACTIONS` | 70+ 个 | `schema.ts` | Action 类型枚举 |
| `NON_REBINDABLE` | 3 个 | `reservedShortcuts.ts` | 不可覆盖的快捷键 |
