
# 第 2 章：安装与打包 — 解剖 npm 包的内部结构

> **核心问题**：当你执行 `npm install -g @anthropic-ai/claude-code` 时，你到底安装了什么？一个 50MB+ 的单文件 bundle 是如何生成的？我们又该如何从这个混淆后的"黑盒"中提取出可分析的源码？

> **⚠️ 注意**：本章基于 v2.1.86 版本编写，当时 Claude Code 通过 npm 全局安装分发。Anthropic 已于后续版本弃用 npm 安装方式，改为通过 `bun build --compile` 将 TypeScript 代码与 Bun runtime（JavaScriptCore 引擎）打包为独立二进制文件分发，不再依赖 Node.js（[技术分析](https://www.frr.dev/posts/claude-code-native-build-bun/)）。当前推荐的安装方式为 `curl -fsSL https://claude.ai/install.sh | bash`（macOS/Linux）或通过 Homebrew / WinGet 安装。本章关于 npm 安装方式的描述已过时，但打包结构、混淆策略和反编译方法论的分析仍然适用。最新的安装方式请参阅 [Anthropic 官方文档](https://code.claude.com/docs/en/setup)。

Claude Code 以 npm 包的形式分发，只需一条命令即可安装。但"简单的安装"背后，是一套精心设计的打包策略 — 单文件 bundle、依赖内联、代码混淆、native 模块跨平台编译。理解这些，是阅读本书后续章节的前提：你需要知道"我们分析的对象长什么样"。

本章将从安装方式开始，逐层拆解 npm 包的文件结构、打包工具链、混淆策略，最后介绍本书的反编译方法论 — 为后续 15 章的深度分析奠定基础。

---

## 2.1 安装方式

### 一条命令的全局安装

Claude Code 的安装遵循标准的 npm 全局安装流程：

```bash
npm install -g @anthropic-ai/claude-code
```

安装完成后，系统 PATH 中会多出一个 `claude` 命令。执行 `claude` 即可启动交互式终端界面。

### 环境要求

| 要求 | 最低版本 | 说明 |
|------|---------|------|
| Node.js | 18.0+ | 需要支持 ES2022 特性（top-level await、structuredClone 等） |
| npm | 随 Node.js 附带 | 用于全局安装 |
| 操作系统 | macOS / Linux / Windows (WSL) | native 模块有平台特定编译 |
| 网络 | 需要访问 api.anthropic.com | 运行时需要 API 连接 |

> **设计决策**：Claude Code 选择 npm 而非独立二进制（如 Go/Rust 编译的 CLI）作为分发渠道。这看似反直觉 — 一个 CLI 工具为什么需要 Node.js 运行时？原因在于 Claude Code 本身就是用 TypeScript 编写的，它深度依赖 Node.js 生态（Ink/React 渲染、streaming HTTP、child_process 等）。npm 全局安装是最自然的选择，也避免了维护多平台二进制的成本。

### 安装后的文件布局

全局安装后，npm 会在全局 `node_modules` 目录下创建包目录，并在 `bin` 目录下创建符号链接：

```
# macOS / Linux 典型路径
/usr/local/lib/node_modules/@anthropic-ai/claude-code/
    ├── package.json
    ├── cli.mjs            # bin 入口（薄包装层）
    ├── main.mjs           # 主 bundle（50MB+）
    ├── vendor/             # native 模块
    │   ├── image-processor.node
    │   ├── audio-capture.node
    │   ├── computer-use-swift.node
    │   └── computer-use-input.node
    └── ...

/usr/local/bin/claude -> ../lib/node_modules/@anthropic-ai/claude-code/cli.mjs
```

关键点：`claude` 命令实际上是一个指向 `cli.mjs` 的符号链接。`cli.mjs` 是一个极薄的包装层，它的唯一职责是 `import` 主 bundle 文件 `main.mjs`。

---

## 2.2 npm 包结构分析

### package.json 关键字段

npm 包的核心配置在 `package.json` 中。以下是 v2.1.86 的关键字段：

```json
{
  "name": "@anthropic-ai/claude-code",
  "version": "2.1.86",
  "bin": {
    "claude": "./cli.mjs"
  },
  "files": [
    "cli.mjs",
    "main.mjs",
    "vendor/"
  ],
  "engines": {
    "node": ">=18.0.0"
  },
  "type": "module"
}
```

| 字段 | 值 | 含义 |
|------|-----|------|
| `bin.claude` | `./cli.mjs` | 注册 `claude` 全局命令，指向入口文件 |
| `type` | `"module"` | 使用 ESM 模块系统（`.mjs` 扩展名） |
| `engines.node` | `>=18.0.0` | 最低 Node.js 版本要求 |
| `files` | 数组 | 控制 npm publish 时包含的文件 |

### 主 bundle 文件 — 单文件架构

整个 Claude Code 的 JavaScript 源码被打包成**一个文件** — `main.mjs`（或在内部构建中为 `main_bundle.js`）。这个文件的规模：

| 指标 | 数值 |
|------|------|
| 压缩后大小（npm tarball） | ~12MB |
| 格式化后行数 | ~503,000 行 |
| 格式化后大小 | ~20MB |
| 内联依赖数量 | 数百个 npm 包 |

503,000 行代码被打包进一个文件 — 这不是笔误。Anthropic TypeScript SDK、React/Ink 渲染库、Commander CLI 框架、AWS SDK（用于 Bedrock）、Google Auth（用于 Vertex）、各种解析器和工具库，全部被内联进这个 bundle。

### native 模块 — 平台特定编译

除了 JavaScript bundle 之外，npm 包还包含 4 个 **native 模块** — 用 Rust 和 Swift 编写、编译为平台特定二进制的 `.node` 文件：

```
vendor/
├── image-processor.node      # Rust (napi), 图像处理（压缩/转换）
├── audio-capture.node         # Rust (napi), 音频捕获（麦克风输入）
├── computer-use-swift.node    # Swift, 屏幕截图/应用控制 (macOS)
└── computer-use-input.node    # Rust (napi), 键盘/鼠标模拟
```

| 模块 | 语言 | 架构 | 用途 |
|------|------|------|------|
| image-processor | Rust (napi) | arm64 | 高性能图像处理 |
| audio-capture | Rust (napi) | arm64 | 音频输入捕获 |
| computer-use-swift | Swift | arm64 + x86_64 | macOS 屏幕截图、应用管理 |
| computer-use-input | Rust (napi) | arm64 + x86_64 | 键盘鼠标自动化 |

这些 native 模块主要服务于 **Computer Use**（计算机使用）功能 — 让 Claude Code 能看到屏幕、操作鼠标键盘。对于纯 CLI 编程助手的使用场景，这些模块不会被加载。

> **设计决策**：native 模块采用 **N-API**（Node.js Addon API）编译，这是 Node.js 官方推荐的 native addon 接口。N-API 提供了 ABI 稳定性 — 一次编译的 `.node` 文件可以跨 Node.js 版本运行，不需要为每个 Node.js 版本重新编译。这大大简化了发布流程。

### 包的总体架构

```
@anthropic-ai/claude-code (npm package)
│
├── cli.mjs ─────────────────── 入口（~几十行）
│   └── import "./main.mjs"
│
├── main.mjs ────────────────── 主 bundle（~12MB / 503K 行）
│   ├── [Module System]         esbuild 生成的模块加载器
│   ├── [Anthropic SDK]         API 客户端、流式处理
│   ├── [React / Ink]           终端 UI 渲染
│   ├── [Commander.js]          CLI 参数解析
│   ├── [AWS SDK]               Bedrock 提供商支持
│   ├── [Google Auth]           Vertex 提供商支持
│   ├── [Tools]                 40+ 工具实现
│   ├── [System Prompt]         行为指令模板
│   ├── [Hooks / Permissions]   安全系统
│   └── [... 数百个依赖]        全部内联
│
└── vendor/ ─────────────────── native 模块
    ├── image-processor.node    Rust → N-API
    ├── audio-capture.node      Rust → N-API
    ├── computer-use-swift.node Swift → N-API
    └── computer-use-input.node Rust → N-API
```

---

## 2.3 打包方式 — esbuild 单文件打包

### 为什么选择单文件打包

Claude Code 使用 **esbuild** 将所有 TypeScript/JavaScript 源码及其依赖打包成一个文件。这是一个刻意的工程决策，而非偶然：

| 考量 | 单文件打包的优势 |
|------|----------------|
| **部署简单** | npm install 后只有一个 JS 文件 + 几个 native 模块，没有 `node_modules` 黑洞 |
| **避免依赖冲突** | 用户系统上的其他 npm 包不会干扰 Claude Code 的内部依赖 |
| **启动速度** | Node.js 只需解析一个文件，避免了遍历 `node_modules` 树的 I/O 开销 |
| **版本锁定** | 所有依赖的确切版本被固化在 bundle 中，不会因为 `npm update` 而被意外升级 |
| **知识产权保护** | 单文件 + 混淆增加了逆向工程的难度 |

### esbuild 的角色

esbuild 是一个用 Go 编写的超快 JavaScript 打包器。Anthropic 的内部构建流程大致如下：

```
TypeScript 源码 (.ts)
    │
    ▼
esbuild (bundle + minify)
    ├── 解析所有 import/require
    ├── 将依赖树展开并内联
    ├── TypeScript → JavaScript 转换
    ├── 变量名混淆（mangling）
    ├── 空白移除（minification）
    └── 输出单文件 main.mjs
    │
    ▼
npm publish
    ├── main.mjs (~12MB)
    ├── cli.mjs (入口)
    └── vendor/*.node (native)
```

### 混淆策略

打包后的代码经过了多层混淆处理：

**1. 变量名混淆（Identifier Mangling）**

所有内部变量名、函数名、类名被替换为无意义的短标识符：

```javascript
// 混淆前（推测的原始代码）
async function agentExecute({ agentDefinition, promptMessages, toolUseContext }) {
    const model = resolveModel(agentDefinition.model);
    const systemPrompt = await buildSystemPrompt(model);
    // ...
}

// 混淆后（实际 bundle 中的代码）
async function* av({ agentDefinition: H, promptMessages: _, toolUseContext: q }) {
    let f = LvH(H.model);
    let z = await lB1(f);
    // ...
}
```

**2. 字符串保留**

值得注意的是，**字符串常量没有被加密**。API 端点、错误消息、System Prompt 文本、环境变量名 — 这些都以明文形式存在于 bundle 中。这是反编译分析的重要切入点。

```javascript
// 这些字符串在 bundle 中清晰可见
"https://api.anthropic.com/v1/messages"
"CLAUDE_CODE_ENTRYPOINT"
"Output token limit hit. Resume directly..."
```

**3. 模块边界消失**

esbuild 将所有模块合并后，原始的文件边界（`import`/`export`）消失了。一个原本分布在数十个文件中的功能，在 bundle 中可能散落在相距数万行的位置。

> **设计决策**：Anthropic 选择了"轻度混淆" — 混淆变量名但保留字符串。这是一个务实的平衡。完全不混淆会暴露内部 API 设计；过度混淆（如字符串加密、控制流混淆）会影响运行时性能和调试。保留字符串意味着错误堆栈仍然有一定可读性，便于用户报告问题。

---

## 2.4 反编译方法简介

本书对 Claude Code 的分析基于反编译后的源码。以下是从 npm 包提取、格式化、拆分、理解源码的完整方法论。

### Step 1：提取源码

从 npm 包中获取 `main.mjs` 文件（即 `main_bundle.js`）：

```bash
# 方法 1：从已安装的全局包中复制
cp $(npm root -g)/@anthropic-ai/claude-code/main.mjs ./main_bundle.js

# 方法 2：下载 npm tarball 并解压
npm pack @anthropic-ai/claude-code
tar -xzf anthropic-ai-claude-code-2.1.86.tgz
cp package/main.mjs ./main_bundle.js
```

### Step 2：代码格式化

原始 bundle 是压缩的 — 几乎没有换行和缩进。第一步是用 Prettier 或类似工具格式化：

```bash
npx prettier --write main_bundle.js
```

格式化后，文件从约 12MB 膨胀到约 20MB，行数达到 ~503,000 行。代码变得可读了，但仍然是一个巨大的单文件。

### Step 3：模块拆分

通过分析代码结构（函数聚类、字符串特征、依赖关系），将 503K 行的巨型文件手动拆分为 19 个功能模块：

```
modules/
├── 01_runtime_bootstrap.js   # 模块系统、polyfills、Bun 运行时
├── 02_api_client.js           # Anthropic API 客户端、SDK
├── 03_file_system.js          # 文件系统操作
├── 04_git_operations.js       # Git 集成
├── 05_config_settings.js      # 配置系统
├── 06_permission_system.js    # 权限与沙箱
├── 07_crypto_encoding.js      # 加密与编码
├── 08_system_prompt.js        # System Prompt 构建
├── 09_data_processing.js      # 解析器、数据缓冲
├── 10_tool_bash.js            # Bash 工具实现
├── 11_api_streaming.js        # API 流式处理、工具注册
├── 12_computer_use.js         # Computer Use 工具
├── 13_ui_rendering.js         # 终端 UI（Ink/React）
├── 14_html_parser.js          # HTML 解析器（parse5）
├── 15_hooks_system.js         # Hooks 生命周期
├── 16_commands_slash.js       # Slash 命令与 CLI
├── 17_system_prompt_full.js   # 完整 System Prompt 文本
├── 18_sdk_examples.js         # SDK 文档与示例
└── 19_tail.js                 # 最终导出与入口函数
```

拆分的依据包括：
- **字符串特征**：API 端点出现的区域是 API 客户端模块；Git 命令字符串聚集的区域是 Git 模块
- **函数调用图**：互相调用频繁的函数倾向于属于同一模块
- **第三方库边界**：内联的第三方库（如 parse5、Commander.js）有明显的代码风格差异
- **注释与版权声明**：部分内联库保留了原始的 license 头部注释

### Step 4：函数识别与语义推测

混淆后的函数名（如 `av()`、`xi1()`、`mH_`）没有语义信息。推测其含义需要多维线索：

| 线索来源 | 方法 | 示例 |
|----------|------|------|
| **字符串常量** | 函数内使用的字符串暗示功能 | 包含 `"max_tokens"` → 可能是 token 限制检查 |
| **参数结构** | 参数名有时保留了语义 | `{ agentDefinition, promptMessages }` → Agent 入口 |
| **调用上下文** | 被谁调用、调用了谁 | 被主循环调用 + 调用 API → 模型调用函数 |
| **返回值模式** | 返回类型暗示功能 | `yield { type: "assistant" }` → 消息生成器 |
| **API 文档** | Claude API 的公开文档 | SSE 事件类型匹配 → 流式处理函数 |
| **同类对比** | 与其他开源 Agent 对比 | 类似 LangChain 的 AgentExecutor → Agent 主循环 |

本书全篇采用 `混淆名()` (推测语义名) 的标注格式。例如：

> `av()` (agentExecute) — Agent 执行入口

前者是 bundle 中的真实标识符，后者是基于行为分析推测的语义名。读者可以通过混淆名在源码中定位函数，通过语义名理解其功能。

### 分析的局限性

反编译分析有固有的局限：

- **语义推测可能有误** — 没有原始源码验证，推测的函数名是"最佳猜测"
- **内部逻辑可能遗漏** — 高度压缩的三元表达式和逗号运算符链难以完全解读
- **版本特定** — 本书基于 v2.1.86，后续版本可能有重大变化
- **编译期开关** — 某些功能（如 VCR 测试模式）通过硬编码 `false` 禁用，在发布版中不可达

---

## 2.5 运行时架构预览

当用户在终端输入 `claude` 并按下回车，会发生什么？在深入后续章节之前，先从最高层次预览一下整个启动和运行流程。

### 启动序列

```
用户输入: $ claude
    │
    ▼
cli.mjs
    │  薄包装层，import main.mjs
    ▼
xyK() (main)                              ← 19_tail.js
    │
    ├── 1. 进程初始化
    │     ├── 注册信号处理器（SIGINT 等）
    │     ├── 检测入口类型（cli / sdk / mcp / action）
    │     ├── 确定客户端类型（cli / remote / vscode）
    │     └── 加载全局设置
    │
    ├── 2. CLI 解析
    │     ├── Commander.js 解析 process.argv
    │     ├── 注册子命令（mcp / update / config / ...）
    │     └── 路由到对应处理函数
    │
    ├── 3. 认证检查
    │     ├── API Key 验证
    │     ├── OAuth 令牌检查
    │     └── 必要时启动 OAuth 流程
    │
    ├── 4. 进入交互模式
    │     ├── 初始化 Ink/React 终端 UI
    │     ├── 渲染欢迎信息和输入框
    │     └── 等待用户输入
    │
    └── 5. 用户提交查询
          │
          ▼
      av() (agentExecute)                  ← 13_ui_rendering.js
          │
          ├── 收集上下文（CLAUDE.md、git status）
          ├── 构建 System Prompt
          └── 进入 Agentic Loop
                │
                ▼
            xi1() (mainLoop)               ← 14_html_parser.js
                │
                ├── Phase 1: 上下文压缩
                ├── Phase 2: API 调用（流式）
                ├── Phase 3: 终止判断
                ├── Phase 4: 工具执行
                ├── Phase 5: 轮数检查
                └── Phase 6: 组装下一轮 → 回到 Phase 1
```

### 核心模块与本书章节映射

以下表格将 19 个反编译模块映射到本书的章节结构，帮助读者快速定位感兴趣的内容：

| 模块文件 | 功能领域 | 对应章节 |
|----------|---------|---------|
| 01_runtime_bootstrap.js | 模块系统、运行时 | 本章（第 2 章） |
| 02_api_client.js | API 客户端 | [第 5 章](../part-2/ch05-api-client.md) |
| 03_file_system.js | 文件操作工具 | [第 10 章](../part-3/ch10-file-io-tools.md) |
| 04_git_operations.js | Git 集成 | [第 11 章](../part-3/ch11-git-integration.md) |
| 05_config_settings.js | 配置系统 | [第 13 章](../part-4/ch13-config-permission.md) |
| 06_permission_system.js | 权限与沙箱 | [第 13 章](../part-4/ch13-config-permission.md)、[第 14 章](../part-4/ch14-sandbox.md) |
| 07_crypto_encoding.js | 加密编码 | （分散在各章） |
| 08_system_prompt.js | System Prompt | [第 6 章](../part-2/ch06-system-prompt.md) |
| 09_data_processing.js | 数据处理 | （分散在各章） |
| 10_tool_bash.js | Bash 工具 | [第 9 章](../part-3/ch09-bash-tool.md) |
| 11_api_streaming.js | 流式处理、工具注册 | [第 4 章](../part-2/ch04-agentic-loop.md)、[第 8 章](../part-3/ch08-tool-system.md) |
| 12_computer_use.js | Computer Use | （本书未深入） |
| 13_ui_rendering.js | 终端 UI | [第 18 章](../part-4/ch18-terminal-ui.md) |
| 14_html_parser.js | HTML 解析 | （辅助模块） |
| 15_hooks_system.js | Hooks 系统 | [第 15 章](../part-4/ch15-hooks-system.md) |
| 16_commands_slash.js | Slash 命令 | [第 17 章](../part-4/ch17-slash-commands.md) |
| 17_system_prompt_full.js | 完整 Prompt 文本 | [第 6 章](../part-2/ch06-system-prompt.md) |
| 18_sdk_examples.js | SDK 文档 | （参考资料） |
| 19_tail.js | 入口与导出 | 本章（第 2 章）、[第 4 章](../part-2/ch04-agentic-loop.md) |

### 运行时依赖关系

从模块拆分中可以看到，Claude Code 的运行时架构呈**分层**结构：

```
┌─────────────────────────────────────────────────────────┐
│                    入口层 (Entry)                        │
│   cli.mjs → xyK() → Commander.js CLI 解析               │
│   19_tail.js                                            │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                    UI 层 (Rendering)                     │
│   Ink/React 终端渲染 · 主题 · 输入处理                    │
│   13_ui_rendering.js                                    │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                  Agent 核心层 (Core)                     │
│   Agentic Loop · System Prompt · Context 管理            │
│   08_system_prompt.js · 14_html_parser.js               │
│   17_system_prompt_full.js                              │
└────────┬───────────────┼───────────────┬────────────────┘
         │               │               │
┌────────▼────────┐ ┌────▼─────────┐ ┌───▼──────────────┐
│   API 通信层    │ │  工具执行层   │ │   安全层          │
│  API Client    │ │  Bash/File   │ │  Permission      │
│  Streaming     │ │  Git/MCP     │ │  Hooks/Sandbox   │
│  02,11         │ │  03,04,10,12 │ │  05,06,15        │
└────────────────┘ └──────────────┘ └──────────────────┘
         │               │               │
┌────────▼───────────────▼───────────────▼────────────────┐
│                  基础设施层 (Infrastructure)              │
│   Module System · Crypto · Data Processing              │
│   01_runtime_bootstrap.js · 07 · 09                     │
└─────────────────────────────────────────────────────────┘
```

这个分层结构将在第 3 章（架构总览）中更详细地展开。这里只需建立一个直觉：Claude Code 不是一个"调 API 的脚本"，而是一个有着完整分层架构的**工程系统**。

---

## 2.6 构建内幕：从源码到 npm 包

通过分析 bundle 中残留的构建信息（debug 路径、native 模块的编译元数据），我们可以还原 Anthropic 的内部构建流程的一些细节。

### 内部代码库

| 信息 | 来源 | 值 |
|------|------|-----|
| 主仓库名 | native 模块路径泄露 | `claude-cli-internal` |
| monorepo 名 | CI 构建路径泄露 | `apps`（`packages/desktop/`） |
| 运行时 | bundle 头部注释 | Bun v1.3.11 (JavaScriptCore) |
| 内部 Rust 仓库 | Cargo 注册表 | `artifactory.infra.ant.dev` |

这些信息来自 native 模块中残留的**调试符号** — Rust 和 Swift 编译器会将源文件路径嵌入二进制文件。例如，image-processor 模块中的路径 `/Users/atp/code/claude-cli-internal/vendor/image-processor-src/` 泄露了开发者用户名和仓库结构。

### 构建环境

分析 native 模块中的编译信息，可以识别出三个不同的构建者：

```
构建者 1: atp (本地开发机)
    └── 编译 image-processor.node (Rust/napi, arm64)

构建者 2: qing (本地开发机)
    └── 编译 audio-capture.node (Rust/napi, arm64)

构建者 3: runner (GitHub Actions CI)
    ├── 编译 computer-use-input.node (Rust/napi, arm64 + x86_64)
    └── 编译 computer-use-swift.node (Swift, arm64 + x86_64)
```

> **设计决策**：混合构建流程 — 部分 native 模块在开发者本地机器上编译，部分在 CI 中编译。这说明 image-processor 和 audio-capture 的开发迭代更频繁，开发者倾向于本地编译以加速开发循环；而 computer-use 相关模块更稳定，走标准的 CI 流程。

### esbuild 打包签名

bundle 代码的开头几十行是 esbuild 生成的**模块系统 polyfill** — 一套用于模拟 CommonJS `require()`/`exports` 行为的辅助函数。这是 esbuild 的标志性特征：

```javascript
// esbuild 生成的模块系统 (01_runtime_bootstrap.js 开头)
var Go9 = Object.create;
var { getPrototypeOf: Ro9, defineProperty: _4H,
      getOwnPropertyNames: ca_, getOwnPropertyDescriptor: Zo9
    } = Object, z9_ = Object.prototype.hasOwnProperty;

// d() — 延迟模块加载器（esbuild 的 __commonJS 模式）
var d = (H, _) => () => (_ || H((_ = { exports: {} }).exports, _), _.exports);
```

`d()` 函数（`__commonJS` 的混淆形式）是 esbuild 的核心模式之一。它实现了**延迟加载** — 模块代码只在第一次被引用时执行，之后复用缓存的 `exports` 对象。这确保了 bundle 中数百个内联模块不会在启动时全部执行，只有实际被 `require()` 的模块才会初始化。

---

## 小结

本章从"用户执行 `npm install`"的视角出发，逐层揭示了 Claude Code npm 包的内部结构：

| 层次 | 关键发现 |
|------|---------|
| **安装方式** | 标准 npm 全局安装，需要 Node.js 18+，`claude` 命令指向 `cli.mjs` 入口 |
| **包结构** | 一个 12MB 的主 bundle + 4 个 native 模块，没有 `node_modules` |
| **打包方式** | esbuild 单文件打包，所有依赖内联，变量名混淆但字符串保留 |
| **反编译方法** | 格式化 → 拆分 19 个模块 → 函数识别与语义推测 |
| **运行时架构** | 5 层分层结构：入口 → UI → Agent 核心 → API/工具/安全 → 基础设施 |

理解了"分析对象长什么样"，我们就可以开始深入每一层的具体实现。下一章将从架构总览开始，建立 Claude Code 核心模块之间的全局关系图 — 为后续各章的深度拆解提供导航。
