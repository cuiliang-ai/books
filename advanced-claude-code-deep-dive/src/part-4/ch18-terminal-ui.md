
# 第 18 章：Terminal UI — 终端渲染引擎

> **核心问题**：如何在纯文本终端中实现一个响应式、高性能的 UI 框架？Claude Code 如何实现流式 Markdown 渲染、虚拟滚动、双缓冲差分更新，以及 60fps 的终端动画？

Claude Code 的 Terminal UI 基于深度定制的 **Ink**（React for CLI）框架，结合自研的布局引擎、Screen 缓冲系统和 ANSI 渲染管线。本章解析这套终端渲染引擎的架构 — 从 React 组件树到终端像素（字符单元格）的完整路径。

---

## 18.1 架构概览

```
┌──────────────────────────────────────────────────────────────┐
│                     React 组件层                               │
│                                                                │
│  App ← FpsMetricsProvider ← StatsProvider ← AppStateProvider  │
│    │                                                           │
│    └── REPL (screens/REPL.tsx)                                │
│          │                                                     │
│          ├── LogoV2              ← 启动画面 + 状态通知          │
│          ├── Messages            ← 消息列表（虚拟滚动）        │
│          │   └── VirtualMessageList  ← 虚拟化容器              │
│          │       └── MessageRow[]    ← 单条消息                │
│          │           ├── Message     ← 消息内容                │
│          │           │   └── Markdown ← Markdown 渲染         │
│          │           └── MessageModel ← 模型标记               │
│          ├── PromptInput         ← 输入框                     │
│          ├── PermissionRequest   ← 权限确认                   │
│          └── SpinnerWithVerb     ← 加载动画                   │
│                                                                │
│  组件输出: React Element Tree                                  │
└───────────────────────────┬────────────────────────────────────┘
                            │
                   react-reconciler
                            │
┌───────────────────────────▼────────────────────────────────────┐
│                     Ink 渲染引擎                                │
│                                                                │
│  ┌────────────────┐   ┌─────────────┐   ┌───────────────────┐ │
│  │ DOM 抽象层     │   │ Yoga 布局   │   │ Reconciler        │ │
│  │ dom.ts         │   │ layout/     │   │ reconciler.ts     │ │
│  │ DOMElement     │   │ yoga.ts     │   │ react-reconciler  │ │
│  │ TextNode       │   │ Flexbox     │   │ createNode/setText│ │
│  └────────┬───────┘   └──────┬──────┘   └───────────────────┘ │
│           │                  │                                 │
│  ┌────────▼──────────────────▼──────────────────────────────┐ │
│  │                   Renderer Pipeline                       │ │
│  │                                                           │ │
│  │  render-node-to-output.ts → Output → Screen              │ │
│  │       (树遍历)         (操作收集)  (字符缓冲)              │ │
│  │                                                           │ │
│  │  Screen (双缓冲):                                         │ │
│  │  ┌─────────┐    ┌─────────┐                               │ │
│  │  │ Front   │    │ Back    │    diff → ANSI escape codes  │ │
│  │  │ Buffer  │◄───│ Buffer  │ ─────────────────► stdout    │ │
│  │  └─────────┘    └─────────┘                               │ │
│  └───────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

---

## 18.2 App 组件：顶层 Provider 架构

Claude Code 的组件树根部是一个三层 Provider 嵌套：

```typescript
// src/components/App.tsx
export function App({
  getFpsMetrics, stats, initialState, children
}: Props): React.ReactNode {
  return (
    <FpsMetricsProvider getFpsMetrics={getFpsMetrics}>
      <StatsProvider store={stats}>
        <AppStateProvider
          initialState={initialState}
          onChangeAppState={onChangeAppState}
        >
          {children}
        </AppStateProvider>
      </StatsProvider>
    </FpsMetricsProvider>
  )
}
```

| Provider | 职责 | 状态类型 |
|----------|------|---------|
| `FpsMetricsProvider` | FPS 性能监控 | `FpsMetrics` |
| `StatsProvider` | 会话统计（token 数、成本） | `StatsStore` |
| `AppStateProvider` | 全局应用状态 | `AppState` |

> **设计决策**：App 组件使用 React Compiler 的 `_c()` memo cache 自动优化 — 源码中的 JSX 被编译为手动 memo 检查。当 `children` 和 `initialState` 不变时，整个 Provider 树跳过重新渲染。

---

## 18.3 REPL Screen：主交互界面

`REPL` 是 Claude Code 的核心 Screen，管理消息流、输入处理和命令执行：

```typescript
// src/screens/REPL.tsx — 超过 3000 行
// 关键导入摘要：
import { Messages } from '../components/Messages.js'
import { VirtualMessageList } from '../components/VirtualMessageList.js'
import PromptInput from '../components/PromptInput/PromptInput.js'
import { PermissionRequest } from '../components/permissions/PermissionRequest.js'
import { SpinnerWithVerb } from '../components/Spinner.js'
import { query } from '../query.js'
import { handlePromptSubmit } from '../utils/handlePromptSubmit.js'
```

REPL 的核心职责：

```
REPL Screen
    │
    ├── 消息管理: messages state + setMessages
    ├── 查询循环: query() → handleMessageFromStream()
    ├── 命令处理: handlePromptSubmit() → findCommand()
    ├── 权限控制: PermissionRequest + useCanUseTool
    ├── 工具集成: useMergedTools() + assembleToolPool()
    ├── 会话恢复: restoreAgentFromSession()
    ├── 成本追踪: useCostSummary()
    ├── 任务管理: useTasksV2WithCollapseEffect()
    ├── 快捷键: GlobalKeybindingHandlers + CommandKeybindingHandlers
    └── 远程会话: useRemoteSession() + useReplBridge()
```

---

## 18.4 主题系统

### Theme 类型

主题定义了 50+ 语义颜色：

```typescript
// src/utils/theme.ts
export type Theme = {
  // 品牌色
  claude: string             // Claude 橙色
  claudeShimmer: string      // 闪烁效果
  permission: string         // 权限蓝
  planMode: string           // Plan 模式青色

  // 语义色
  text: string               // 文本色
  inverseText: string        // 反转文本
  inactive: string           // 非活跃灰
  success: string            // 成功绿
  error: string              // 错误红
  warning: string            // 警告琥珀

  // Diff 色
  diffAdded: string          // 新增行
  diffRemoved: string        // 删除行
  diffAddedWord: string      // 新增词
  diffRemovedWord: string    // 删除词

  // Agent 色（Sub-Agent 专用）
  red_FOR_SUBAGENTS_ONLY: string
  blue_FOR_SUBAGENTS_ONLY: string
  green_FOR_SUBAGENTS_ONLY: string
  // ... 8 种 Agent 颜色

  // TUI V2 色
  userMessageBackground: string
  bashMessageBackgroundColor: string
  memoryBackgroundColor: string
  selectionBg: string        // 文本选择高亮

  // 彩虹色（ultrathink 关键词高亮）
  rainbow_red: string
  rainbow_orange: string
  // ... 7 种 + 7 种 shimmer 变体
}
```

### 6 种主题

```typescript
// src/utils/theme.ts
export const THEME_NAMES = [
  'dark',                // 深色，RGB 真彩色
  'light',               // 浅色，RGB 真彩色
  'light-daltonized',    // 色盲友好浅色
  'dark-daltonized',     // 色盲友好深色
  'light-ansi',          // 浅色，仅 16 色 ANSI
  'dark-ansi',           // 深色，仅 16 色 ANSI
] as const

export const THEME_SETTINGS = ['auto', ...THEME_NAMES] as const
// 'auto' 在运行时根据系统暗/亮模式解析为具体 ThemeName
```

### 颜色格式策略

```typescript
// 真彩色主题 — 使用 RGB 值
const lightTheme: Theme = {
  claude: 'rgb(215,119,87)',           // Claude 橙
  permission: 'rgb(87,105,247)',       // 中蓝色
  success: 'rgb(44,122,57)',           // 绿色
  error: 'rgb(171,43,63)',             // 红色
  diffAdded: 'rgb(105,219,124)',       // 浅绿
  diffRemoved: 'rgb(255,168,180)',     // 浅红
  // ...
}

// ANSI 主题 — 使用标准 16 色
const lightAnsiTheme: Theme = {
  claude: 'ansi:redBright',
  permission: 'ansi:blue',
  success: 'ansi:green',
  error: 'ansi:red',
  diffAdded: 'ansi:green',
  diffRemoved: 'ansi:red',
  // ...
}
```

> **设计决策**：真彩色主题使用显式 RGB 值而非 ANSI 命名色，原因是用户的终端配色方案会重新定义 ANSI 颜色的含义。例如用户可能将"红色"设为橙色，导致 diff 中的删除行看起来像新增行。显式 RGB 值确保视觉一致性。ANSI 主题则是为不支持真彩色的终端（如某些 SSH 客户端）提供的降级方案。

### 色盲友好主题

```typescript
// src/utils/theme.ts
const lightDaltonizedTheme: Theme = {
  bashBorder: 'rgb(0,102,204)',       // 蓝色代替粉色
  success: 'rgb(0,102,153)',          // 蓝色代替绿色（红绿色盲）
  warning: 'rgb(255,153,0)',          // 调整后的橙色
  diffAdded: 'rgb(153,204,255)',      // 浅蓝代替浅绿
  diffRemovedWord: 'rgb(153,51,51)', // 柔和红（降低强度）
  // ...
}
```

---

## 18.5 Ink 渲染引擎

Claude Code 使用深度定制的 Ink 框架。`src/ink/` 目录包含 70+ 文件，是一个完整的终端 UI 引擎。

### Reconciler — React 到 DOM 的桥梁

```typescript
// src/ink/reconciler.ts
import createReconciler from 'react-reconciler'

// React Reconciler 接口实现：
// - createInstance()  → createNode(): 创建 DOMElement
// - createTextInstance() → createTextNode(): 创建 TextNode
// - appendChildNode() / removeChildNode(): 管理子节点
// - commitUpdate() → diff() + setAttribute/setStyle: 属性更新
// - commitTextUpdate() → setTextNodeValue(): 文本更新

const diff = (before: AnyObject, after: AnyObject): AnyObject | undefined => {
  // 高效属性比较 — 只返回变化的部分
  if (before === after) return
  const changed: AnyObject = {}
  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(after, key)) {
      changed[key] = undefined  // 删除
    }
  }
  // ... 新增和修改的检查
  return isChanged ? changed : undefined
}
```

### DOM 抽象层

Ink 维护一个轻量级 DOM 树，与浏览器 DOM 类似但简化：

```
DOMElement
    │
    ├── nodeName: 'ink-box' | 'ink-text' | 'ink-root' | ...
    ├── yogaNode: YogaNode       ← Flexbox 布局
    ├── style: Styles             ← CSS-like 样式
    ├── childNodes: DOMNode[]     ← 子节点列表
    ├── parentNode: DOMElement    ← 父节点
    └── attributes: Map<string, DOMNodeAttribute>

TextNode
    ├── nodeName: '#text'
    ├── nodeValue: string         ← 文本内容
    └── yogaNode: YogaNode        ← 文本尺寸
```

### Yoga 布局引擎

Ink 使用 Facebook 的 Yoga 引擎进行 Flexbox 布局计算：

```typescript
// src/ink/layout/yoga.ts
// Yoga 负责 CSS Flexbox 的布局计算：
// - flexDirection, justifyContent, alignItems
// - width, height, minWidth, maxWidth
// - padding, margin, border
// - position: absolute, gap
// - overflow: hidden
```

### Renderer Pipeline

渲染管线从 React 树到 Screen 缓冲的完整路径：

```
React 组件树
    │  react-reconciler
    ▼
DOMElement 树 + Yoga 布局
    │  renderer.ts
    ▼
render-node-to-output.ts
    │  遍历 DOM 树，收集绘制操作
    ▼
Output 对象
    │  操作类型：Write | Clip | Blit | Clear | Shift
    ▼
Screen 缓冲（字符单元格矩阵）
    │  双缓冲差分
    ▼
ANSI escape codes → stdout
```

---

## 18.6 Screen 缓冲与双缓冲

### Screen 数据结构

```typescript
// src/ink/screen.ts

// 字符串池（interning）— 内存效率优化
export class CharPool {
  private strings: string[] = [' ', '']  // 0=空格, 1=空
  private ascii: Int32Array              // ASCII 快速路径

  intern(char: string): number {
    // ASCII 快速路径：直接数组查找
    if (char.length === 1) {
      const code = char.charCodeAt(0)
      if (code < 128) {
        const cached = this.ascii[code]!
        if (cached !== -1) return cached
        // 新 ASCII 字符：分配 index
        const index = this.strings.length
        this.strings.push(char)
        this.ascii[code] = index
        return index
      }
    }
    // 非 ASCII：Map 查找
    return this.stringMap.get(char) ?? this.allocate(char)
  }
}

// 超链接池
export class HyperlinkPool {
  private strings: string[] = ['']  // 0=无超链接
  // OSC 8 hyperlink interning
}
```

> **设计决策**：Screen 中的每个字符不是直接存储字符串，而是存储 interned 的整数 ID。这使得帧间差分可以用整数比较代替字符串比较，在长会话（2000+ 消息）中显著降低 CPU 开销。CharPool 为 ASCII 字符提供 O(1) 数组查找快速路径。

### 双缓冲渲染

```typescript
// src/ink/renderer.ts
export default function createRenderer(
  node: DOMElement,
  stylePool: StylePool,
): Renderer {
  let output: Output | undefined
  return options => {
    const { frontFrame, backFrame, terminalWidth, terminalRows } = options

    // Front Buffer: 上一帧的 Screen（终端当前显示的内容）
    const prevScreen = frontFrame.screen
    // Back Buffer: 当前帧的 Screen（即将显示的内容）
    const backScreen = backFrame.screen

    // 计算 Yoga 布局
    const width = Math.floor(node.yogaNode.getComputedWidth())
    const height = options.altScreen ? terminalRows : yogaHeight

    // Alt-screen 高度约束 — 防止超出终端行数
    if (options.altScreen && yogaHeight > terminalRows) {
      logForDebugging(
        `alt-screen: yoga height ${yogaHeight} > terminalRows ${terminalRows}`)
    }

    // 渲染 DOM 树到 Output 操作集
    if (!output) {
      output = new Output(width, height, stylePool, { screen: backScreen })
    }
    renderNodeToOutput(node, output, /* ... */)

    // 将操作应用到 Back Buffer
    const screen = output.get(prevScreen)

    return { screen, viewport, cursor }
  }
}
```

---

## 18.7 Output 操作系统

Output 收集 DOM 遍历产生的绘制操作：

```typescript
// src/ink/output.ts
export type Operation =
  | WriteOperation    // 写入文本
  | ClipOperation     // 设置裁剪区域
  | UnclipOperation   // 移除裁剪
  | BlitOperation     // 从前帧复制（不变区域）
  | ClearOperation    // 清空区域
  | NoSelectOperation // 标记不可选择
  | ShiftOperation    // 滚动偏移

type WriteOperation = {
  type: 'write'
  x: number
  y: number
  text: string
  softWrap?: boolean[]  // 软换行标记
  transformers?: Transformer[]  // ANSI 转换器链
  skipStyleCache?: boolean
}
```

### ClusteredChar — 预计算的字符元数据

```typescript
// src/ink/output.ts
type ClusteredChar = {
  value: string         // 字素簇
  width: number         // 终端宽度（CJK=2, emoji=2, ASCII=1）
  styleId: number       // interned 样式 ID
  hyperlink: string | undefined  // OSC 8 超链接
}
```

> **设计决策**：`ClusteredChar` 是一个关键的缓存优化。每个唯一行的字符只解析一次（ANSI tokenize + 字素聚类 + 宽度计算 + 样式 interning），结果通过 `charCache` 缓存。后续帧只需要读取属性 + `setCellAt` — 没有 `stringWidth` 调用，没有样式 interning，没有超链接提取。

---

## 18.8 渲染优化

### 滚动优化 — DECSTBM 硬件滚动

```typescript
// src/ink/render-node-to-output.ts
export type ScrollHint = {
  top: number      // 滚动区域顶部行（0-indexed）
  bottom: number   // 滚动区域底部行（0-indexed）
  delta: number    // 滚动量（>0 = 内容向上移动）
}
```

当 ScrollBox 的 `scrollTop` 变化且其他内容不变时，`log-update.ts` 可以发出 DECSTBM（DEC Set Top and Bottom Margins）+ SU/SD（Scroll Up/Down）硬件滚动指令，而非重写整个 viewport。

### 布局位移检测

```typescript
// src/ink/render-node-to-output.ts
// 每帧标记：是否有节点的位置/尺寸发生变化
let layoutShifted = false

export function resetLayoutShifted(): void {
  layoutShifted = false
}

export function didLayoutShift(): boolean {
  return layoutShifted
}
```

稳态帧（如 spinner 旋转、时钟跳动、文本追加到固定高度 Box）不会触发布局位移 → 窄范围损坏边界 → O(changed cells) 差分而非 O(rows×cols)。

### Blit 优化

`BlitOperation` 是核心优化：当一个 DOM 子树在两帧之间没有变化时，直接从前帧的 Screen 复制到后帧，跳过整个子树的重新渲染：

```
帧 N-1 (Front)    帧 N (Back)
┌──────────────┐   ┌──────────────┐
│ Logo (不变)  │──blit──│ Logo (复制) │
│              │   │              │
│ Message 1-99 │──blit──│ Message 1-99│
│ (不变)       │   │ (复制)       │
│              │   │              │
│ Message 100  │   │ Message 100  │
│ (新内容)     │──write──│ (重新渲染) │
│              │   │              │
│ PromptInput  │──blit──│ PromptInput │
└──────────────┘   └──────────────┘
```

> **设计决策**：LogoV2 组件用 `React.memo` + `OffscreenFreeze` 包装。如果 Logo 在每次 `Messages` 更新时变脏，reconciler 的 `seenDirtyChild` 级联会禁用所有后续兄弟的 blit 优化 — 在长会话（~2800 消息）中会导致 150K+ writes/frame，CPU 100%。

---

## 18.9 Markdown 渲染

### Markdown 组件

```typescript
// src/components/Markdown.tsx
export function Markdown(props: Props): React.ReactNode {
  const settings = useSettings()

  // 语法高亮禁用时，跳过异步加载
  if (settings.syntaxHighlightingDisabled) {
    return <MarkdownBody {...props} highlight={null} />
  }

  // 正常路径：Suspense + 异步加载语法高亮器
  return (
    <Suspense fallback={<MarkdownBody {...props} highlight={null} />}>
      <MarkdownWithHighlight {...props} />
    </Suspense>
  )
}
```

### Token 缓存

```typescript
// src/components/Markdown.tsx
const TOKEN_CACHE_MAX = 500
const tokenCache = new Map<string, Token[]>()

// 快速路径：无 Markdown 语法 → 跳过完整解析
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /

function hasMarkdownSyntax(s: string): boolean {
  // 只检查前 500 字符 — Markdown 语法通常出现在开头
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s)
}

function cachedLexer(content: string): Token[] {
  // 快速路径：纯文本 → 单个 paragraph token
  if (!hasMarkdownSyntax(content)) {
    return [{
      type: 'paragraph',
      raw: content, text: content,
      tokens: [{ type: 'text', raw: content, text: content }]
    } as Token]
  }

  // LRU 缓存：hash → tokens
  const key = hashContent(content)
  const hit = tokenCache.get(key)
  if (hit) {
    // 提升到 MRU — 防止 FIFO 驱逐当前查看的消息
    tokenCache.delete(key)
    tokenCache.set(key, hit)
    return hit
  }

  const tokens = marked.lexer(content)
  // LRU 驱逐
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const first = tokenCache.keys().next().value
    if (first !== undefined) tokenCache.delete(first)
  }
  tokenCache.set(key, tokens)
  return tokens
}
```

> **设计决策**：`marked.lexer` 在虚拟滚动的重新挂载时是热点成本（每条消息 ~3ms）。`useMemo` 不能在 unmount→remount 之间保持缓存。历史消息是不可变的，相同内容→相同 tokens。使用 content hash 作为 key 避免保留完整内容字符串（否则会导致 turn50→turn99 的 RSS 回归，issue #24180）。

### 混合渲染策略

MarkdownBody 使用混合渲染：表格渲染为 React 组件，其他内容渲染为 ANSI 字符串：

```typescript
// src/components/Markdown.tsx
function MarkdownBody({ children, dimColor, highlight }) {
  const [theme] = useTheme()
  configureMarked()

  const tokens = cachedLexer(stripPromptXMLTags(children))
  const elements = []
  let nonTableContent = ""

  const flushNonTableContent = () => {
    if (nonTableContent) {
      elements.push(
        <Ansi key={elements.length} dimColor={dimColor}>
          {nonTableContent.trim()}
        </Ansi>)
      nonTableContent = ""
    }
  }

  for (const token of tokens) {
    if (token.type === "table") {
      flushNonTableContent()
      elements.push(
        <MarkdownTable key={elements.length}
          token={token} highlight={highlight} />)
    } else {
      nonTableContent += formatToken(
        token, theme, 0, null, null, highlight)
    }
  }
  flushNonTableContent()

  return <Box flexDirection="column">{elements}</Box>
}
```

---

## 18.10 虚拟滚动

### VirtualMessageList

```typescript
// src/components/VirtualMessageList.tsx
type Props = {
  messages: RenderableMessage[]
  scrollRef: RefObject<ScrollBoxHandle | null>
  columns: number           // 宽度变化时重置高度缓存
  itemKey: (msg: RenderableMessage) => string
  renderItem: (msg: RenderableMessage, index: number) => React.ReactNode
  onItemClick?: (msg: RenderableMessage) => void
}

// 搜索功能
export type JumpHandle = {
  jumpToIndex: (i: number) => void
  setSearchQuery: (q: string) => void
  nextMatch: () => void
  prevMatch: () => void
  setAnchor: () => void
  warmSearchIndex: () => Promise<number>
  disarmSearch: () => void
}
```

### 搜索文本缓存

```typescript
// src/components/VirtualMessageList.tsx
const fallbackLowerCache = new WeakMap<RenderableMessage, string>()

function defaultExtractSearchText(msg: RenderableMessage): string {
  const cached = fallbackLowerCache.get(msg)
  if (cached !== undefined) return cached
  const lowered = renderableSearchText(msg)
  fallbackLowerCache.set(msg, lowered)
  return lowered
}
```

---

## 18.11 Messages 组件：消息列表

Messages 是 REPL 的核心显示组件，负责将原始消息数组转化为可渲染的消息列表：

```typescript
// src/components/Messages.tsx
// 关键转换管线：
//
// messages (原始)
//   │ normalizeMessages()      → 标准化
//   │ reorderMessagesInUI()    → UI 重排
//   │ collapseReadSearchGroups() → 折叠 Read/Search
//   │ collapseHookSummaries()   → 折叠 Hook 摘要
//   │ collapseTeammateShutdowns() → 折叠队友关闭
//   │ collapseBackgroundBashNotifications() → 折叠后台通知
//   │ applyGrouping()           → 工具调用分组
//   ▼
// RenderableMessage[]
```

### LogoHeader 性能优化

```typescript
// src/components/Messages.tsx
const LogoHeader = React.memo(function LogoHeader({ agentDefinitions }) {
  return (
    <OffscreenFreeze>
      <Box flexDirection="column" gap={1}>
        <LogoV2 />
        <React.Suspense fallback={null}>
          <StatusNotices agentDefinitions={agentDefinitions} />
        </React.Suspense>
      </Box>
    </OffscreenFreeze>
  )
})
```

> **设计决策**：`LogoHeader` 用 `React.memo` 包装并仅依赖 `agentDefinitions`（而非 `messages` 数组）。如果依赖 `messages`，每条新消息都会使 LogoHeader 变脏。在 Ink 的渲染模型中，Logo 是 MessageRow 列表的第一个兄弟节点 — 如果它变脏，`renderChildren` 的 `seenDirtyChild` 级联会禁用所有后续 MessageRow 的 blit（前帧复制）优化。在 ~2800 消息的长会话中，这意味着 150K+ 字符写入/帧，CPU 使用率达到 100%。

---

## 18.12 消息折叠与分组

Messages 组件对原始消息流进行多轮转换，优化显示：

| 转换阶段 | 文件 | 功能 |
|----------|------|------|
| `normalizeMessages()` | `utils/messages.ts` | 标准化消息格式 |
| `reorderMessagesInUI()` | `utils/messages.ts` | UI 排序优化 |
| `collapseReadSearchGroups()` | `utils/collapseReadSearch.ts` | 合并连续 Read/Grep 调用 |
| `collapseHookSummaries()` | `utils/collapseHookSummaries.ts` | 合并 Hook 结果 |
| `collapseTeammateShutdowns()` | `utils/collapseTeammateShutdowns.ts` | 合并队友关闭通知 |
| `collapseBackgroundBashNotifications()` | `utils/collapseBackgroundBashNotifications.ts` | 合并后台 Bash 通知 |
| `applyGrouping()` | `utils/groupToolUses.ts` | 工具调用分组显示 |

---

## 18.13 终端底层

### termio 模块

`src/ink/termio/` 提供完整的终端控制序列抽象：

```
src/ink/termio/
    ├── ansi.ts      ← ANSI 基础常量（ESC, BEL, SEP）
    ├── csi.ts       ← CSI 序列（光标移动、清屏）
    ├── dec.ts       ← DEC 私有序列（DECSTBM 等）
    ├── esc.ts       ← ESC 序列
    ├── osc.ts       ← OSC 序列（超链接、标题）
    ├── sgr.ts       ← SGR 序列（颜色、样式）
    ├── parser.ts    ← ANSI 序列解析器
    ├── tokenize.ts  ← ANSI 文本 tokenization
    └── types.ts     ← 类型定义
```

### 关键能力

```
src/ink/
    ├── bidi.ts                  ← 双向文本（RTL 支持）
    ├── colorize.ts              ← 颜色应用
    ├── focus.ts                 ← 焦点管理
    ├── hit-test.ts              ← 点击测试
    ├── selection.ts             ← 文本选择
    ├── searchHighlight.ts       ← 搜索高亮
    ├── tabstops.ts              ← Tab 停止位
    ├── wrap-text.ts             ← 文本换行
    ├── wrapAnsi.ts              ← ANSI 感知的文本换行
    ├── stringWidth.ts           ← Unicode 字符宽度
    ├── widest-line.ts           ← 最宽行计算
    ├── measure-text.ts          ← 文本尺寸测量
    ├── supports-hyperlinks.ts   ← 超链接支持检测
    ├── terminal.ts              ← 终端能力检测
    └── terminal-querier.ts      ← 终端特性查询
```

### Hooks（React Hooks for Terminal）

```
src/ink/hooks/
    ├── use-input.ts             ← 键盘输入处理
    ├── use-stdin.ts             ← stdin 原始输入
    ├── use-animation-frame.ts   ← 动画帧调度
    ├── use-interval.ts          ← 定时器
    ├── use-terminal-title.ts    ← 终端标题控制
    ├── use-terminal-focus.ts    ← 终端焦点事件
    ├── use-terminal-viewport.ts ← 视口尺寸
    ├── use-tab-status.ts        ← Tab 标签状态
    ├── use-declared-cursor.ts   ← 光标声明
    ├── use-search-highlight.ts  ← 搜索高亮
    └── use-selection.ts         ← 文本选择
```

---

## 18.14 事件系统

```
src/ink/events/
    ├── dispatcher.ts       ← 事件分发器
    ├── emitter.ts          ← 事件发射器
    ├── event.ts            ← 基础事件类型
    ├── event-handlers.ts   ← 事件处理器注册
    ├── click-event.ts      ← 鼠标点击事件
    ├── focus-event.ts      ← 焦点事件
    ├── input-event.ts      ← 输入事件
    ├── keyboard-event.ts   ← 键盘事件
    ├── terminal-event.ts   ← 终端事件
    └── terminal-focus-event.ts ← 终端焦点事件
```

Ink 的事件模型类似浏览器 DOM 事件但简化。`Dispatcher` 负责将 stdin 原始输入解析为结构化事件（键盘、鼠标点击、终端焦点），然后通过组件树传播。

---

## 18.15 性能关键路径总结

```
用户输入/模型输出
        │
        ▼
React 状态更新 (setMessages)
        │
        ▼
React Compiler 自动 memo
        │  跳过无变化的子树
        ▼
Reconciler → DOM 更新
        │  只更新变化的节点
        ▼
Yoga 增量布局
        │  只重算受影响的子树
        ▼
render-node-to-output
        │  Blit 不变区域
        ▼
Output → Screen (Back Buffer)
        │  charCache 避免重复解析
        ▼
Screen 差分 (Back vs Front)
        │  整数比较 (interned IDs)
        ▼
最小 ANSI 序列 → stdout
        │  DECSTBM 硬件滚动
        ▼
终端显示
```

关键优化汇总：

| 层级 | 优化技术 | 效果 |
|------|---------|------|
| React | React Compiler `_c()` | 自动跳过不变子树 |
| React | `React.memo` + `OffscreenFreeze` | 防止级联脏标记 |
| Markdown | Token LRU 缓存 | 避免 `marked.lexer` 重复解析（~3ms/条） |
| Markdown | 纯文本快速路径 | 跳过 GFM 解析 |
| DOM | Blit 操作 | 不变区域直接从前帧复制 |
| Screen | CharPool interning | 整数比较代替字符串比较 |
| Screen | charCache | 避免重复 ANSI tokenize + 字素聚类 |
| 终端 | DECSTBM 硬件滚动 | 避免重写整个 viewport |
| 终端 | 布局位移检测 | 窄范围 diff |
| 虚拟滚动 | 高度缓存 + 窗口化 | 只渲染可见消息 |

---

## 章末速查表

| 概念 | 文件 | 关键函数/类型 |
|------|------|-------------|
| App 入口 | `components/App.tsx` | `App()` |
| REPL Screen | `screens/REPL.tsx` | 主交互循环 |
| 主题定义 | `utils/theme.ts` | `Theme` 类型, 6 种主题 |
| Reconciler | `ink/reconciler.ts` | `createReconciler` |
| DOM 抽象 | `ink/dom.ts` | `DOMElement`, `TextNode` |
| 渲染器 | `ink/renderer.ts` | `createRenderer()` |
| Output 操作 | `ink/output.ts` | `Operation` 类型 |
| Screen 缓冲 | `ink/screen.ts` | `Screen`, `CharPool`, `HyperlinkPool` |
| 节点渲染 | `ink/render-node-to-output.ts` | `renderNodeToOutput()` |
| 滚动优化 | `ink/render-node-to-output.ts` | `ScrollHint` |
| Markdown | `components/Markdown.tsx` | `Markdown()`, `cachedLexer()` |
| 虚拟滚动 | `components/VirtualMessageList.tsx` | `VirtualMessageList`, `JumpHandle` |
| Messages | `components/Messages.tsx` | `Messages`, `LogoHeader` |
| MessageRow | `components/MessageRow.tsx` | `MessageRow`, `hasContentAfterIndex()` |
| 终端控制 | `ink/termio/*.ts` | CSI/DEC/OSC/SGR 序列 |
| 事件系统 | `ink/events/*.ts` | `Dispatcher`, 事件类型 |
| 键盘输入 | `ink/hooks/use-input.ts` | `useInput()` |
| 文本宽度 | `ink/stringWidth.ts` | `stringWidth()` |
| 文本换行 | `ink/wrap-text.ts` | `wrapText()` |
| BiDi 文本 | `ink/bidi.ts` | `reorderBidi()` |
