# 第 8 章：工具系统总论 — Agent 的执行臂

> **核心问题**：OpenAI Codex CLI 如何通过精密设计的工具系统，将 AI 模型的推理能力转化为对现实世界的操作能力？这个看似简单的"工具调用"背后，隐藏着怎样复杂而优雅的架构设计？

在 AI Agent 的世界里，工具系统扮演着至关重要的角色。如果说大语言模型是 Agent 的"大脑"，那么工具系统就是它的"手臂"——负责将抽象的推理转化为具体的行动。OpenAI Codex CLI 的工具系统是一个高度工程化的执行框架，它不仅要保证功能的丰富性和扩展性，更要在安全性和性能之间找到完美的平衡点。

## 8.1 工具系统架构概览

### 8.1.1 整体架构设计

Codex 的工具系统采用了经典的**注册-分发**（Registry-Dispatcher）架构模式，核心组件分布在 `codex-rs/core/src/tools/` 目录下：

```
tools/
├── mod.rs                    # 工具系统入口和公共函数
├── registry.rs              # 工具注册表和分发器
├── router.rs                # 工具路由系统
├── orchestrator.rs          # 工具编排器
├── context.rs               # 工具上下文管理
├── handlers/                # 具体工具实现
│   ├── mod.rs
│   ├── shell.rs            # Shell 命令工具
│   ├── apply_patch.rs      # 文件修补工具
│   ├── list_dir.rs         # 目录列表工具
│   ├── mcp.rs              # MCP 工具适配器
│   ├── dynamic.rs          # 动态工具处理器
│   └── ...
├── sandboxing.rs           # 沙箱隔离
├── runtimes/               # 运行时环境
└── spec.rs                 # 工具规范定义
```

#### 架构流程图

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Model Call    │───▶│   Tool Router    │───▶│  Tool Registry  │
│ (function_call) │    │                  │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                               │                         │
                               ▼                         ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Hook System   │◀───│ Tool Invocation  │───▶│  Tool Handler   │
│  (Pre/Post)     │    │    Context       │    │   (Specific)    │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                               │                         │
                               ▼                         ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ Response Format │◀───│   Tool Output    │◀───│   Tool Exec     │
│   (to Model)    │    │   Processing     │    │  (Sandboxed)    │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

### 8.1.2 核心抽象设计

工具系统的设计遵循了 Rust 的类型安全原则，通过 trait 定义了清晰的抽象接口：

```rust
// 来源：codex-rs/core/src/tools/registry.rs
#[async_trait]
pub trait ToolHandler: Send + Sync {
    type Output: ToolOutput + 'static;

    fn kind(&self) -> ToolKind;

    /// 检查工具调用是否可能修改环境
    async fn is_mutating(&self, invocation: &ToolInvocation) -> bool {
        false
    }

    /// 工具执行前的钩子载荷
    fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload> {
        None
    }

    /// 工具执行后的钩子载荷
    fn post_tool_use_payload(
        &self,
        call_id: &str,
        payload: &ToolPayload,
        result: &dyn ToolOutput,
    ) -> Option<PostToolUsePayload> {
        None
    }

    /// 执行工具调用的核心方法
    async fn handle(&self, invocation: ToolInvocation) -> Result<Self::Output, FunctionCallError>;
}
```

> **设计决策**：`ToolHandler` trait 使用了关联类型 `Output`，这样每个具体的工具处理器可以定义自己的输出类型，同时通过 `ToolOutput` trait 保证了输出格式的一致性。这种设计既提供了类型安全，又保持了灵活性。

### 8.1.3 工具分类体系

Codex 支持三大类工具，每类都有不同的设计目标和使用场景：

| 工具类型 | 枚举值 | 用途 | 典型示例 |
|---------|--------|------|----------|
| Function | `ToolKind::Function` | 内置功能工具 | shell、read_file、write_file |
| MCP | `ToolKind::Mcp` | MCP 协议工具 | 外部服务集成 |
| Dynamic | N/A | 动态工具 | 客户端定义的运行时工具 |

## 8.2 工具注册与发现机制

### 8.2.1 工具注册表实现

`ToolRegistry` 是整个工具系统的核心，它维护着从工具名称到处理器的映射关系：

```rust
// 来源：codex-rs/core/src/tools/registry.rs
pub struct ToolRegistry {
    handlers: HashMap<String, Arc<dyn AnyToolHandler>>,
}

impl ToolRegistry {
    fn handler(&self, name: &str, namespace: Option<&str>) -> Option<Arc<dyn AnyToolHandler>> {
        self.handlers
            .get(&tool_handler_key(name, namespace))
            .map(Arc::clone)
    }

    pub(crate) async fn dispatch_any(
        &self,
        invocation: ToolInvocation,
    ) -> Result<AnyToolResult, FunctionCallError> {
        // 工具分发逻辑
    }
}
```

#### 工具键值生成策略

工具的唯一标识通过命名空间和名称组合生成：

```rust
// 来源：codex-rs/core/src/tools/registry.rs
pub(crate) fn tool_handler_key(tool_name: &str, namespace: Option<&str>) -> String {
    if let Some(namespace) = namespace {
        format!("{namespace}:{tool_name}")
    } else {
        tool_name.to_string()
    }
}
```

这种设计支持了**命名空间隔离**，避免了不同来源的工具之间的命名冲突。

### 8.2.2 工具构建器模式

Codex 使用构建器模式来组装工具注册表，这样可以在启动时动态配置工具集合：

```rust
// 来源：codex-rs/core/src/tools/registry.rs
pub struct ToolRegistryBuilder {
    handlers: HashMap<String, Arc<dyn AnyToolHandler>>,
    specs: Vec<ConfiguredToolSpec>,
}

impl ToolRegistryBuilder {
    pub fn register_handler<H>(&mut self, name: impl Into<String>, handler: Arc<H>)
    where
        H: ToolHandler + 'static,
    {
        let name = name.into();
        let handler: Arc<dyn AnyToolHandler> = handler;
        if self.handlers.insert(name.clone(), handler.clone()).is_some() {
            warn!("overwriting handler for tool {name}");
        }
    }

    pub fn build(self) -> (Vec<ConfiguredToolSpec>, ToolRegistry) {
        let registry = ToolRegistry::new(self.handlers);
        (self.specs, registry)
    }
}
```

### 8.2.3 工具规范与配置

每个工具都需要提供 JSON Schema 规范，用于模型理解和参数验证：

```rust
// 来源：codex-tools/src/lib.rs
pub struct ConfiguredToolSpec {
    pub spec: ToolSpec,
    pub supports_parallel_tool_calls: bool,
}

impl ConfiguredToolSpec {
    pub fn new(spec: ToolSpec, supports_parallel_tool_calls: bool) -> Self {
        Self {
            spec,
            supports_parallel_tool_calls,
        }
    }
}
```

#### 工具规范示例

以 shell 工具为例，其 JSON Schema 定义了严格的参数结构：

```json
{
    "type": "function",
    "function": {
        "name": "shell",
        "description": "Execute shell commands in the current environment",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Command to execute as array of strings"
                },
                "workdir": {
                    "type": "string",
                    "description": "Working directory for command execution"
                }
            },
            "required": ["command"]
        }
    }
}
```

## 8.3 工具执行流程与上下文管理

### 8.3.1 工具调用上下文

每次工具调用都会创建一个 `ToolInvocation` 上下文，携带执行所需的全部信息：

```rust
// 来源：codex-rs/core/src/tools/context.rs
pub struct ToolInvocation {
    pub session: Arc<Session>,
    pub turn: Arc<TurnContext>,
    pub call_id: String,
    pub tool_name: Arc<str>,
    pub tool_namespace: Option<Arc<str>>,
    pub payload: ToolPayload,
    pub tracker: SharedTurnDiffTracker,
}
```

#### 工具载荷类型

`ToolPayload` 枚举定义了不同类型工具的参数格式：

```rust
pub enum ToolPayload {
    Function { arguments: String },
    ToolSearch { arguments: ToolSearchArgs },
    Custom { input: JsonValue },
    LocalShell { params: LocalShellParams },
    Mcp { server: String, tool: String, raw_arguments: String },
}
```

### 8.3.2 工具执行流水线

工具的执行遵循严格的流水线模式，确保每个阶段都得到正确处理：

```
┌─────────────────┐
│  1. 工具查找     │  Registry.handler(name, namespace)
└─────────────────┘
          │
          ▼
┌─────────────────┐
│  2. 载荷匹配     │  handler.matches_kind(payload)
└─────────────────┘
          │
          ▼
┌─────────────────┐
│  3. 前置钩子     │  run_pre_tool_use_hooks()
└─────────────────┘
          │
          ▼
┌─────────────────┐
│  4. 变更检测     │  handler.is_mutating()
└─────────────────┘
          │
          ▼
┌─────────────────┐
│  5. 权限等待     │  tool_call_gate.wait_ready()
└─────────────────┘
          │
          ▼
┌─────────────────┐
│  6. 工具执行     │  handler.handle(invocation)
└─────────────────┘
          │
          ▼
┌─────────────────┐
│  7. 后置钩子     │  run_post_tool_use_hooks()
└─────────────────┘
          │
          ▼
┌─────────────────┐
│  8. 结果返回     │  result.to_response_item()
└─────────────────┘
```

### 8.3.3 并行工具调用支持

Codex 支持并行执行多个工具调用，但需要通过变更检测来协调互斥操作：

```rust
// 来源：codex-rs/core/src/tools/registry.rs
let is_mutating = handler.is_mutating(&invocation).await;
// ...
if is_mutating {
    tracing::trace!("waiting for tool gate");
    invocation_for_tool.turn.tool_call_gate.wait_ready().await;
    tracing::trace!("tool gate released");
}
```

> **设计决策**：通过 `is_mutating()` 方法和 `tool_call_gate`，系统可以区分只读操作和写操作，只有写操作需要排队执行，而只读操作可以并行进行。这种设计在保证数据一致性的同时，最大化了执行效率。

## 8.4 内置工具列表与分类

### 8.4.1 核心功能工具

| 工具名称 | 处理器 | 主要功能 | 变更性 |
|---------|--------|----------|--------|
| `shell` | `ShellHandler` | 执行 shell 命令 | ✓ |
| `shell_command` | `ShellCommandHandler` | 单行命令执行 | ✓ |
| `apply_patch` | `ApplyPatchHandler` | 应用文件补丁 | ✓ |
| `list_dir` | `ListDirHandler` | 列出目录内容 | ✗ |
| `view_image` | `ViewImageHandler` | 查看图像文件 | ✗ |

### 8.4.2 系统管理工具

| 工具名称 | 处理器 | 主要功能 | 变更性 |
|---------|--------|----------|--------|
| `request_permissions` | `RequestPermissionsHandler` | 请求额外权限 | ✗ |
| `request_user_input` | `RequestUserInputHandler` | 请求用户输入 | ✗ |
| `test_sync` | `TestSyncHandler` | 同步测试工具 | ✗ |

### 8.4.3 多智能体工具

| 工具名称 | 处理器 | 主要功能 | 变更性 |
|---------|--------|----------|--------|
| `close_agent` | `CloseAgentHandler` | 关闭智能体 | ✓ |
| `spawn_agent` | `SpawnAgentHandler` | 创建新智能体 | ✓ |
| `agent_jobs` | `AgentJobsHandler` | 智能体任务管理 | ✗ |

### 8.4.4 开发工具

| 工具名称 | 处理器 | 主要功能 | 变更性 |
|---------|--------|----------|--------|
| `js_repl` | `JsReplHandler` | JavaScript REPL | ✓ |
| `js_repl_reset` | `JsReplResetHandler` | 重置 JS 环境 | ✓ |
| `plan` | `PlanHandler` | 生成执行计划 | ✗ |

## 8.5 沙箱化执行机制

### 8.5.1 沙箱上下文管理

所有工具执行都在沙箱环境中进行，`ToolCtx` 负责管理执行上下文：

```rust
// 来源：codex-rs/core/src/tools/sandboxing.rs
pub struct ToolCtx {
    pub session: Arc<Session>,
    pub turn: Arc<TurnContext>,
    pub call_id: String,
}

impl ToolCtx {
    pub async fn exec_params(&self, params: ExecParams) -> Result<ExecToolCallOutput, FunctionCallError> {
        // 沙箱执行逻辑
    }
}
```

### 8.5.2 权限控制机制

工具执行前需要进行权限检查和升级：

```rust
// 来源：codex-rs/core/src/tools/handlers/mod.rs
pub(super) async fn apply_granted_turn_permissions(
    session: &Session,
    sandbox_permissions: SandboxPermissions,
    additional_permissions: Option<PermissionProfile>,
) -> EffectiveAdditionalPermissions {
    let granted_session_permissions = session.granted_session_permissions().await;
    let granted_turn_permissions = session.granted_turn_permissions().await;

    // 合并权限配置
    let granted_permissions = merge_permission_profiles(
        granted_session_permissions.as_ref(),
        granted_turn_permissions.as_ref(),
    );

    // 计算有效权限
    let effective_permissions = merge_permission_profiles(
        additional_permissions.as_ref(),
        granted_permissions.as_ref(),
    );

    // 返回最终权限配置
    EffectiveAdditionalPermissions {
        sandbox_permissions,
        additional_permissions: effective_permissions,
        permissions_preapproved,
    }
}
```

### 8.5.3 安全边界设计

#### 权限分级表

| 权限级别 | 描述 | 典型用例 |
|---------|------|----------|
| `ReadOnly` | 只读访问 | 文件查看、目录列表 |
| `WorkspaceWrite` | 工作区写入 | 代码编辑、构建输出 |
| `WithAdditionalPermissions` | 附加权限 | 网络访问、系统调用 |
| `DangerFullAccess` | 完全访问 | 系统管理、危险操作 |

## 8.6 动态工具系统

### 8.6.1 动态工具概念

动态工具（Dynamic Tools）是 Codex 的一个重要创新，允许客户端在运行时定义新的工具能力：

```rust
// 来源：codex-rs/core/src/tools/handlers/dynamic.rs
pub struct DynamicToolHandler;

#[async_trait]
impl ToolHandler for DynamicToolHandler {
    type Output = FunctionToolOutput;

    fn kind(&self) -> ToolKind {
        ToolKind::Function
    }

    async fn is_mutating(&self, _invocation: &ToolInvocation) -> bool {
        true  // 动态工具默认认为是变更性的
    }

    async fn handle(&self, invocation: ToolInvocation) -> Result<Self::Output, FunctionCallError> {
        let args: Value = parse_arguments(&arguments)?;
        let response = request_dynamic_tool(&session, turn.as_ref(), call_id, tool_name, args)
            .await
            .ok_or_else(|| {
                FunctionCallError::RespondToModel(
                    "dynamic tool call was cancelled before receiving a response".to_string(),
                )
            })?;

        // 转换响应格式
        let body = content_items
            .into_iter()
            .map(FunctionCallOutputContentItem::from)
            .collect::<Vec<_>>();
        Ok(FunctionToolOutput::from_content(body, Some(success)))
    }
}
```

### 8.6.2 动态工具通信协议

动态工具通过事件系统与客户端进行通信：

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│    AI Model     │───▶│  Dynamic Tool    │───▶│   Client App    │
│  (tool call)    │    │    Handler       │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                               │                         │
                               │  DynamicToolCallRequest │
                               ▼                         ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Tool Result   │◀───│   Event System   │◀───│ Tool Execution  │
│  (to Model)     │    │                  │    │  (Client Side)  │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                               ▲                         │
                               │  DynamicToolResponse    │
                               └─────────────────────────┘
```

#### 动态工具请求流程

```rust
// 来源：codex-rs/core/src/tools/handlers/dynamic.rs
async fn request_dynamic_tool(
    session: &Session,
    turn_context: &TurnContext,
    call_id: String,
    tool: String,
    arguments: Value,
) -> Option<DynamicToolResponse> {
    // 1. 创建响应通道
    let (tx_response, rx_response) = oneshot::channel();

    // 2. 注册待处理调用
    let mut active = session.active_turn.lock().await;
    let mut ts = at.turn_state.lock().await;
    ts.insert_pending_dynamic_tool(call_id.clone(), tx_response);

    // 3. 发送请求事件
    let event = EventMsg::DynamicToolCallRequest(DynamicToolCallRequest {
        call_id: call_id.clone(),
        turn_id: turn_id.clone(),
        tool: tool.clone(),
        arguments: arguments.clone(),
    });
    session.send_event(turn_context, event).await;

    // 4. 等待客户端响应
    let response = rx_response.await.ok();

    // 5. 发送响应事件
    session.send_event(turn_context, response_event).await;
    response
}
```

## 8.7 MCP 工具集成

### 8.7.1 MCP 协议适配

Model Context Protocol (MCP) 是一个标准化的工具集成协议，Codex 通过 `McpHandler` 提供了完整的 MCP 支持：

```rust
// 来源：codex-rs/core/src/tools/handlers/mcp.rs
pub struct McpHandler;

#[async_trait]
impl ToolHandler for McpHandler {
    type Output = FunctionToolOutput;

    fn kind(&self) -> ToolKind {
        ToolKind::Mcp
    }

    async fn handle(&self, invocation: ToolInvocation) -> Result<Self::Output, FunctionCallError> {
        let ToolPayload::Mcp { server, tool, raw_arguments } = invocation.payload else {
            return Err(FunctionCallError::RespondToModel(
                "MCP handler received non-MCP payload".to_string(),
            ));
        };

        // MCP 工具调用逻辑
        let manager = invocation.session.services.mcp_connection_manager.read().await;
        let result = manager.call_tool(&server, &tool, &raw_arguments).await?;

        Ok(FunctionToolOutput::from_mcp_result(result))
    }
}
```

### 8.7.2 MCP 连接管理

MCP 工具的执行依赖于连接管理器，它负责维护与 MCP 服务器的连接：

```rust
// MCP 连接生命周期管理
pub struct McpConnectionManager {
    connections: HashMap<String, McpConnection>,
}

impl McpConnectionManager {
    pub async fn call_tool(
        &self,
        server: &str,
        tool: &str,
        arguments: &str
    ) -> Result<McpToolResult, McpError> {
        let connection = self.connections.get(server)
            .ok_or_else(|| McpError::ServerNotFound(server.to_string()))?;

        connection.call_tool(tool, arguments).await
    }

    pub fn server_origin(&self, server: &str) -> Option<&str> {
        self.connections.get(server)
            .map(|conn| conn.origin.as_str())
    }
}
```

### 8.7.3 MCP 工具发现

MCP 服务器可以动态提供工具列表，系统会自动发现并注册这些工具：

```rust
// MCP 工具发现和注册流程
async fn discover_mcp_tools(manager: &McpConnectionManager) -> Vec<ToolSpec> {
    let mut tools = Vec::new();

    for (server_name, connection) in manager.connections.iter() {
        match connection.list_tools().await {
            Ok(server_tools) => {
                for tool in server_tools {
                    tools.push(ToolSpec {
                        name: format!("{}:{}", server_name, tool.name),
                        description: tool.description,
                        parameters: tool.input_schema,
                    });
                }
            }
            Err(err) => {
                warn!("Failed to discover tools from MCP server {}: {}", server_name, err);
            }
        }
    }

    tools
}
```

## 8.8 钩子系统集成

### 8.8.1 工具钩子接口

工具系统与钩子系统深度集成，支持在工具执行前后插入自定义逻辑：

```rust
// 来源：codex-rs/core/src/tools/registry.rs
pub(crate) struct PreToolUsePayload {
    pub(crate) command: String,
}

pub(crate) struct PostToolUsePayload {
    pub(crate) command: String,
    pub(crate) tool_response: Value,
}
```

### 8.8.2 钩子执行流程

#### 前置钩子

```rust
// 工具执行前的钩子检查
if let Some(pre_tool_use_payload) = handler.pre_tool_use_payload(&invocation)
    && let Some(reason) = run_pre_tool_use_hooks(
        &invocation.session,
        &invocation.turn,
        invocation.call_id.clone(),
        pre_tool_use_payload.command.clone(),
    ).await
{
    return Err(FunctionCallError::RespondToModel(format!(
        "Command blocked by PreToolUse hook: {reason}. Command: {}",
        pre_tool_use_payload.command
    )));
}
```

#### 后置钩子

```rust
// 工具执行后的钩子处理
let post_tool_use_outcome = if let Some(post_tool_use_payload) = post_tool_use_payload {
    Some(
        run_post_tool_use_hooks(
            &invocation.session,
            &invocation.turn,
            invocation.call_id.clone(),
            post_tool_use_payload.command,
            post_tool_use_payload.tool_response,
        ).await,
    )
} else {
    None
};

// 根据钩子结果修改响应
if let Some(outcome) = &post_tool_use_outcome {
    if let Some(replacement_text) = replacement_text {
        let mut guard = response_cell.lock().await;
        if let Some(result) = guard.as_mut() {
            result.result = Box::new(FunctionToolOutput::from_text(
                replacement_text,
                /*success*/ None,
            ));
        }
    }
}
```

### 8.8.3 钩子载荷转换

工具系统需要将内部的 `ToolPayload` 转换为钩子系统理解的格式：

```rust
// 来源：codex-rs/core/src/tools/registry.rs
impl From<&ToolPayload> for HookToolInput {
    fn from(payload: &ToolPayload) -> Self {
        match payload {
            ToolPayload::Function { arguments } => HookToolInput::Function {
                arguments: arguments.clone(),
            },
            ToolPayload::LocalShell { params } => HookToolInput::LocalShell {
                params: HookToolInputLocalShell {
                    command: params.command.clone(),
                    workdir: params.workdir.clone(),
                    timeout_ms: params.timeout_ms,
                    sandbox_permissions: params.sandbox_permissions,
                    prefix_rule: params.prefix_rule.clone(),
                    justification: params.justification.clone(),
                },
            },
            ToolPayload::Mcp { server, tool, raw_arguments } => HookToolInput::Mcp {
                server: server.clone(),
                tool: tool.clone(),
                arguments: raw_arguments.clone(),
            },
            // ... 其他载荷类型
        }
    }
}
```

## 8.9 性能优化与监控

### 8.9.1 工具执行遥测

系统对每个工具调用都进行详细的性能监控：

```rust
// 来源：codex-rs/core/src/tools/registry.rs
let started = Instant::now();
let result = otel
    .log_tool_result_with_tags(
        tool_name.as_ref(),
        &call_id_owned,
        log_payload.as_ref(),
        &metric_tags,
        mcp_server_ref,
        mcp_server_origin_ref,
        || async {
            // 工具执行逻辑
            match handler.handle_any(invocation_for_tool).await {
                Ok(result) => {
                    let preview = result.result.log_preview();
                    let success = result.result.success_for_logging();
                    Ok((preview, success))
                }
                Err(err) => Err(err),
            }
        },
    )
    .await;
let duration = started.elapsed();
```

### 8.9.2 输出截断策略

为了控制内存使用和网络传输，系统对工具输出实施智能截断：

```rust
// 来源：codex-rs/core/src/tools/mod.rs
pub(crate) const TELEMETRY_PREVIEW_MAX_BYTES: usize = 2 * 1024; // 2 KiB
pub(crate) const TELEMETRY_PREVIEW_MAX_LINES: usize = 64; // lines

pub fn format_exec_output_for_model_structured(
    exec_output: &ExecToolCallOutput,
    truncation_policy: TruncationPolicy,
) -> String {
    let formatted_output = format_exec_output_str(exec_output, truncation_policy);

    let payload = ExecOutput {
        output: &formatted_output,
        metadata: ExecMetadata {
            exit_code: exec_output.exit_code,
            duration_seconds: ((exec_output.duration.as_secs_f32()) * 10.0).round() / 10.0,
        },
    };

    serde_json::to_string(&payload).expect("serialize ExecOutput")
}
```

### 8.9.3 并发控制优化

通过细粒度的变更检测，系统可以最大化工具执行的并行度：

```
┌─────────────────┐    ┌─────────────────┐
│   只读工具A     │    │   只读工具B     │
│ (list_dir)      │    │ (view_image)    │
└─────────────────┘    └─────────────────┘
         │                       │
         └───────┬───────────────┘
                 │ 并行执行
                 ▼
┌─────────────────────────────────────────┐
│          Tool Call Gate               │
│     (变更性工具排队等待)               │
└─────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────┐
│   写入工具C     │
│ (apply_patch)   │
└─────────────────┘
```

## 8.10 错误处理与容错机制

### 8.10.1 分层错误处理

工具系统采用分层的错误处理策略：

```rust
// 来源：codex-rs/core/src/function_tool.rs
#[derive(Debug, thiserror::Error)]
pub enum FunctionCallError {
    #[error("respond to model: {0}")]
    RespondToModel(String),

    #[error("fatal error: {0}")]
    Fatal(String),
}
```

### 8.10.2 超时处理机制

```rust
// 来源：codex-rs/core/src/tools/mod.rs
fn build_content_with_timeout(exec_output: &ExecToolCallOutput) -> String {
    if exec_output.timed_out {
        format!(
            "command timed out after {} milliseconds\n{}",
            exec_output.duration.as_millis(),
            exec_output.aggregated_output.text
        )
    } else {
        exec_output.aggregated_output.text.clone()
    }
}
```

### 8.10.3 不支持工具的处理

```rust
// 来源：codex-rs/core/src/tools/registry.rs
fn unsupported_tool_call_message(
    payload: &ToolPayload,
    tool_name: &str,
    namespace: Option<&str>,
) -> String {
    let tool_name = tool_handler_key(tool_name, namespace);
    match payload {
        ToolPayload::Custom { .. } => format!("unsupported custom tool call: {tool_name}"),
        _ => format!("unsupported call: {tool_name}"),
    }
}
```

## 8.11 总结

OpenAI Codex CLI 的工具系统是一个精心设计的执行框架，它通过以下关键特性实现了 AI Agent 的强大能力：

1. **统一抽象**：通过 `ToolHandler` trait 提供了一致的工具接口
2. **灵活扩展**：支持 Function、MCP、Dynamic 三种工具类型
3. **安全执行**：完整的沙箱化和权限控制机制
4. **高效并发**：基于变更检测的智能并行执行
5. **深度集成**：与钩子系统的无缝整合
6. **全面监控**：详细的性能遥测和错误处理

这个工具系统不仅是技术实现的典范，更是软件架构设计的艺术品。它展现了如何在复杂性和简洁性、功能性和安全性、性能和可维护性之间找到完美的平衡点。

在下一章中，我们将深入探讨 Shell 工具的具体实现，看看这个最重要的工具是如何实现安全而强大的命令执行能力的。