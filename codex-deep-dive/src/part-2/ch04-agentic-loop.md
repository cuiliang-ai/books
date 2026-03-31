# 第 4 章：Agentic Loop — Agent 的心跳

> **核心问题：** OpenAI Codex CLI 如何实现从用户输入到模型调用，再到工具执行的完整循环？Turn 概念如何管理，循环终止条件是什么，错误恢复机制如何工作？

## 4.1 架构概览：心跳驱动的对话引擎

OpenAI Codex CLI 的 Agentic Loop 是整个系统的心跳。与传统的请求-响应模式不同，Codex 实现了一个持续运行的事件驱动循环，能够处理用户输入、模型推理、工具调用和结果反馈的完整链路。

### 4.1.1 循环的解剖学

```
┌─────────────────────────────────────────────────────────┐
│                   Agentic Loop                          │
│                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│  │ User Input  │───▶│   Model     │───▶│ Tool Call   │ │
│  │ Processing  │    │ Inference   │    │ Execution   │ │
│  └─────────────┘    └─────────────┘    └─────────────┘ │
│         ▲                                      │       │
│         │            ┌─────────────┐           │       │
│         └────────────│   Result    │◀──────────┘       │
│                      │ Processing  │                   │
│                      └─────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

这个循环由以下核心组件构成：

1. **Turn Management** (`codex-rs/core/src/turn_metadata.rs`)
2. **Agent Control** (`codex-rs/core/src/agent/control.rs`)
3. **Stream Event Processing** (`codex-rs/core/src/stream_events_utils.rs`)
4. **Context Manager** (`codex-rs/core/src/context_manager/`)

### 4.1.2 主循环入口点

在 `codex.rs` 中，主循环的入口是通过多个路径触发的：

```rust
// codex-rs/core/src/codex.rs
pub struct CodexSession {
    thread_manager: Arc<ThreadManagerState>,
    context_manager: ContextManager,
    agent_control: Option<AgentControl>,
    // ...
}

impl CodexSession {
    // 主要的会话处理入口
    async fn handle_session_request(&mut self, request: SessionRequest) -> CodexResult<()> {
        match request {
            SessionRequest::UserMessage { content, .. } => {
                self.process_user_input(content).await
            },
            SessionRequest::ToolResult { result, .. } => {
                self.process_tool_result(result).await
            },
            // ...
        }
    }
}
```

## 4.2 Turn 概念与管理

### 4.2.1 Turn 的定义

在 Codex 中，**Turn** 代表一个完整的对话轮次，包括：
- 用户输入（User Input）
- 模型响应（Model Response）
- 工具调用序列（Tool Call Sequence）
- 最终结果（Final Result）

每个 Turn 都有唯一的标识符和元数据：

```rust
// codex-rs/core/src/turn_metadata.rs
#[derive(Debug, Clone)]
pub struct TurnMetadata {
    pub turn_id: TurnId,
    pub session_id: SessionId,
    pub start_time: Instant,
    pub model_info: Option<ModelInfo>,
    pub token_usage: Option<TokenUsage>,
    pub status: TurnStatus,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TurnStatus {
    Starting,
    ModelInference,
    ToolExecution,
    Completed,
    Failed(CodexErr),
}
```

### 4.2.2 Turn 生命周期管理

Turn 的生命周期管理通过 `TurnMetadataState` 进行：

```rust
pub struct TurnMetadataState {
    current_turn: Option<TurnMetadata>,
    turn_history: VecDeque<TurnMetadata>,
    timing_tracker: TurnTimingTracker,
}

impl TurnMetadataState {
    pub fn start_new_turn(&mut self, session_id: SessionId) -> TurnId {
        let turn_metadata = TurnMetadata::new(session_id);
        let turn_id = turn_metadata.turn_id.clone();

        if let Some(previous_turn) = self.current_turn.take() {
            self.turn_history.push_back(previous_turn);
        }

        self.current_turn = Some(turn_metadata);
        turn_id
    }

    pub fn complete_current_turn(&mut self, result: TurnResult) {
        if let Some(mut current) = self.current_turn.take() {
            current.status = TurnStatus::Completed;
            current.end_time = Some(Instant::now());
            self.turn_history.push_back(current);
        }
    }
}
```

### 4.2.3 Turn 并发控制

> **设计决策：** Codex 支持 Sub-Agent 并发执行，但每个 Agent 实例内部的 Turn 处理是序列化的，避免竞态条件。

```rust
// codex-rs/core/src/agent/control.rs
pub struct AgentControl {
    live_agents: Arc<StdMutex<HashMap<ThreadId, LiveAgent>>>,
    mailbox: Mailbox,
    spawn_agent_options: SpawnAgentOptions,
}

impl AgentControl {
    pub async fn spawn_agent(
        &self,
        agent_name: Option<String>,
        task: String,
        options: SpawnAgentOptions,
    ) -> CodexResult<ThreadId> {
        let thread_id = ThreadId::new();
        let agent_metadata = self.create_agent_metadata(agent_name, task)?;

        // 并发启动新的 Agent 实例
        let live_agent = LiveAgent {
            thread_id: thread_id.clone(),
            metadata: agent_metadata,
            status: AgentStatus::Starting,
        };

        self.live_agents.lock().unwrap().insert(thread_id.clone(), live_agent);

        // 异步启动 Agent 循环
        self.start_agent_loop(thread_id.clone()).await?;
        Ok(thread_id)
    }
}
```

## 4.3 主循环实现深度解析

### 4.3.1 事件驱动架构

主循环基于 Rust 的异步事件驱动架构，使用 `tokio` 运行时：

```rust
// codex-rs/core/src/codex.rs (简化)
impl CodexSession {
    pub async fn run_session_loop(&mut self) -> CodexResult<()> {
        let mut event_receiver = self.create_event_receiver().await?;

        loop {
            tokio::select! {
                // 处理用户输入事件
                user_event = self.user_input_receiver.recv() => {
                    match user_event {
                        Some(input) => self.handle_user_input(input).await?,
                        None => break, // Channel closed
                    }
                },

                // 处理模型响应事件
                model_event = self.model_response_receiver.recv() => {
                    match model_event {
                        Some(response) => self.handle_model_response(response).await?,
                        None => continue,
                    }
                },

                // 处理工具执行结果
                tool_event = self.tool_result_receiver.recv() => {
                    match tool_event {
                        Some(result) => self.handle_tool_result(result).await?,
                        None => continue,
                    }
                },

                // 处理 Agent 间通信
                agent_message = self.agent_mailbox.recv() => {
                    match agent_message {
                        Some(msg) => self.handle_inter_agent_message(msg).await?,
                        None => continue,
                    }
                },

                // 超时处理
                _ = tokio::time::sleep(Duration::from_secs(300)) => {
                    self.handle_session_timeout().await?;
                }
            }

            // 检查循环终止条件
            if self.should_terminate_session().await? {
                break;
            }
        }

        self.cleanup_session().await?;
        Ok(())
    }
}
```

### 4.3.2 用户输入处理流水线

用户输入进入系统后，经历以下处理阶段：

```
用户输入 → 输入验证 → Context 注入 → 模型调用 → 响应处理
    ↓         ↓          ↓           ↓          ↓
┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
│ Validate│ │ Enrich  │ │ Model   │ │ Stream  │ │ Execute │
│ Input   │ │ Context │ │ Request │ │ Process │ │ Tools   │
└─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘
```

#### 输入处理实现

```rust
impl CodexSession {
    async fn handle_user_input(&mut self, input: UserInput) -> CodexResult<()> {
        // 1. 开始新的 Turn
        let turn_id = self.turn_metadata.start_new_turn(self.session_id.clone());

        // 2. 输入验证和预处理
        let validated_input = self.validate_and_preprocess_input(input).await?;

        // 3. Context 注入
        let enriched_context = self.context_manager
            .enrich_with_context(validated_input)
            .await?;

        // 4. 检查安全策略
        self.exec_policy_manager
            .check_input_policy(&enriched_context)
            .await?;

        // 5. 发起模型调用
        self.initiate_model_call(enriched_context, turn_id).await?;

        Ok(())
    }

    async fn initiate_model_call(
        &mut self,
        context: EnrichedContext,
        turn_id: TurnId
    ) -> CodexResult<()> {
        self.turn_metadata.update_status(TurnStatus::ModelInference);

        let model_client = self.get_model_client().await?;
        let stream = model_client
            .create_completion_stream(context.into_prompt())
            .await?;

        // 启动流式处理
        self.process_model_stream(stream, turn_id).await
    }
}
```

### 4.3.3 流式响应处理

Codex 使用流式处理来提供实时响应，这是用户体验的关键：

```rust
async fn process_model_stream(
    &mut self,
    mut stream: ModelResponseStream,
    turn_id: TurnId,
) -> CodexResult<()> {
    let mut response_buffer = String::new();
    let mut tool_calls = Vec::new();

    while let Some(chunk) = stream.next().await {
        match chunk? {
            StreamChunk::TextDelta { text } => {
                response_buffer.push_str(&text);
                // 实时发送到UI
                self.send_text_delta_to_ui(text).await?;
            },

            StreamChunk::FunctionCall { call } => {
                tool_calls.push(call);
                // 准备工具调用
                self.prepare_tool_execution(call).await?;
            },

            StreamChunk::Done { usage } => {
                self.turn_metadata.update_token_usage(usage);
                break;
            },
        }
    }

    // 如果有工具调用，执行它们
    if !tool_calls.is_empty() {
        self.execute_tools(tool_calls, turn_id).await?;
    } else {
        self.complete_turn(turn_id).await?;
    }

    Ok(())
}
```

## 4.4 工具调用调度与执行

### 4.4.1 工具执行架构

Codex 的工具执行系统具有以下特点：
- **并行执行**：多个工具可以并发执行（如果安全策略允许）
- **权限控制**：每个工具调用都要经过执行策略检查
- **错误隔离**：单个工具失败不会影响其他工具
- **超时管理**：防止工具执行时间过长

```rust
// 工具执行调度器
pub struct ToolExecutor {
    exec_policy: ExecPolicyManager,
    sandboxing: SandboxingManager,
    concurrent_limit: usize,
}

impl ToolExecutor {
    pub async fn execute_tools(
        &self,
        tool_calls: Vec<ToolCall>,
        turn_context: &TurnContext,
    ) -> CodexResult<Vec<ToolResult>> {
        // 按安全等级分组
        let (safe_tools, unsafe_tools) = self.categorize_tools(&tool_calls)?;

        // 并行执行安全工具
        let safe_results = self.execute_safe_tools_parallel(safe_tools).await?;

        // 序列执行不安全工具（需要审批）
        let unsafe_results = self.execute_unsafe_tools_sequential(unsafe_tools).await?;

        // 合并结果
        let mut results = safe_results;
        results.extend(unsafe_results);

        Ok(results)
    }

    async fn execute_safe_tools_parallel(
        &self,
        tools: Vec<ToolCall>
    ) -> CodexResult<Vec<ToolResult>> {
        let semaphore = Arc::new(Semaphore::new(self.concurrent_limit));
        let futures: Vec<_> = tools
            .into_iter()
            .map(|tool| {
                let sem = semaphore.clone();
                let executor = self.clone();
                async move {
                    let _permit = sem.acquire().await?;
                    executor.execute_single_tool(tool).await
                }
            })
            .collect();

        try_join_all(futures).await
    }
}
```

### 4.4.2 工具调用的生命周期

每个工具调用经历以下阶段：

```
工具调用请求 → 权限检查 → 沙箱准备 → 执行 → 结果收集 → 后处理
      ↓            ↓           ↓         ↓        ↓         ↓
┌──────────────┐ ┌────────┐ ┌────────┐ ┌─────┐ ┌────────┐ ┌────────┐
│ Tool Call    │ │Policy  │ │Sandbox │ │Exec │ │Collect │ │Process │
│ Validation   │ │Check   │ │Setup   │ │Tool │ │Result  │ │Output  │
└──────────────┘ └────────┘ └────────┘ └─────┘ └────────┘ └────────┘
```

#### 具体实现细节

```rust
impl ToolExecutor {
    async fn execute_single_tool(&self, tool_call: ToolCall) -> CodexResult<ToolResult> {
        let execution_id = ExecutionId::new();

        // 1. 权限检查
        self.exec_policy
            .check_tool_permission(&tool_call)
            .await?;

        // 2. 沙箱环境准备
        let sandbox = self.sandboxing
            .prepare_sandbox_for_tool(&tool_call)
            .await?;

        // 3. 执行工具
        let start_time = Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(300), // 5分钟超时
            self.do_execute_tool(tool_call, sandbox)
        ).await??;

        // 4. 收集执行统计
        let execution_time = start_time.elapsed();
        self.record_execution_metrics(execution_id, execution_time).await?;

        // 5. 后处理（安全扫描、输出过滤等）
        self.post_process_tool_result(result).await
    }

    async fn do_execute_tool(
        &self,
        tool_call: ToolCall,
        sandbox: Sandbox,
    ) -> CodexResult<RawToolResult> {
        match tool_call.tool_name.as_str() {
            "bash" => self.execute_bash_tool(tool_call, sandbox).await,
            "read_file" => self.execute_read_file_tool(tool_call).await,
            "write_file" => self.execute_write_file_tool(tool_call, sandbox).await,
            "edit_file" => self.execute_edit_file_tool(tool_call, sandbox).await,
            // MCP 工具
            name if name.starts_with("mcp_") => {
                self.execute_mcp_tool(tool_call, sandbox).await
            },
            _ => Err(CodexErr::UnknownTool(tool_call.tool_name)),
        }
    }
}
```

### 4.4.3 结果回注机制

工具执行完成后，结果需要回注到对话上下文中：

```rust
async fn handle_tool_result(&mut self, result: ToolResult) -> CodexResult<()> {
    // 1. 记录到 Context Manager
    self.context_manager.append_tool_result(result.clone());

    // 2. 检查是否需要继续调用模型
    if self.needs_model_continuation(&result) {
        let continuation_prompt = self.build_continuation_prompt(result).await?;
        self.initiate_model_call(continuation_prompt, self.current_turn_id()).await?;
    } else {
        // 3. 完成当前 Turn
        self.complete_current_turn().await?;
    }

    Ok(())
}

fn needs_model_continuation(&self, result: &ToolResult) -> bool {
    match result {
        ToolResult::Success { requires_continuation, .. } => *requires_continuation,
        ToolResult::Error { recoverable, .. } => *recoverable,
        ToolResult::Partial { .. } => true,
    }
}
```

## 4.5 循环终止条件

### 4.5.1 终止条件类型

Codex 的主循环有以下几种终止条件：

1. **正常完成**：用户任务完成，无需进一步交互
2. **用户中断**：用户显式停止会话
3. **超时终止**：长时间无活动自动终止
4. **错误终止**：不可恢复的错误发生
5. **资源限制**：超出 token 限制或其他资源约束
6. **策略限制**：触发安全策略限制

```rust
impl CodexSession {
    async fn should_terminate_session(&self) -> CodexResult<bool> {
        // 1. 检查用户中断信号
        if self.interrupt_signal.is_set() {
            return Ok(true);
        }

        // 2. 检查会话超时
        if self.is_session_timeout() {
            return Ok(true);
        }

        // 3. 检查资源限制
        if self.context_manager.is_context_full()? {
            return Ok(true);
        }

        // 4. 检查错误状态
        if let Some(error) = &self.fatal_error {
            if !error.is_recoverable() {
                return Ok(true);
            }
        }

        // 5. 检查完成状态
        if self.is_task_completed() {
            return Ok(true);
        }

        Ok(false)
    }
}
```

### 4.5.2 优雅关闭机制

当触发终止条件时，Codex 执行优雅关闭：

```rust
async fn cleanup_session(&mut self) -> CodexResult<()> {
    // 1. 停止接受新的输入
    self.input_receiver.close();

    // 2. 等待进行中的工具执行完成
    self.tool_executor.wait_for_completion().await?;

    // 3. 保存会话状态
    self.save_session_state().await?;

    // 4. 清理子 Agent
    if let Some(agent_control) = &self.agent_control {
        agent_control.shutdown_all_agents().await?;
    }

    // 5. 关闭网络连接
    self.model_client.close().await?;

    // 6. 释放资源
    self.cleanup_resources().await?;

    Ok(())
}
```

## 4.6 错误恢复与重试策略

### 4.6.1 错误分类体系

Codex 对错误进行分类处理：

```rust
// codex-rs/core/src/error.rs
#[derive(Debug, thiserror::Error)]
pub enum CodexErr {
    // 可恢复的网络错误
    #[error("Network error: {0}")]
    Network(#[from] NetworkError),

    // 可重试的模型API错误
    #[error("Model API error: {0}")]
    ModelApi {
        error: ApiError,
        retryable: bool,
        backoff_ms: u64,
    },

    // 工具执行错误
    #[error("Tool execution failed: {tool_name}")]
    ToolExecution {
        tool_name: String,
        error: Box<dyn std::error::Error + Send + Sync>,
        recoverable: bool,
    },

    // 不可恢复的系统错误
    #[error("Fatal system error: {0}")]
    Fatal(String),
}

impl CodexErr {
    pub fn is_recoverable(&self) -> bool {
        match self {
            CodexErr::Network(_) => true,
            CodexErr::ModelApi { retryable, .. } => *retryable,
            CodexErr::ToolExecution { recoverable, .. } => *recoverable,
            CodexErr::Fatal(_) => false,
        }
    }

    pub fn retry_delay(&self) -> Duration {
        match self {
            CodexErr::Network(_) => Duration::from_millis(1000),
            CodexErr::ModelApi { backoff_ms, .. } => Duration::from_millis(*backoff_ms),
            CodexErr::ToolExecution { .. } => Duration::from_millis(2000),
            CodexErr::Fatal(_) => Duration::MAX, // 不重试
        }
    }
}
```

### 4.6.2 重试策略实现

```rust
pub struct RetryPolicy {
    max_retries: usize,
    base_delay: Duration,
    max_delay: Duration,
    backoff_multiplier: f32,
}

impl RetryPolicy {
    pub async fn execute_with_retry<F, T, E>(&self, mut operation: F) -> Result<T, E>
    where
        F: FnMut() -> Pin<Box<dyn Future<Output = Result<T, E>> + Send>>,
        E: std::error::Error + Send + Sync,
    {
        let mut attempt = 0;
        let mut delay = self.base_delay;

        loop {
            match operation().await {
                Ok(result) => return Ok(result),
                Err(error) => {
                    attempt += 1;

                    if attempt >= self.max_retries || !self.should_retry(&error) {
                        return Err(error);
                    }

                    // 指数退避
                    tokio::time::sleep(delay).await;
                    delay = std::cmp::min(
                        Duration::from_millis(
                            (delay.as_millis() as f32 * self.backoff_multiplier) as u64
                        ),
                        self.max_delay,
                    );
                }
            }
        }
    }
}
```

### 4.6.3 Circuit Breaker 模式

对于频繁失败的操作，Codex 实现了 Circuit Breaker 模式：

```rust
pub struct CircuitBreaker {
    failure_count: Arc<AtomicUsize>,
    last_failure_time: Arc<Mutex<Option<Instant>>>,
    failure_threshold: usize,
    timeout: Duration,
    state: Arc<AtomicU8>, // 0: Closed, 1: Open, 2: HalfOpen
}

impl CircuitBreaker {
    pub async fn call<F, T, E>(&self, operation: F) -> Result<T, CircuitBreakerError<E>>
    where
        F: Future<Output = Result<T, E>>,
        E: std::error::Error,
    {
        match self.current_state() {
            CircuitState::Open => {
                if self.should_attempt_reset() {
                    self.set_state(CircuitState::HalfOpen);
                } else {
                    return Err(CircuitBreakerError::CircuitOpen);
                }
            },
            CircuitState::HalfOpen => {
                // 在半开状态下，允许少量请求通过
            },
            CircuitState::Closed => {
                // 正常状态，允许所有请求
            },
        }

        match operation.await {
            Ok(result) => {
                self.on_success();
                Ok(result)
            },
            Err(error) => {
                self.on_failure();
                Err(CircuitBreakerError::OperationFailed(error))
            }
        }
    }
}
```

## 4.7 与 Claude Code 的对比分析

### 4.7.1 架构差异对比

| 维度 | OpenAI Codex CLI | Claude Code |
|------|------------------|-------------|
| **语言实现** | Rust + Node.js | TypeScript |
| **并发模型** | Tokio 异步 | Node.js 事件循环 |
| **工具执行** | 并行 + 权限控制 | 序列执行 |
| **错误处理** | 分层错误类型 | 简单错误传播 |
| **内存管理** | 两阶段内存管道 | 自动压缩 |
| **子 Agent** | 真正并发执行 | 序列化执行 |

### 4.7.2 性能特性对比

**Codex 的优势：**
1. **真正的并发**：Rust 的零成本异步带来更好的性能
2. **内存安全**：编译时保证内存安全，减少运行时错误
3. **精细控制**：更细粒度的资源管理和错误处理

**Claude Code 的优势：**
1. **开发效率**：TypeScript 生态系统更丰富
2. **调试友好**：更容易调试和热更新
3. **社区支持**：JavaScript 社区更大

### 4.7.3 设计哲学差异

> **设计决策：** Codex 选择 "Correctness First" 的设计哲学，优先保证系统的正确性和安全性，而 Claude Code 更注重开发体验和快速迭代。

## 4.8 性能优化与监控

### 4.8.1 性能监控指标

Codex 内置了丰富的性能监控：

```rust
#[derive(Debug, Clone)]
pub struct PerformanceMetrics {
    pub turn_latency_ms: f64,
    pub model_api_latency_ms: f64,
    pub tool_execution_latency_ms: f64,
    pub context_size_tokens: usize,
    pub memory_usage_mb: f64,
    pub concurrent_agents: usize,
}

impl CodexSession {
    pub fn collect_metrics(&self) -> PerformanceMetrics {
        PerformanceMetrics {
            turn_latency_ms: self.turn_metadata.average_turn_time().as_secs_f64() * 1000.0,
            model_api_latency_ms: self.model_client.average_latency_ms(),
            tool_execution_latency_ms: self.tool_executor.average_execution_time_ms(),
            context_size_tokens: self.context_manager.token_count(),
            memory_usage_mb: self.memory_usage_mb(),
            concurrent_agents: self.agent_control.live_agent_count(),
        }
    }
}
```

### 4.8.2 自适应优化

基于性能指标，Codex 可以自适应调整参数：

```rust
pub struct AdaptiveOptimizer {
    metrics_history: VecDeque<PerformanceMetrics>,
    optimization_rules: Vec<Box<dyn OptimizationRule>>,
}

impl AdaptiveOptimizer {
    pub fn optimize_session(&mut self, session: &mut CodexSession) -> CodexResult<()> {
        let current_metrics = session.collect_metrics();
        self.metrics_history.push_back(current_metrics.clone());

        for rule in &self.optimization_rules {
            if rule.should_apply(&current_metrics) {
                rule.apply_optimization(session)?;
            }
        }

        Ok(())
    }
}

// 示例优化规则：根据延迟调整并发度
struct ConcurrencyOptimizationRule;

impl OptimizationRule for ConcurrencyOptimizationRule {
    fn should_apply(&self, metrics: &PerformanceMetrics) -> bool {
        metrics.turn_latency_ms > 5000.0 // 超过 5 秒
    }

    fn apply_optimization(&self, session: &mut CodexSession) -> CodexResult<()> {
        // 降低工具执行并发度
        session.tool_executor.set_concurrency_limit(2);
        Ok(())
    }
}
```

## 4.9 总结与设计洞察

### 4.9.1 核心设计原则

OpenAI Codex CLI 的 Agentic Loop 体现了以下设计原则：

1. **安全第一**：每个操作都经过多层安全检查
2. **可恢复性**：系统能从各种错误状态中恢复
3. **可观测性**：丰富的监控和调试能力
4. **可扩展性**：支持 Sub-Agent 和工具插件
5. **性能优化**：基于指标的自适应优化

### 4.9.2 关键技术选择

| 技术选择 | 理由 | 权衡 |
|----------|------|------|
| **Rust 异步** | 零成本抽象，内存安全 | 学习曲线陡峭 |
| **Actor 模型** | 易于推理的并发模型 | 消息传递开销 |
| **流式处理** | 更好的用户体验 | 复杂的状态管理 |
| **两阶段内存** | 精确的内存管理 | 实现复杂度高 |

### 4.9.3 速查表

| 组件 | 文件路径 | 核心功能 | 关键接口 |
|------|----------|----------|----------|
| **主循环** | `codex.rs` | 事件驱动循环 | `run_session_loop()` |
| **Turn 管理** | `turn_metadata.rs` | Turn 生命周期 | `start_new_turn()` |
| **Agent 控制** | `agent/control.rs` | 多 Agent 管理 | `spawn_agent()` |
| **工具执行** | `exec.rs` | 工具调用执行 | `execute_tools()` |
| **上下文管理** | `context_manager/` | 对话历史管理 | `enrich_context()` |
| **错误恢复** | `error.rs` | 错误处理策略 | `is_recoverable()` |

Codex 的 Agentic Loop 是一个精心设计的系统，它在保证安全性和可靠性的同时，提供了出色的性能和用户体验。这个架构为构建企业级 AI Agent 系统提供了宝贵的参考。