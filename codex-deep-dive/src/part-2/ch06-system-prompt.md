# 第 6 章：System Prompt — Agent 的行为基因

> **核心问题：** OpenAI Codex CLI 如何构建动态的系统提示？如何注入上下文信息、工具描述和用户自定义指令？AGENTS.md 和 Skills 如何增强 Agent 的能力？

## 6.1 架构概览：多层次提示构建系统

OpenAI Codex CLI 的 System Prompt 系统是一个精心设计的多层架构，它将静态的基础指令与动态的上下文信息相结合，为 Agent 构建出完整的行为指南。这个系统的核心理念是 **"Composable Prompts"**（可组合提示），通过模块化的方式构建复杂的系统提示。

### 6.1.1 提示构建流水线

```
┌─────────────────────────────────────────────────────────────────┐
│                  System Prompt Construction                     │
│                                                                 │
│ ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────┐ │
│ │    Base     │─▶│ Environment │─▶│    Tools    │─▶│  Final  │ │
│ │ Instructions│  │   Context   │  │ Description │  │ Prompt  │ │
│ └─────────────┘  └─────────────┘  └─────────────┘  └─────────┘ │
│       ▲                 ▲                 ▲              ▲     │
│       │                 │                 │              │     │
│ ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │     │
│ │  AGENTS.md  │  │   Skills    │  │     MCP     │       │     │
│ │ Instructions│  │ Injections  │  │   Tools     │       │     │
│ └─────────────┘  └─────────────┘  └─────────────┘       │     │
│                                                          │     │
│ ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │     │
│ │   Memory    │  │ Subagents   │  │ User Config │───────┘     │
│ │  Context    │  │   Context   │  │   Override  │             │
│ └─────────────┘  └─────────────┘  └─────────────┘             │
└─────────────────────────────────────────────────────────────────┘
```

### 6.1.2 核心组件结构

在 Codex 中，System Prompt 的构建涉及多个模块：

```rust
// 提示构建的核心结构
pub struct PromptBuilder {
    base_instructions: BaseInstructions,
    environment_context: EnvironmentContext,
    tools_registry: ToolsRegistry,
    skills_manager: SkillsManager,
    memory_manager: MemoryManager,
    agents_config: AgentsConfig,
}

pub struct SystemPromptComponents {
    base_prompt: String,                    // 来自 prompt.md
    environment_context: String,            // 工作目录、时间、网络等
    tools_description: String,              // 可用工具的描述
    skills_injections: Vec<SkillInjection>, // Skills 增强
    agents_instructions: String,            // AGENTS.md 内容
    memory_context: Option<String>,         // 内存摘要
    user_instructions: Option<String>,      // 用户自定义指令
}
```

## 6.2 基础指令系统

### 6.2.1 Core Prompt 架构

Codex 的基础提示定义在 `prompt.md` 中，它建立了 Agent 的基本人格和行为准则：

```markdown
# 基础提示结构分析 (prompt.md)

## 身份定义
You are a coding agent running in the Codex CLI, a terminal-based coding assistant.

## 核心能力声明
- Receive user prompts and other context
- Communicate by streaming thinking & responses
- Emit function calls to run terminal commands and apply patches

## 个性设定
Your default personality and tone is concise, direct, and friendly.
```

这个基础提示通过以下方式加载到系统中：

```rust
// codex-rs/core/src/client_common.rs
pub struct BaseInstructions {
    content: String,
    version: String,
}

impl BaseInstructions {
    pub fn load_from_file() -> CodexResult<Self> {
        // 加载编译时嵌入的 prompt.md
        let content = include_str!("../prompt.md").to_string();

        Ok(Self {
            content,
            version: Self::calculate_version(&content),
        })
    }

    pub fn build_system_message(&self, context: &PromptContext) -> String {
        let mut prompt = self.content.clone();

        // 注入动态内容占位符
        prompt = prompt.replace("{ENVIRONMENT_CONTEXT}", &context.environment);
        prompt = prompt.replace("{TOOLS_DESCRIPTION}", &context.tools);
        prompt = prompt.replace("{AGENTS_INSTRUCTIONS}", &context.agents_md);

        prompt
    }
}
```

### 6.2.2 提示版本管理

为了确保提示的一致性和可追踪性，Codex 实现了提示版本管理：

```rust
impl BaseInstructions {
    fn calculate_version(content: &str) -> String {
        use sha2::{Sha256, Digest};
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        let result = hasher.finalize();
        format!("{:x}", result)[..8].to_string() // 取前8位作为版本号
    }

    pub fn is_compatible_with(&self, other_version: &str) -> bool {
        // 检查提示版本兼容性
        self.version == other_version
    }
}
```

## 6.3 环境上下文注入

### 6.3.1 动态环境信息

Codex 会自动收集和注入当前的环境信息，让 Agent 了解执行上下文：

```rust
// codex-rs/core/src/environment_context.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentContext {
    pub cwd: Option<PathBuf>,        // 当前工作目录
    pub shell: Shell,                // Shell 类型和版本
    pub current_date: Option<String>, // 当前日期时间
    pub timezone: Option<String>,     // 时区信息
    pub network: Option<NetworkContext>, // 网络策略
    pub subagents: Option<String>,    // 子Agent信息
}

impl EnvironmentContext {
    pub fn collect_current_context() -> CodexResult<Self> {
        let cwd = std::env::current_dir().ok();
        let shell = Shell::detect_current_shell()?;
        let current_date = Some(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string());
        let timezone = Some(chrono::Local::now().format("%Z").to_string());

        // 检测网络策略
        let network = NetworkContext::detect_current_policy().await?;

        Ok(Self {
            cwd,
            shell,
            current_date,
            timezone,
            network: Some(network),
            subagents: None,
        })
    }

    pub fn render_to_prompt(&self) -> String {
        let mut context_lines = Vec::new();

        if let Some(cwd) = &self.cwd {
            context_lines.push(format!("Working directory: {}", cwd.display()));
        }

        context_lines.push(format!("Shell: {} ({})",
            self.shell.shell_type(), self.shell.version()));

        if let Some(date) = &self.current_date {
            context_lines.push(format!("Current time: {}", date));
        }

        if let Some(tz) = &self.timezone {
            context_lines.push(format!("Timezone: {}", tz));
        }

        if let Some(network) = &self.network {
            context_lines.push(network.render_policy_description());
        }

        format!("## Environment Context\n\n{}\n", context_lines.join("\n"))
    }
}
```

### 6.3.2 网络策略上下文

网络访问策略是环境上下文的重要组成部分：

```rust
#[derive(Debug, Clone)]
pub struct NetworkContext {
    allowed_domains: Vec<String>,
    denied_domains: Vec<String>,
    requires_approval: bool,
}

impl NetworkContext {
    async fn detect_current_policy() -> CodexResult<Self> {
        // 从配置中读取网络策略
        let config = Config::load().await?;

        Ok(Self {
            allowed_domains: config.network_policy.allowed_domains.clone(),
            denied_domains: config.network_policy.denied_domains.clone(),
            requires_approval: config.approval_mode.requires_network_approval(),
        })
    }

    fn render_policy_description(&self) -> String {
        let mut policy_desc = Vec::new();

        if !self.allowed_domains.is_empty() {
            policy_desc.push(format!("Allowed domains: {}",
                self.allowed_domains.join(", ")));
        }

        if !self.denied_domains.is_empty() {
            policy_desc.push(format!("Blocked domains: {}",
                self.denied_domains.join(", ")));
        }

        if self.requires_approval {
            policy_desc.push("Network access requires user approval".to_string());
        }

        format!("Network policy: {}", policy_desc.join("; "))
    }
}
```

## 6.4 工具描述自动生成

### 6.4.1 工具注册与描述

Codex 维护了一个工具注册表，自动生成工具的 JSON Schema 描述：

```rust
// codex-rs/core/src/tools/registry.rs
pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn ToolHandler>>,
    schemas: HashMap<String, ToolSchema>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolSchema {
    name: String,
    description: String,
    parameters: serde_json::Value,
    dangerous: bool,
    requires_approval: bool,
}

impl ToolRegistry {
    pub fn register_tool<T>(&mut self, tool: T) -> CodexResult<()>
    where
        T: ToolHandler + 'static,
    {
        let schema = tool.generate_schema()?;
        self.schemas.insert(schema.name.clone(), schema.clone());
        self.tools.insert(schema.name.clone(), Box::new(tool));
        Ok(())
    }

    pub fn generate_tools_description(&self, context: &TurnContext) -> String {
        let mut descriptions = Vec::new();

        descriptions.push("## Available Tools\n".to_string());
        descriptions.push("You have access to the following tools:\n".to_string());

        let available_tools = self.filter_available_tools(context);

        for tool_schema in available_tools {
            descriptions.push(self.format_tool_description(&tool_schema));
        }

        descriptions.join("\n")
    }

    fn format_tool_description(&self, schema: &ToolSchema) -> String {
        let mut desc = format!("### {}\n", schema.name);
        desc.push_str(&format!("**Description:** {}\n", schema.description));

        if schema.dangerous {
            desc.push_str("⚠️  **This tool requires user approval before execution**\n");
        }

        desc.push_str(&format!("**Parameters:**\n```json\n{}\n```\n",
            serde_json::to_string_pretty(&schema.parameters).unwrap_or_default()));

        desc
    }

    fn filter_available_tools(&self, context: &TurnContext) -> Vec<&ToolSchema> {
        self.schemas
            .values()
            .filter(|schema| {
                // 根据上下文过滤可用工具
                self.is_tool_available(schema, context)
            })
            .collect()
    }

    fn is_tool_available(&self, schema: &ToolSchema, context: &TurnContext) -> bool {
        // 检查工具可用性：权限、平台支持、依赖等
        match schema.name.as_str() {
            "shell" => context.platform.supports_shell(),
            "apply_patch" => context.has_write_permissions(),
            "web_search" => context.network_policy.allows_web_search(),
            _ => true, // 默认可用
        }
    }
}
```

### 6.4.2 动态工具加载

对于 MCP 工具，Codex 支持运行时动态加载：

```rust
pub struct McpToolRegistry {
    servers: HashMap<String, McpServer>,
    dynamic_tools: HashMap<String, DynamicToolSchema>,
}

impl McpToolRegistry {
    pub async fn refresh_tools(&mut self) -> CodexResult<()> {
        for (server_name, server) in &mut self.servers {
            match server.list_tools().await {
                Ok(tools) => {
                    for tool in tools {
                        let schema = self.convert_mcp_to_schema(tool, server_name)?;
                        self.dynamic_tools.insert(schema.name.clone(), schema);
                    }
                },
                Err(e) => {
                    tracing::warn!("Failed to load tools from MCP server {}: {}", server_name, e);
                }
            }
        }
        Ok(())
    }

    fn convert_mcp_to_schema(&self, mcp_tool: McpTool, server_name: &str) -> CodexResult<DynamicToolSchema> {
        Ok(DynamicToolSchema {
            name: format!("mcp_{}_{}", server_name, mcp_tool.name),
            description: mcp_tool.description,
            parameters: mcp_tool.input_schema,
            server_name: server_name.to_string(),
            requires_approval: true, // MCP 工具默认需要审批
            dangerous: mcp_tool.is_dangerous(),
        })
    }

    pub fn generate_mcp_tools_description(&self) -> String {
        if self.dynamic_tools.is_empty() {
            return String::new();
        }

        let mut desc = Vec::new();
        desc.push("## MCP Tools\n".to_string());
        desc.push("Additional tools provided by MCP servers:\n".to_string());

        for (server_name, tools) in self.group_tools_by_server() {
            desc.push(format!("### From {}\n", server_name));
            for tool in tools {
                desc.push(format!("- **{}**: {}\n", tool.name, tool.description));
            }
        }

        desc.join("")
    }
}
```

## 6.5 AGENTS.md 机制

### 6.5.1 AGENTS.md 发现与加载

AGENTS.md 是 Codex 的一个创新特性，允许代码库作者为 Agent 提供特定的指令：

```rust
// codex-rs/core/src/instructions/mod.rs
pub struct AgentsInstructionsLoader {
    cache: HashMap<PathBuf, CachedInstructions>,
    watcher: FileWatcher,
}

#[derive(Debug, Clone)]
struct CachedInstructions {
    content: String,
    scope: InstructionScope,
    last_modified: SystemTime,
    checksum: String,
}

#[derive(Debug, Clone)]
pub enum InstructionScope {
    Repository,    // 仓库根目录的 AGENTS.md
    Directory,     // 特定目录的 AGENTS.md
    Project,       // 项目级别的 AGENTS.md
}

impl AgentsInstructionsLoader {
    pub async fn discover_instructions(&mut self, cwd: &Path) -> CodexResult<Vec<AgentInstruction>> {
        let mut instructions = Vec::new();
        let mut current_dir = Some(cwd);

        // 从当前目录向上遍历，收集所有 AGENTS.md
        while let Some(dir) = current_dir {
            let agents_file = dir.join("AGENTS.md");

            if agents_file.exists() {
                let instruction = self.load_instruction_file(&agents_file).await?;
                instructions.push(instruction);
            }

            current_dir = dir.parent();
        }

        // 按优先级排序：越深层的优先级越高
        instructions.reverse();
        Ok(instructions)
    }

    async fn load_instruction_file(&mut self, path: &Path) -> CodexResult<AgentInstruction> {
        let metadata = tokio::fs::metadata(path).await?;
        let last_modified = metadata.modified()?;

        // 检查缓存
        if let Some(cached) = self.cache.get(path) {
            if cached.last_modified == last_modified {
                return Ok(AgentInstruction::from_cached(cached));
            }
        }

        // 读取并解析文件
        let content = tokio::fs::read_to_string(path).await?;
        let checksum = self.calculate_checksum(&content);

        let instruction = AgentInstruction::parse(content.clone(), path)?;

        // 更新缓存
        self.cache.insert(path.to_path_buf(), CachedInstructions {
            content,
            scope: instruction.scope.clone(),
            last_modified,
            checksum,
        });

        Ok(instruction)
    }
}
```

### 6.5.2 指令优先级与合并

多个 AGENTS.md 文件需要按照作用域优先级合并：

```rust
#[derive(Debug, Clone)]
pub struct AgentInstruction {
    content: String,
    scope: InstructionScope,
    path: PathBuf,
    priority: u32,
}

impl AgentInstruction {
    pub fn parse(content: String, path: &Path) -> CodexResult<Self> {
        let scope = Self::determine_scope(path)?;
        let priority = Self::calculate_priority(&scope, path);

        Ok(Self {
            content,
            scope,
            path: path.to_path_buf(),
            priority,
        })
    }

    fn determine_scope(path: &Path) -> CodexResult<InstructionScope> {
        // 通过路径和内容确定作用域
        if Self::is_repository_root(path) {
            Ok(InstructionScope::Repository)
        } else if Self::is_project_directory(path) {
            Ok(InstructionScope::Project)
        } else {
            Ok(InstructionScope::Directory)
        }
    }

    fn calculate_priority(scope: &InstructionScope, path: &Path) -> u32 {
        let base_priority = match scope {
            InstructionScope::Repository => 100,
            InstructionScope::Project => 200,
            InstructionScope::Directory => 300,
        };

        // 目录深度越深，优先级越高
        let depth = path.ancestors().count() as u32;
        base_priority + depth
    }
}

pub struct InstructionMerger;

impl InstructionMerger {
    pub fn merge_instructions(instructions: Vec<AgentInstruction>) -> String {
        let mut sorted_instructions = instructions;
        sorted_instructions.sort_by_key(|inst| inst.priority);

        let mut merged = Vec::new();
        merged.push("# Repository Instructions\n".to_string());

        for instruction in sorted_instructions {
            merged.push(format!("## From {}\n", instruction.path.display()));
            merged.push(instruction.content);
            merged.push("\n---\n".to_string());
        }

        merged.join("\n")
    }
}
```

### 6.5.3 条件指令与上下文感知

AGENTS.md 支持条件指令，根据不同的上下文激活不同的规则：

```markdown
<!-- AGENTS.md 示例 -->
# Rust/codex-rs

<!-- 条件指令：仅在 Rust 项目中生效 -->
@if language=rust
- Crate names are prefixed with `codex-`
- Always inline format! args when possible
- Use method references over closures when possible
@endif

<!-- 条件指令：仅在测试环境中生效 -->
@if environment=test
- Never add or modify any code related to `CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR`
- Always collapse if statements per clippy rules
@endif

<!-- 条件指令：仅当有特定文件时生效 -->
@if exists=Cargo.toml
Run `just fmt` automatically after making Rust code changes
@endif
```

条件指令的解析和求值：

```rust
pub struct ConditionalInstructionParser;

impl ConditionalInstructionParser {
    pub fn parse_and_evaluate(content: &str, context: &TurnContext) -> String {
        let mut result = String::new();
        let mut lines = content.lines();
        let mut in_conditional = false;
        let mut current_condition: Option<Condition> = None;

        while let Some(line) = lines.next() {
            if line.trim().starts_with("@if ") {
                let condition = self.parse_condition(line)?;
                in_conditional = true;
                current_condition = Some(condition);
            } else if line.trim() == "@endif" {
                in_conditional = false;
                current_condition = None;
            } else if in_conditional {
                if let Some(ref condition) = current_condition {
                    if self.evaluate_condition(condition, context) {
                        result.push_str(line);
                        result.push('\n');
                    }
                }
            } else {
                result.push_str(line);
                result.push('\n');
            }
        }

        result
    }

    fn parse_condition(&self, line: &str) -> CodexResult<Condition> {
        let condition_str = line.strip_prefix("@if ").unwrap().trim();

        if let Some((key, value)) = condition_str.split_once('=') {
            Ok(Condition::Equals {
                key: key.trim().to_string(),
                value: value.trim().to_string(),
            })
        } else if condition_str.starts_with("exists=") {
            let path = condition_str.strip_prefix("exists=").unwrap();
            Ok(Condition::FileExists(path.to_string()))
        } else {
            Err(CodexErr::InvalidCondition(condition_str.to_string()))
        }
    }

    fn evaluate_condition(&self, condition: &Condition, context: &TurnContext) -> bool {
        match condition {
            Condition::Equals { key, value } => {
                match key.as_str() {
                    "language" => context.detected_language.as_deref() == Some(value),
                    "environment" => context.environment_type.as_deref() == Some(value),
                    "platform" => context.platform.name() == value,
                    _ => false,
                }
            },
            Condition::FileExists(path) => {
                context.cwd.join(path).exists()
            },
        }
    }
}

#[derive(Debug, Clone)]
enum Condition {
    Equals { key: String, value: String },
    FileExists(String),
}
```

## 6.6 Skills 系统

### 6.6.1 Skill 定义与加载

Skills 是 Codex 的另一个强大特性，允许用户定义可重用的 Agent 能力：

```rust
// codex-rs/core-skills/src/model.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub version: String,
    pub author: Option<String>,
    pub license: Option<String>,
    pub dependencies: Vec<SkillDependency>,
    pub content: SkillContent,
    pub metadata: SkillMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillContent {
    pub instructions: String,
    pub templates: HashMap<String, String>,
    pub examples: Vec<SkillExample>,
    pub resources: Vec<SkillResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillMetadata {
    pub tags: Vec<String>,
    pub category: String,
    pub min_codex_version: Option<String>,
    pub platforms: Vec<String>,
    pub dangerous: bool,
}
```

### 6.6.2 Skill 注入机制

Skills 通过注入机制将其内容添加到系统提示中：

```rust
// codex-rs/core-skills/src/injection.rs
pub struct SkillInjectionEngine {
    loaded_skills: HashMap<String, Skill>,
    injection_cache: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct SkillInjection {
    pub skill_name: String,
    pub injection_type: InjectionType,
    pub content: String,
    pub priority: u32,
}

#[derive(Debug, Clone)]
pub enum InjectionType {
    Instructions,     // 添加到指令部分
    Tools,           // 添加新工具定义
    Examples,        // 添加示例
    Context,         // 添加上下文信息
    Preamble,        // 添加到开头
    Postscript,      // 添加到结尾
}

impl SkillInjectionEngine {
    pub fn inject_skills(
        &mut self,
        base_prompt: &str,
        active_skills: &[String],
        context: &TurnContext,
    ) -> CodexResult<String> {
        let mut prompt = base_prompt.to_string();
        let mut injections = Vec::new();

        // 收集所有需要注入的内容
        for skill_name in active_skills {
            if let Some(skill) = self.loaded_skills.get(skill_name) {
                let skill_injections = self.generate_skill_injections(skill, context)?;
                injections.extend(skill_injections);
            }
        }

        // 按优先级和类型排序
        injections.sort_by_key(|inj| (inj.injection_type.priority(), inj.priority));

        // 执行注入
        for injection in injections {
            prompt = self.apply_injection(&prompt, &injection)?;
        }

        Ok(prompt)
    }

    fn generate_skill_injections(
        &self,
        skill: &Skill,
        context: &TurnContext,
    ) -> CodexResult<Vec<SkillInjection>> {
        let mut injections = Vec::new();

        // 基础指令注入
        injections.push(SkillInjection {
            skill_name: skill.name.clone(),
            injection_type: InjectionType::Instructions,
            content: skill.content.instructions.clone(),
            priority: 100,
        });

        // 模板注入
        for (template_name, template_content) in &skill.content.templates {
            let rendered = self.render_template(template_content, context)?;
            injections.push(SkillInjection {
                skill_name: skill.name.clone(),
                injection_type: InjectionType::Context,
                content: format!("## {} Template\n\n{}", template_name, rendered),
                priority: 200,
            });
        }

        // 示例注入
        if !skill.content.examples.is_empty() {
            let examples_content = self.format_examples(&skill.content.examples);
            injections.push(SkillInjection {
                skill_name: skill.name.clone(),
                injection_type: InjectionType::Examples,
                content: examples_content,
                priority: 300,
            });
        }

        Ok(injections)
    }

    fn apply_injection(&self, prompt: &str, injection: &SkillInjection) -> CodexResult<String> {
        match injection.injection_type {
            InjectionType::Preamble => {
                Ok(format!("{}\n\n{}", injection.content, prompt))
            },
            InjectionType::Postscript => {
                Ok(format!("{}\n\n{}", prompt, injection.content))
            },
            InjectionType::Instructions => {
                // 在指令部分插入
                self.insert_at_section(prompt, "# Instructions", &injection.content)
            },
            InjectionType::Tools => {
                // 在工具部分插入
                self.insert_at_section(prompt, "## Available Tools", &injection.content)
            },
            InjectionType::Examples => {
                // 在示例部分插入
                self.insert_at_section(prompt, "## Examples", &injection.content)
            },
            InjectionType::Context => {
                // 在上下文部分插入
                self.insert_at_section(prompt, "## Context", &injection.content)
            },
        }
    }
}
```

### 6.6.3 Skill 依赖解析

Skills 可以依赖其他 Skills 或外部资源：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDependency {
    pub name: String,
    pub version: Option<String>,
    pub source: DependencySource,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DependencySource {
    Local(PathBuf),          // 本地 Skill
    Git { url: String, branch: Option<String> }, // Git 仓库
    Registry(String),        // Skill 注册表
    Environment(String),     // 环境变量
}

pub struct SkillDependencyResolver {
    resolution_cache: HashMap<String, ResolvedDependency>,
}

impl SkillDependencyResolver {
    pub async fn resolve_dependencies(
        &mut self,
        skill: &Skill,
    ) -> CodexResult<Vec<ResolvedDependency>> {
        let mut resolved = Vec::new();

        for dep in &skill.dependencies {
            if let Some(cached) = self.resolution_cache.get(&dep.name) {
                resolved.push(cached.clone());
                continue;
            }

            let resolved_dep = match &dep.source {
                DependencySource::Local(path) => {
                    self.resolve_local_dependency(dep, path).await?
                },
                DependencySource::Git { url, branch } => {
                    self.resolve_git_dependency(dep, url, branch.as_deref()).await?
                },
                DependencySource::Environment(env_var) => {
                    self.resolve_environment_dependency(dep, env_var).await?
                },
                DependencySource::Registry(registry_name) => {
                    self.resolve_registry_dependency(dep, registry_name).await?
                },
            };

            self.resolution_cache.insert(dep.name.clone(), resolved_dep.clone());
            resolved.push(resolved_dep);
        }

        Ok(resolved)
    }

    async fn resolve_environment_dependency(
        &self,
        dep: &SkillDependency,
        env_var: &str,
    ) -> CodexResult<ResolvedDependency> {
        match std::env::var(env_var) {
            Ok(value) => {
                Ok(ResolvedDependency::Environment {
                    name: dep.name.clone(),
                    value,
                })
            },
            Err(_) if !dep.required => {
                Ok(ResolvedDependency::Missing {
                    name: dep.name.clone(),
                    optional: true,
                })
            },
            Err(_) => {
                Err(CodexErr::MissingDependency {
                    skill: dep.name.clone(),
                    dependency: env_var.to_string(),
                })
            }
        }
    }
}
```

## 6.7 Memory 上下文集成

### 6.7.1 Memory System 接口

Codex 的 Memory 系统会为当前 Turn 提供相关的历史上下文：

```rust
// codex-rs/core/src/memories/mod.rs
pub struct MemoryManager {
    phase1_store: Phase1MemoryStore,
    phase2_store: Phase2MemoryStore,
    context_builder: MemoryContextBuilder,
}

impl MemoryManager {
    pub async fn build_memory_context(
        &self,
        turn_context: &TurnContext,
    ) -> CodexResult<Option<String>> {
        // Phase 1: 获取相关的原始记忆
        let raw_memories = self.phase1_store
            .query_relevant_memories(turn_context)
            .await?;

        if raw_memories.is_empty() {
            return Ok(None);
        }

        // Phase 2: 获取整合的记忆摘要
        let consolidated_memories = self.phase2_store
            .get_consolidated_memories(turn_context)
            .await?;

        // 构建上下文
        let context = self.context_builder.build_context(
            &raw_memories,
            &consolidated_memories,
            turn_context,
        ).await?;

        Ok(Some(context))
    }
}

pub struct MemoryContextBuilder;

impl MemoryContextBuilder {
    pub async fn build_context(
        &self,
        raw_memories: &[RawMemory],
        consolidated: &[ConsolidatedMemory],
        turn_context: &TurnContext,
    ) -> CodexResult<String> {
        let mut context = Vec::new();

        context.push("## Relevant Memory Context\n".to_string());

        // 添加整合记忆
        if !consolidated.is_empty() {
            context.push("### Key Insights\n".to_string());
            for memory in consolidated {
                context.push(format!("- {}\n", memory.summary));
            }
        }

        // 添加相关的原始记忆片段
        if !raw_memories.is_empty() {
            context.push("\n### Recent Relevant Activities\n".to_string());
            for memory in raw_memories.iter().take(5) { // 限制数量
                context.push(format!("- **{}**: {}\n",
                    memory.rollout_slug.as_deref().unwrap_or("Session"),
                    Self::truncate_memory(&memory.content, 200)));
            }
        }

        Ok(context.join(""))
    }

    fn truncate_memory(content: &str, max_chars: usize) -> String {
        if content.len() <= max_chars {
            content.to_string()
        } else {
            format!("{}...", &content[..max_chars])
        }
    }
}
```

### 6.7.2 记忆检索与排序

记忆系统使用语义相似性和时间权重来检索相关上下文：

```rust
impl Phase1MemoryStore {
    async fn query_relevant_memories(
        &self,
        turn_context: &TurnContext,
    ) -> CodexResult<Vec<RawMemory>> {
        // 构建查询向量
        let query_embedding = self.embedding_service
            .encode_query(turn_context)
            .await?;

        // 语义搜索
        let semantic_matches = self.vector_store
            .similarity_search(&query_embedding, 20)
            .await?;

        // 时间过滤
        let time_filtered = self.filter_by_time_relevance(
            semantic_matches,
            turn_context.current_time,
        );

        // 相关性排序
        let ranked = self.rank_by_relevance(time_filtered, turn_context);

        Ok(ranked.into_iter().take(10).collect())
    }

    fn rank_by_relevance(
        &self,
        memories: Vec<RawMemory>,
        context: &TurnContext,
    ) -> Vec<RawMemory> {
        let mut scored_memories: Vec<(f32, RawMemory)> = memories
            .into_iter()
            .map(|memory| {
                let score = self.calculate_relevance_score(&memory, context);
                (score, memory)
            })
            .collect();

        scored_memories.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        scored_memories.into_iter().map(|(_, memory)| memory).collect()
    }

    fn calculate_relevance_score(&self, memory: &RawMemory, context: &TurnContext) -> f32 {
        let mut score = memory.semantic_similarity; // 基础语义分数

        // 时间衰减
        let age_hours = context.current_time
            .signed_duration_since(memory.created_at)
            .num_hours() as f32;
        let time_decay = (-age_hours / 168.0).exp(); // 一周衰减
        score *= time_decay;

        // 项目相关性加权
        if memory.project_context.as_ref() == Some(&context.project_name) {
            score *= 1.5;
        }

        // 文件相关性加权
        if let Some(files) = &memory.involved_files {
            let current_files: HashSet<_> = context.modified_files.iter().collect();
            let memory_files: HashSet<_> = files.iter().collect();
            let overlap = current_files.intersection(&memory_files).count() as f32;
            let union = current_files.union(&memory_files).count() as f32;
            if union > 0.0 {
                score *= 1.0 + (overlap / union);
            }
        }

        score
    }
}
```

## 6.8 用户配置与覆盖

### 6.8.1 配置层级系统

Codex 支持多层级的配置，允许用户在不同层级覆盖默认行为：

```rust
// codex-rs/core/src/config/mod.rs
#[derive(Debug, Clone)]
pub struct ConfigLayerStack {
    layers: Vec<ConfigLayer>,
}

#[derive(Debug, Clone)]
pub struct ConfigLayer {
    source: ConfigSource,
    config: ConfigToml,
    priority: u32,
}

#[derive(Debug, Clone)]
pub enum ConfigSource {
    Default,                    // 内置默认配置
    System(PathBuf),           // 系统级配置 (/etc/codex/config.toml)
    User(PathBuf),             // 用户级配置 (~/.codex/config.toml)
    Project(PathBuf),          // 项目级配置 (.codex/config.toml)
    Environment,               // 环境变量
    CommandLine,               // 命令行参数
}

impl ConfigLayerStack {
    pub fn load_all_layers(cwd: &Path) -> CodexResult<Self> {
        let mut layers = Vec::new();

        // 按优先级顺序加载
        layers.push(Self::load_default_config());
        layers.extend(Self::discover_system_configs()?);
        layers.extend(Self::discover_user_configs()?);
        layers.extend(Self::discover_project_configs(cwd)?);
        layers.push(Self::load_environment_config());

        Ok(Self { layers })
    }

    pub fn merge_prompt_configuration(&self) -> PromptConfig {
        let mut config = PromptConfig::default();

        // 按优先级合并配置
        for layer in &self.layers {
            if let Some(prompt_config) = &layer.config.prompt {
                config = config.merge(prompt_config);
            }
        }

        config
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptConfig {
    pub custom_instructions: Option<String>,
    pub personality_override: Option<String>,
    pub skill_preferences: SkillPreferences,
    pub memory_settings: MemorySettings,
    pub agent_instructions_enabled: bool,
}

impl PromptConfig {
    fn merge(mut self, other: &PromptConfig) -> Self {
        // 后加载的配置覆盖先加载的配置
        if other.custom_instructions.is_some() {
            self.custom_instructions = other.custom_instructions.clone();
        }
        if other.personality_override.is_some() {
            self.personality_override = other.personality_override.clone();
        }
        self.skill_preferences = self.skill_preferences.merge(&other.skill_preferences);
        self.memory_settings = self.memory_settings.merge(&other.memory_settings);
        if other.agent_instructions_enabled != self.agent_instructions_enabled {
            self.agent_instructions_enabled = other.agent_instructions_enabled;
        }
        self
    }
}
```

### 6.8.2 动态配置应用

配置可以在运行时动态应用到系统提示中：

```rust
impl PromptBuilder {
    pub fn apply_user_configuration(
        &mut self,
        mut prompt: String,
        config: &PromptConfig,
    ) -> CodexResult<String> {
        // 应用自定义指令
        if let Some(custom_instructions) = &config.custom_instructions {
            prompt = self.inject_custom_instructions(prompt, custom_instructions)?;
        }

        // 应用个性覆盖
        if let Some(personality) = &config.personality_override {
            prompt = self.apply_personality_override(prompt, personality)?;
        }

        // 应用 Skill 偏好
        prompt = self.apply_skill_preferences(prompt, &config.skill_preferences)?;

        // 应用记忆设置
        if !config.memory_settings.enabled {
            prompt = self.remove_memory_sections(prompt)?;
        }

        Ok(prompt)
    }

    fn inject_custom_instructions(
        &self,
        prompt: String,
        instructions: &str,
    ) -> CodexResult<String> {
        // 在适当的位置注入用户指令
        let injection_point = self.find_instructions_section(&prompt)
            .unwrap_or_else(|| prompt.len());

        let mut result = prompt;
        result.insert_str(injection_point, &format!(
            "\n\n## Additional User Instructions\n\n{}\n\n",
            instructions
        ));

        Ok(result)
    }

    fn apply_personality_override(
        &self,
        prompt: String,
        personality: &str,
    ) -> CodexResult<String> {
        // 替换默认的个性描述
        let default_personality = "Your default personality and tone is concise, direct, and friendly.";

        Ok(prompt.replace(default_personality, &format!(
            "Your personality and tone should be: {}.",
            personality
        )))
    }
}
```

## 6.9 完整的提示构建流程

### 6.9.1 提示构建管道

所有组件最终通过提示构建管道协调工作：

```rust
pub struct SystemPromptPipeline {
    base_instructions: BaseInstructions,
    environment_collector: EnvironmentContextCollector,
    tools_registry: ToolRegistry,
    agents_loader: AgentsInstructionsLoader,
    skills_engine: SkillInjectionEngine,
    memory_manager: MemoryManager,
    config_stack: ConfigLayerStack,
}

impl SystemPromptPipeline {
    pub async fn build_system_prompt(
        &mut self,
        turn_context: &TurnContext,
    ) -> CodexResult<String> {
        // 1. 加载基础指令
        let mut prompt = self.base_instructions.content.clone();

        // 2. 收集环境上下文
        let env_context = self.environment_collector
            .collect_current_context()
            .await?;

        // 3. 生成工具描述
        let tools_description = self.tools_registry
            .generate_tools_description(turn_context);

        // 4. 加载 AGENTS.md 指令
        let agents_instructions = self.agents_loader
            .discover_and_merge_instructions(&turn_context.cwd)
            .await?;

        // 5. 应用 Skills
        let active_skills = self.determine_active_skills(turn_context)?;
        prompt = self.skills_engine.inject_skills(
            &prompt,
            &active_skills,
            turn_context,
        )?;

        // 6. 添加记忆上下文
        if let Some(memory_context) = self.memory_manager
            .build_memory_context(turn_context)
            .await? {
            prompt = self.inject_memory_context(prompt, &memory_context)?;
        }

        // 7. 应用用户配置
        let config = self.config_stack.merge_prompt_configuration();
        prompt = self.apply_user_configuration(prompt, &config)?;

        // 8. 执行最终替换
        prompt = self.perform_final_substitutions(
            prompt,
            &env_context,
            &tools_description,
            &agents_instructions,
        )?;

        // 9. 验证和优化
        self.validate_and_optimize_prompt(&prompt)?;

        Ok(prompt)
    }

    fn perform_final_substitutions(
        &self,
        mut prompt: String,
        env_context: &EnvironmentContext,
        tools_description: &str,
        agents_instructions: &str,
    ) -> CodexResult<String> {
        // 替换占位符
        prompt = prompt.replace(
            "{ENVIRONMENT_CONTEXT}",
            &env_context.render_to_prompt(),
        );
        prompt = prompt.replace("{TOOLS_DESCRIPTION}", tools_description);
        prompt = prompt.replace("{AGENTS_INSTRUCTIONS}", agents_instructions);

        // 清理多余的空行和格式
        prompt = self.clean_prompt_formatting(&prompt);

        Ok(prompt)
    }

    fn validate_and_optimize_prompt(&self, prompt: &str) -> CodexResult<()> {
        // 检查提示长度
        let token_count = self.estimate_token_count(prompt);
        if token_count > MAX_SYSTEM_PROMPT_TOKENS {
            return Err(CodexErr::PromptTooLong {
                actual: token_count,
                max: MAX_SYSTEM_PROMPT_TOKENS,
            });
        }

        // 检查必需的部分
        self.validate_required_sections(prompt)?;

        // 检查冲突指令
        self.detect_conflicting_instructions(prompt)?;

        Ok(())
    }
}

const MAX_SYSTEM_PROMPT_TOKENS: usize = 8192; // 系统提示最大长度限制
```

### 6.9.2 提示缓存与优化

为了提高性能，Codex 实现了提示缓存机制：

```rust
pub struct PromptCache {
    cache: HashMap<PromptCacheKey, CachedPrompt>,
    max_size: usize,
    hit_count: Arc<AtomicU64>,
    miss_count: Arc<AtomicU64>,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct PromptCacheKey {
    base_version: String,
    env_hash: String,
    tools_hash: String,
    config_hash: String,
    skills_hash: String,
}

#[derive(Debug, Clone)]
struct CachedPrompt {
    content: String,
    created_at: Instant,
    access_count: usize,
    dependencies: Vec<String>,
}

impl PromptCache {
    pub fn get_or_build<F>(
        &mut self,
        key: PromptCacheKey,
        builder: F,
    ) -> CodexResult<String>
    where
        F: FnOnce() -> CodexResult<String>,
    {
        if let Some(cached) = self.cache.get_mut(&key) {
            cached.access_count += 1;
            self.hit_count.fetch_add(1, Ordering::Relaxed);
            return Ok(cached.content.clone());
        }

        self.miss_count.fetch_add(1, Ordering::Relaxed);

        let content = builder()?;
        let cached_prompt = CachedPrompt {
            content: content.clone(),
            created_at: Instant::now(),
            access_count: 1,
            dependencies: Vec::new(),
        };

        // LRU 清理
        if self.cache.len() >= self.max_size {
            self.evict_least_recently_used();
        }

        self.cache.insert(key, cached_prompt);
        Ok(content)
    }
}
```

## 6.10 总结与设计洞察

### 6.10.1 核心设计原则

OpenAI Codex CLI 的 System Prompt 系统体现了以下设计原则：

1. **可组合性**：模块化的提示组件可以灵活组合
2. **上下文感知**：动态注入环境和任务相关信息
3. **可扩展性**：通过 Skills 和 AGENTS.md 支持扩展
4. **一致性**：统一的构建流程确保提示质量
5. **性能优化**：缓存机制减少重复构建开销

### 6.10.2 架构优势分析

| 优势 | 实现方式 | 效果 |
|------|----------|------|
| **动态适应** | 环境上下文自动收集 | Agent 了解当前状态 |
| **知识注入** | Memory 系统集成 | 利用历史经验 |
| **行为定制** | Skills + AGENTS.md | 领域特化能力 |
| **配置灵活** | 多层配置系统 | 满足不同需求 |
| **性能优化** | 提示缓存机制 | 减少计算开销 |

### 6.10.3 与其他系统对比

| 维度 | Codex CLI | Claude Code | 传统 Chatbot |
|------|-----------|-------------|--------------|
| **提示复杂度** | 高度模块化 | 相对简单 | 静态模板 |
| **上下文感知** | 深度集成 | 基础支持 | 无 |
| **扩展性** | Skills + AGENTS.md | 有限 | 无 |
| **配置能力** | 多层配置 | 基础配置 | 固定 |
| **性能优化** | 缓存 + 增量 | 基础缓存 | 无 |

### 6.10.4 速查表

| 组件 | 文件路径 | 核心功能 | 关键接口 |
|------|----------|----------|----------|
| **基础提示** | `prompt.md` | 基础行为定义 | `BaseInstructions::load()` |
| **环境上下文** | `environment_context.rs` | 动态环境信息 | `collect_current_context()` |
| **工具注册** | `tools/registry.rs` | 工具描述生成 | `generate_tools_description()` |
| **AGENTS.md** | `instructions/mod.rs` | 仓库级指令 | `discover_instructions()` |
| **Skills 引擎** | `core-skills/injection.rs` | 技能注入 | `inject_skills()` |
| **记忆集成** | `memories/mod.rs` | 历史上下文 | `build_memory_context()` |
| **配置系统** | `config/mod.rs` | 多层配置 | `merge_prompt_configuration()` |

### 6.10.5 最佳实践

1. **AGENTS.md 编写**：
   - 使用条件指令适应不同上下文
   - 按优先级组织指令
   - 避免冲突的指令

2. **Skills 开发**：
   - 模块化设计，单一职责
   - 明确依赖关系
   - 提供详细的示例

3. **配置管理**：
   - 合理使用配置层级
   - 避免过度复杂的覆盖
   - 文档化配置选项

4. **性能优化**：
   - 利用提示缓存
   - 控制提示长度
   - 定期清理无用组件

Codex 的 System Prompt 系统是一个高度工程化的解决方案，它成功地解决了大型 AI Agent 系统中提示管理的复杂性问题。这个架构为构建可扩展、可维护的 Agent 系统提供了重要的参考价值。