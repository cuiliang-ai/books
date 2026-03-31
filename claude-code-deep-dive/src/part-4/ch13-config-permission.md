
# 第 13 章：配置与权限系统 — Agent 的行为边界

> **核心问题**：一个拥有 Bash、文件读写、MCP 等强大工具的 Agent，如何做到"该做的自动做，不该做的绝不做"？配置从哪里来，权限由谁裁决，用户的一次 "Always allow" 又如何被记住？

一个 Coding Agent 面临的核心矛盾是：**能力越大，风险越大**。Agent 需要执行 shell 命令来运行测试、需要写文件来修 bug、需要访问 MCP 工具来与外部系统交互 — 但如果不加限制，一条 `rm -rf /` 就能造成灾难。

Claude Code 用一套 **5 层级联配置 + deny-first 权限引擎** 来解决这个矛盾。它将用户偏好、项目规则、本地覆盖、CLI 参数和企业策略统一在一个决策框架中，实现了三个核心设计原则：

- **deny 优先**：任何层级的 deny 规则都无法被其他层级覆盖
- **就近覆盖**：更具体的配置源优先级更高
- **运行时可变**：用户交互可动态添加规则并持久化

本章将完整解析这套系统的架构设计和实现细节。

---

## 13.1 概述：为什么 Agent 需要精细的配置与权限控制

### 问题空间

传统 CLI 工具的权限模型很简单 — 用户执行命令，操作系统负责权限检查。但 Agent 的场景完全不同：

1. **自主决策**：Agent 决定调用什么工具、传什么参数，用户可能事先并不知道
2. **多信任域**：用户自己的偏好、团队的项目规则、企业的安全策略，各有不同的信任级别
3. **动态演进**：用户在使用过程中会逐渐放开权限（"这个 git 命令总是 OK 的"）
4. **工具多样性**：Bash、文件操作、MCP 工具各有不同的风险等级

这意味着 Agent 需要一个**多层级、声明式、可动态更新**的配置与权限系统。

### Claude Code 的解决方案架构

```
                 ┌──────────────────────────────────┐
                 │          权限决策引擎              │
                 │   Ye6() (checkPermission)         │
                 │                                    │
                 │  deny > ask > tool.check > allow   │
                 └────────────┬─────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
     ┌────────▼──────┐ ┌─────▼──────┐ ┌──────▼────────┐
     │  规则解析引擎   │ │ 规则收集器  │ │  5 种权限模式  │
     │ Jf()/M_8()    │ │ L9H/JVH/   │ │ default/plan/ │
     │ (parseRule/   │ │ MVH()      │ │ acceptEdits/  │
     │  matchRule)   │ │(collectXxx)│ │ auto/bypass   │
     └───────────────┘ └────────────┘ └───────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
     ┌──────────────┐ ┌─────────────┐ ┌─────────────┐
     │ 5 层静态设置  │ │ 3 种运行时源 │ │  动态持久化   │
     │ user/project │ │ cliArg/     │ │  JO()/oJ7() │
     │ /local/flag  │ │ command/    │ │ (applyUpdate│
     │ /policy      │ │ session     │ │  /persist)  │
     └──────────────┘ └─────────────┘ └─────────────┘
```

> **设计决策**：Claude Code 没有采用传统的 RBAC（基于角色的访问控制）或 ABAC（基于属性的访问控制），而是设计了一个**声明式规则引擎** — 用简单的字符串格式（`ToolName(pattern)`）表达权限规则。这使得规则可以直接写在 JSON 文件中，用户无需学习复杂的策略语言。

**小结**：Agent 的权限控制不同于传统应用。Claude Code 通过 5 层配置合并 + deny-first 规则引擎，在安全底线和使用便利之间找到平衡。

---

## 13.2 5 层设置层级：user → project → local → flag → policy

### 解决什么问题

一个 Agent 工具可能被不同的人、在不同的项目、以不同的方式使用。个人开发者想要 `Bash(git *)` 始终允许，项目维护者想要禁止 `Write(*.lock)`，企业管理员想要阻止所有 MCP 工具调用。这些需求如何共存而不冲突？

答案是**分层配置，按优先级合并**。

### 5 层定义

```
优先级（低 → 高）:
userSettings → projectSettings → localSettings → flagSettings → policySettings
```

| 层级 | 源名称 | 文件路径 | 说明 | 典型使用者 |
|------|--------|----------|------|-----------|
| Layer 1 | `userSettings` | `~/.claude/settings.json` | 用户全局设置，跨所有项目 | 个人开发者 |
| Layer 2 | `projectSettings` | `<project>/.claude/settings.json` | 项目级设置，提交到版本控制 | 项目维护者 |
| Layer 3 | `localSettings` | `<project>/.claude/settings.local.json` | 本地覆盖，加入 `.gitignore` | 个人开发者 |
| Layer 4 | `flagSettings` | CLI 参数 `--allowedTools` 等 | 命令行参数注入的规则 | 自动化脚本 |
| Layer 5 | `policySettings` | 企业管理策略文件 | 组织级强制策略，不可覆盖 | 企业管理员 |

> **常见的 "3 层" 说法**指的是前 3 层（user/project/local），后 2 层（flag/policy）分别用于 CLI 参数和企业管控。

### 源码中的层级常量

```javascript
// modules/04_git_operations.js
// cR — 5 层静态配置源列表
cR = ["userSettings", "projectSettings", "localSettings",
      "flagSettings", "policySettings"]

// modules/15_hooks_system.js — 运行时扩展的完整规则源（8 个）
// j_8 (allRuleSources) — 在 5 层之上追加了 3 个运行时来源
j_8 = [...cR, "cliArg", "command", "session"]
// 即: ["userSettings", "projectSettings", "localSettings",
//      "flagSettings", "policySettings",
//      "cliArg", "command", "session"]
```

运行时额外的 3 个规则来源：
- **`cliArg`**：命令行直接传入的规则（如 `--allowedTools "Bash(git *)"` ）
- **`command`**：slash 命令设置的规则（如 `/allowed-tools add Bash(npm *)` ）
- **`session`**：用户在权限对话框中点击 "Always allow" 动态添加的规则

### 文件路径解析

Claude Code 用一对函数将源名称映射到实际文件路径：

```javascript
// fw() (getSettingsFilePath) — 将源名称映射到完整文件路径
// modules/04_git_operations.js, line ~8962
function fw(source) {
  let baseDir = O1H(source);  // 获取基础目录 (getBaseDir)
  let relPath = T1H(source);  // 获取相对路径 (getRelativePath)
  return path.join(baseDir, relPath);
}

// O1H() (getBaseDir) — 返回基础目录
function O1H(source) {
  switch(source) {
    case "userSettings":    return os.homedir();       // ~/.claude/
    case "projectSettings": return projectRoot;         // <project>/.claude/
    case "localSettings":   return projectRoot;         // <project>/.claude/
    case "policySettings":  return managedPolicyDir;    // 企业管理目录
    default:                return projectRoot;
  }
}

// T1H() (getRelativePath) — 返回相对路径
function T1H(source) {
  switch(source) {
    case "localSettings":   return ".claude/settings.local.json";
    default:                return ".claude/settings.json";
  }
}
```

> **设计决策**：`projectSettings` 和 `localSettings` 虽然都在项目目录下，但文件名不同：前者是 `settings.json`（提交到 Git），后者是 `settings.local.json`（加入 `.gitignore`）。这让团队可以共享项目级规则，同时每个开发者保留自己的本地覆盖。

### 实际文件路径示例

```
~/.claude/settings.json                          <-- Layer 1: userSettings
/home/user/my-project/.claude/settings.json      <-- Layer 2: projectSettings
/home/user/my-project/.claude/settings.local.json<-- Layer 3: localSettings
[CLI args: --allowedTools "Bash(git *)"]         <-- Layer 4: flagSettings
/etc/claude/managed-settings.json                <-- Layer 5: policySettings
```

### 层级优先级的视觉理解

```
┌─────────────────────────────────────────────┐
│         policySettings（企业策略）            │ <-- 最高优先级，不可覆盖
│  ┌─────────────────────────────────────┐    │
│  │       flagSettings（CLI 参数）       │    │
│  │  ┌──────────────────────────────┐   │    │
│  │  │    localSettings（本地覆盖）   │   │    │
│  │  │  ┌────────────────────────┐  │   │    │
│  │  │  │  projectSettings（项目）│  │   │    │
│  │  │  │  ┌──────────────────┐  │  │   │    │
│  │  │  │  │  userSettings    │  │  │   │    │
│  │  │  │  │  （用户全局）      │  │  │   │    │
│  │  │  │  └──────────────────┘  │  │   │    │
│  │  │  └────────────────────────┘  │   │    │
│  │  └──────────────────────────────┘   │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘

  deny 规则：任何层级 --> 不可覆盖 --> 直接拒绝
  allow 规则：可被高层级的 deny/ask 覆盖
```

但要注意：**deny 规则是例外**。无论来自哪一层，deny 都不可被覆盖 — 这是 deny-first 安全模型的核心。后面 13.4 节会详细分析。

**小结**：5 层配置层级通过"就近覆盖"实现灵活性，通过"deny 不可覆盖"保证安全底线。8 个规则源（5 静态 + 3 运行时）覆盖了从企业策略到即时交互的全部场景。

---

## 13.3 Zod Schema 验证机制

### 解决什么问题

配置文件由用户手动编辑（或由程序写入），格式错误在所难免。一个写成 `"premissions"` 的拼写错误、一个类型不匹配的值，都可能导致权限系统行为异常。

Claude Code 使用 **Zod schema** 在加载时对每个配置文件进行严格验证，确保结构和类型的正确性。

### 设置文件的合法结构

通过 `GW8()` (validateSettingsSchema) 函数定义的 Zod schema，设置文件只允许以下顶层键：

```json
{
  "permissions": {
    "allow": ["Bash(git *)"],
    "deny": ["Write(~/.ssh/*)"],
    "ask": ["Bash"]
  },
  "sandbox": {
    "allow": ["/home/user/project"],
    "deny": ["/etc", "/root"]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "echo 'pre-bash'" }
        ]
      }
    ]
  }
}
```

三个顶层键的职责：
- **`permissions`**：权限规则（allow/deny/ask 三个列表）
- **`sandbox`**：沙箱目录规则（允许/拒绝的路径列表）
- **`hooks`**：钩子配置（PreToolUse/PostToolUse 等生命周期钩子）

### 权限规则的字符串格式

权限规则采用简洁的字符串表达，格式为 `ToolName` 或 `ToolName(content)`：

```
"Bash"              --> 匹配所有 Bash 调用
"Bash(git *)"       --> 匹配 Bash 中以 "git " 开头的命令
"Write(~/.ssh/*)"   --> 匹配写入 ~/.ssh/ 下任何文件
"mcp__*"            --> 通配符匹配所有 MCP 工具
"Read"              --> 匹配所有文件读取
"Edit"              --> 匹配所有编辑操作
```

> **设计决策**：规则格式借鉴了 glob 模式的简洁性 — 用户不需要学习正则表达式或 JSON Schema，只需用自然的 `ToolName(pattern)` 格式就能表达大部分权限需求。`*` 通配符的支持进一步降低了使用门槛。

### 设置加载与缓存流程

```
k6(source) (readSettingsCached)       // 外层入口，带缓存
  |
  +-- 缓存命中且未过期？ --> 返回缓存
  |
  +-- 缓存未命中 --> XW8(source) (readSettingsRaw)
                       |
                       +-- fw(source) (getSettingsFilePath) // 解析文件路径
                       |
                       +-- fs.readFileSync()                // 读取 JSON 文件
                       |
                       +-- JSON.parse()                     // 解析为对象
                       |
                       +-- GW8(data) (validateSettingsSchema)// Zod schema 验证
                       |
                       +-- [policySettings 特殊处理]
                       |     |
                       |     +-- 级联合并企业策略目录下的多个文件
                       |
                       +-- 返回验证后的设置对象
```

核心加载代码：

```javascript
// k6() (readSettingsCached) — 带缓存的设置读取
function k6(source) {
  if (cache.has(source) && !isStale(source)) {
    return cache.get(source);        // 缓存命中，直接返回
  }
  let settings = XW8(source);        // 原始读取 + 验证
  cache.set(source, settings);       // 更新缓存
  return settings;
}
```

`policySettings` 有特殊的加载逻辑：它不仅读取单个文件，还会合并来自企业管理目录的多个策略文件，形成最终的不可覆盖策略集。这为企业管理员提供了灵活的策略组合能力。

### 验证失败的处理

当配置文件验证失败时，Claude Code 不会直接崩溃，而是：

1. 记录错误日志，指出具体的验证失败位置
2. 跳过该层级的配置，继续使用其他层级
3. 向用户发出警告

这种**容错设计**确保了即使某个配置文件损坏，Agent 仍然可以在安全的默认配置下运行。

**小结**：Zod schema 验证是配置系统的"守门员"，确保所有加载的配置都符合预期格式。带缓存的加载机制避免了重复磁盘 I/O，而 policySettings 的级联合并为企业管控提供了灵活性。

---

## 13.4 权限规则引擎：Jf() / M_8()、allow/deny/ask 决策树

### 解决什么问题

有了分层配置和验证机制，下一个问题是：当 Agent 想调用一个工具时，系统如何从 8 个规则源中快速得出"允许/拒绝/询问"的决策？

这就是权限规则引擎的职责 — 它包含两部分：**规则解析**（把字符串变成可匹配的结构）和**规则匹配**（判断一条规则是否适用于当前工具调用）。

### 规则解析器：Jf() (parseRule)

```javascript
// modules/04_git_operations.js, line ~7832
// Jf() (parseRule) — 将规则字符串解析为结构化对象
function Jf(ruleString) {
  // 输入: "Bash(git *)"
  // 输出: { toolName: "Bash", ruleContent: "git *" }

  // 输入: "Write"
  // 输出: { toolName: "Write", ruleContent: undefined }

  let match = ruleString.match(/^([^(]+)(?:\((.+)\))?$/);
  return {
    toolName: match[1],           // 工具名称部分
    ruleContent: match[2] || undefined  // 括号内的模式部分（可选）
  };
}
```

解析示例：

```
输入字符串                解析结果
───────────────────    ─────────────────────────────
"Bash"                 { toolName: "Bash", ruleContent: undefined }
"Bash(git *)"          { toolName: "Bash", ruleContent: "git *" }
"Write(~/.ssh/*)"      { toolName: "Write", ruleContent: "~/.ssh/*" }
"mcp__server__tool"    { toolName: "mcp__server__tool", ruleContent: undefined }
"mcp__*"               { toolName: "mcp__*", ruleContent: undefined }
```

### 规则匹配器：M_8() (matchRule)

```javascript
// modules/15_hooks_system.js, line ~7104
// M_8() (matchRule) — 判断一条规则是否匹配当前工具调用
function M_8(rule, toolName, toolInput) {
  let parsed = Jf(rule);  // 先解析规则字符串

  // Step 1: 工具名匹配（支持 MCP 通配符）
  if (parsed.toolName !== toolName) {
    if (!parsed.toolName.includes("*")) return false;
    // MCP 通配符匹配: "mcp__*" matches "mcp__server__tool"
    let pattern = parsed.toolName.replace("*", ".*");
    if (!new RegExp(`^${pattern}$`).test(toolName)) return false;
  }

  // Step 2: 内容匹配（如果规则有 content 部分）
  if (parsed.ruleContent) {
    // 将 ruleContent 转为 glob/regex 进行匹配
    return globMatch(parsed.ruleContent, toolInput);
  }

  // Step 3: 无 content = 匹配该工具的所有调用
  return true;
}
```

匹配逻辑的三个层次：

```
规则 "Bash(git *)" vs 工具调用 Bash("git push origin main")

Step 1: toolName 匹配
  "Bash" === "Bash" --> PASS

Step 2: ruleContent 匹配
  globMatch("git *", "git push origin main") --> PASS

结果: MATCH

---

规则 "mcp__*" vs 工具调用 mcp__github__create_pr()

Step 1: toolName 匹配
  "mcp__*" !== "mcp__github__create_pr"
  但 "mcp__*" 包含通配符
  /^mcp__.*$/.test("mcp__github__create_pr") --> PASS

Step 2: 无 ruleContent
  --> 匹配所有调用

结果: MATCH
```

### 规则收集器：L9H() / JVH() / MVH()

权限引擎需要从 8 个规则源中收集规则。三个收集函数分别负责 deny/ask/allow：

```javascript
// L9H() (collectDenyRules) — 收集所有 deny 规则
function L9H(permissionContext) {
  return j_8.flatMap(source =>
    permissionContext.alwaysDenyRules[source] || []
  );
}

// JVH() (collectAskRules) — 收集所有 ask 规则
function JVH(permissionContext) {
  return j_8.flatMap(source =>
    permissionContext.alwaysAskRules[source] || []
  );
}

// MVH() (collectAllowRules) — 收集所有 allow 规则
function MVH(permissionContext) {
  return j_8.flatMap(source =>
    permissionContext.alwaysAllowRules[source] || []
  );
}
```

> **设计决策**：三个收集函数都使用 `flatMap` 从**所有 8 个源**收集规则，形成**联合集**。这意味着 deny 规则是跨层级聚合的 — 用户层级的 deny 和企业层级的 deny 一样不可被绕过。这是 deny-first 安全模型的基础。

### 完整权限决策树

当一个工具被调用时，权限检查按以下顺序执行：

```
工具调用请求 (e.g., Bash("rm -rf /tmp/test"))
    |
    v
+-----------------------------------------------+
|  Ye6() (checkPermission) — 预检查（快速路径）    |
|  遍历所有 8 个规则源                             |
|  (j_8: user/project/local/flag/                |
|   policy/cliArg/command/session)               |
+---------------------+-------------------------+
                      |
         +------------v------------+
         |  ld_() (checkDeny)      |  <-- 遍历所有源的 deny 规则
         |  L9H() 收集 deny 规则    |      flatMap 所有层级
         +------------+------------+
                      |
                 匹配到 deny?
                /           \
             YES             NO
              |               |
              v               v
         拒绝执行       +------------------+
         (不可覆盖)     | _O9() (checkAsk)  |  <-- 遍历所有源的 ask 规则
                        | JVH() 收集规则     |
                        +--------+---------+
                                 |
                            匹配到 ask?
                           /           \
                        YES             NO
                         |               |
                         v               v
                    弹出权限       +------------------------+
                    确认对话框     | tool.checkPermissions() |
                                  | 工具自身的权限检查        |
                                  +-----------+------------+
                                              |
                                         工具要求 ask?
                                        /           \
                                     YES             NO
                                      |               |
                                      v               v
                                 弹出权限       +------------------+
                                 确认对话框     | MVH() (checkAllow)|
                                               | 检查 allow 规则    |
                                               +--------+---------+
                                                        |
                                                   匹配到 allow?
                                                  /           \
                                               YES             NO
                                                |               |
                                                v               v
                                           静默允许        弹出权限
                                                          确认对话框
```

### 核心优先级原则

```
deny（任何层级）> ask（任何层级）> tool.checkPermissions() > allow（任何层级）
```

关键规则：

1. **deny 不可覆盖**：`policySettings` 中的 deny 规则，用户层级无法通过 allow 绕过。甚至用户层级自己的 deny 也无法被自己的 allow 覆盖
2. **ask 优先于 allow**：即使有 allow 规则，ask 规则仍会触发确认对话框
3. **工具自检**：每个工具自身可以声明某些操作需要确认（如 Bash 工具对高危命令的检测）
4. **allow 是最后防线**：只有前面的检查都通过（无 deny、无 ask、工具自检也通过），allow 规则才会生效实现"静默允许"

### 与 Hook 系统的协同

权限检查与 Hook 系统深度集成，形成完整的工具执行生命周期：

```
工具调用请求
    |
    v
PreToolUse Hooks (r49())     <-- Hook 可以修改/拒绝工具调用
    |
    v
Permission Decision (Ye6())   <-- 权限规则检查（本节重点）
    |
    +-- deny --> 拒绝，返回错误
    +-- ask  --> 弹出对话框
    |            +-- 用户允许 --> 继续（可选 "Always allow" 持久化）
    |            +-- 用户拒绝 --> 返回错误
    +-- allow --> 继续
    |
    v
tool.call()                    <-- 实际执行工具
    |
    v
PostToolUse Hooks (i49())     <-- Hook 可以处理结果
```

PreToolUse Hook 可以返回特殊值来影响权限流程：

```javascript
// Hook 返回值对权限的影响
{
  "decision": "block"    // 直接拒绝，不进入权限检查
  "decision": "allow"    // 直接允许，跳过权限检查
  "decision": "ask"      // 强制弹出确认对话框
  // 不返回 decision      // 继续正常权限流程
}
```

> **设计决策**：Hook 的 decision 优先于权限规则引擎。这让高级用户可以用自定义脚本实现超越声明式规则的动态权限逻辑 — 例如，根据当前 Git 分支决定是否允许 `Write` 操作。

**小结**：权限规则引擎通过 `Jf()` 解析规则字符串、`M_8()` 执行匹配逻辑、`L9H()/JVH()/MVH()` 从 8 个源收集规则、`Ye6()` 按 deny > ask > tool.check > allow 的优先级做出决策。deny-first 模型保证了安全底线不可被绕过。

---

## 13.5 5 种权限模式：default / plan / acceptEdits / auto / bypassPermissions

### 解决什么问题

即使有了完善的规则引擎，不同场景下用户对"自动化程度"的需求差异很大。代码审查时希望 Agent 只读不写；快速迭代时希望文件编辑不用每次确认；CI/CD 中希望完全自动化。

Claude Code 通过 5 种**权限模式**来适配这些场景，每种模式改变权限决策树的默认行为。

### 模式定义

| 模式 | 说明 | 典型场景 | 自动允许范围 |
|------|------|---------|-------------|
| `default` | 标准模式，遵循完整的 deny/ask/allow 规则链 | 日常交互 | 仅匹配 allow 规则的操作 |
| `plan` | 只允许只读操作，所有写入需要审批 | 代码审查、规划 | Read/Glob/Grep 等只读工具 |
| `acceptEdits` | 自动接受文件编辑，其他操作仍需确认 | 快速迭代编码 | Write/Edit/NotebookEdit |
| `auto` | 自动执行大部分操作（受安全分类器约束） | CI/CD、自动化 | 几乎所有非危险操作 |
| `bypassPermissions` | 跳过所有权限检查 | 完全信任环境 | 所有操作 |

### 默认权限上下文

权限上下文是权限系统的核心数据结构，记录当前模式和所有规则：

```javascript
// xM() (createDefaultPermissionContext) — 创建默认 toolPermissionContext
// modules/08_system_prompt.js, line ~186
function xM() {
  return {
    mode: "default",               // 当前权限模式
    alwaysAllowRules: {},          // 按源分组: { userSettings: [], session: [], ... }
    alwaysDenyRules: {},           // 同上
    alwaysAskRules: {},            // 同上
    additionalDirectories: [],     // 额外允许的目录路径
    deniedDirectories: [],         // 拒绝的目录路径
  };
}
```

### 模式如何影响决策树

权限模式本质上是在决策树的不同位置"短路"：

```
                          权限决策入口
                              |
                    +-------- | --------+
                    |         |         |
                 mode ==   mode ==   mode ==
              "bypass"    "auto"    "default"
                    |         |         |
                    v         v         v
               直接允许   安全分类器   完整规则链
              (跳过一切)  判断后允许   deny>ask>allow

           +------------------+
           |     mode ==      |
           |  "acceptEdits"   |
           +--------+---------+
                    |
              工具是写入工具?
               /          \
            YES            NO
             |              |
             v              v
        自动允许编辑    继续规则链
        (Write/Edit)   (deny>ask>allow)

           +------------------+
           |     mode ==      |
           |     "plan"       |
           +--------+---------+
                    |
              工具是只读?
               /          \
            YES            NO
             |              |
             v              v
          自动允许        强制 ask
        (Read/Grep)    (必须用户确认)
```

> **设计决策**：`bypassPermissions` 模式看似危险，但它只在明确需要的环境中使用（如 Docker 容器内的 CI 流水线）。即使在此模式下，操作系统层面的安全机制仍然生效。Claude Code 的分层防御理念是：权限系统是防线之一，而非唯一防线。

### 模式与 deny 规则的关系

一个重要的细节：**deny 规则在所有模式下都生效**。即使在 `bypassPermissions` 模式下，`policySettings` 中的 deny 规则仍然会被执行。这确保了企业策略的绝对权威性。

```
                bypassPermissions 模式下的检查流程

                工具调用请求
                    |
                    v
              policySettings deny?  <-- 即使 bypass 也检查企业 deny
                 /          \
              YES            NO
               |              |
               v              v
           拒绝执行        直接允许
```

**小结**：5 种权限模式从 `default`（最严格）到 `bypassPermissions`（最宽松）覆盖了不同的使用场景。模式通过在决策树的不同位置"短路"来改变默认行为，但 deny 规则始终生效，保证安全底线。

---

## 13.6 运行时权限动态更新与持久化

### 解决什么问题

静态配置文件不够灵活 — 用户在使用过程中经常发现"这个操作其实是安全的，以后不要再问我了"。每次都要手动编辑配置文件显然不现实。

Claude Code 支持**运行时动态更新权限规则**，并将更新**持久化到对应的配置文件**。典型场景是用户在权限对话框中选择 "Always allow"。

### 权限更新的数据结构

权限更新是一个操作对象，描述要做什么变更：

```javascript
// 更新操作的类型
{
  type: "setMode"       // 切换权限模式
  type: "addRules"      // 添加规则
  type: "replaceRules"  // 替换规则
  type: "removeRules"   // 移除规则
  type: "addDirectories"    // 添加目录路径
  type: "removeDirectories" // 移除目录路径
}

// 示例: 用户点击 "Always allow" 后生成的更新
{
  type: "addRules",
  source: "session",          // 规则来源：当前会话
  ruleType: "allow",          // 规则类型：允许
  rules: ["Bash(git push *)"] // 规则内容
}
```

### 内存更新：JO() (applyPermissionUpdate)

```javascript
// JO() (applyPermissionUpdate) — 应用单个权限更新到内存
function JO(permissionContext, update) {
  switch(update.type) {
    case "setMode":
      // 切换权限模式 (default/plan/acceptEdits/auto/bypassPermissions)
      permissionContext.mode = update.mode;
      break;

    case "addRules":
      // 添加规则到指定源和类型
      // e.g., update: { source: "session", ruleType: "allow",
      //                  rules: ["Bash(git *)"] }
      permissionContext[ruleTypeToKey(update.ruleType)]
                       [update.source]
                       .push(...update.rules);
      break;

    case "replaceRules":
      // 替换指定源的所有规则
      permissionContext[ruleTypeToKey(update.ruleType)]
                       [update.source] = update.rules;
      break;

    case "removeRules":
      // 移除匹配的规则
      // ...filter logic...
      break;

    case "addDirectories":
      // 添加允许/拒绝的目录路径（sandbox 规则）
      break;

    case "removeDirectories":
      // 移除目录路径
      break;
  }
}
```

### 持久化：oJ7() (persistPermissionUpdate)

```javascript
// oJ7() (persistPermissionUpdate) — 将规则持久化到设置文件
function oJ7(update) {
  // 1. 确定目标文件（基于 update.source）
  let targetFile = fw(update.source);  // getSettingsFilePath

  // 2. 读取现有设置
  let existing = k6(update.source);    // readSettingsCached

  // 3. 合并更新
  let merged = deepMerge(existing, updateToSettings(update));

  // 4. 写入文件
  J8(update.source, merged);           // writeSettingsMerged
}

// J8() (writeSettingsMerged) — 带合并的设置写入
function J8(source, newSettings) {
  let filePath = fw(source);                              // 解析文件路径
  let existing = readJsonSafe(filePath);                   // 读取现有内容
  let merged = deepMerge(existing, newSettings);           // 深度合并
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2)); // 写入
  cache.invalidate(source);                                // 清除缓存!
}
```

> **设计决策**：写入设置文件后**立即清除对应源的缓存**（`cache.invalidate(source)`）。这保证了下次读取时一定能获取到最新的设置。这是经典的**写入即失效（Write-Invalidate）**缓存策略 — 简单、正确、可预测。

### 批量更新：Tv() (applyUpdates)

```javascript
// Tv() (applyUpdates) — 顺序应用多个更新
function Tv(permissionContext, updates) {
  for (let update of updates) {
    JO(permissionContext, update);  // 内存更新 (applyPermissionUpdate)
    Id(update);                     // 持久化 (persistUpdate)
  }
}
```

### "Always allow" 的完整流程

当用户在权限对话框中选择 "Always allow" 时，背后发生了什么：

```
用户看到: "Allow Bash(git push origin main)?"
                    |
用户选择: [Always allow]
                    |
                    v
+--------------------------------------------------+
| 1. 生成更新对象                                    |
|    { type: "addRules",                            |
|      source: "session",                           |
|      ruleType: "allow",                           |
|      rules: ["Bash(git push *)"] }                |
+--------------------------------------------------+
                    |
                    v
+--------------------------------------------------+
| 2. JO() — 更新内存中的 permissionContext           |
|    permissionContext.alwaysAllowRules.session      |
|      .push("Bash(git push *)")                    |
+--------------------------------------------------+
                    |
                    v
+--------------------------------------------------+
| 3. oJ7() — 持久化到设置文件                        |
|    写入 ~/.claude/settings.json 或                |
|    <project>/.claude/settings.local.json          |
+--------------------------------------------------+
                    |
                    v
+--------------------------------------------------+
| 4. cache.invalidate() — 清除缓存                  |
|    确保下次读取使用最新设置                          |
+--------------------------------------------------+
                    |
                    v
下一次相同操作 --> 静默允许（不再弹出对话框）
```

**小结**：运行时权限更新通过 `JO()` 修改内存、`oJ7()` 持久化到磁盘、`cache.invalidate()` 保证一致性。"Always allow" 功能将用户的信任决策转化为持久化规则，避免重复询问。

---

## 13.7 设计启示

Claude Code 的配置与权限系统为构建通用 Agent 提供了以下可复用的架构模式：

### 1. 多层级配置合并（Cascade Merge）

将全局/项目/本地/参数/策略分层，支持灵活覆盖又保证安全底线。这种模式在很多系统中都有应用（如 CSS 层叠、Git 配置、npm 配置），但 Claude Code 的创新在于将 **deny 规则排除在层叠覆盖之外**。

```
传统层叠: 高层级覆盖低层级（无例外）
CC 层叠:  高层级覆盖低层级，但 deny 跨层级聚合（不可覆盖）
```

### 2. 声明式规则引擎

用简单的字符串格式（`Tool(pattern)`）表达复杂的权限规则，易于配置和理解。相比 Rego（OPA）、Cedar（AWS）等策略语言，这种方式：

- **学习成本低**：用户只需理解 `ToolName(glob_pattern)` 的格式
- **可读性高**：`"Bash(git *)"` 一眼就能看出含义
- **表达力足够**：覆盖了 Agent 场景的绝大部分权限需求

### 3. deny-first 安全模型

deny 规则不可覆盖，确保安全策略无法被绕过。这比传统的"默认拒绝，显式允许"更进一步 — 在 CC 中，显式拒绝**永远优先于**显式允许。

```
传统 RBAC:  如果有 deny 和 allow，最终结果取决于优先级规则
CC deny-first: deny 总是赢，无论来自哪个层级
```

### 4. 运行时动态更新 + 持久化

权限规则可在会话中动态添加，兼顾安全性和用户体验。这种"渐进式信任"模式值得其他 Agent 系统借鉴：

- 初始状态严格限制
- 用户在使用中逐步放开权限
- 放开的权限被持久化，避免重复操作

### 5. Hook 与权限协同

Hook 系统可以在权限检查之前介入，提供声明式规则无法覆盖的动态逻辑。这形成了两层控制：

```
声明式规则层: settings.json 中的 allow/deny/ask（覆盖 95% 场景）
编程式逻辑层: PreToolUse Hook（处理剩余 5% 的复杂逻辑）
```

### 6. 设置持久化与缓存一致性

读取带缓存、写入清缓存（Write-Invalidate），保证性能和一致性。这是一个在 Agent 系统中经常被忽视但至关重要的细节 — 配置的不一致可能导致安全漏洞。

| 设计模式 | 在 CC 中的应用 |
|---------|---------------|
| **级联合并（Cascade Merge）** | 5 层设置按优先级合并，deny 除外 |
| **规则聚合（Rule Aggregation）** | deny/ask/allow 从所有源 flatMap 收集 |
| **策略模式（Strategy）** | 5 种权限模式切换不同的决策策略 |
| **写入即失效（Write-Invalidate）** | 写入设置后立即清除缓存 |
| **容错降级** | 配置验证失败不崩溃，降级到默认设置 |

---

## 速查表

### 关键函数速查

| 混淆名 | 推测英文名 | 位置 | 用途 |
|--------|-----------|------|------|
| `fw()` | getSettingsFilePath | `04_git_operations.js:~8962` | 源名称 → 文件路径映射 |
| `O1H()` | getBaseDir | `04_git_operations.js:~8942` | 源名称 → 基础目录 |
| `T1H()` | getRelativePath | `04_git_operations.js:~8976` | 源名称 → 相对路径 |
| `k6()` | readSettingsCached | `04_git_operations.js:~8985` | 带缓存读取设置 |
| `XW8()` | readSettingsRaw | `04_git_operations.js:~8992` | 原始设置读取 + 验证 |
| `J8()` | writeSettingsMerged | `04_git_operations.js:~9036` | 带合并写入设置文件 |
| `GW8()` | validateSettingsSchema | `04_git_operations.js:~9093` | Zod schema 验证 |
| `Jf()` | parseRule | `04_git_operations.js:~7832` | 规则字符串 → 结构化对象 |
| `M_8()` | matchRule | `15_hooks_system.js:~7104` | 规则 vs 工具调用匹配 |
| `Ye6()` | checkPermission | `15_hooks_system.js:~7242` | 权限决策入口（预检查） |
| `ld_()` | checkDeny | `15_hooks_system.js:~7117` | deny 规则检查 |
| `_O9()` | checkAsk | `15_hooks_system.js:~7121` | ask 规则检查 |
| `L9H()` | collectDenyRules | `15_hooks_system.js:~7088` | 收集所有 deny 规则 |
| `JVH()` | collectAskRules | `15_hooks_system.js:~7096` | 收集所有 ask 规则 |
| `MVH()` | collectAllowRules | `15_hooks_system.js:~7034` | 收集所有 allow 规则 |
| `JO()` | applyPermissionUpdate | `11_api_streaming.js:~9856` | 内存中应用权限更新 |
| `oJ7()` | persistPermissionUpdate | `11_api_streaming.js:~9856` | 持久化规则到文件 |
| `Tv()` | applyUpdates | `11_api_streaming.js:~9856` | 批量应用多个更新 |
| `xM()` | createDefaultPermissionContext | `08_system_prompt.js:~186` | 创建默认权限上下文 |

### 5 层配置速查

| 层级 | 源名称 | 文件位置 | 可被覆盖 |
|------|--------|---------|---------|
| Layer 1 | `userSettings` | `~/.claude/settings.json` | 是（被 L2-5 覆盖） |
| Layer 2 | `projectSettings` | `<project>/.claude/settings.json` | 是（被 L3-5 覆盖） |
| Layer 3 | `localSettings` | `<project>/.claude/settings.local.json` | 是（被 L4-5 覆盖） |
| Layer 4 | `flagSettings` | CLI 参数 | 是（被 L5 覆盖） |
| Layer 5 | `policySettings` | 企业策略文件 | 否（最高优先级） |

### 权限模式速查

| 模式 | 自动允许 | 需要确认 | 强制拒绝 | 典型使用 |
|------|---------|---------|---------|---------|
| `default` | 匹配 allow 的操作 | 未匹配的操作 | 匹配 deny 的操作 | 日常交互 |
| `plan` | 只读操作 | 所有写入操作 | 匹配 deny 的操作 | 代码审查 |
| `acceptEdits` | 文件编辑操作 | 其他写入操作 | 匹配 deny 的操作 | 快速迭代 |
| `auto` | 大部分操作 | 高危操作 | 匹配 deny 的操作 | CI/CD |
| `bypassPermissions` | 几乎所有操作 | 无 | 企业 deny 规则 | 完全信任 |

### 决策优先级速查

```
deny (任何层级) > ask (任何层级) > tool.checkPermissions() > allow (任何层级)

Hook decision: block > deny > allow > ask > (无 decision = 继续正常流程)
```

---

*分析基于 Claude Code v2.1.86 反编译源码。混淆函数名后的英文名为基于上下文的合理推测。*
