# 第 9 章：Shell 工具 — 沙箱中的命令执行

> **核心问题**：在一个 AI Agent 系统中，如何安全地执行用户命令？Shell 工具作为最危险也是最有用的工具，如何在保证功能强大的同时，确保系统的安全性和稳定性？

Shell 工具是 OpenAI Codex CLI 中最核心也是最复杂的工具。它承担着将 AI 模型的意图转化为实际系统操作的重任。这个看似简单的"执行命令"背后，隐藏着精密的安全机制、复杂的权限控制和高效的执行策略。本章将深入剖析 Shell 工具的每一个设计细节，揭示如何在沙箱环境中安全地赋予 AI Agent 强大的系统控制能力。

## 9.1 Shell 工具架构概览

### 9.1.1 双工具设计模式

Codex 采用了独特的**双工具设计**，提供两种不同的 Shell 执行方式：

```rust
// 来源：codex-rs/core/src/tools/handlers/shell.rs
pub struct ShellHandler;           // 通用 shell 工具
pub struct ShellCommandHandler;    // 单行命令工具

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ShellCommandBackend {
    Classic,    // 经典后端
    ZshFork,    // Zsh 分叉后端
}
```

#### 工具对比表

| 特性 | ShellHandler | ShellCommandHandler |
|------|-------------|-------------------|
| **用途** | 多行复杂脚本 | 单行命令执行 |
| **参数格式** | `["cmd", "arg1", "arg2"]` | `"cmd arg1 arg2"` |
| **后端支持** | 统一处理 | 可选后端 (Classic/ZshFork) |
| **安全检测** | 完整命令数组分析 | 字符串解析 + 安全检测 |
| **典型用例** | 构建脚本、批处理 | 快速查询、简单操作 |

### 9.1.2 Shell 工具执行架构

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Model Call    │───▶│  Shell Handler   │───▶│  Command Safety │
│ shell(["ls"])   │    │                  │    │   Validation    │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                               │                         │
                               ▼                         ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  Hook System    │◀───│  Exec Policy     │◀───│  Safety Check   │
│   Validation    │    │   Engine         │    │   Result        │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                               │
                               ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  User Approval  │◀───│ Permission Gate  │───▶│ Sandbox Setup   │
│   (if needed)   │    │                  │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                               │                         │
                               ▼                         ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Final Result  │◀───│  Shell Runtime   │◀───│  Command Exec   │
│  (to Model)     │    │   Backend        │    │  (PTY/Pipes)    │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

### 9.1.3 核心数据结构

#### Shell 工具参数

```rust
// 来源：codex-protocol/src/models.rs
pub struct ShellToolCallParams {
    pub command: Vec<String>,                    // 命令数组
    pub workdir: Option<String>,                 // 工作目录
    pub timeout_ms: Option<u64>,                 // 超时（毫秒）
    pub sandbox_permissions: Option<SandboxPermissions>, // 沙箱权限
    pub additional_permissions: Option<PermissionProfile>, // 附加权限
    pub justification: Option<String>,           // 执行理由
}

pub struct ShellCommandToolCallParams {
    pub command: String,                         // 命令字符串
    pub workdir: Option<String>,                 // 工作目录
    pub timeout_ms: Option<u64>,                 // 超时设置
    pub login: Option<bool>,                     // 登录 shell
    pub sandbox_permissions: Option<SandboxPermissions>, // 沙箱权限
    pub additional_permissions: Option<PermissionProfile>, // 附加权限
    pub justification: Option<String>,           // 执行理由
}
```

#### 执行参数转换

```rust
// 来源：codex-rs/core/src/tools/handlers/shell.rs
impl ShellHandler {
    fn to_exec_params(
        params: &ShellToolCallParams,
        turn_context: &TurnContext,
        thread_id: ThreadId,
    ) -> ExecParams {
        ExecParams {
            command: params.command.clone(),
            cwd: turn_context.resolve_path(params.workdir.clone()),
            expiration: params.timeout_ms.into(),
            capture_policy: ExecCapturePolicy::ShellTool,
            env: create_env(&turn_context.shell_environment_policy, Some(thread_id)),
            network: turn_context.network.clone(),
            sandbox_permissions: params.sandbox_permissions.unwrap_or_default(),
            windows_sandbox_level: turn_context.windows_sandbox_level,
            windows_sandbox_private_desktop: turn_context
                .config
                .permissions
                .windows_sandbox_private_desktop,
            justification: params.justification.clone(),
            arg0: None,
        }
    }
}
```

## 9.2 命令安全检测机制

### 9.2.1 安全命令白名单

Codex 维护了一个详尽的安全命令白名单，用于快速识别无害的命令：

```rust
// 来源：codex-rs/shell-command/src/command_safety/is_safe_command.rs
fn is_safe_to_call_with_exec(command: &[String]) -> bool {
    let Some(cmd0) = command.first().map(String::as_str) else {
        return false;
    };

    match executable_name_lookup_key(cmd0).as_deref() {
        // 基础系统命令
        Some(
            "cat" | "cd" | "cut" | "echo" | "expr" | "false" | "grep" |
            "head" | "id" | "ls" | "nl" | "paste" | "pwd" | "rev" |
            "seq" | "stat" | "tail" | "tr" | "true" | "uname" |
            "uniq" | "wc" | "which" | "whoami"
        ) => true,

        // Linux 特有安全命令
        Some(cmd) if cfg!(target_os = "linux") && matches!(cmd, "numfmt" | "tac") => true,

        // 有条件安全的命令
        Some("base64") => !has_unsafe_base64_options(&command[1..]),
        Some("find") => !has_unsafe_find_options(&command[1..]),
        Some("git") => is_safe_git_command(command),

        _ => false,
    }
}
```

#### 安全命令分类表

| 命令类别 | 典型命令 | 安全原因 |
|---------|----------|----------|
| **文件查看** | `cat`, `head`, `tail`, `grep` | 只读操作，无副作用 |
| **系统信息** | `pwd`, `whoami`, `uname`, `id` | 仅查询系统状态 |
| **文本处理** | `cut`, `tr`, `uniq`, `wc`, `sort` | 纯数据转换，不修改文件 |
| **目录操作** | `ls`, `cd` | 基本导航操作 |
| **条件安全** | `find`, `git`, `base64` | 需参数检查的命令 |

### 9.2.2 条件安全命令处理

某些命令本身相对安全，但特定参数组合可能带来风险：

#### base64 命令安全检测

```rust
// 来源：codex-rs/shell-command/src/command_safety/is_safe_command.rs
Some("base64") => {
    const UNSAFE_BASE64_OPTIONS: &[&str] = &["-o", "--output"];

    !command.iter().skip(1).any(|arg| {
        UNSAFE_BASE64_OPTIONS.contains(&arg.as_str())
            || arg.starts_with("--output=")
            || (arg.starts_with("-o") && arg != "-o")
    })
}
```

#### find 命令危险选项检测

```rust
const UNSAFE_FIND_OPTIONS: &[&str] = &[
    // 可执行任意命令的选项
    "-exec", "-execdir", "-ok", "-okdir",
    // 可删除文件的选项
    "-delete",
    // 可修改文件的选项
    "-fprint", "-fprint0", "-fprintf",
    // 其他危险操作
    "-quit", "-prune"
];
```

#### Git 命令安全分析

Git 命令的安全性检测更加复杂，需要识别子命令并分析全局选项：

```rust
// 来源：codex-rs/shell-command/src/command_safety/is_dangerous_command.rs
pub fn find_git_subcommand(args: &[String]) -> Option<&str> {
    let mut i = 1; // 跳过 "git"

    while i < args.len() {
        let arg = &args[i];

        if git_global_option_requires_prompt(arg) {
            return None; // 危险全局选项
        }

        if !arg.starts_with('-') {
            return Some(arg); // 找到子命令
        }

        i += 1;
        // 处理需要参数的选项
        if matches!(arg.as_str(), "-C" | "-c" | "--git-dir" | "--work-tree") {
            i += 1; // 跳过参数值
        }
    }

    None
}
```

### 9.2.3 复合命令安全分析

对于包含管道、重定向等 shell 操作符的复合命令，系统采用解析器进行安全分析：

```rust
// 来源：codex-rs/shell-command/src/command_safety/is_safe_command.rs
// 支持 `bash -lc "..."` 格式，其中脚本只包含安全的"纯"命令
if let Some(all_commands) = parse_shell_lc_plain_commands(&command)
    && !all_commands.is_empty()
    && all_commands
        .iter()
        .all(|cmd| is_safe_to_call_with_exec(cmd))
{
    return true;
}
```

#### 支持的安全操作符

| 操作符 | 描述 | 安全原因 |
|-------|------|----------|
| `&&` | 逻辑与 | 不引入副作用 |
| `\|\|` | 逻辑或 | 不引入副作用 |
| `;` | 命令分隔 | 仅控制执行顺序 |
| `\|` | 管道 | 数据传递，不修改系统 |

## 9.3 执行策略与权限控制

### 9.3.1 执行策略引擎

Codex 使用基于规则的执行策略引擎来控制命令执行：

```rust
// 来源：codex-rs/core/src/exec_policy.rs
pub struct ExecPolicy {
    policy: Arc<ArcSwap<Policy>>,
    config_layer_stack: ConfigLayerStack,
}

impl ExecPolicy {
    pub async fn evaluate_command(
        &self,
        command: &[String],
        sandbox_policy: &SandboxPolicy,
    ) -> Result<ExecApprovalRequirement, ExecPolicyError> {
        let policy = self.policy.load();

        let evaluation = policy.evaluate_command(
            command,
            &MatchOptions {
                sandbox_policy: Some(sandbox_policy),
                ..Default::default()
            }
        )?;

        match evaluation.decision {
            Decision::Allow => Ok(ExecApprovalRequirement::None),
            Decision::Prompt => Ok(ExecApprovalRequirement::UserApproval),
            Decision::Deny => Err(ExecPolicyError::CommandRejected(
                evaluation.reason.unwrap_or_default()
            )),
        }
    }
}
```

### 9.3.2 危险命令检测

除了白名单机制，系统还维护了危险命令的黑名单：

```rust
// 来源：codex-rs/core/src/exec_policy.rs
static BANNED_PREFIX_SUGGESTIONS: &[&[&str]] = &[
    &["python3"], &["python3", "-"], &["python3", "-c"],
    &["python"], &["python", "-"], &["python", "-c"],
    &["git"],
    &["bash"], &["bash", "-lc"],
    &["sh"], &["sh", "-c"], &["sh", "-lc"],
    &["zsh"], &["zsh", "-lc"],
    &["pwsh"], &["pwsh", "-Command"], &["pwsh", "-c"],
    &["powershell"], &["powershell", "-Command"],
    &["env"], &["sudo"],
    &["node"], &["node", "-e"],
    &["perl"], &["perl", "-e"],
    &["ruby"], &["ruby", "-e"],
    &["php"], &["php", "-r"],
    &["lua"], &["lua", "-e"],
    &["osascript"],
];
```

#### 危险命令分类

| 风险等级 | 命令类型 | 典型示例 | 风险说明 |
|---------|----------|----------|----------|
| **高危** | 解释器 | `python -c`, `node -e` | 可执行任意代码 |
| **中危** | 系统工具 | `sudo`, `env` | 权限提升 |
| **管控** | 版本控制 | `git` | 可能修改代码仓库 |
| **平台特定** | 脚本引擎 | `osascript`, `powershell` | 平台特定的执行环境 |

### 9.3.3 变更性检测逻辑

Shell 工具实现了精确的变更性检测，用于并发控制：

```rust
// 来源：codex-rs/core/src/tools/handlers/shell.rs
async fn is_mutating(&self, invocation: &ToolInvocation) -> bool {
    match &invocation.payload {
        ToolPayload::Function { arguments } => {
            serde_json::from_str::<ShellToolCallParams>(arguments)
                .map(|params| !is_known_safe_command(&params.command))
                .unwrap_or(true) // 解析失败时保守地认为是变更性的
        }
        ToolPayload::LocalShell { params } => {
            !is_known_safe_command(&params.command)
        }
        _ => true, // 其他载荷类型默认为变更性
    }
}
```

> **设计决策**：变更性检测采用了"失败安全"的原则——当无法确定命令安全性时，默认认为是变更性的。这确保了系统的安全性，虽然可能牺牲一些并行性能。

## 9.4 沙箱执行环境

### 9.4.1 沙箱权限层级

Codex 定义了细粒度的沙箱权限系统：

```rust
// 来源：codex-protocol/src/permissions.rs
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SandboxPermissions {
    /// 使用默认权限
    UseDefault,
    /// 只读访问
    ReadOnly,
    /// 工作区写入权限
    WorkspaceWrite,
    /// 需要提升权限
    RequireEscalated,
    /// 使用附加权限
    WithAdditionalPermissions,
}
```

#### 权限层级图

```
┌─────────────────┐
│   ReadOnly      │  ← 最安全，仅查看
└─────────────────┘
          │
          ▼
┌─────────────────┐
│  WorkspaceWrite │  ← 中等安全，工作区修改
└─────────────────┘
          │
          ▼
┌─────────────────┐
│WithAdditional   │  ← 低安全，需审批
│   Permissions   │
└─────────────────┘
          │
          ▼
┌─────────────────┐
│RequireEscalated │  ← 危险，需明确授权
└─────────────────┘
```

### 9.4.2 执行上下文构建

每个 Shell 命令都在精心构建的执行上下文中运行：

```rust
// 来源：codex-rs/core/src/tools/handlers/shell.rs
struct RunExecLikeArgs {
    tool_name: String,
    exec_params: ExecParams,
    additional_permissions: Option<PermissionProfile>,
    prefix_rule: Option<Vec<String>>,
    session: Arc<crate::codex::Session>,
    turn: Arc<TurnContext>,
    tracker: crate::tools::context::SharedTurnDiffTracker,
    call_id: String,
    freeform: bool,
    shell_runtime_backend: ShellRuntimeBackend,
}
```

#### 环境变量管理

```rust
// 来源：codex-rs/core/src/exec_env.rs
pub fn create_env(
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<ThreadId>
) -> HashMap<String, String> {
    let mut env = HashMap::new();

    match policy {
        ShellEnvironmentPolicy::Inherit => {
            // 继承当前进程环境
            env = std::env::vars().collect();
        }
        ShellEnvironmentPolicy::Clean => {
            // 清洁环境，只保留必要变量
            if let Ok(path) = std::env::var("PATH") {
                env.insert("PATH".to_string(), path);
            }
            if let Ok(home) = std::env::var("HOME") {
                env.insert("HOME".to_string(), home);
            }
        }
        ShellEnvironmentPolicy::Custom(custom_vars) => {
            env.extend(custom_vars.clone());
        }
    }

    // 添加 Codex 特定变量
    if let Some(thread_id) = thread_id {
        env.insert("CODEX_THREAD_ID".to_string(), thread_id.to_string());
    }

    env
}
```

### 9.4.3 工作目录解析

```rust
// 来源：codex-rs/core/src/codex.rs
impl TurnContext {
    pub fn resolve_path(&self, workdir: Option<String>) -> PathBuf {
        match workdir {
            Some(dir) if !dir.is_empty() => {
                let path = PathBuf::from(dir);
                if path.is_absolute() {
                    path
                } else {
                    self.cwd.join(path)
                }
            }
            _ => self.cwd.clone(),
        }
    }
}
```

## 9.5 Shell 运行时后端

### 9.5.1 后端架构设计

Codex 支持多种 Shell 运行时后端，以适应不同的执行需求：

```rust
// 来源：codex-rs/core/src/tools/runtimes/shell.rs
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellRuntimeBackend {
    ShellCommandClassic,     // 经典后端
    ShellCommandZshFork,     // Zsh 分叉后端
}

pub struct ShellRuntime {
    backend: ShellRuntimeBackend,
}

impl ShellRuntime {
    pub async fn execute(&self, request: ShellRequest) -> Result<ShellResponse, ShellError> {
        match self.backend {
            ShellRuntimeBackend::ShellCommandClassic => {
                self.execute_classic(request).await
            }
            ShellRuntimeBackend::ShellCommandZshFork => {
                self.execute_zsh_fork(request).await
            }
        }
    }
}
```

#### 后端特性对比

| 特性 | Classic 后端 | ZshFork 后端 |
|------|-------------|--------------|
| **性能** | 标准 | 优化 |
| **兼容性** | 最佳 | 良好 (Zsh 限定) |
| **隔离性** | 标准 | 增强 |
| **资源消耗** | 低 | 中等 |
| **适用场景** | 通用命令 | 复杂脚本 |

### 9.5.2 PTY 支持与输出捕获

```rust
// 来源：codex-rs/core/src/exec.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecCapturePolicy {
    /// Shell 工具专用捕获策略
    ShellTool,
    /// 实时流式输出
    Streaming,
    /// 批量缓冲输出
    Buffered,
}

pub struct ExecParams {
    pub command: Vec<String>,
    pub cwd: PathBuf,
    pub expiration: ExecExpiration,
    pub capture_policy: ExecCapturePolicy,
    pub env: HashMap<String, String>,
    pub network: NetworkConfig,
    pub sandbox_permissions: SandboxPermissions,
    // ... 其他参数
}
```

#### 输出捕获策略

Shell 工具使用专门的捕获策略来处理命令输出：

```rust
// 来源：codex-rs/core/src/exec.rs
impl ExecCapturePolicy {
    pub fn buffer_size(&self) -> Option<usize> {
        match self {
            ExecCapturePolicy::ShellTool => Some(1024 * 1024), // 1MB 缓冲
            ExecCapturePolicy::Streaming => Some(4096),        // 4KB 缓冲
            ExecCapturePolicy::Buffered => None,               // 无限制
        }
    }

    pub fn enable_pty(&self) -> bool {
        match self {
            ExecCapturePolicy::ShellTool => true,  // 启用 PTY 支持颜色
            ExecCapturePolicy::Streaming => false,
            ExecCapturePolicy::Buffered => false,
        }
    }
}
```

### 9.5.3 超时处理机制

```rust
// 来源：codex-rs/core/src/exec.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecExpiration {
    /// 永不超时
    Never,
    /// 指定超时时间
    After(Duration),
    /// 从参数推导超时时间
    FromParams(Option<u64>), // 毫秒
}

impl From<Option<u64>> for ExecExpiration {
    fn from(timeout_ms: Option<u64>) -> Self {
        match timeout_ms {
            Some(ms) if ms > 0 => ExecExpiration::After(Duration::from_millis(ms)),
            _ => ExecExpiration::After(Duration::from_secs(300)), // 默认 5 分钟
        }
    }
}
```

## 9.6 用户审批工作流

### 9.6.1 审批需求评估

系统通过多层检查来确定是否需要用户审批：

```
┌─────────────────┐
│  Command Input  │
└─────────────────┘
          │
          ▼
┌─────────────────┐    YES   ┌─────────────────┐
│   Safe Command  │─────────▶│  Execute Direct │
│     Check       │          │                 │
└─────────────────┘          └─────────────────┘
          │ NO
          ▼
┌─────────────────┐
│  Policy Engine  │
│   Evaluation    │
└─────────────────┘
          │
          ▼
┌─────────────────┐    ALLOW  ┌─────────────────┐
│     Policy      │──────────▶│  Execute Direct │
│    Decision     │           │                 │
└─────────────────┘           └─────────────────┘
          │ PROMPT
          ▼
┌─────────────────┐    DENY   ┌─────────────────┐
│  User Approval  │──────────▶│  Reject Command │
│    Workflow     │           │                 │
└─────────────────┘           └─────────────────┘
          │ APPROVED
          ▼
┌─────────────────┐
│  Execute with   │
│   Monitoring    │
└─────────────────┘
```

### 9.6.2 审批请求构造

```rust
// 来源：codex-rs/core/src/exec_policy.rs
pub struct ExecApprovalRequest {
    pub command: Vec<String>,
    pub workdir: PathBuf,
    pub reason: String,
    pub risk_level: RiskLevel,
    pub policy_context: PolicyContext,
}

impl ExecApprovalRequest {
    pub fn from_shell_params(
        params: &ShellToolCallParams,
        turn_context: &TurnContext,
        policy_evaluation: &PolicyEvaluation,
    ) -> Self {
        Self {
            command: params.command.clone(),
            workdir: turn_context.resolve_path(params.workdir.clone()),
            reason: params.justification
                .clone()
                .unwrap_or_else(|| "AI-requested command execution".to_string()),
            risk_level: assess_command_risk(&params.command),
            policy_context: PolicyContext::from_evaluation(policy_evaluation),
        }
    }
}
```

### 9.6.3 风险评估算法

```rust
// 来源：codex-rs/core/src/exec_policy.rs
#[derive(Debug, Clone, PartialEq, Eq, Ord, PartialOrd)]
pub enum RiskLevel {
    Low,      // 白名单命令
    Medium,   // 需要参数检查的命令
    High,     // 潜在危险命令
    Critical, // 明确危险的命令
}

fn assess_command_risk(command: &[String]) -> RiskLevel {
    if is_known_safe_command(command) {
        return RiskLevel::Low;
    }

    if command_might_be_dangerous(command) {
        return RiskLevel::Critical;
    }

    // 检查是否包含危险模式
    let command_str = command.join(" ");
    if contains_dangerous_patterns(&command_str) {
        return RiskLevel::High;
    }

    // 默认为中等风险
    RiskLevel::Medium
}

fn contains_dangerous_patterns(command: &str) -> bool {
    const DANGEROUS_PATTERNS: &[&str] = &[
        "rm -rf", "> /dev/", "dd if=", ":(){ :|:& };:", // Fork bomb
        "curl | sh", "wget | sh", "eval", "exec",
    ];

    DANGEROUS_PATTERNS.iter().any(|pattern| command.contains(pattern))
}
```

## 9.7 钩子集成与拦截机制

### 9.7.1 Shell 工具钩子载荷

Shell 工具为钩子系统提供了丰富的载荷信息：

```rust
// 来源：codex-rs/core/src/tools/handlers/shell.rs
fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload> {
    let command = shell_payload_command(&invocation.payload)?;
    Some(PreToolUsePayload { command })
}

fn post_tool_use_payload(
    &self,
    _call_id: &str,
    payload: &ToolPayload,
    result: &dyn ToolOutput,
) -> Option<PostToolUsePayload> {
    let command = shell_payload_command(payload)?;
    let tool_response = result.to_json_value();

    Some(PostToolUsePayload {
        command,
        tool_response,
    })
}
```

### 9.7.2 命令拦截与修改

钩子系统可以拦截并修改 Shell 命令：

```rust
// 来源：codex-hooks/src/lib.rs
pub struct HookResult {
    pub should_continue: bool,
    pub modified_command: Option<Vec<String>>,
    pub additional_context: Vec<String>,
    pub reason: Option<String>,
}

// 钩子可以：
// 1. 阻止命令执行 (should_continue = false)
// 2. 修改命令内容 (modified_command)
// 3. 添加上下文信息 (additional_context)
// 4. 提供阻止原因 (reason)
```

### 9.7.3 Apply Patch 拦截

特殊的文件修改命令会被 apply_patch 工具拦截：

```rust
// 来源：codex-rs/core/src/tools/handlers/apply_patch.rs
pub(super) fn intercept_apply_patch(
    command: &[String],
) -> Option<InterceptResult> {
    // 检测是否是文件修改命令
    if is_file_modification_command(command) {
        let (file_path, operation) = parse_modification_command(command)?;

        Some(InterceptResult {
            intercept: true,
            suggested_tool: "apply_patch".to_string(),
            file_path,
            operation,
        })
    } else {
        None
    }
}

fn is_file_modification_command(command: &[String]) -> bool {
    match command.first().map(String::as_str) {
        Some("echo") => command.contains(&">>".to_string()) || command.contains(&">".to_string()),
        Some("cat") => command.contains(&">>".to_string()) || command.contains(&">".to_string()),
        Some("sed") => command.iter().any(|arg| arg.starts_with("-i")),
        Some("awk") => command.contains(&">".to_string()),
        _ => false,
    }
}
```

## 9.8 性能优化与资源管理

### 9.8.1 命令执行缓存

对于某些只读命令，系统实现了智能缓存：

```rust
// 来源：codex-rs/core/src/tools/handlers/shell.rs
pub struct ShellCache {
    cache: Arc<RwLock<HashMap<String, CachedResult>>>,
    ttl: Duration,
}

struct CachedResult {
    output: String,
    exit_code: i32,
    timestamp: Instant,
}

impl ShellCache {
    pub async fn get_or_execute<F, Fut>(
        &self,
        cache_key: &str,
        executor: F,
    ) -> Result<ExecToolCallOutput, FunctionCallError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<ExecToolCallOutput, FunctionCallError>>,
    {
        // 检查缓存
        {
            let cache = self.cache.read().await;
            if let Some(cached) = cache.get(cache_key) {
                if cached.timestamp.elapsed() < self.ttl {
                    return Ok(cached.to_exec_output());
                }
            }
        }

        // 执行命令并缓存结果
        let result = executor().await?;
        if result.exit_code == 0 {
            let mut cache = self.cache.write().await;
            cache.insert(cache_key.to_string(), CachedResult::from(&result));
        }

        Ok(result)
    }
}
```

### 9.8.2 资源限制控制

```rust
// 来源：codex-rs/core/src/exec.rs
pub struct ResourceLimits {
    pub max_memory: Option<u64>,        // 最大内存（字节）
    pub max_cpu_time: Option<Duration>, // 最大 CPU 时间
    pub max_output_size: Option<u64>,   // 最大输出大小
    pub max_open_files: Option<u32>,    // 最大打开文件数
}

impl ResourceLimits {
    pub fn for_shell_tool() -> Self {
        Self {
            max_memory: Some(512 * 1024 * 1024),    // 512MB
            max_cpu_time: Some(Duration::from_secs(300)), // 5 分钟
            max_output_size: Some(10 * 1024 * 1024), // 10MB
            max_open_files: Some(256),               // 256 个文件
        }
    }
}
```

### 9.8.3 并发执行优化

通过精确的变更性检测，系统可以并行执行多个只读命令：

```rust
// 来源：codex-rs/core/src/tools/parallel.rs
pub struct ParallelExecutor {
    read_only_semaphore: Arc<Semaphore>,    // 只读操作信号量
    mutating_mutex: Arc<Mutex<()>>,         // 变更操作互斥锁
}

impl ParallelExecutor {
    pub async fn execute_shell_command(
        &self,
        command: &[String],
        is_mutating: bool,
    ) -> Result<ExecToolCallOutput, ExecError> {
        if is_mutating {
            // 变更操作需要独占访问
            let _guard = self.mutating_mutex.lock().await;
            self.execute_single(command).await
        } else {
            // 只读操作可以并行
            let _permit = self.read_only_semaphore.acquire().await?;
            self.execute_single(command).await
        }
    }
}
```

## 9.9 错误处理与诊断

### 9.9.1 分层错误处理

Shell 工具采用细粒度的错误分类和处理：

```rust
// 来源：codex-rs/core/src/tools/handlers/shell.rs
#[derive(Debug, thiserror::Error)]
pub enum ShellError {
    #[error("Command not found: {command}")]
    CommandNotFound { command: String },

    #[error("Permission denied: {reason}")]
    PermissionDenied { reason: String },

    #[error("Command timeout after {duration:?}")]
    Timeout { duration: Duration },

    #[error("Command failed with exit code {code}: {stderr}")]
    CommandFailed { code: i32, stderr: String },

    #[error("Sandbox violation: {details}")]
    SandboxViolation { details: String },

    #[error("Resource limit exceeded: {limit_type}")]
    ResourceLimitExceeded { limit_type: String },
}

impl From<ShellError> for FunctionCallError {
    fn from(error: ShellError) -> Self {
        match error {
            ShellError::PermissionDenied { .. } |
            ShellError::SandboxViolation { .. } => {
                FunctionCallError::RespondToModel(error.to_string())
            }
            _ => FunctionCallError::Fatal(error.to_string())
        }
    }
}
```

### 9.9.2 诊断信息收集

```rust
// 来源：codex-rs/core/src/tools/handlers/shell.rs
pub struct ShellDiagnostics {
    pub command: Vec<String>,
    pub working_directory: PathBuf,
    pub environment_vars: HashMap<String, String>,
    pub permissions: SandboxPermissions,
    pub execution_time: Duration,
    pub peak_memory_usage: Option<u64>,
    pub exit_code: i32,
    pub signal: Option<String>,
}

impl ShellDiagnostics {
    pub fn to_debug_report(&self) -> String {
        format!(
            "Shell Command Diagnostics:\n\
             Command: {:?}\n\
             Working Directory: {:?}\n\
             Execution Time: {:?}\n\
             Exit Code: {}\n\
             Peak Memory: {:?}\n\
             Permissions: {:?}",
            self.command,
            self.working_directory,
            self.execution_time,
            self.exit_code,
            self.peak_memory_usage,
            self.permissions
        )
    }
}
```

### 9.9.3 故障恢复机制

```rust
// 来源：codex-rs/core/src/tools/handlers/shell.rs
pub struct ShellRecovery;

impl ShellRecovery {
    pub async fn handle_command_failure(
        error: &ShellError,
        context: &ToolInvocation,
    ) -> Option<String> {
        match error {
            ShellError::CommandNotFound { command } => {
                Self::suggest_alternatives(command).await
            }
            ShellError::PermissionDenied { .. } => {
                Some("Try requesting additional permissions or using a different approach.".to_string())
            }
            ShellError::Timeout { .. } => {
                Some("Command timed out. Consider breaking it into smaller steps or increasing the timeout.".to_string())
            }
            _ => None,
        }
    }

    async fn suggest_alternatives(command: &str) -> Option<String> {
        let alternatives = match command {
            "python" => vec!["python3", "py"],
            "node" => vec!["nodejs"],
            "vim" => vec!["nano", "emacs"],
            _ => return None,
        };

        Some(format!(
            "Command '{}' not found. Try these alternatives: {}",
            command,
            alternatives.join(", ")
        ))
    }
}
```

## 9.10 平台特定实现

### 9.10.1 Windows 平台适配

```rust
// 来源：codex-rs/shell-command/src/command_safety/windows_safe_commands.rs
pub fn is_safe_command_windows(command: &[String]) -> bool {
    let Some(cmd0) = command.first().map(String::as_str) else {
        return false;
    };

    match cmd0.to_lowercase().as_str() {
        // Windows 内置命令
        "dir" | "type" | "echo" | "cd" | "cls" | "date" | "time" |
        "ver" | "vol" | "path" | "set" | "where" | "whoami" => true,

        // PowerShell cmdlets
        cmd if cmd.starts_with("get-") => is_safe_powershell_cmdlet(cmd),

        // 检查 .exe 扩展名
        cmd if cmd.ends_with(".exe") => {
            is_safe_windows_executable(&cmd[..cmd.len()-4])
        }

        _ => false,
    }
}

fn is_safe_powershell_cmdlet(cmdlet: &str) -> bool {
    match cmdlet {
        "get-location" | "get-childitem" | "get-content" |
        "get-process" | "get-service" | "get-date" |
        "get-host" | "get-variable" => true,
        _ => false,
    }
}
```

### 9.10.2 macOS 平台适配

```rust
// 来源：codex-rs/shell-command/src/command_safety/macos_safe_commands.rs
pub fn is_safe_command_macos(command: &[String]) -> bool {
    let Some(cmd0) = command.first().map(String::as_str) else {
        return false;
    };

    match cmd0 {
        // macOS 特有的安全命令
        "dscl" if is_read_only_dscl_command(&command[1..]) => true,
        "system_profiler" => true,
        "sw_vers" => true,
        "sysctl" if is_read_only_sysctl_command(&command[1..]) => true,
        "defaults" if command.get(1) == Some(&"read".to_string()) => true,

        _ => false,
    }
}

fn is_read_only_dscl_command(args: &[String]) -> bool {
    // 只允许读取操作
    args.iter().any(|arg| matches!(arg.as_str(), "read" | "list" | "search"))
        && !args.iter().any(|arg| matches!(arg.as_str(), "create" | "delete" | "change"))
}
```

## 9.11 监控与遥测

### 9.11.1 执行指标收集

```rust
// 来源：codex-rs/core/src/tools/handlers/shell.rs
pub struct ShellMetrics {
    pub total_commands: Arc<AtomicU64>,
    pub safe_commands: Arc<AtomicU64>,
    pub dangerous_commands: Arc<AtomicU64>,
    pub approved_commands: Arc<AtomicU64>,
    pub rejected_commands: Arc<AtomicU64>,
    pub execution_times: Arc<Mutex<Vec<Duration>>>,
}

impl ShellMetrics {
    pub fn record_command_execution(
        &self,
        command: &[String],
        is_safe: bool,
        needed_approval: bool,
        was_approved: bool,
        execution_time: Duration,
    ) {
        self.total_commands.fetch_add(1, Ordering::Relaxed);

        if is_safe {
            self.safe_commands.fetch_add(1, Ordering::Relaxed);
        } else {
            self.dangerous_commands.fetch_add(1, Ordering::Relaxed);
        }

        if needed_approval {
            if was_approved {
                self.approved_commands.fetch_add(1, Ordering::Relaxed);
            } else {
                self.rejected_commands.fetch_add(1, Ordering::Relaxed);
            }
        }

        if let Ok(mut times) = self.execution_times.lock() {
            times.push(execution_time);
            // 保持最近 1000 次执行的记录
            if times.len() > 1000 {
                times.drain(0..times.len() - 1000);
            }
        }
    }
}
```

### 9.11.2 安全事件记录

```rust
// 来源：codex-rs/core/src/tools/handlers/shell.rs
pub struct SecurityEvent {
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub event_type: SecurityEventType,
    pub command: Vec<String>,
    pub user_session: String,
    pub risk_level: RiskLevel,
    pub outcome: SecurityOutcome,
}

#[derive(Debug, Clone)]
pub enum SecurityEventType {
    DangerousCommandAttempt,
    PolicyViolation,
    SandboxEscape,
    UnauthorizedAccess,
    SuspiciousActivity,
}

#[derive(Debug, Clone)]
pub enum SecurityOutcome {
    Blocked,
    Approved,
    AutoApproved,
    Failed,
}

impl SecurityEvent {
    pub fn log(&self) {
        tracing::warn!(
            event_type = ?self.event_type,
            command = ?self.command,
            risk_level = ?self.risk_level,
            outcome = ?self.outcome,
            "Shell security event recorded"
        );
    }
}
```

## 9.12 总结

OpenAI Codex CLI 的 Shell 工具是一个工程学的杰作，它完美地平衡了功能性和安全性：

### 9.12.1 核心设计原则

1. **安全优先**：失败安全的设计哲学，保守的权限控制
2. **分层防护**：多层安全检查，从白名单到策略引擎到用户审批
3. **性能优化**：智能的并发控制和缓存机制
4. **可观测性**：全面的监控和诊断能力
5. **平台适配**：跨平台的一致性体验

### 9.12.2 技术亮点

| 技术特性 | 实现方式 | 价值 |
|---------|----------|------|
| **安全命令识别** | 白名单 + 黑名单 + 启发式分析 | 自动化安全决策 |
| **细粒度权限** | 多层级沙箱权限系统 | 最小权限原则 |
| **智能并发** | 基于变更性的并发控制 | 性能与安全平衡 |
| **钩子集成** | 前置和后置钩子支持 | 可扩展性 |
| **故障恢复** | 智能错误处理和建议 | 用户体验 |

### 9.12.3 架构优势

Shell 工具的架构体现了现代系统设计的最佳实践：

- **模块化**：清晰的职责分离，便于维护和测试
- **可扩展**：支持多种后端和钩子扩展
- **可观测**：全面的监控和诊断能力
- **容错性**：优雅的错误处理和恢复机制
- **安全性**：深度防御的安全策略

在下一章中，我们将探讨文件 I/O 工具族，看看 Codex 如何以同样精密的方式处理文件操作的安全性和功能性。