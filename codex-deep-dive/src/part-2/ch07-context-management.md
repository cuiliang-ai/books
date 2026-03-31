# 第 7 章：Context 管理 — 有限记忆的艺术

> **核心问题：** OpenAI Codex CLI 如何在有限的上下文窗口内管理无限的对话历史？Token 计数如何实现？压缩策略如何设计？长对话如何处理？会话持久化如何工作？

## 7.1 架构概览：多层次上下文管理系统

OpenAI Codex CLI 的上下文管理系统是一个精心设计的多层架构，它需要在有限的模型上下文窗口内，智能地管理几乎无限的对话历史。这个系统的核心挑战是 **"有限记忆的艺术"** —— 如何在保持对话连贯性的同时，最大化利用可用的上下文空间。

### 7.1.1 上下文管理层级

```
┌─────────────────────────────────────────────────────────────────┐
│                  Context Management System                      │
│                                                                 │
│ ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│ │   Active        │  │   Compressed    │  │   Archived      │ │
│ │   Context       │  │   History       │  │   Memory        │ │
│ │  (Recent 10-20  │  │  (Summary of    │  │ (Long-term      │ │
│ │   messages)     │  │   older turns)  │  │  memories)      │ │
│ └─────────────────┘  └─────────────────┘  └─────────────────┘ │
│          ▲                     ▲                     ▲        │
│          │                     │                     │        │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │            Context Manager (ContextManager)                 │ │
│ │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │ │
│ │  │   Token     │  │ Compaction  │  │ Persistence │       │ │
│ │  │  Counter    │  │  Engine     │  │   Manager   │       │ │
│ │  └─────────────┘  └─────────────┘  └─────────────┘       │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 7.1.2 核心组件架构

在 Codex 的实现中，上下文管理涉及多个协作组件：

```rust
// codex-rs/core/src/context_manager/history.rs
#[derive(Debug, Clone, Default)]
pub struct ContextManager {
    /// 对话历史项目，最旧的项目在向量开头
    items: Vec<ResponseItem>,

    /// Token 使用信息
    token_info: Option<TokenUsageInfo>,

    /// 用于差分和设置更新的参考上下文快照
    reference_context_item: Option<TurnContextItem>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct TotalTokenUsageBreakdown {
    pub last_api_response_total_tokens: i64,
    pub all_history_items_model_visible_bytes: i64,
    pub estimated_tokens_of_items_added_since_last_successful_api_response: i64,
    pub estimated_bytes_of_items_added_since_last_successful_api_response: i64,
}
```

## 7.2 Token 计数与估算

### 7.2.1 多层级 Token 计数

Codex 实现了一个精确的 Token 计数系统，支持不同类型的内容：

```rust
// codex-rs/core/src/context_manager/history.rs
impl ContextManager {
    /// 估算当前上下文的总 Token 数
    pub fn estimate_total_tokens(&self) -> i64 {
        let breakdown = self.get_token_breakdown();

        breakdown.last_api_response_total_tokens +
        breakdown.estimated_tokens_of_items_added_since_last_successful_api_response
    }

    /// 计算详细的 Token 使用情况分解
    pub fn get_token_breakdown(&self) -> TotalTokenUsageBreakdown {
        let mut breakdown = TotalTokenUsageBreakdown::default();

        // 来自最后一次 API 响应的 Token 数
        if let Some(token_info) = &self.token_info {
            breakdown.last_api_response_total_tokens = token_info.total_tokens.unwrap_or(0);
        }

        // 计算所有历史项目的可见字节数
        let mut total_visible_bytes = 0i64;
        let mut bytes_since_last_response = 0i64;
        let mut found_last_response = false;

        for item in &self.items {
            let item_bytes = Self::calculate_item_visible_bytes(item);
            total_visible_bytes += item_bytes;

            if !found_last_response {
                if Self::is_api_response_item(item) {
                    found_last_response = true;
                } else {
                    bytes_since_last_response += item_bytes;
                }
            }
        }

        breakdown.all_history_items_model_visible_bytes = total_visible_bytes;
        breakdown.estimated_bytes_of_items_added_since_last_successful_api_response = bytes_since_last_response;

        // 使用启发式方法将字节转换为 Token
        breakdown.estimated_tokens_of_items_added_since_last_successful_api_response =
            approx_tokens_from_byte_count_i64(bytes_since_last_response);

        breakdown
    }

    fn calculate_item_visible_bytes(item: &ResponseItem) -> i64 {
        match item {
            ResponseItem::UserMessage(msg) => {
                Self::calculate_message_bytes(&msg.content)
            },
            ResponseItem::AssistantMessage(msg) => {
                Self::calculate_message_bytes(&msg.content)
            },
            ResponseItem::ToolCall(tool_call) => {
                Self::calculate_tool_call_bytes(tool_call)
            },
            ResponseItem::ToolResult(result) => {
                Self::calculate_tool_result_bytes(result)
            },
            ResponseItem::ContextCompaction(compaction) => {
                // 压缩项目通常包含摘要文本
                compaction.summary.as_ref()
                    .map(|s| s.len() as i64)
                    .unwrap_or(0)
            },
            _ => 0, // 其他类型的项目
        }
    }

    fn calculate_message_bytes(content: &[ContentItem]) -> i64 {
        content.iter().map(|item| {
            match item {
                ContentItem::Text { text } => text.len() as i64,
                ContentItem::Image { .. } => {
                    // 图像按固定 Token 数计算
                    IMAGE_TOKEN_COST
                },
                ContentItem::Audio { .. } => {
                    // 音频按时长计算
                    AUDIO_TOKEN_PER_SECOND * item.duration_seconds().unwrap_or(0.0) as i64
                },
            }
        }).sum()
    }
}

// Token 估算常量
const IMAGE_TOKEN_COST: i64 = 765; // 每张图片的基础 Token 成本
const AUDIO_TOKEN_PER_SECOND: i64 = 150; // 每秒音频的 Token 成本
const BYTES_PER_TOKEN_ESTIMATE: f32 = 4.0; // 平均每个 Token 的字节数
```

### 7.2.2 自适应 Token 估算

对于不同语言和内容类型，Codex 使用自适应的 Token 估算策略：

```rust
pub struct AdaptiveTokenEstimator {
    language_multipliers: HashMap<String, f32>,
    content_type_multipliers: HashMap<ContentType, f32>,
    model_specific_adjustments: HashMap<String, f32>,
}

impl AdaptiveTokenEstimator {
    pub fn estimate_tokens(&self, content: &str, context: &EstimationContext) -> usize {
        // 基础字节计数
        let base_tokens = (content.len() as f32 / BYTES_PER_TOKEN_ESTIMATE) as usize;

        // 语言特定调整
        let language_multiplier = self.language_multipliers
            .get(&context.detected_language)
            .unwrap_or(&1.0);

        // 内容类型调整
        let content_multiplier = self.content_type_multipliers
            .get(&context.content_type)
            .unwrap_or(&1.0);

        // 模型特定调整
        let model_multiplier = self.model_specific_adjustments
            .get(&context.model_name)
            .unwrap_or(&1.0);

        let adjusted_tokens = (base_tokens as f32 *
                             language_multiplier *
                             content_multiplier *
                             model_multiplier) as usize;

        // 为安全起见，增加 10% 的缓冲区
        (adjusted_tokens as f32 * 1.1) as usize
    }
}

#[derive(Debug, Clone)]
pub struct EstimationContext {
    detected_language: String,
    content_type: ContentType,
    model_name: String,
    has_code: bool,
    has_structured_data: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ContentType {
    PlainText,
    Code,
    Markdown,
    Json,
    Xml,
    Mixed,
}
```

## 7.3 自动压缩机制

### 7.3.1 压缩触发条件

Codex 使用多种触发条件来决定何时执行上下文压缩：

```rust
// codex-rs/core/src/compact.rs
pub struct CompactionTrigger {
    strategies: Vec<Box<dyn CompactionStrategy>>,
    last_compaction_time: Option<Instant>,
    min_compaction_interval: Duration,
}

pub trait CompactionStrategy {
    fn should_trigger(&self, context: &ContextManager, turn_context: &TurnContext) -> bool;
    fn priority(&self) -> CompactionPriority;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CompactionPriority {
    Low = 0,
    Medium = 1,
    High = 2,
    Critical = 3,
}

// 基于 Token 数的压缩策略
pub struct TokenThresholdStrategy {
    context_window_size: usize,
    trigger_threshold: f32, // 0.8 = 80% 填满时触发
    critical_threshold: f32, // 0.95 = 95% 填满时强制触发
}

impl CompactionStrategy for TokenThresholdStrategy {
    fn should_trigger(&self, context: &ContextManager, turn_context: &TurnContext) -> bool {
        let current_tokens = context.estimate_total_tokens() as usize;
        let threshold = (self.context_window_size as f32 * self.trigger_threshold) as usize;

        current_tokens >= threshold
    }

    fn priority(&self) -> CompactionPriority {
        let current_tokens = context.estimate_total_tokens() as usize;
        let critical_threshold = (self.context_window_size as f32 * self.critical_threshold) as usize;

        if current_tokens >= critical_threshold {
            CompactionPriority::Critical
        } else {
            CompactionPriority::High
        }
    }
}

// 基于对话轮次的压缩策略
pub struct TurnCountStrategy {
    max_turns_without_compaction: usize,
}

impl CompactionStrategy for TurnCountStrategy {
    fn should_trigger(&self, context: &ContextManager, turn_context: &TurnContext) -> bool {
        let turns_since_compaction = self.count_turns_since_last_compaction(context);
        turns_since_compaction >= self.max_turns_without_compaction
    }

    fn priority(&self) -> CompactionPriority {
        CompactionPriority::Medium
    }
}

// 基于内容复杂度的压缩策略
pub struct ComplexityBasedStrategy {
    max_complexity_score: f32,
}

impl CompactionStrategy for ComplexityBasedStrategy {
    fn should_trigger(&self, context: &ContextManager, turn_context: &TurnContext) -> bool {
        let complexity = self.calculate_context_complexity(context);
        complexity >= self.max_complexity_score
    }
}
```

### 7.3.2 智能压缩算法

压缩过程使用 LLM 生成的智能摘要替代原始历史：

```rust
// codex-rs/core/src/compact.rs
pub struct IntelligentCompactor {
    model_client: Arc<ModelClient>,
    compaction_prompt_template: String,
    max_summary_tokens: usize,
}

impl IntelligentCompactor {
    pub async fn compress_context(
        &self,
        context: &ContextManager,
        turn_context: &TurnContext,
    ) -> CodexResult<CompactionResult> {
        // 1. 确定需要压缩的历史范围
        let compression_range = self.determine_compression_range(context)?;

        // 2. 构建压缩提示
        let compaction_prompt = self.build_compaction_prompt(
            &context.items[compression_range.clone()],
            turn_context,
        )?;

        // 3. 调用 LLM 生成摘要
        let summary = self.generate_summary(compaction_prompt).await?;

        // 4. 验证摘要质量
        self.validate_summary(&summary, &context.items[compression_range.clone()])?;

        // 5. 创建压缩结果
        Ok(CompactionResult {
            summary,
            compressed_range: compression_range,
            compression_ratio: self.calculate_compression_ratio(context, &summary),
            preserved_items: self.identify_preserved_items(context),
        })
    }

    fn build_compaction_prompt(
        &self,
        items_to_compress: &[ResponseItem],
        turn_context: &TurnContext,
    ) -> CodexResult<String> {
        let mut prompt = self.compaction_prompt_template.clone();

        // 添加要压缩的历史内容
        let history_text = self.format_history_for_compression(items_to_compress)?;
        prompt = prompt.replace("{HISTORY_TO_COMPRESS}", &history_text);

        // 添加当前上下文信息
        prompt = prompt.replace("{CURRENT_TASK}", &turn_context.current_task_summary());
        prompt = prompt.replace("{PROJECT_CONTEXT}", &turn_context.project_context());

        Ok(prompt)
    }

    async fn generate_summary(&self, prompt: String) -> CodexResult<String> {
        let request = ModelRequest {
            messages: vec![
                Message::system(SUMMARIZATION_SYSTEM_PROMPT),
                Message::user(prompt),
            ],
            max_tokens: Some(self.max_summary_tokens),
            temperature: 0.3, // 较低的温度以确保一致性
            ..Default::default()
        };

        let response = self.model_client.complete(request).await?;

        // 提取摘要文本
        let summary = response.choices[0].message.content
            .as_ref()
            .ok_or(CodexErr::EmptyCompactionSummary)?
            .clone();

        Ok(summary)
    }

    fn validate_summary(
        &self,
        summary: &str,
        original_items: &[ResponseItem],
    ) -> CodexResult<()> {
        // 检查摘要长度
        let summary_tokens = approx_token_count(summary);
        if summary_tokens > self.max_summary_tokens {
            return Err(CodexErr::SummaryTooLong {
                actual: summary_tokens,
                max: self.max_summary_tokens,
            });
        }

        // 检查关键信息是否保留
        let key_entities = self.extract_key_entities(original_items);
        let summary_entities = self.extract_key_entities_from_text(summary);

        let preservation_ratio = self.calculate_entity_preservation_ratio(
            &key_entities,
            &summary_entities,
        );

        if preservation_ratio < MIN_ENTITY_PRESERVATION_RATIO {
            return Err(CodexErr::SummaryQualityTooLow {
                preservation_ratio,
                min_required: MIN_ENTITY_PRESERVATION_RATIO,
            });
        }

        Ok(())
    }
}

const SUMMARIZATION_SYSTEM_PROMPT: &str = include_str!("../templates/compact/prompt.md");
const MIN_ENTITY_PRESERVATION_RATIO: f32 = 0.7; // 至少保留 70% 的关键实体
```

### 7.3.3 分层压缩策略

Codex 实现了分层压缩，根据内容重要性使用不同的压缩级别：

```rust
#[derive(Debug, Clone)]
pub enum CompressionLevel {
    Light,    // 轻度压缩，保留更多细节
    Medium,   // 中度压缩，平衡细节和简洁性
    Heavy,    // 重度压缩，只保留核心信息
    Extreme,  // 极度压缩，只保留最关键的信息
}

pub struct LayeredCompressor {
    light_compressor: LightCompressor,
    medium_compressor: MediumCompressor,
    heavy_compressor: HeavyCompressor,
    extreme_compressor: ExtremeCompressor,
}

impl LayeredCompressor {
    pub async fn compress_with_strategy(
        &self,
        items: &[ResponseItem],
        level: CompressionLevel,
        context: &TurnContext,
    ) -> CodexResult<String> {
        match level {
            CompressionLevel::Light => {
                self.light_compressor.compress(items, context).await
            },
            CompressionLevel::Medium => {
                self.medium_compressor.compress(items, context).await
            },
            CompressionLevel::Heavy => {
                self.heavy_compressor.compress(items, context).await
            },
            CompressionLevel::Extreme => {
                self.extreme_compressor.compress(items, context).await
            },
        }
    }

    pub fn determine_compression_level(
        &self,
        current_pressure: f32,
        content_importance: ContentImportance,
    ) -> CompressionLevel {
        match (current_pressure, content_importance) {
            (p, ContentImportance::Critical) if p < 0.9 => CompressionLevel::Light,
            (p, ContentImportance::Critical) => CompressionLevel::Medium,
            (p, ContentImportance::High) if p < 0.8 => CompressionLevel::Light,
            (p, ContentImportance::High) if p < 0.95 => CompressionLevel::Medium,
            (p, ContentImportance::High) => CompressionLevel::Heavy,
            (p, _) if p < 0.7 => CompressionLevel::Light,
            (p, _) if p < 0.85 => CompressionLevel::Medium,
            (p, _) if p < 0.95 => CompressionLevel::Heavy,
            _ => CompressionLevel::Extreme,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum ContentImportance {
    Critical,   // 错误消息、关键决策
    High,       // 工具调用结果、重要指令
    Medium,     // 普通对话、状态更新
    Low,        // 调试输出、冗余信息
}
```

## 7.4 Memory 系统集成

### 7.4.1 两阶段 Memory 管道

Codex 实现了一个先进的两阶段 Memory 系统：

```rust
// codex-rs/core/src/memories/mod.rs
pub struct MemoryPipeline {
    phase1_processor: Phase1Processor,  // 单独的 rollout 提取
    phase2_processor: Phase2Processor,  // 全局整合
    memory_store: MemoryStore,
}

/// Phase 1: 从 rollout 中提取结构化记忆
pub struct Phase1Processor {
    extraction_prompt_template: String,
    concurrent_limit: usize,
    retry_config: RetryConfig,
}

impl Phase1Processor {
    pub async fn process_rollout(&self, rollout: &Rollout) -> CodexResult<ExtractedMemory> {
        // 1. 过滤与记忆相关的响应项目
        let memory_relevant_items = self.filter_memory_relevant_items(rollout)?;

        if memory_relevant_items.is_empty() {
            return Ok(ExtractedMemory::empty());
        }

        // 2. 构建提取提示
        let extraction_prompt = self.build_extraction_prompt(&memory_relevant_items)?;

        // 3. 调用模型提取记忆
        let raw_extraction = self.call_extraction_model(extraction_prompt).await?;

        // 4. 解析和验证提取结果
        let structured_memory = self.parse_extraction_result(&raw_extraction)?;

        // 5. 脱敏处理
        let sanitized_memory = self.sanitize_memory(structured_memory)?;

        Ok(sanitized_memory)
    }

    fn build_extraction_prompt(&self, items: &[ResponseItem]) -> CodexResult<String> {
        let mut prompt = self.extraction_prompt_template.clone();

        let rollout_content = self.format_rollout_for_extraction(items)?;
        prompt = prompt.replace("{ROLLOUT_CONTENT}", &rollout_content);

        Ok(prompt)
    }

    async fn call_extraction_model(&self, prompt: String) -> CodexResult<String> {
        let request = ModelRequest {
            messages: vec![
                Message::system(MEMORY_EXTRACTION_SYSTEM_PROMPT),
                Message::user(prompt),
            ],
            response_format: Some(ResponseFormat::JsonObject), // 结构化输出
            temperature: 0.2,
            ..Default::default()
        };

        let response = self.model_client.complete(request).await?;
        Ok(response.choices[0].message.content.unwrap_or_default())
    }

    fn parse_extraction_result(&self, raw_result: &str) -> CodexResult<ExtractedMemory> {
        let parsed: MemoryExtractionResult = serde_json::from_str(raw_result)?;

        Ok(ExtractedMemory {
            raw_memory: parsed.raw_memory,
            rollout_summary: parsed.rollout_summary,
            rollout_slug: parsed.rollout_slug,
            key_decisions: parsed.key_decisions,
            learned_patterns: parsed.learned_patterns,
            important_context: parsed.important_context,
            extracted_at: Utc::now(),
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct MemoryExtractionResult {
    raw_memory: String,
    rollout_summary: String,
    rollout_slug: Option<String>,
    key_decisions: Vec<String>,
    learned_patterns: Vec<String>,
    important_context: Vec<String>,
}

const MEMORY_EXTRACTION_SYSTEM_PROMPT: &str = include_str!("../templates/memories/stage_one_system.md");
```

### 7.4.2 全局记忆整合

Phase 2 负责将多个 Phase 1 输出整合为连贯的记忆：

```rust
/// Phase 2: 全局记忆整合
pub struct Phase2Processor {
    consolidation_prompt_template: String,
    max_input_memories: usize,
    memory_ranking: MemoryRanking,
}

impl Phase2Processor {
    pub async fn consolidate_memories(
        &self,
        phase1_outputs: Vec<ExtractedMemory>,
    ) -> CodexResult<ConsolidatedMemory> {
        // 1. 选择和排序输入记忆
        let selected_memories = self.select_memories_for_consolidation(phase1_outputs)?;

        // 2. 计算整合差异
        let consolidation_diff = self.compute_consolidation_diff(&selected_memories)?;

        // 3. 构建整合提示
        let consolidation_prompt = self.build_consolidation_prompt(&consolidation_diff)?;

        // 4. 执行整合
        let consolidated_output = self.call_consolidation_model(consolidation_prompt).await?;

        // 5. 更新记忆工件
        self.update_memory_artifacts(&consolidated_output).await?;

        Ok(consolidated_output)
    }

    fn select_memories_for_consolidation(
        &self,
        mut memories: Vec<ExtractedMemory>,
    ) -> CodexResult<Vec<ExtractedMemory>> {
        // 按使用计数和最近使用时间排序
        memories.sort_by(|a, b| {
            let a_score = self.memory_ranking.calculate_score(a);
            let b_score = self.memory_ranking.calculate_score(b);
            b_score.partial_cmp(&a_score).unwrap_or(std::cmp::Ordering::Equal)
        });

        // 过滤过期的记忆
        let now = Utc::now();
        let max_unused_days = chrono::Duration::days(30);

        memories.retain(|memory| {
            if let Some(last_usage) = memory.last_usage {
                now.signed_duration_since(last_usage) <= max_unused_days
            } else {
                // 对于从未使用的记忆，检查生成时间
                now.signed_duration_since(memory.extracted_at) <= max_unused_days
            }
        });

        // 限制数量
        memories.truncate(self.max_input_memories);

        Ok(memories)
    }

    async fn update_memory_artifacts(
        &self,
        consolidated: &ConsolidatedMemory,
    ) -> CodexResult<()> {
        // 更新 raw_memories.md
        self.update_raw_memories_file(consolidated).await?;

        // 更新 rollout_summaries/
        self.update_rollout_summaries(consolidated).await?;

        // 清理过期的摘要文件
        self.cleanup_stale_summaries().await?;

        Ok(())
    }
}

pub struct MemoryRanking;

impl MemoryRanking {
    pub fn calculate_score(&self, memory: &ExtractedMemory) -> f32 {
        let mut score = 0.0;

        // 使用计数权重
        score += memory.usage_count as f32 * 2.0;

        // 时间衰减
        let age_days = Utc::now()
            .signed_duration_since(memory.extracted_at)
            .num_days() as f32;
        let time_decay = (-age_days / 30.0).exp(); // 30天衰减
        score *= time_decay;

        // 内容质量权重
        if !memory.key_decisions.is_empty() {
            score *= 1.5;
        }
        if !memory.learned_patterns.is_empty() {
            score *= 1.3;
        }

        score
    }
}
```

## 7.5 长对话处理策略

### 7.5.1 渐进式压缩

对于超长对话，Codex 使用渐进式压缩策略：

```rust
pub struct ProgressiveCompressor {
    compression_levels: Vec<CompressionLevel>,
    level_thresholds: Vec<usize>, // Token 阈值
    rolling_window: RollingWindow,
}

impl ProgressiveCompressor {
    pub async fn process_long_conversation(
        &mut self,
        context: &mut ContextManager,
        turn_context: &TurnContext,
    ) -> CodexResult<()> {
        let current_tokens = context.estimate_total_tokens() as usize;
        let target_compression_level = self.determine_target_level(current_tokens);

        match target_compression_level {
            0 => Ok(()), // 无需压缩
            1 => self.apply_light_compression(context).await,
            2 => self.apply_medium_compression(context).await,
            3 => self.apply_heavy_compression(context).await,
            _ => self.apply_extreme_compression(context).await,
        }
    }

    async fn apply_light_compression(&self, context: &mut ContextManager) -> CodexResult<()> {
        // 轻度压缩：只压缩最旧的 20% 内容
        let total_items = context.items.len();
        let compress_count = (total_items as f32 * 0.2) as usize;

        if compress_count > 0 {
            let items_to_compress = context.items.drain(0..compress_count).collect::<Vec<_>>();
            let summary = self.compress_items(&items_to_compress, CompressionLevel::Light).await?;

            // 在开头插入压缩摘要
            context.items.insert(0, ResponseItem::ContextCompaction(
                ContextCompactionItem::new_with_summary(summary)
            ));
        }

        Ok(())
    }

    async fn apply_medium_compression(&self, context: &mut ContextManager) -> CodexResult<()> {
        // 中度压缩：压缩最旧的 40% 内容
        let total_items = context.items.len();
        let compress_count = (total_items as f32 * 0.4) as usize;

        if compress_count > 0 {
            let items_to_compress = context.items.drain(0..compress_count).collect::<Vec<_>>();
            let summary = self.compress_items(&items_to_compress, CompressionLevel::Medium).await?;

            context.items.insert(0, ResponseItem::ContextCompaction(
                ContextCompactionItem::new_with_summary(summary)
            ));
        }

        Ok(())
    }

    async fn apply_heavy_compression(&self, context: &mut ContextManager) -> CodexResult<()> {
        // 重度压缩：压缩除了最近 10 个项目外的所有内容
        let preserve_count = 10.min(context.items.len());
        let compress_count = context.items.len().saturating_sub(preserve_count);

        if compress_count > 0 {
            let items_to_compress = context.items.drain(0..compress_count).collect::<Vec<_>>();
            let summary = self.compress_items(&items_to_compress, CompressionLevel::Heavy).await?;

            context.items.insert(0, ResponseItem::ContextCompaction(
                ContextCompactionItem::new_with_summary(summary)
            ));
        }

        Ok(())
    }
}
```

### 7.5.2 滚动窗口机制

```rust
pub struct RollingWindow {
    window_size: usize,
    overlap_size: usize,
    compression_cache: LruCache<String, String>,
}

impl RollingWindow {
    pub fn process_with_rolling_window(
        &mut self,
        items: &[ResponseItem],
    ) -> CodexResult<Vec<ProcessedChunk>> {
        let mut processed_chunks = Vec::new();
        let mut current_pos = 0;

        while current_pos < items.len() {
            let chunk_end = (current_pos + self.window_size).min(items.len());
            let chunk = &items[current_pos..chunk_end];

            // 检查缓存
            let chunk_hash = self.calculate_chunk_hash(chunk);
            if let Some(cached_result) = self.compression_cache.get(&chunk_hash) {
                processed_chunks.push(ProcessedChunk::Cached(cached_result.clone()));
            } else {
                let processed = self.process_chunk(chunk).await?;
                self.compression_cache.put(chunk_hash, processed.content.clone());
                processed_chunks.push(processed);
            }

            // 移动到下一个窗口，考虑重叠
            current_pos += self.window_size - self.overlap_size;
        }

        Ok(processed_chunks)
    }

    async fn process_chunk(&self, chunk: &[ResponseItem]) -> CodexResult<ProcessedChunk> {
        // 对单个窗口进行处理（压缩或保留）
        let chunk_tokens = Self::estimate_chunk_tokens(chunk);

        if chunk_tokens > MAX_CHUNK_TOKENS {
            let compressed = self.compress_chunk(chunk).await?;
            Ok(ProcessedChunk::Compressed(compressed))
        } else {
            Ok(ProcessedChunk::Preserved(chunk.to_vec()))
        }
    }
}

#[derive(Debug, Clone)]
pub enum ProcessedChunk {
    Preserved(Vec<ResponseItem>),
    Compressed(String),
    Cached(String),
}

const MAX_CHUNK_TOKENS: usize = 2048;
```

## 7.6 会话持久化与恢复

### 7.6.1 会话状态序列化

```rust
// codex-rs/core/src/state/session.rs
#[derive(Debug, Serialize, Deserialize)]
pub struct SessionState {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub context_manager: SerializableContextManager,
    pub turn_history: Vec<TurnSnapshot>,
    pub memory_state: MemoryState,
    pub configuration: SessionConfiguration,
    pub created_at: DateTime<Utc>,
    pub last_updated: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SerializableContextManager {
    pub items: Vec<ResponseItem>,
    pub token_info: Option<TokenUsageInfo>,
    pub reference_context: Option<TurnContextItem>,
    pub compression_history: Vec<CompressionRecord>,
}

impl From<&ContextManager> for SerializableContextManager {
    fn from(context: &ContextManager) -> Self {
        Self {
            items: context.items.clone(),
            token_info: context.token_info.clone(),
            reference_context: context.reference_context_item.clone(),
            compression_history: context.get_compression_history(),
        }
    }
}

pub struct SessionPersistence {
    storage_backend: Box<dyn StorageBackend>,
    compression_enabled: bool,
    encryption_key: Option<SecretKey>,
}

impl SessionPersistence {
    pub async fn save_session(&self, session: &Session) -> CodexResult<()> {
        // 1. 创建会话快照
        let session_state = SessionState::from_session(session).await?;

        // 2. 序列化
        let mut serialized = serde_json::to_vec(&session_state)?;

        // 3. 压缩（如果启用）
        if self.compression_enabled {
            serialized = self.compress_data(&serialized)?;
        }

        // 4. 加密（如果启用）
        if let Some(key) = &self.encryption_key {
            serialized = self.encrypt_data(&serialized, key)?;
        }

        // 5. 存储
        let storage_key = format!("session_{}", session_state.session_id);
        self.storage_backend.store(&storage_key, &serialized).await?;

        Ok(())
    }

    pub async fn restore_session(&self, session_id: &SessionId) -> CodexResult<SessionState> {
        // 1. 从存储中读取
        let storage_key = format!("session_{}", session_id);
        let mut data = self.storage_backend.retrieve(&storage_key).await?;

        // 2. 解密（如果需要）
        if let Some(key) = &self.encryption_key {
            data = self.decrypt_data(&data, key)?;
        }

        // 3. 解压缩（如果需要）
        if self.compression_enabled {
            data = self.decompress_data(&data)?;
        }

        // 4. 反序列化
        let session_state: SessionState = serde_json::from_slice(&data)?;

        // 5. 验证状态完整性
        self.validate_session_state(&session_state)?;

        Ok(session_state)
    }
}
```

### 7.6.2 增量会话更新

为了减少存储开销，Codex 支持增量会话更新：

```rust
pub struct IncrementalSessionUpdater {
    last_saved_snapshot: Option<SessionSnapshot>,
    pending_changes: Vec<SessionChange>,
    auto_save_interval: Duration,
    max_pending_changes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SessionChange {
    AddedItem { item: ResponseItem, position: usize },
    RemovedItem { position: usize },
    UpdatedTokenInfo { new_info: TokenUsageInfo },
    CompressedRange { range: Range<usize>, summary: String },
    UpdatedMemory { memory_update: MemoryUpdate },
}

impl IncrementalSessionUpdater {
    pub fn record_change(&mut self, change: SessionChange) {
        self.pending_changes.push(change);

        // 如果变更过多，触发完整保存
        if self.pending_changes.len() >= self.max_pending_changes {
            self.flush_changes().await?;
        }
    }

    pub async fn flush_changes(&mut self) -> CodexResult<()> {
        if self.pending_changes.is_empty() {
            return Ok(());
        }

        // 应用所有待处理的变更
        let updated_session = self.apply_pending_changes().await?;

        // 保存更新后的会话
        self.persistence.save_session(&updated_session).await?;

        // 清空待处理的变更
        self.pending_changes.clear();
        self.last_saved_snapshot = Some(SessionSnapshot::from(&updated_session));

        Ok(())
    }

    async fn apply_pending_changes(&self) -> CodexResult<SessionState> {
        let mut session_state = self.last_saved_snapshot
            .as_ref()
            .ok_or(CodexErr::NoSavedSnapshot)?
            .clone()
            .into_session_state();

        for change in &self.pending_changes {
            match change {
                SessionChange::AddedItem { item, position } => {
                    session_state.context_manager.items.insert(*position, item.clone());
                },
                SessionChange::RemovedItem { position } => {
                    session_state.context_manager.items.remove(*position);
                },
                SessionChange::UpdatedTokenInfo { new_info } => {
                    session_state.context_manager.token_info = Some(new_info.clone());
                },
                SessionChange::CompressedRange { range, summary } => {
                    // 移除原始项目并插入压缩摘要
                    let compressed_items = session_state.context_manager.items
                        .drain(range.clone())
                        .collect::<Vec<_>>();

                    let compaction_item = ResponseItem::ContextCompaction(
                        ContextCompactionItem::new_with_summary(summary.clone())
                    );

                    session_state.context_manager.items.insert(range.start, compaction_item);
                },
                SessionChange::UpdatedMemory { memory_update } => {
                    session_state.memory_state.apply_update(memory_update)?;
                },
            }
        }

        session_state.last_updated = Utc::now();
        Ok(session_state)
    }
}
```

## 7.7 Fork 与分支会话

### 7.7.1 会话分叉机制

Codex 支持会话分叉，允许用户探索不同的对话分支：

```rust
pub struct SessionFork {
    parent_session_id: SessionId,
    fork_session_id: SessionId,
    fork_point: TurnId,
    fork_strategy: ForkStrategy,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub enum ForkStrategy {
    FullHistory,           // 完整复制所有历史
    LastNTurns(usize),    // 只复制最近 N 轮对话
    CompactedHistory,     // 复制压缩后的历史
    MemoryOnly,           // 只复制记忆，不复制详细历史
}

pub struct SessionForkManager {
    session_storage: Arc<SessionPersistence>,
    fork_registry: ForkRegistry,
    max_forks_per_session: usize,
}

impl SessionForkManager {
    pub async fn create_fork(
        &mut self,
        parent_session: &Session,
        strategy: ForkStrategy,
    ) -> CodexResult<SessionId> {
        // 1. 检查分叉限制
        self.check_fork_limits(parent_session.id())?;

        // 2. 生成新的会话 ID
        let fork_session_id = SessionId::new();

        // 3. 根据策略创建分叉会话
        let fork_session_state = match strategy {
            ForkStrategy::FullHistory => {
                self.create_full_history_fork(parent_session).await?
            },
            ForkStrategy::LastNTurns(n) => {
                self.create_recent_turns_fork(parent_session, n).await?
            },
            ForkStrategy::CompactedHistory => {
                self.create_compacted_fork(parent_session).await?
            },
            ForkStrategy::MemoryOnly => {
                self.create_memory_only_fork(parent_session).await?
            },
        };

        // 4. 保存分叉会话
        self.session_storage.save_session_state(&fork_session_state).await?;

        // 5. 注册分叉关系
        let fork = SessionFork {
            parent_session_id: parent_session.id(),
            fork_session_id,
            fork_point: parent_session.current_turn_id(),
            fork_strategy: strategy,
            created_at: Utc::now(),
        };

        self.fork_registry.register_fork(fork)?;

        Ok(fork_session_id)
    }

    async fn create_compacted_fork(
        &self,
        parent_session: &Session,
    ) -> CodexResult<SessionState> {
        let parent_context = parent_session.context_manager();

        // 压缩父会话的历史
        let compacted_history = self.compress_session_history(parent_context).await?;

        // 创建新的上下文管理器
        let fork_context = ContextManager {
            items: vec![ResponseItem::ContextCompaction(
                ContextCompactionItem::new_with_summary(compacted_history)
            )],
            token_info: parent_context.token_info().clone(),
            reference_context_item: None, // 清除引用上下文，强制重新注入
        };

        // 复制记忆状态
        let memory_state = parent_session.memory_state().clone();

        Ok(SessionState {
            session_id: SessionId::new(),
            thread_id: ThreadId::new(),
            context_manager: fork_context.into(),
            turn_history: Vec::new(), // 新会话从空历史开始
            memory_state,
            configuration: parent_session.configuration().clone(),
            created_at: Utc::now(),
            last_updated: Utc::now(),
        })
    }

    async fn compress_session_history(
        &self,
        context: &ContextManager,
    ) -> CodexResult<String> {
        let compaction_prompt = format!(
            "Create a comprehensive handoff summary for the following conversation history. \
             Focus on:\n\
             - Key decisions and outcomes\n\
             - Current project state\n\
             - Important context for continuation\n\
             - Unresolved issues or next steps\n\n\
             Conversation History:\n{}",
            self.format_context_for_compression(context)?
        );

        // 使用压缩模型生成摘要
        let summary = self.compaction_engine
            .generate_summary(compaction_prompt)
            .await?;

        Ok(summary)
    }
}
```

### 7.7.2 分叉会话同步

```rust
pub struct ForkSynchronizer {
    diff_engine: DiffEngine,
    merge_strategy: MergeStrategy,
}

impl ForkSynchronizer {
    pub async fn sync_fork_with_parent(
        &self,
        fork_session: &mut Session,
        parent_session: &Session,
        sync_strategy: SyncStrategy,
    ) -> CodexResult<SyncResult> {
        // 1. 计算差异
        let diff = self.diff_engine.compute_diff(
            parent_session.context_manager(),
            fork_session.context_manager(),
        ).await?;

        // 2. 根据策略应用更新
        match sync_strategy {
            SyncStrategy::MergeUpdates => {
                self.merge_updates(fork_session, &diff).await
            },
            SyncStrategy::ReplaceWithParent => {
                self.replace_with_parent(fork_session, parent_session).await
            },
            SyncStrategy::SelectiveSync { filter } => {
                self.selective_sync(fork_session, &diff, filter).await
            },
        }
    }

    async fn merge_updates(
        &self,
        fork_session: &mut Session,
        diff: &SessionDiff,
    ) -> CodexResult<SyncResult> {
        let mut conflicts = Vec::new();
        let mut applied_changes = Vec::new();

        for change in &diff.changes {
            match self.can_apply_change_safely(fork_session, change) {
                Ok(true) => {
                    self.apply_change(fork_session, change).await?;
                    applied_changes.push(change.clone());
                },
                Ok(false) => {
                    conflicts.push(SyncConflict {
                        change: change.clone(),
                        reason: ConflictReason::SafetyCheck,
                    });
                },
                Err(e) => {
                    conflicts.push(SyncConflict {
                        change: change.clone(),
                        reason: ConflictReason::Error(e),
                    });
                }
            }
        }

        Ok(SyncResult {
            applied_changes,
            conflicts,
            sync_timestamp: Utc::now(),
        })
    }
}

#[derive(Debug, Clone)]
pub enum SyncStrategy {
    MergeUpdates,
    ReplaceWithParent,
    SelectiveSync { filter: SyncFilter },
}

#[derive(Debug, Clone)]
pub struct SyncFilter {
    include_memory_updates: bool,
    include_context_updates: bool,
    include_configuration_updates: bool,
    max_age: Option<Duration>,
}
```

## 7.8 性能优化与监控

### 7.8.1 上下文性能指标

```rust
#[derive(Debug, Clone)]
pub struct ContextPerformanceMetrics {
    pub average_compression_ratio: f32,
    pub compression_latency_ms: f64,
    pub memory_usage_mb: f64,
    pub token_efficiency: f32,
    pub cache_hit_rate: f32,
}

pub struct ContextPerformanceMonitor {
    metrics_history: VecDeque<ContextPerformanceMetrics>,
    compression_times: VecDeque<Duration>,
    memory_usage_samples: VecDeque<usize>,
    cache_stats: CacheStatistics,
}

impl ContextPerformanceMonitor {
    pub fn record_compression(&mut self,
        original_tokens: usize,
        compressed_tokens: usize,
        duration: Duration
    ) {
        let ratio = compressed_tokens as f32 / original_tokens as f32;

        self.compression_times.push_back(duration);
        if self.compression_times.len() > 100 {
            self.compression_times.pop_front();
        }

        // 记录压缩比率
        self.record_metric_update(|metrics| {
            metrics.average_compression_ratio = self.calculate_average_compression_ratio();
            metrics.compression_latency_ms = duration.as_secs_f64() * 1000.0;
        });
    }

    pub fn calculate_context_efficiency(&self, context: &ContextManager) -> f32 {
        let total_tokens = context.estimate_total_tokens();
        let unique_information_tokens = self.estimate_unique_information(context);

        unique_information_tokens as f32 / total_tokens as f32
    }

    fn estimate_unique_information(&self, context: &ContextManager) -> usize {
        // 使用简单的去重算法估算独特信息量
        let mut unique_chunks = HashSet::new();
        let mut total_unique_tokens = 0;

        for item in &context.items {
            let content = self.extract_item_content(item);
            let chunks = self.chunk_content(&content, 50); // 50 token 块

            for chunk in chunks {
                if unique_chunks.insert(self.normalize_chunk(&chunk)) {
                    total_unique_tokens += approx_token_count(&chunk);
                }
            }
        }

        total_unique_tokens
    }

    pub fn suggest_optimizations(&self, context: &ContextManager) -> Vec<OptimizationSuggestion> {
        let mut suggestions = Vec::new();

        let efficiency = self.calculate_context_efficiency(context);
        if efficiency < 0.6 {
            suggestions.push(OptimizationSuggestion::AggressiveCompression);
        }

        let recent_compression_ratio = self.get_recent_average_compression_ratio();
        if recent_compression_ratio > 0.8 {
            suggestions.push(OptimizationSuggestion::BetterCompressionStrategy);
        }

        let memory_usage = self.get_current_memory_usage();
        if memory_usage > 512 * 1024 * 1024 { // 512MB
            suggestions.push(OptimizationSuggestion::IncreaseCompressionFrequency);
        }

        suggestions
    }
}

#[derive(Debug, Clone)]
pub enum OptimizationSuggestion {
    AggressiveCompression,
    BetterCompressionStrategy,
    IncreaseCompressionFrequency,
    EnableMemorySystem,
    ReduceContextWindow,
}
```

### 7.8.2 自适应优化

```rust
pub struct AdaptiveContextOptimizer {
    performance_monitor: ContextPerformanceMonitor,
    optimization_rules: Vec<Box<dyn OptimizationRule>>,
    learning_rate: f32,
}

pub trait OptimizationRule {
    fn should_apply(&self, metrics: &ContextPerformanceMetrics) -> bool;
    fn apply(&self, context: &mut ContextManager) -> CodexResult<()>;
    fn priority(&self) -> OptimizationPriority;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum OptimizationPriority {
    Low = 0,
    Medium = 1,
    High = 2,
    Critical = 3,
}

pub struct CompressionFrequencyRule {
    compression_ratio_threshold: f32,
    latency_threshold_ms: f64,
}

impl OptimizationRule for CompressionFrequencyRule {
    fn should_apply(&self, metrics: &ContextPerformanceMetrics) -> bool {
        metrics.average_compression_ratio < self.compression_ratio_threshold ||
        metrics.compression_latency_ms > self.latency_threshold_ms
    }

    fn apply(&self, context: &mut ContextManager) -> CodexResult<()> {
        // 调整压缩频率参数
        context.set_compression_trigger_threshold(0.7); // 更激进的压缩
        Ok(())
    }

    fn priority(&self) -> OptimizationPriority {
        OptimizationPriority::High
    }
}

impl AdaptiveContextOptimizer {
    pub async fn optimize_context(
        &mut self,
        context: &mut ContextManager,
    ) -> CodexResult<Vec<OptimizationAction>> {
        let metrics = self.performance_monitor.get_current_metrics();
        let mut applied_actions = Vec::new();

        // 收集适用的优化规则
        let mut applicable_rules: Vec<_> = self.optimization_rules
            .iter()
            .filter(|rule| rule.should_apply(&metrics))
            .collect();

        // 按优先级排序
        applicable_rules.sort_by_key(|rule| rule.priority());

        // 应用优化规则
        for rule in applicable_rules {
            match rule.apply(context) {
                Ok(()) => {
                    applied_actions.push(OptimizationAction {
                        rule_name: rule.type_name().to_string(),
                        applied_at: Utc::now(),
                        success: true,
                    });
                },
                Err(e) => {
                    applied_actions.push(OptimizationAction {
                        rule_name: rule.type_name().to_string(),
                        applied_at: Utc::now(),
                        success: false,
                    });

                    tracing::warn!("Failed to apply optimization rule {}: {}",
                        rule.type_name(), e);
                }
            }
        }

        Ok(applied_actions)
    }
}
```

## 7.9 总结与设计洞察

### 7.9.1 核心设计原则

OpenAI Codex CLI 的上下文管理系统体现了以下设计原则：

1. **智能压缩**：使用 LLM 生成高质量的上下文摘要
2. **分层管理**：活跃上下文、压缩历史、长期记忆三层结构
3. **性能优化**：缓存、增量更新、自适应调整
4. **用户体验**：会话持久化、分叉、恢复机制
5. **可观测性**：详细的性能指标和优化建议

### 7.9.2 关键技术创新

| 创新点 | 实现方式 | 优势 |
|--------|----------|------|
| **LLM 驱动压缩** | 使用模型生成智能摘要 | 保留语义信息 |
| **分层压缩** | 根据压力级别调整策略 | 平衡效率和质量 |
| **增量持久化** | 只保存变更差异 | 减少存储开销 |
| **会话分叉** | 支持探索性对话分支 | 提升用户体验 |
| **自适应优化** | 基于性能指标自动调整 | 持续改进性能 |

### 7.9.3 架构对比分析

| 维度 | Codex CLI | Claude Code | 传统 Chatbot |
|------|-----------|-------------|--------------|
| **压缩策略** | LLM 智能压缩 | 简单截断 | 固定窗口 |
| **记忆系统** | 两阶段记忆 | 基础记忆 | 无持久记忆 |
| **会话管理** | 完整持久化 + 分叉 | 基础持久化 | 无持久化 |
| **性能优化** | 自适应优化 | 静态配置 | 无优化 |
| **上下文利用率** | 高效利用 | 中等 | 低效 |

### 7.9.4 速查表

| 组件 | 文件路径 | 核心功能 | 关键接口 |
|------|----------|----------|----------|
| **上下文管理器** | `context_manager/history.rs` | 历史管理 | `record_items()` |
| **压缩引擎** | `compact.rs` | 智能压缩 | `run_compact_task()` |
| **记忆系统** | `memories/mod.rs` | 长期记忆 | `build_memory_context()` |
| **会话持久化** | `state/session.rs` | 状态保存 | `save_session()` |
| **性能监控** | `context_manager/metrics.rs` | 性能指标 | `record_compression()` |
| **分叉管理** | `fork_manager.rs` | 会话分叉 | `create_fork()` |

### 7.9.5 最佳实践建议

1. **压缩策略选择**：
   - 对重要对话使用轻度压缩
   - 对历史数据使用重度压缩
   - 根据实时性能调整策略

2. **记忆系统配置**：
   - 合理设置记忆保留期限
   - 定期清理无用记忆
   - 优化记忆检索性能

3. **会话管理**：
   - 及时保存重要会话状态
   - 合理使用分叉功能
   - 监控存储使用情况

4. **性能调优**：
   - 关注上下文利用率指标
   - 根据使用模式调整参数
   - 定期分析性能瓶颈

Codex 的上下文管理系统是 AI Agent 领域的一个重要创新，它成功地解决了长对话场景中的核心挑战。这个"有限记忆的艺术"为构建更智能、更高效的 AI 系统提供了宝贵的经验和参考。