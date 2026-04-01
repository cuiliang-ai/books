
# 第 24 章：定时任务与调度系统 — Agent 的时间感知

> **核心问题**：一个只在对话轮次中运行的 Agent，如何获得"时间感"——在未来某个时刻自动唤醒并执行任务？这个看似简单的能力背后，隐藏着 Agent 从"被动工具"走向"主动助手"的深刻范式转变。

---

## 24.1 从被动到主动：Agent 的三个时代

### 第一时代：被动触发

最原始的 Agent 架构是纯粹的请求-响应：用户说一句，Agent 做一件事，然后沉默等待下一次输入。

```
用户: "帮我查一下 PR 状态"
Agent: （查询，返回结果）
... 沉默 ...
用户: "再帮我查一下"      ← 必须人工重复
Agent: （查询，返回结果）
... 沉默 ...
```

这就是 Claude Code 最初的形态——一个强大但**没有时间维度**的工具。

### 第二时代：Cron 定时触发

人类的工作方式天然是时间驱动的：每天早上 9 点检查 PR、每小时跑一次测试、下午 3 点参加会议。Claude Code 的定时调度系统让 Agent 第一次拥有了**不依赖人类输入的行动能力**：

```
用户: "每小时帮我查一下 PR 状态"
Agent: （设定 cron 任务）
... 1 小时后 ...
Agent: （自动唤醒，查询，推送结果）  ← 无需人类触发
... 1 小时后 ...
Agent: （自动唤醒，查询，推送结果）
```

用户仍然设定规则，但执行是自动的。**触发者从人变成了时钟。** 这就是本章要深入剖析的系统。

### 第三时代：24 小时主动触发

源码中已经能看到第三个时代的骨架。在这个阶段，触发者不再是用户设定的时钟规则，而是 Agent 自身对环境的感知：

```
Agent: （检测到 PR 有新评论，主动通知你）
Agent: （发现 CI 失败，自动分析原因并修复）
Agent: （感知到一天结束，主动整理当天工作摘要）
Agent: （在空闲时"做梦"，自动整合近期对话为持久化记忆）
```

源码中的证据：

| Feature Flag | 能力 | 触发方式 |
|:-------------|:-----|:---------|
| `AGENT_TRIGGERS` | 定时执行（CronCreate/Delete/List） | 时钟 |
| `AGENT_TRIGGERS_REMOTE` | 响应外部 webhook | 事件 |
| `KAIROS_GITHUB_WEBHOOKS` | 监听 GitHub PR 事件 | 事件 |
| `KAIROS_CHANNELS` | 多通道通知（终端 + 推送） | 环境 |
| `PROACTIVE` | 基于上下文主动行动 | 环境感知 |
| `MONITOR_TOOL` | 监控文件/日志变化 | 事件 |

**Cron 是从第一时代到第三时代的桥梁。** 它是 Agent 获得自主性的第一步——虽然规则仍由人类设定，但执行已经不需要人的参与。而每一步自主性的增加，都同时要求一套对称的**约束机制**：jitter 防止负载洪峰，7 天过期防止无限运行，workload 标注允许 QoS 降级。

这章的核心命题是：**赋予 Agent 能力的同时，如何精确地约束这些能力？**

---

## 24.2 KAIROS：Cron 最重要的消费者

在深入技术细节之前，有必要先理解 cron 系统存在的"大背景"。

### KAIROS 是什么

KAIROS（希腊语 καιρός，"恰当的时机"）是 Claude Code 的**常驻智能助手模式**，在 `src/assistant/` 目录下实现，通过 `feature('KAIROS')` 编译时门控。与标准 CLI 的"一问一答"不同，KAIROS 模式下 Claude：

- 始终在后台运行，持有项目上下文
- 通过定时任务自动执行例行检查
- 在 Brief 模式下工作——通过 `SendUserMessage` 发送简洁状态更新
- 支持 session 持久化和恢复（`--session-id`、`--continue`）

KAIROS 安装时会预写入几个**永不过期**的 cron 任务到 `scheduled_tasks.json`：

| 任务 | 功能 |
|------|------|
| `morning-checkin` | 每天工作日早上提供项目状态摘要 |
| `catch-up` | 定时检查新事件并更新上下文 |
| `dream` | 记忆整合：在空闲期合成近期对话为持久化记忆 |

### Cron 独立于 KAIROS

但 cron 系统本身**不依赖 KAIROS**。`prompt.ts` 中的注释明确指出：

> AGENT_TRIGGERS is independently shippable from KAIROS — the cron module graph has zero imports into src/assistant/ and no feature('KAIROS') calls.

Cron 使用的是 `feature('AGENT_TRIGGERS')`，与 `feature('KAIROS')` 的导入图**完全隔离**。这意味着 cron 功能可以（也已经）在不启用 KAIROS 的情况下独立发布为 GA 功能（`/loop` 命令）。

这个架构决策的含义深远：**时间感知是 Agent 的基础能力**，而非某个高级模式的附属功能。就像文件读写不需要"高级模式"才能使用一样，定时调度也应该是 Agent 的原生能力。

### autoDream：Agent 的"睡眠与记忆整合"

最能体现第三时代雏形的是 `services/autoDream/` —— 当满足条件时（上次整合 ≥24 小时、≥5 个新会话），自动发起一个 forked subagent 执行记忆整合：

```
Phase 1 — Orient    → ls 记忆目录，理解现有结构
Phase 2 — Gather    → grep 近期会话转录，寻找新信息
Phase 3 — Consolidate → 合并新信息到记忆文件，避免重复
Phase 4 — Reindex   → 更新 CLAUDE.md 索引
```

这不是用户说"整理一下记忆"触发的，而是 Agent **自己判断时机**然后执行的。它甚至有自己独立的 gate `isAutoDreamEnabled()`，注释说："Extracted from dream.ts so auto-dream ships independently of KAIROS feature flags"。

---

## 24.3 架构总览

### 核心组件

定时调度系统由六个核心模块组成，形成清晰的分层架构：

```
用户请求 "每小时检查部署"
        │
        ▼
┌─────────────────────────────┐
│  /loop Skill (语法糖)        │  ← skills/bundled/loop.ts
│  解析 "5m /babysit-prs"      │
│  → interval + prompt         │
└────────────┬────────────────┘
             │ 调用
             ▼
┌─────────────────────────────┐
│  CronCreate / Delete / List │  ← tools/ScheduleCronTool/
│  (三个 Tool 实现)            │
│  输入验证 / 权限 / UI 渲染   │
└────────────┬────────────────┘
             │ 写入
             ▼
┌─────────────────────────────┐
│  cronTasks.ts (数据层)       │  ← utils/cronTasks.ts
│  读写 scheduled_tasks.json  │
│  Session 内存 / 磁盘持久化   │
└────────────┬────────────────┘
             │ 驱动
             ▼
┌─────────────────────────────┐
│  cronScheduler.ts (调度核心)│  ← utils/cronScheduler.ts
│  1s 轮询 / chokidar 监听    │
│  任务触发 / 过期回收          │
├─────────────────────────────┤
│  cron.ts (Cron 解析器)       │  ← utils/cron.ts
│  5 字段标准 cron / DST 处理  │
├─────────────────────────────┤
│  cronTasksLock.ts (调度锁)  │  ← utils/cronTasksLock.ts
│  跨进程互斥 / PID 活性探测   │
├─────────────────────────────┤
│  cronJitterConfig.ts (抖动) │  ← utils/cronJitterConfig.ts
│  GrowthBook 动态配置         │
└─────────────────────────────┘
             │ 触发
             ▼
┌─────────────────────────────┐
│  REPL 消息队列              │  ← hooks/useScheduledTasks.ts
│  enqueuePendingNotification │
│  prompt 注入到对话流         │
└─────────────────────────────┘
```

### 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `utils/cron.ts` | ~310 | Cron 表达式解析、next-run 计算、人类可读转换 |
| `utils/cronTasks.ts` | ~460 | 任务 CRUD、Jitter 计算、missed 检测 |
| `utils/cronScheduler.ts` | ~530 | 调度引擎核心：轮询 / 触发 / 过期 / 锁协调 |
| `utils/cronTasksLock.ts` | ~196 | 跨进程调度锁（O_EXCL + PID 探测） |
| `utils/cronJitterConfig.ts` | ~76 | GrowthBook 动态 jitter 参数 |
| `tools/ScheduleCronTool/*.ts` | ~400 | 三个 Tool 实现 + Prompt + UI |
| `hooks/useScheduledTasks.ts` | ~140 | React Hook，REPL 端调度器生命周期 |
| `skills/bundled/loop.ts` | ~93 | `/loop` 语法糖 Skill |

---

## 24.4 Cron 解析器：零依赖的极简实现

Claude Code 没有引入 `cron-parser` 或 `node-cron`，而是在 `cron.ts` 中从零实现了标准 5 字段 cron 解析器。支持通配符、步进（`*/5`）、范围（`1-5`）、范围步进（`1-30/2`）和列表（`1,15,30`）。不支持 L/W/?/名称别名——这些对"提醒我下午 3 点"的典型用例毫无必要。

### 值得关注的三个设计点

**1. 跳跃式搜索**

`computeNextCronRun()` 不是逐分钟暴力遍历。当月份不匹配时直接跳到下月 1 日，日期不匹配跳到次日，小时不匹配跳到下一小时。最坏情况遍历 366 天×24 小时×60 分钟 = 527,040 次，但实际场景中通常几步内就命中。

**2. DOM/DOW 的 OR 语义**

当 dayOfMonth 和 dayOfWeek 同时被约束时，标准 cron 采用 OR 语义——只要日期或星期任一匹配即可。这与 vixie-cron 行为一致，但容易让人直觉上误解为 AND：

```typescript
// 都约束了 → OR（不是 AND！）
domSet.has(dom) || dowSet.has(dow)
```

**3. DST 无需特殊代码**

所有时间运算使用本地时间 API（`getHours()` / `getMinutes()`），DST 转换自然处理：Spring Forward 时"不存在的 2:30"匹配不到就跳过，Fall Back 时"重复的 2:00"只触发一次。

### cronToHuman：80/20 原则

`cronToHuman()` 故意只覆盖常见模式（`*/N * * * *`、`M H * * *`、`M H * * D`、`M H * * 1-5`），不常见的直接返回原始 cron 字符串。还处理了一个微妙问题——UTC cron 在半时区偏移国家（如印度 UTC+5:30）可能跨日，需要用实际 Date 对象推算本地星期。

---

## 24.5 任务数据模型：能力与约束的共生

### CronTask 类型

```typescript
type CronTask = {
  id: string           // 8 位 hex（UUID 前 8 字符）
  cron: string         // 5 字段 cron 表达式
  prompt: string       // 触发时注入的 prompt
  createdAt: number    // 创建时间（epoch ms）
  lastFiredAt?: number // 上次触发时间（仅 recurring）
  recurring?: boolean  // true = 周期性
  permanent?: boolean  // true = 豁免自动过期
  durable?: boolean    // 运行时标记：false = session-only
  agentId?: string     // 运行时标记：创建此任务的 teammate
}
```

这个类型定义中，**每个"能力"字段旁边都有一个"约束"字段**：

| 能力 | 约束 | 为什么需要约束 |
|------|------|---------------|
| `recurring: true`（永续执行） | 7 天自动过期 | P99 会话时长从 61min 暴涨到 53h，内存泄漏无限累积 |
| `durable: true`（跨会话持久化） | GrowthBook kill switch | 磁盘持久化引入锁、文件 I/O 复杂度 |
| `permanent: true`（永不过期） | 仅限 assistant mode 内置 | 不通过 CronCreateTool 暴露，防止用户绕过过期策略 |
| `agentId`（teammate 创建） | teammate 消亡后自动清理孤儿 cron | 避免向死 teammate 无限触发 |

### 双轨存储：简单路径不付复杂代价

```
durable: false（默认）              durable: true
┌──────────────────────┐          ┌──────────────────────────────┐
│  bootstrap/state.ts   │          │  .claude/scheduled_tasks.json │
│  (进程内存)            │          │  (磁盘文件)                    │
│                       │          │                              │
│  ✓ 无文件 I/O          │          │  ✓ 跨会话持久化                │
│  ✓ 无锁               │          │  ✗ 需要 chokidar 监听          │
│  ✓ 对其他会话不可见     │          │  ✗ 需要跨进程调度锁             │
│  ✗ 进程退出即消失       │          │  ✗ 需要 missed 检测             │
└──────────────────────┘          └──────────────────────────────┘
```

大多数使用场景是"提醒我 5 分钟后做某事"——这不需要写磁盘、不需要跨会话、不需要锁。只有用户明确说"永久设置"时才走完整的磁盘路径。这避免了"为了支持最复杂的场景而让所有场景都变复杂"的工程陷阱。

### permanent：不可重建问题

`permanent` 字段的存在揭示了一个有趣的工程困境。KAIROS 安装脚本使用 `writeIfMissing()`——如果 `scheduled_tasks.json` 已存在就跳过写入。这意味着如果 permanent 任务被过期删除了，**重新安装也无法恢复它**。所以 permanent 任务必须豁免自动过期。

这是一个"先有鸡还是先有蛋"的设计约束：过期策略保护系统资源 → 但某些系统任务不能被过期 → 所以需要一个逃生舱 → 但逃生舱不能暴露给用户 → 所以 `permanent` 不通过 `CronCreateTool` 设置，只能直接写入 JSON 文件。

### 读写安全

`readCronTasks()` 对每条任务**独立验证**——单个记录字段缺失或 cron 无效只会跳过该条目，不会阻塞整个文件。`writeCronTasks()` 会 strip 掉运行时专有字段（`durable`、`agentId`），保持磁盘文件的干净形态。

---

## 24.6 调度引擎：时钟的心跳

`cronScheduler.ts` 是整个系统的心脏——一个非 React 的纯 TypeScript 调度器。

### 生命周期

```
start()
  │
  ├─ 已启用？─── 是 ──→ enable()
  │                       │
  │   否                  ├─ 获取调度锁
  │   │                   ├─ 首次加载任务 + 处理 missed
  │   ▼                   ├─ chokidar 监听文件变化
  │  enablePoll           └─ 启动 1s 检查计时器
  │  (1s 轮询等待)
  │   │
  │   ▼
  │  CronCreate 调用时
  │  setScheduledTasksEnabled(true)
  │   → enable()
  │
check() ← 每 1 秒
  │
  ├─ isKilled?  → 停止（GrowthBook mid-session kill switch）
  ├─ isLoading? → 跳过（不在 LLM 回复中途插入）
  │
  ├─ 遍历文件任务（仅 lock owner）
  │   └─ 首次见到 → 计算 nextFireAt（含 jitter）
  │   └─ now >= nextFireAt → 触发！
  │       ├─ recurring    → 从 now 重算 nextFireAt
  │       ├─ one-shot     → 删除
  │       └─ aged（>7天）  → 最后一次触发后删除
  │
  └─ 遍历 session 任务（无需锁）
```

### 锚点选择：一个微妙但关键的决策

调度器第一次看到一个任务时，需要计算 nextFireAt。**从哪个时间点开始算**直接影响正确性：

```typescript
next = t.recurring
  ? jitteredNextCronRunMs(t.cron, t.lastFiredAt ?? t.createdAt, ...)
  : oneShotJitteredNextCronRunMs(t.cron, t.createdAt, ...)
```

| 场景 | 锚点 | 为什么 |
|------|------|--------|
| 从未触发的 recurring | `createdAt` | 从 `now` 锚定会让 pinned cron（`30 14 27 2 *`）算出一年后的下次触发 |
| 曾触发过的 recurring | `lastFiredAt` | 进程重启后能重建与上次相同的 nextFireAt |
| One-shot | `createdAt` | "下次"就是创建后的第一次匹配 |

注释中有一句令人警醒的话：

> Without this, a daemon child despawning on idle loses nextFireAt and the next spawn re-anchors from 10-day-old createdAt → fires every task every cycle.

如果锚点选错，daemon 模式下每次子进程重启都会从 10 天前的 createdAt 重新算起，导致所有任务在每个 tick 都触发。

### 过期回收：能力的时间约束

引入 cron 后的一个惊人数据：

> P99 session uptime 61min → 53h post-#19931

一个"每小时检查 PR"的 cron 任务会让 Claude Code 进程**持续运行数天**。无限的 recurring 任务让内存泄漏持续累积。7 天自动过期是在"覆盖一周工作流"和"防止资源耗尽"之间的平衡——过期的 recurring 任务触发最后一次，然后被删除。

### Missed 任务：离线期间的温柔恢复

Claude 重启时，调度器检查在离线期间本应触发的 one-shot 任务（recurring 任务不需要——下一个 tick 自然触发）。通知文本的构造方式体现了安全意识——用动态长度的代码围栏包裹 prompt 内容：

```typescript
// 围栏比 prompt 中最长的反引号序列多一个，防止 prompt injection
const longestRun = (t.prompt.match(/`+/g) ?? []).reduce(
  (max, run) => Math.max(max, run.length), 0,
)
const fence = '`'.repeat(Math.max(3, longestRun + 1))
```

### 触发后的五条路径

| 任务类型 | 存储 | 触发后动作 |
|---------|------|-----------|
| One-shot session | 内存 | 同步删除，无 I/O |
| One-shot file | 磁盘 | 异步删除 + `inFlight` Set 防重复触发 |
| Recurring session | 内存 | 从 `now` 重算 nextFireAt |
| Recurring file | 磁盘 | 批量 `markCronTasksFired()` 写回 lastFiredAt |
| Aged recurring | 同上 | 触发最后一次，走 one-shot 删除路径 |

`inFlight` 机制值得注意——文件任务的 `removeCronTasks()` 是异步的，在它完成之前 chokidar 可能触发文件变更回调导致重新加载，如果不防护就会在下一个 tick 重复触发。

---

## 24.7 雷群效应：赋予能力后的第一个约束

### 问题的本质

当成千上万用户都说"每小时检查一下"时，朴素实现会让所有客户端在 :00 同时请求 API：

```
10:00:00  ███████████████████████████  API 洪峰
...
11:00:00  ███████████████████████████  又一个洪峰
```

这不是理论风险——这是**赋予 Agent 时间感知后的必然后果**。用户的时间意图天然聚集在整点和半点。

### 四层防御

Claude Code 的解决方案体现了"层层防御，每层独立有效"的设计思想：

**第一层：Prompt 引导（源头分散）**

`CronCreate` 的 system prompt 指导 LLM 避开 :00 和 :30：

```
"every morning around 9" → "57 8 * * *"（不是 "0 9 * * *"）
"hourly"                 → "7 * * * *"（不是 "0 * * * *"）
```

只有用户明确说 "9:00 sharp" 才用精确时间。这一层最简单也最有效——如果 LLM 配合，问题在源头就解决了大半。

**第二层：确定性 Jitter（客户端分散）**

即使 Prompt 引导失败，调度器用 `taskId` 的 hash 值计算确定性偏移。对 recurring 和 one-shot 采用**相反方向**：

| 类型 | 方向 | 理由 | 范围 |
|------|------|------|------|
| Recurring | **向后延迟** | 周期任务延迟几分钟无感 | 间隔的 10%，最多 15 分钟 |
| One-shot | **向前提前** | "提醒我 3 点"延迟 = 迟到，提前几十秒无感 | 最多 90 秒 |

为什么是确定性而非随机？因为同一个任务在进程重启后需要计算出**完全相同的** nextFireAt。`jitterFrac()` 将 8 位 hex taskId 解析为 [0, 1) 的小数——UUID 前缀保证了跨任务的均匀分布。

**第三层：GrowthBook 动态调参（运维杠杆）**

所有 jitter 参数通过 `tengu_kairos_cron_config` 实时下发，每 60 秒刷新：

```typescript
type CronJitterConfig = {
  recurringFrac: number     // 默认 0.1
  recurringCapMs: number    // 默认 15 分钟
  oneShotMaxMs: number      // 默认 90 秒
  oneShotFloorMs: number    // 默认 0
  oneShotMinuteMod: number  // 默认 30（:00 和 :30 触发 jitter）
  recurringMaxAgeMs: number // 默认 7 天
}
```

在 API 负载高峰时，运维推送 `{oneShotMinuteMod: 15, oneShotMaxMs: 300000, oneShotFloorMs: 30000}` → :00/:15/:30/:45 都被 jitter，窗口扩大到 5 分钟，最少提前 30 秒——**全球客户端在下一分钟内生效**。

配置验证采用 Zod **全量拒绝**策略：一个字段越界，整个配置回退默认值。比部分接受更安全——避免"一个 fat-finger 导致组合行为异常"。

**第四层：workload 标注（服务端降级）**

触发的 prompt 带有 `workload: WORKLOAD_CRON`，传递到 API 请求头的 `cc_workload=` 字段。Anthropic 后端可以在容量紧张时对 cron 请求实施更低的 QoS——没有人类在实时等待定时任务的响应。

```
四层防御叠加：

用户说 "every hour"
    │
    ▼
① Prompt → "7 * * * *"                 ← 源头分散
    │
    ▼
② jitter → taskId hash 偏移 0~6 min    ← 客户端分散
    │
    ▼
③ GrowthBook → 事故时加大窗口           ← 运维应急
    │
    ▼
④ cc_workload=cron → QoS 降级          ← 服务端兜底
```

---

## 24.8 跨进程调度锁：约束的协调层

### 问题

两个 Claude Code 终端打开同一项目目录，看到同一个 `scheduled_tasks.json`。没有互斥，每个任务会被两个进程各触发一次。

### O_EXCL 原子锁

`cronTasksLock.ts` 使用文件系统级原子操作：

```typescript
await writeFile(path, body, { flag: 'wx' })  // O_EXCL: 文件存在则失败
```

`O_EXCL`（`'wx'` flag）是 POSIX 级别的 test-and-set。两个进程同时尝试，只有一个成功。锁文件包含 `sessionId`、`pid`、`acquiredAt`。

### PID 探测防死锁

持有者崩溃后，锁文件变成"死锁"。非持有者每 5 秒探测一次 `isProcessRunning(existing.pid)`：PID 已死 → unlink 锁文件 → 重试 exclusive create。两个进程同时尝试恢复时，只有一个 create 成功。

### Session 任务绕过锁

Session-only 任务存储在进程内存中，对其他进程不可见，**完全不需要锁**。又一个双轨设计的好处。

---

## 24.9 工具层与 /loop Skill

### 三层 Feature Gate

```typescript
export function isKairosCronEnabled(): boolean {
  return feature('AGENT_TRIGGERS')          // ① 编译时 dead code elimination
    ? !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CRON)  // ② 本地环境变量
      && getFeatureValue_CACHED_WITH_REFRESH(
        'tengu_kairos_cron', true,           // ③ GrowthBook 运行时 kill switch
        KAIROS_CRON_REFRESH_MS,
      )
    : false
}
```

默认值为何是 `true`？因为 GrowthBook 在 Bedrock/Vertex/Foundry 和 `DISABLE_TELEMETRY` 环境下不可用；`false` 默认值会让这些用户永远无法使用已 GA 的 `/loop`。GrowthBook gate 的角色纯粹是**全局 kill switch**——正常情况下不干预。

### CronCreate 验证

四条规则，逐级递进：

1. cron 语法是否合法（`parseCronExpression`）
2. 未来一年内是否有匹配（`nextCronRunMs`）
3. 是否超过 50 个任务上限
4. Teammate 不能创建 durable 任务（agentId 只在进程内有效，durable 后重启变孤儿）

### Durable 静默降级

即使用户传了 `durable: true`，如果 `isDurableCronEnabled()` 返回 false，调用时静默降级为 session-only。Schema 不变，LLM 不会收到验证错误——这比突然拒绝更平滑。

### /loop：语法糖 + 即时首执行

`/loop 5m /babysit-prs` 做两件事：① 创建 `*/5 * * * *` 的 recurring cron；② **立即执行第一次**。不等第一个 tick——"开始循环"意味着"现在就开始"。

Skill 不自己解析间隔，而是生成详细 prompt 让 LLM 解析。这保持了自然语言理解的灵活性（`/loop check the deploy every 20m` 的 trailing "every" 语法）。

---

## 24.10 REPL 集成与 Teammate 路由

### useScheduledTasks Hook

React Hook 管理调度器生命周期，用 `useRef` 避免闭包捕获过时的 `isLoading` 值。`isKilled: () => !isKairosCronEnabled()` 作为 mid-session kill switch——GrowthBook 翻转后，下一个 1s tick 就停止调度。

### Teammate Cron 路由

当 cron 任务带有 `agentId` 时，触发应路由到对应 teammate 而非主 REPL：

```typescript
onFireTask: task => {
  if (task.agentId) {
    const teammate = findTeammateTaskByAgentId(task.agentId, ...)
    if (teammate && !isTerminalTaskStatus(teammate.status)) {
      injectUserMessageToTeammate(teammate.id, task.prompt, ...)
      return
    }
    // Teammate 已消失 → 清理孤儿 cron，避免无限循环
    void removeCronTasks([task.id])
    return
  }
  enqueueForLead(task.prompt)
}
```

### workload 标注的深意

触发的 prompt 以 `priority: 'later'` 入队，且标注 `workload: WORKLOAD_CRON`。这个标注流经 billing header 到达 API 服务端。含义是：**这个请求没有人类在实时等待，容量紧张时可以延迟处理**。

这揭示了一个架构洞察：Agent 的主动行为和被动响应需要**不同的 QoS 级别**。人类说"帮我修这个 bug"是高优先级——有人在等。cron 触发的"检查 PR 状态"是低优先级——早几分钟晚几分钟无所谓。随着 Agent 越来越主动，这种 QoS 分层会变得越来越重要。

---

## 24.11 设计哲学：能力赋予与能力约束的对称性

回顾整章，一个贯穿始终的主题浮现出来：**每一项赋予 Agent 的新能力，都伴随着一套对称的约束机制。**

```
能力赋予                              约束机制
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
定时触发（时间感知）                   ← Jitter 四层防御（负载约束）
周期性执行（永续运行）                 ← 7 天自动过期（生命周期约束）
跨会话持久化（记忆延续）               ← 调度锁 + durable kill switch
Teammate 可创建 cron（分布式自主性）   ← 孤儿清理 + agentId 隔离
Missed 任务恢复（离线容错）            ← 代码围栏防 prompt injection
KAIROS permanent 任务（豁免过期）      ← 不通过 Tool 暴露，仅内部写入
```

这不是巧合——这是 Agent 自主性增长的**内在要求**。一个只做被动应答的工具不需要 jitter，因为它的请求量等于人类的输入频率。一个能定时触发的 Agent 立刻面临雷群效应。一个能跨进程运行的 Agent 立刻面临重复触发。一个能"做梦"整合记忆的 Agent 立刻面临无限资源消耗。

**自主性的每一步增长，都要求一套新的约束机制。** 这是 Agent 工程最核心的设计张力。

---

## 章末速查表

| 组件 | 文件 | 关键设计 |
|------|------|---------|
| Cron 解析器 | `utils/cron.ts` | 零依赖、5 字段标准 cron、DST 安全、OR 语义 |
| 任务数据层 | `utils/cronTasks.ts` | 双存储（内存/磁盘）、防御性解析、短 ID |
| 调度引擎 | `utils/cronScheduler.ts` | 1s 轮询、锚点选择、inFlight 防重、aged 过期 |
| 调度锁 | `utils/cronTasksLock.ts` | O_EXCL 原子锁、PID 活性探测、5s 探测间隔 |
| Jitter 配置 | `utils/cronJitterConfig.ts` | GrowthBook 60s 刷新、Zod 全量拒绝 |
| CronCreate | `tools/ScheduleCronTool/` | 三层 gate、durable 静默降级、50 任务上限 |
| /loop Skill | `skills/bundled/loop.ts` | 语法糖 + 即时首执行 |
| REPL Hook | `hooks/useScheduledTasks.ts` | Teammate 路由、workload 标注、mid-session kill |
| Feature Gate | `prompt.ts` | `AGENT_TRIGGERS` ≠ `KAIROS`，独立可发布 |

| 关键数字 | 值 | 来源 |
|---------|-----|------|
| Recurring 过期 | 7 天 | `recurringMaxAgeMs`，P99 会话 53h 的约束 |
| Recurring jitter | 间隔的 10%，最多 15 分钟 | `recurringFrac` / `recurringCapMs` |
| One-shot jitter | ≤90s 提前 | `oneShotMaxMs`，只对 :00/:30 生效 |
| 任务上限 | 50 个 | `MAX_JOBS`，8-hex ID 碰撞安全 |
| 调度器 tick | 1 秒 | `CHECK_INTERVAL_MS` |
| 锁探测间隔 | 5 秒 | `LOCK_PROBE_INTERVAL_MS` |
| Jitter 配置刷新 | 60 秒 | `JITTER_CONFIG_REFRESH_MS` |
| Feature gate 刷新 | 5 分钟 | `KAIROS_CRON_REFRESH_MS` |

> **最终思考**：定时调度看似简单——不就是 `setInterval` 加个 cron 表达式吗？但这章真正要说的不是 cron 实现，而是一个更根本的命题：**Agent 自主性的每一步增长，都同时创造一个新的工程问题。** 赋予时间感知 → 雷群效应。赋予永续执行 → 资源耗尽。赋予跨进程持久化 → 重复触发。赋予离线恢复 → prompt injection。Claude Code 的 cron 系统是这个命题的第一个完整案例——它展示了如何在 **赋予能力** 和 **约束能力** 之间找到精确的平衡点。而这个命题，随着 Agent 从 cron 定时走向 24 小时主动触发，只会变得越来越重要。
