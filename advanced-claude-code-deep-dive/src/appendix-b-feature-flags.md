# 附录 B：Feature Flag 完整索引

> 本附录汇总 Claude Code v2.1.86 源码中通过 `feature('FLAG_NAME')` 引用的所有编译期 feature flag，按功能域分类，标注成熟度、用途及本书讨论章节。

---

## 1. 机制概述

Claude Code 使用 Bun 的 `bun:bundle` 提供的编译期 feature flag 系统。核心 API：

```typescript
import { feature } from 'bun:bundle'

if (feature('FLAG_NAME')) {
  const mod = require('./experimental-module.js')
  // 使用实验性功能
}
```

**关键特性**：

| 特性 | 说明 |
|:-----|:-----|
| **编译时求值** | `feature('X')` 在构建时被替换为 `true` 或 `false` 字面量 |
| **Dead Code Elimination** | 值为 `false` 时，整个分支（含 `require()`）被 tree-shaking 移除 |
| **必须内联** | `feature()` 调用必须出现在 `if`/三元表达式中，不能赋值到变量后传递 |
| **零运行时开销** | 未启用的功能代码完全不存在于最终二进制中 |
| **代码级隔离** | 内部 flag 名称和相关代码不会泄漏到外部构建 |

> 与运行时 feature flag（GrowthBook / Statsig）互补：编译时 flag 做功能隔离，运行时 flag 做灰度发布和 A/B 测试。

详见：[第 2 章 §2.6](part-1/ch02-installation-packaging.md)、[第 4 章 §4.16](part-2/ch04-agentic-loop.md)、[第 6 章 §6.6](part-2/ch06-system-prompt.md)、[第 26 章 §26.5](part-6/ch26-design-philosophy.md)

---

## 2. 成熟度图例

| 标记 | 含义 | 说明 |
|:-----|:-----|:-----|
| 🟢 | 已公开/活跃 | 外部构建中启用，用户可用 |
| 🟡 | 实验性/灰度 | 部分用户可用，可能随时变更 |
| 🔴 | 内部/预发布 | 仅 `ant`（Anthropic 内部）构建可用 |
| ⚪ | 不确定 | 源码中存在但成熟度不明 |

---

## 3. 完整 Feature Flag 索引

### 3.1 上下文管理域

| Flag | 成熟度 | 用途 | 说明 | 讨论章节 |
|:-----|:------:|:-----|:-----|:---------|
| `REACTIVE_COMPACT` | 🟡 | 响应式上下文压缩 | prompt-too-long 时自动触发压缩恢复 | Ch04, Ch07 |
| `CONTEXT_COLLAPSE` | 🟡 | 上下文折叠 | 渐进式上下文管理，折叠旧对话轮次 | Ch07, Ch29 |
| `HISTORY_SNIP` | 🟡 | 历史裁剪 | 长会话中裁剪早期历史，保留近期上下文 | Ch07, Ch25 |
| `CACHED_MICROCOMPACT` | 🟡 | 缓存微压缩 | 利用 cache_edits 优化微压缩效果 | Ch04, Ch06 |
| `TOKEN_BUDGET` | ⚪ | Token 预算控制 | 自动继续（auto-continue）功能的预算管理 | Ch02 |

### 3.2 多 Agent 与协作域

| Flag | 成熟度 | 用途 | 说明 | 讨论章节 |
|:-----|:------:|:-----|:-----|:---------|
| `COORDINATOR_MODE` | 🔴 | 协调器模式 | 管理多个 Worker Agent 的编排系统 | Ch21, Ch25, Ch29 |
| `FORK_SUBAGENT` | 🔴 | Fork 子 Agent | 通过进程 fork 实现廉价并行子代理 | Ch02, Ch25 |
| `UDS_INBOX` | 🔴 | Unix Domain Socket | Agent 间进程内通信通道 | Ch02, Ch25, Ch26 |

### 3.3 IDE 集成与远程控制域

| Flag | 成熟度 | 用途 | 说明 | 讨论章节 |
|:-----|:------:|:-----|:-----|:---------|
| `BRIDGE_MODE` | 🟡 | 桥接模式 | Claude Desktop ↔ Claude Code 双向连接 | Ch20, Ch29 |
| `CCR_AUTO_CONNECT` | 🔴 | CCR 自动连接 | Claude Code Remote 自动连接 | Ch29 |
| `CCR_MIRROR` | 🔴 | CCR 镜像 | Claude Code Remote 镜像模式 | Ch29 |
| `TERMINAL_PANEL` | 🔴 | 终端面板 | IDE 内嵌终端面板 | Ch29 |

### 3.4 主动行为与调度域

| Flag | 成熟度 | 用途 | 说明 | 讨论章节 |
|:-----|:------:|:-----|:-----|:---------|
| `KAIROS` | 🔴 | 助手模式 | 长期运行的 Assistant 模式，时间感知系统 | Ch24, Ch25, Ch29 |
| `PROACTIVE` | 🔴 | 主动行为 | Agent 主动通知、Sleep/唤醒机制 | Ch06, Ch25, Ch29 |
| `AGENT_TRIGGERS` | 🔴 | 触发器 | Cron 定时任务工具 | Ch24, Ch26, Ch29 |
| `AGENT_TRIGGERS_REMOTE` | 🔴 | 远程触发器 | 远程触发器管理 | Ch29 |
| `MONITOR_TOOL` | 🔴 | 监控工具 | 系统监控与观测 | Ch29 |

### 3.5 安全与分类域

| Flag | 成熟度 | 用途 | 说明 | 讨论章节 |
|:-----|:------:|:-----|:-----|:---------|
| `BASH_CLASSIFIER` | 🟡 | Bash 命令安全分类 | AI 驱动的 Bash 命令风险评估 | Ch26, Ch29 |
| `TRANSCRIPT_CLASSIFIER` | 🟡 | 对话轨迹安全分类 | 对话内容安全审计与分类 | Ch23, Ch26, Ch29 |

### 3.6 交互模式域

| Flag | 成熟度 | 用途 | 说明 | 讨论章节 |
|:-----|:------:|:-----|:-----|:---------|
| `VOICE_MODE` | 🟡 | 语音模式 | 语音流交互输入 | Ch22, Ch29 |
| `BUDDY` | 🔴 | 伴侣模式 | 实验性 UI / 虚拟伴侣（含愚人节彩蛋窗口） | Ch02, Ch25 |
| `DAEMON` | 🔴 | 后台守护进程 | Claude Code 常驻后台运行 | Ch25 |
| `BG_SESSIONS` | ⚪ | 后台会话 | `claude ps` 任务摘要、后台任务管理 | Ch02 |

### 3.7 工具与扩展域

| Flag | 成熟度 | 用途 | 说明 | 讨论章节 |
|:-----|:------:|:-----|:-----|:---------|
| `WEB_BROWSER_TOOL` | 🔴 | 浏览器工具 | 浏览器交互操作 | Ch26, Ch29 |
| `CHICAGO_MCP` | 🔴 | Computer Use MCP | 屏幕操作（Computer Use Agent） | Ch02, Ch29 |
| `WORKFLOW_SCRIPTS` | 🔴 | 工作流脚本 | 可编排的任务流引擎 | Ch02, Ch25, Ch26 |
| `EXPERIMENTAL_SKILL_SEARCH` | 🔴 | Skill 搜索 | AI 驱动的 Skill 自动发现 | Ch02, Ch25 |
| `ULTRAPLAN` | 🔴 | 超级计划 | 高级规划工具（ant-only） | Ch02, Ch25 |
| `TORCH` | 🔴 | 未知 | 源码中存在但用途不明 | Ch25 |

### 3.8 记忆与数据域

| Flag | 成熟度 | 用途 | 说明 | 讨论章节 |
|:-----|:------:|:-----|:-----|:---------|
| `EXTRACT_MEMORIES` | 🔴 | 记忆提取 | 从对话中自动提取结构化记忆 | Ch25 |
| `COMMIT_ATTRIBUTION` | ⚪ | 提交归属 | Git 提交中标注 AI 贡献 | Ch25 |
| `FILE_PERSISTENCE` | ⚪ | 文件持久化 | 跨会话文件状态持久化 | Ch25 |
| `BREAK_CACHE_COMMAND` | ⚪ | 缓存破坏命令 | 手动清除 prompt cache | Ch25 |

---

## 4. 统计概览

```
Feature Flag 统计：

总计           33 个
├── 🟢 已公开    0 个（核心功能无需 flag，始终启用）
├── 🟡 实验性    8 个
├── 🔴 内部     21 个
└── ⚪ 不确定    4 个

按功能域：
├── 上下文管理    5 个
├── 多 Agent      3 个
├── IDE/远程      4 个
├── 主动/调度     5 个
├── 安全/分类     2 个
├── 交互模式      4 个
├── 工具/扩展     6 个
└── 记忆/数据     4 个
```

---

## 5. 与运行时 Feature Flag 的关系

Claude Code 同时使用两套 feature flag 系统：

| 维度 | 编译时 (`bun:bundle`) | 运行时 (GrowthBook/Statsig) |
|:-----|:---------------------|:---------------------------|
| **求值时机** | 构建阶段 | 程序运行中 |
| **切换粒度** | 需要重新构建发布 | 实时远程切换 |
| **典型用途** | 功能隔离（内部/外部） | A/B 测试、灰度发布、参数调优 |
| **代码影响** | 未启用 → 代码完全不存在 | 未启用 → 代码存在但不执行 |
| **安全性** | 高（逆向工程也看不到） | 中（代码在二进制中，仅逻辑跳过） |
| **本书关注** | 本附录 | Ch05 §5.6, Ch08 §8.7 |

运行时 flag 的典型用例包括：
- `tengu_session_memory`：控制 Session Memory 功能（见第 8 章 §8.7）
- `getPromptCache1hEligible()`：1 小时 prompt cache 白名单（见第 5 章 §5.6）
- Bridge 轮询间隔、心跳频率等运维参数（见第 20 章 §20.8）

---

## 6. 如何在源码中追踪 Feature Flag

```bash
# 搜索所有编译时 feature flag
grep -rn "feature('" src/ | grep -oP "feature\('\K[^']+'" | sort -u

# 搜索运行时 flag（GrowthBook）
grep -rn "getFeatureValue\|isFeatureEnabled\|gb\." src/ --include="*.ts"

# 查看某个 flag 的所有引用点
grep -rn "feature('KAIROS')" src/
```

> **注意**：以上命令针对 Claude Code 源码仓库。外部构建的二进制文件中，被禁用的 flag 及其相关代码已被完全移除，无法通过反编译恢复。

---

*本附录基于 Claude Code v2.1.86 源码分析。Feature flag 列表可能随版本更新而变化，部分 flag 可能在后续版本中被移除、重命名或正式发布。*
