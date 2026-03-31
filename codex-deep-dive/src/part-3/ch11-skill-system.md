# 第 11 章：Skill 系统 — 可插拔的能力扩展

> **核心问题**：AI Agent 如何获得持续进化的能力？当面对千变万化的业务需求时，如何让 AI 系统具备动态扩展的智能？Codex 的 Skill 系统如何实现从静态工具集到动态能力生态的转变？

在 AI Agent 的世界里，Skill 系统代表了一种全新的能力扩展范式。它不同于传统的工具系统——工具提供具体的执行能力，而 Skill 提供的是知识、经验和智慧的注入。OpenAI Codex CLI 的 Skill 系统是一个精密设计的能力生态，它允许用户、开发者甚至 AI 自身创建、分享和演化各种专业技能，为 AI Agent 提供了无限的成长可能性。

## 11.1 Skill 系统架构概览

### 11.1.1 Skill 系统的设计哲学

Skill 系统基于一个核心理念：**AI 的能力不应该局限于预定义的工具集，而应该能够通过知识注入的方式持续扩展**。

```
传统工具系统                    Skill 系统
┌─────────────────┐            ┌─────────────────┐
│     固定工具     │            │   动态知识库    │
│   shell, read   │     vs.    │ 领域专业知识    │
│   write, grep   │            │   经验模式      │
│   ...           │            │   最佳实践      │
└─────────────────┘            └─────────────────┘
        │                              │
        ▼                              ▼
┌─────────────────┐            ┌─────────────────┐
│   执行具体操作   │            │   增强推理能力   │
│   机械式处理     │            │   情境化决策     │
└─────────────────┘            └─────────────────┘
```

### 11.1.2 Skill 系统核心组件

```
Skill 系统架构
├── 管理层 (Manager Layer)
│   ├── SkillsManager          # 技能生命周期管理
│   ├── SkillCache            # 缓存和性能优化
│   └── ConfigRules           # 配置规则引擎
├── 加载层 (Loader Layer)
│   ├── SkillLoader           # 技能加载器
│   ├── SystemSkills          # 系统内置技能
│   └── UserSkills            # 用户自定义技能
├── 模型层 (Model Layer)
│   ├── SkillMetadata         # 技能元数据
│   ├── SkillInterface        # 用户界面定义
│   ├── SkillDependencies     # 依赖管理
│   └── SkillPolicy           # 策略控制
├── 注入层 (Injection Layer)
│   ├── SkillInjections       # 提示注入
│   ├── ExplicitMentions      # 显式引用
│   └── ImplicitInvocation    # 隐式调用
└── 运行时层 (Runtime Layer)
    ├── SkillWatcher          # 变更监控
    ├── AnalyticsClient       # 使用分析
    └── TelemetryIntegration  # 遥测集成
```

### 11.1.3 Skill 文件格式

每个 Skill 都是一个标准化的 Markdown 文件，采用 YAML frontmatter + Markdown 内容的格式：

```markdown
---
name: skill-name
description: 技能的简要描述
metadata:
  short-description: 更短的描述
---

# 技能标题

## 技能内容

这里是技能的具体指导内容，包括：
- 使用场景和时机
- 执行步骤和最佳实践
- 示例代码和命令
- 常见问题和解决方案
```

## 11.2 技能管理器 (SkillsManager)

### 11.2.1 SkillsManager 核心设计

`SkillsManager` 是整个 Skill 系统的控制中心：

```rust
// 来源：codex-rs/core-skills/src/manager.rs
pub struct SkillsManager {
    codex_home: PathBuf,                                              // Codex 主目录
    restriction_product: Option<Product>,                             // 产品限制
    cache_by_cwd: RwLock<HashMap<PathBuf, SkillLoadOutcome>>,        // 按工作目录缓存
    cache_by_config: RwLock<HashMap<ConfigSkillsCacheKey, SkillLoadOutcome>>, // 按配置缓存
}

#[derive(Debug, Clone)]
pub struct SkillsLoadInput {
    pub cwd: PathBuf,                                    // 当前工作目录
    pub effective_skill_roots: Vec<PathBuf>,             // 有效的技能根目录
    pub config_layer_stack: ConfigLayerStack,           // 配置层堆栈
    pub bundled_skills_enabled: bool,                    // 是否启用内置技能
}
```

#### 双重缓存策略

SkillsManager 采用了**双重缓存策略**来优化性能：

| 缓存类型 | 缓存键 | 用途 | 优势 |
|---------|--------|------|------|
| **CWD 缓存** | `PathBuf` (工作目录) | 简单场景快速查找 | 速度快，适用于大多数情况 |
| **配置缓存** | `ConfigSkillsCacheKey` | 复杂配置精确匹配 | 防止配置泄露，支持会话隔离 |

```rust
// 来源：codex-rs/core-skills/src/manager.rs
impl SkillsManager {
    /// 基于配置加载技能，避免额外的配置层加载
    /// 使用基于有效技能相关配置状态的缓存键，而不仅仅是工作目录
    pub fn skills_for_config(&self, input: &SkillsLoadInput) -> SkillLoadOutcome {
        let roots = self.skill_roots_for_config(input);
        let skill_config_rules = skill_config_rules_from_stack(&input.config_layer_stack);
        let cache_key = config_skills_cache_key(&roots, &skill_config_rules);

        // 检查配置缓存
        if let Some(outcome) = self.cached_outcome_for_config(&cache_key) {
            return outcome;
        }

        // 构建新的技能结果
        let outcome = self.build_skill_outcome(roots, &skill_config_rules);

        // 更新缓存
        let mut cache = self.cache_by_config.write().unwrap();
        cache.insert(cache_key, outcome.clone());
        outcome
    }
}
```

### 11.2.2 技能根目录发现

SkillsManager 使用分层的技能根目录发现策略：

```rust
// 来源：codex-rs/core-skills/src/loader.rs
pub fn skill_roots(
    cwd: &Path,
    config_layer_stack: &ConfigLayerStack,
    bundled_skills_enabled: bool,
) -> Vec<SkillRoot> {
    let mut roots = Vec::new();

    // 1. 系统技能根目录 (如果启用)
    if bundled_skills_enabled {
        let system_root = system_cache_root_dir(&codex_home);
        if system_root.exists() {
            roots.push(SkillRoot::System(system_root));
        }
    }

    // 2. 用户全局技能目录
    if let Some(home) = home_dir() {
        let user_skills_dir = home.join(".codex").join("skills");
        if user_skills_dir.exists() {
            roots.push(SkillRoot::User(user_skills_dir));
        }
    }

    // 3. 项目级技能目录
    let project_roots = find_project_skill_roots(cwd);
    for root in project_roots {
        roots.push(SkillRoot::Project(root));
    }

    // 4. 配置层指定的技能目录
    let config_roots = extract_skill_roots_from_config(config_layer_stack);
    for root in config_roots {
        roots.push(SkillRoot::Config(root));
    }

    roots
}
```

#### 技能根目录优先级

```
优先级 (高 → 低)
┌─────────────────┐
│   Config 层      │  ← 最高：配置文件指定
└─────────────────┘
          │
┌─────────────────┐
│   Project 层     │  ← 项目级 .codex/skills
└─────────────────┘
          │
┌─────────────────┐
│   User 层        │  ← 用户级 ~/.codex/skills
└─────────────────┘
          │
┌─────────────────┐
│   System 层      │  ← 最低：内置系统技能
└─────────────────┘
```

### 11.2.3 缓存失效与刷新机制

```rust
// 来源：codex-rs/core-skills/src/manager.rs
impl SkillsManager {
    /// 清理特定工作目录的缓存
    pub fn invalidate_cache_for_cwd(&self, cwd: &Path) {
        let mut cache = self.cache_by_cwd.write().unwrap();
        cache.remove(cwd);
    }

    /// 清理所有缓存
    pub fn invalidate_all_caches(&self) {
        {
            let mut cache = self.cache_by_cwd.write().unwrap();
            cache.clear();
        }
        {
            let mut cache = self.cache_by_config.write().unwrap();
            cache.clear();
        }
    }

    /// 检查缓存是否需要刷新
    fn is_cache_stale(&self, cache_key: &ConfigSkillsCacheKey) -> bool {
        // 检查技能文件的修改时间
        for root in &cache_key.roots {
            if let Ok(metadata) = std::fs::metadata(root) {
                if let Ok(modified) = metadata.modified() {
                    if modified > cache_key.last_modified {
                        return true;
                    }
                }
            }
        }
        false
    }
}
```

## 11.3 技能加载器 (SkillLoader)

### 11.3.1 技能发现算法

技能加载器使用**广度优先搜索**算法遍历技能目录：

```rust
// 来源：codex-rs/core-skills/src/loader.rs
pub fn load_skills_from_roots(
    roots: Vec<SkillRoot>,
    config_rules: &SkillConfigRules,
) -> SkillLoadOutcome {
    let mut outcome = SkillLoadOutcome::default();
    let mut skill_paths_seen = HashSet::new();

    for root in roots {
        let root_path = root.path();
        let mut queue = VecDeque::new();
        queue.push_back(root_path.clone());

        while let Some(current_dir) = queue.pop_front() {
            if let Ok(entries) = fs::read_dir(&current_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();

                    if path.is_dir() {
                        // 递归搜索子目录
                        queue.push_back(path);
                    } else if path.file_name() == Some(OsStr::new("SKILL.md")) {
                        // 发现技能文件
                        if skill_paths_seen.insert(path.clone()) {
                            match load_single_skill(&path, &root) {
                                Ok(skill) => {
                                    if config_rules.is_skill_enabled(&skill) {
                                        outcome.skills.push(skill);
                                    } else {
                                        outcome.disabled_paths.insert(path);
                                    }
                                }
                                Err(error) => {
                                    outcome.errors.push(SkillError {
                                        path,
                                        message: error.to_string(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 构建隐式调用索引
    outcome.implicit_skills_by_scripts_dir = Arc::new(
        build_implicit_skill_path_indexes(&outcome.skills)
    );

    outcome
}
```

### 11.3.2 技能文件解析

技能文件解析采用**分层解析**策略：

```rust
// 来源：codex-rs/core-skills/src/loader.rs
fn load_single_skill(skill_path: &Path, root: &SkillRoot) -> Result<SkillMetadata, SkillError> {
    let content = fs::read_to_string(skill_path)?;

    // 1. 解析 YAML frontmatter
    let (frontmatter, markdown_content) = parse_frontmatter(&content)?;

    // 2. 解析技能元数据文件 (skill.toml)
    let metadata_file_path = skill_path.parent()
        .unwrap()
        .join("skill.toml");
    let metadata_file = if metadata_file_path.exists() {
        Some(parse_skill_metadata_file(&metadata_file_path)?)
    } else {
        None
    };

    // 3. 合并解析结果
    let skill = SkillMetadata {
        name: frontmatter.name
            .or_else(|| infer_skill_name_from_path(skill_path))
            .ok_or("Skill name is required")?,
        description: frontmatter.description
            .unwrap_or_else(|| "No description provided".to_string()),
        short_description: frontmatter.metadata.short_description
            .or_else(|| metadata_file.as_ref()
                .and_then(|m| m.interface.as_ref())
                .and_then(|i| i.short_description.clone())),
        interface: metadata_file.as_ref().and_then(|m| m.interface.clone()),
        dependencies: metadata_file.as_ref().and_then(|m| m.dependencies.clone()),
        policy: metadata_file.as_ref().and_then(|m| m.policy.clone()),
        path_to_skills_md: skill_path.to_path_buf(),
        scope: infer_skill_scope(skill_path, root),
    };

    Ok(skill)
}
```

#### 技能文件结构

```
skill-directory/
├── SKILL.md              # 主要技能内容 (必需)
├── skill.toml             # 元数据配置 (可选)
├── scripts/               # 相关脚本 (可选)
├── references/            # 参考文档 (可选)
└── examples/              # 示例代码 (可选)
```

### 11.3.3 技能作用域推断

```rust
// 来源：codex-rs/core-skills/src/loader.rs
fn infer_skill_scope(skill_path: &Path, root: &SkillRoot) -> SkillScope {
    match root {
        SkillRoot::System(_) => SkillScope::System,
        SkillRoot::User(_) => SkillScope::User,
        SkillRoot::Project(_) => SkillScope::Project,
        SkillRoot::Config(_) => {
            // 配置指定的技能根据路径位置推断作用域
            if skill_path.ancestors().any(|p| p.ends_with(".codex")) {
                SkillScope::Project
            } else {
                SkillScope::User
            }
        }
    }
}
```

## 11.4 技能模型与元数据

### 11.4.1 SkillMetadata 数据结构

```rust
// 来源：codex-rs/core-skills/src/model.rs
#[derive(Debug, Clone, PartialEq)]
pub struct SkillMetadata {
    pub name: String,                           // 技能名称
    pub description: String,                    // 详细描述
    pub short_description: Option<String>,      // 简短描述
    pub interface: Option<SkillInterface>,      // 用户界面定义
    pub dependencies: Option<SkillDependencies>, // 依赖声明
    pub policy: Option<SkillPolicy>,            // 策略控制
    pub path_to_skills_md: PathBuf,             // 技能文件路径
    pub scope: SkillScope,                      // 作用域
}

impl SkillMetadata {
    /// 检查技能是否允许隐式调用
    fn allow_implicit_invocation(&self) -> bool {
        self.policy
            .as_ref()
            .and_then(|policy| policy.allow_implicit_invocation)
            .unwrap_or(true) // 默认允许隐式调用
    }

    /// 检查技能是否匹配产品限制
    pub fn matches_product_restriction_for_product(
        &self,
        restriction_product: Option<Product>,
    ) -> bool {
        match &self.policy {
            Some(policy) => {
                policy.products.is_empty() // 无产品限制
                    || restriction_product.is_some_and(|product| {
                        product.matches_product_restriction(&policy.products)
                    })
            }
            None => true, // 无策略时默认匹配
        }
    }
}
```

### 11.4.2 技能界面定义

```rust
// 来源：codex-rs/core-skills/src/model.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillInterface {
    pub display_name: Option<String>,       // 显示名称
    pub short_description: Option<String>,  // 简短描述
    pub icon_small: Option<PathBuf>,        // 小图标路径
    pub icon_large: Option<PathBuf>,        // 大图标路径
    pub brand_color: Option<String>,        // 品牌色 (HEX)
    pub default_prompt: Option<String>,     // 默认提示语
}
```

#### 技能界面配置示例

```toml
# skill.toml
[interface]
display_name = "PR 保姆"
short_description = "自动监控和处理 GitHub PR 的状态"
icon_small = "icons/pr-babysitter-16.png"
icon_large = "icons/pr-babysitter-64.png"
brand_color = "#28a745"
default_prompt = "请监控当前分支的 PR，处理 CI 失败和评审意见"
```

### 11.4.3 技能依赖管理

```rust
// 来源：codex-rs/core-skills/src/model.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillDependencies {
    pub tools: Vec<SkillToolDependency>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillToolDependency {
    pub r#type: String,                     // 依赖类型
    pub value: String,                      // 依赖值
    pub description: Option<String>,        // 描述
    pub transport: Option<String>,          // 传输方式
    pub command: Option<String>,            // 命令
    pub url: Option<String>,                // URL
}
```

#### 依赖类型表

| 依赖类型 | 描述 | 示例值 |
|---------|------|--------|
| `binary` | 可执行文件 | `gh`, `python3`, `node` |
| `python-package` | Python 包 | `requests`, `pandas` |
| `npm-package` | NPM 包 | `typescript`, `eslint` |
| `environment` | 环境变量 | `GITHUB_TOKEN`, `API_KEY` |
| `service` | 外部服务 | `github-api`, `slack-webhook` |

### 11.4.4 技能策略控制

```rust
// 来源：codex-rs/core-skills/src/model.rs
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SkillPolicy {
    pub allow_implicit_invocation: Option<bool>,    // 是否允许隐式调用
    pub products: Vec<Product>,                     // 产品限制
}
```

#### 策略配置示例

```toml
# skill.toml
[policy]
allow_implicit_invocation = false  # 仅显式调用
products = ["Codex"]               # 仅限 Codex 产品

[dependencies]
[[dependencies.tools]]
type = "binary"
value = "gh"
description = "GitHub CLI tool"
transport = "PATH"

[[dependencies.tools]]
type = "environment"
value = "GITHUB_TOKEN"
description = "GitHub API access token"
```

## 11.5 技能注入机制

### 11.5.1 技能注入流程

技能注入是 Skill 系统的核心功能，它将技能内容注入到 AI 模型的上下文中：

```rust
// 来源：codex-rs/core-skills/src/injection.rs
pub async fn build_skill_injections(
    mentioned_skills: &[SkillMetadata],
    otel: Option<&SessionTelemetry>,
    analytics_client: &AnalyticsEventsClient,
    tracking: TrackEventsContext,
) -> SkillInjections {
    if mentioned_skills.is_empty() {
        return SkillInjections::default();
    }

    let mut result = SkillInjections {
        items: Vec::with_capacity(mentioned_skills.len()),
        warnings: Vec::new(),
    };
    let mut invocations = Vec::new();

    for skill in mentioned_skills {
        match fs::read_to_string(&skill.path_to_skills_md).await {
            Ok(contents) => {
                // 发射成功指标
                emit_skill_injected_metric(otel, skill, "ok");

                // 记录调用
                invocations.push(SkillInvocation {
                    skill_name: skill.name.clone(),
                    skill_scope: skill.scope,
                    skill_path: skill.path_to_skills_md.clone(),
                    invocation_type: InvocationType::Explicit,
                });

                // 创建技能指令项
                result.items.push(ResponseItem::from(SkillInstructions {
                    name: skill.name.clone(),
                    path: skill.path_to_skills_md.to_string_lossy().into_owned(),
                    contents,
                }));
            }
            Err(err) => {
                // 发射错误指标
                emit_skill_injected_metric(otel, skill, "error");

                let message = format!(
                    "Failed to load skill {name} at {path}: {err:#}",
                    name = skill.name,
                    path = skill.path_to_skills_md.display()
                );
                result.warnings.push(message);
            }
        }
    }

    // 提交分析事件
    analytics_client.track_skill_invocations(tracking, invocations);

    result
}
```

### 11.5.2 显式技能引用

用户可以通过多种方式显式引用技能：

#### 1. 结构化引用 (UserInput::Skill)

```json
{
    "type": "skill",
    "skill_path": "/path/to/skill/SKILL.md",
    "skill_name": "pr-babysitter"
}
```

#### 2. 文本中的技能提及

```markdown
请使用 $pr-babysitter 技能来监控这个 PR。

或者：
请使用 $skill:pr-babysitter 来处理这个问题。
```

#### 3. 技能引用解析

```rust
// 来源：codex-rs/core-skills/src/injection.rs
pub fn collect_explicit_skill_mentions(
    inputs: &[UserInput],
    skills: &[SkillMetadata],
) -> Vec<SkillMetadata> {
    let mut mentioned_skills = Vec::new();
    let mut mentioned_paths = HashSet::new();

    // 1. 收集结构化技能选择
    for input in inputs {
        if let UserInput::Skill { skill_path, .. } = input {
            for skill in skills {
                if skill.path_to_skills_md == *skill_path {
                    if mentioned_paths.insert(skill_path.clone()) {
                        mentioned_skills.push(skill.clone());
                    }
                    break;
                }
            }
        }
    }

    // 2. 解析文本中的技能提及
    let skill_name_counts = build_skill_name_counts(skills);
    for input in inputs {
        if let UserInput::Text { text } = input {
            let text_mentions = extract_skill_mentions_from_text(text);
            for mention in text_mentions {
                if let Some(skill) = resolve_skill_mention(&mention, skills, &skill_name_counts) {
                    if mentioned_paths.insert(skill.path_to_skills_md.clone()) {
                        mentioned_skills.push(skill.clone());
                    }
                }
            }
        }
    }

    mentioned_skills
}

/// 从文本中提取技能提及
fn extract_skill_mentions_from_text(text: &str) -> Vec<String> {
    let mut mentions = Vec::new();

    // 匹配 $skill-name 或 $skill:skill-name 格式
    let skill_regex = regex::Regex::new(r"\$(?:skill:)?([a-zA-Z0-9\-_]+)").unwrap();

    for capture in skill_regex.captures_iter(text) {
        if let Some(skill_name) = capture.get(1) {
            mentions.push(skill_name.as_str().to_string());
        }
    }

    mentions
}
```

### 11.5.3 隐式技能调用

隐式技能调用是 Skill 系统的高级特性，允许系统根据上下文自动激活相关技能：

```rust
// 来源：codex-rs/core-skills/src/invocation_utils.rs
pub fn detect_implicit_skill_invocation_for_command(
    command: &[String],
    skills_outcome: &SkillLoadOutcome,
) -> Option<SkillMetadata> {
    // 检查是否有技能关联到特定的脚本路径
    if let Some(script_path) = infer_script_path_from_command(command) {
        if let Some(skill) = skills_outcome
            .implicit_skills_by_scripts_dir
            .get(&script_path.parent()?)
        {
            if skills_outcome.is_skill_allowed_for_implicit_invocation(skill) {
                return Some(skill.clone());
            }
        }
    }

    // 检查是否有技能关联到工作目录的文档
    let cwd = std::env::current_dir().ok()?;
    for doc_path in potential_doc_paths(&cwd) {
        if let Some(skill) = skills_outcome
            .implicit_skills_by_doc_path
            .get(&doc_path)
        {
            if command_matches_skill_pattern(command, skill) &&
               skills_outcome.is_skill_allowed_for_implicit_invocation(skill) {
                return Some(skill.clone());
            }
        }
    }

    None
}

/// 构建隐式技能路径索引
pub(crate) fn build_implicit_skill_path_indexes(
    skills: &[SkillMetadata],
) -> HashMap<PathBuf, SkillMetadata> {
    let mut index = HashMap::new();

    for skill in skills {
        let skill_dir = skill.path_to_skills_md.parent().unwrap();

        // 索引 scripts/ 目录
        let scripts_dir = skill_dir.join("scripts");
        if scripts_dir.exists() {
            index.insert(scripts_dir, skill.clone());
        }

        // 索引相关文档路径
        let doc_patterns = [
            skill_dir.join("README.md"),
            skill_dir.join("USAGE.md"),
            skill_dir.join("GUIDE.md"),
        ];

        for doc_path in &doc_patterns {
            if doc_path.exists() {
                index.insert(doc_path.clone(), skill.clone());
            }
        }
    }

    index
}
```

## 11.6 系统技能与用户技能

### 11.6.1 系统技能管理

系统技能是 Codex 内置的技能集合，提供核心功能：

```rust
// 来源：codex-rs/core-skills/src/system.rs
pub(crate) use codex_skills::install_system_skills;

pub(crate) fn uninstall_system_skills(codex_home: &Path) {
    let system_skills_dir = system_cache_root_dir(codex_home);
    let _ = std::fs::remove_dir_all(&system_skills_dir);
}
```

#### 系统技能安装流程

```rust
// 来源：codex-skills/src/lib.rs (推断)
pub fn install_system_skills(codex_home: &Path) -> Result<(), SkillInstallError> {
    let system_dir = system_cache_root_dir(codex_home);

    // 创建系统技能目录
    std::fs::create_dir_all(&system_dir)?;

    // 安装内置技能
    let bundled_skills = [
        ("pr-babysitter", include_str!("skills/pr-babysitter/SKILL.md")),
        ("code-review", include_str!("skills/code-review/SKILL.md")),
        ("debug-helper", include_str!("skills/debug-helper/SKILL.md")),
        // ... 更多系统技能
    ];

    for (skill_name, skill_content) in &bundled_skills {
        let skill_dir = system_dir.join(skill_name);
        std::fs::create_dir_all(&skill_dir)?;

        let skill_file = skill_dir.join("SKILL.md");
        std::fs::write(skill_file, skill_content)?;

        // 安装相关资源 (脚本、图标等)
        install_skill_assets(skill_name, &skill_dir)?;
    }

    Ok(())
}
```

### 11.6.2 用户技能创建

用户可以通过多种方式创建自定义技能：

#### 1. 手动创建

```bash
# 创建技能目录
mkdir -p ~/.codex/skills/my-custom-skill

# 创建主要技能文件
cat > ~/.codex/skills/my-custom-skill/SKILL.md << 'EOF'
---
name: my-custom-skill
description: 我的自定义技能
---

# 自定义技能

## 使用场景
当需要执行特定的自动化任务时使用此技能。

## 执行步骤
1. 分析当前上下文
2. 执行预定义的操作序列
3. 验证结果并报告

## 示例命令
```bash
# 示例命令
echo "执行自定义操作"
```
EOF

# 创建元数据配置
cat > ~/.codex/skills/my-custom-skill/skill.toml << 'EOF'
[interface]
display_name = "我的技能"
short_description = "执行自定义操作的技能"

[dependencies]
[[dependencies.tools]]
type = "binary"
value = "jq"
description = "JSON processing tool"

[policy]
allow_implicit_invocation = true
EOF
```

#### 2. 技能模板生成

```rust
// 来源：codex-cli/src/commands/skill.rs (推断)
pub fn create_skill_template(
    skill_name: &str,
    target_dir: &Path,
) -> Result<(), SkillCreationError> {
    let skill_dir = target_dir.join(skill_name);
    std::fs::create_dir_all(&skill_dir)?;

    // 生成 SKILL.md 模板
    let skill_template = format!(
        r#"---
name: {}
description: 技能描述
---

# {}

## 目标
简要说明这个技能的目标和用途。

## 使用场景
- 场景 1：具体的使用情况
- 场景 2：另一个使用情况

## 执行步骤
1. 第一步：详细说明
2. 第二步：详细说明
3. 第三步：详细说明

## 示例
```bash
# 示例命令
echo "Hello, {}!"
```

## 注意事项
- 重要提醒 1
- 重要提醒 2
"#,
        skill_name, skill_name, skill_name
    );

    std::fs::write(skill_dir.join("SKILL.md"), skill_template)?;

    // 生成 skill.toml 模板
    let config_template = r#"[interface]
display_name = "技能显示名称"
short_description = "简短描述"

[dependencies]
# [[dependencies.tools]]
# type = "binary"
# value = "tool-name"
# description = "工具描述"

[policy]
allow_implicit_invocation = true
products = []
"#;

    std::fs::write(skill_dir.join("skill.toml"), config_template)?;

    // 创建常用目录结构
    std::fs::create_dir_all(skill_dir.join("scripts"))?;
    std::fs::create_dir_all(skill_dir.join("references"))?;
    std::fs::create_dir_all(skill_dir.join("examples"))?;

    Ok(())
}
```

## 11.7 技能配置与规则

### 11.7.1 技能配置规则引擎

```rust
// 来源：codex-rs/core-skills/src/config_rules.rs
pub struct SkillConfigRules {
    disabled_paths: HashSet<PathBuf>,
    enabled_patterns: Vec<glob::Pattern>,
    disabled_patterns: Vec<glob::Pattern>,
}

impl SkillConfigRules {
    pub fn is_skill_enabled(&self, skill: &SkillMetadata) -> bool {
        let skill_path = &skill.path_to_skills_md;

        // 检查明确禁用的路径
        if self.disabled_paths.contains(skill_path) {
            return false;
        }

        // 检查禁用模式
        for pattern in &self.disabled_patterns {
            if pattern.matches_path(skill_path) {
                return false;
            }
        }

        // 如果有启用模式，检查是否匹配
        if !self.enabled_patterns.is_empty() {
            for pattern in &self.enabled_patterns {
                if pattern.matches_path(skill_path) {
                    return true;
                }
            }
            return false; // 有启用模式但不匹配
        }

        true // 默认启用
    }
}

pub fn skill_config_rules_from_stack(
    config_stack: &ConfigLayerStack,
) -> SkillConfigRules {
    let mut disabled_paths = HashSet::new();
    let mut enabled_patterns = Vec::new();
    let mut disabled_patterns = Vec::new();

    // 遍历配置层
    for layer in config_stack.layers() {
        if let Some(skills_config) = &layer.skills {
            // 收集禁用路径
            for disabled_path in &skills_config.disabled {
                disabled_paths.insert(PathBuf::from(disabled_path));
            }

            // 收集启用模式
            for pattern_str in &skills_config.enabled_patterns {
                if let Ok(pattern) = glob::Pattern::new(pattern_str) {
                    enabled_patterns.push(pattern);
                }
            }

            // 收集禁用模式
            for pattern_str in &skills_config.disabled_patterns {
                if let Ok(pattern) = glob::Pattern::new(pattern_str) {
                    disabled_patterns.push(pattern);
                }
            }
        }
    }

    SkillConfigRules {
        disabled_paths,
        enabled_patterns,
        disabled_patterns,
    }
}
```

#### 技能配置示例

```toml
# .codex/config.toml
[skills]
# 禁用特定技能
disabled = [
    "/path/to/unwanted/skill/SKILL.md"
]

# 启用模式 (如果指定，只有匹配的技能被启用)
enabled_patterns = [
    "~/.codex/skills/approved-*/**",
    ".codex/skills/team-*/**"
]

# 禁用模式
disabled_patterns = [
    "**/*-experimental/**",
    "**/deprecated-*/**"
]
```

### 11.7.2 技能权限与安全

```rust
// 来源：codex-rs/core-skills/src/security.rs (推断)
pub struct SkillSecurityPolicy {
    pub allowed_file_access: Vec<PathBuf>,
    pub allowed_network_domains: Vec<String>,
    pub max_execution_time: Duration,
    pub require_user_approval: bool,
}

impl SkillSecurityPolicy {
    pub fn from_skill_metadata(skill: &SkillMetadata) -> Self {
        let mut policy = Self::default();

        // 基于技能作用域设置默认权限
        match skill.scope {
            SkillScope::System => {
                // 系统技能有更高权限
                policy.allowed_file_access.push(PathBuf::from("/"));
                policy.require_user_approval = false;
            }
            SkillScope::User => {
                // 用户技能限制在用户目录
                if let Some(home) = dirs::home_dir() {
                    policy.allowed_file_access.push(home);
                }
                policy.require_user_approval = true;
            }
            SkillScope::Project => {
                // 项目技能限制在项目目录
                if let Ok(cwd) = std::env::current_dir() {
                    policy.allowed_file_access.push(cwd);
                }
                policy.require_user_approval = false;
            }
        }

        // 应用技能特定的策略
        if let Some(skill_policy) = &skill.policy {
            // 根据 skill_policy 调整权限
        }

        policy
    }

    pub fn validate_file_access(&self, path: &Path) -> bool {
        self.allowed_file_access.iter().any(|allowed| {
            path.starts_with(allowed)
        })
    }

    pub fn validate_network_access(&self, domain: &str) -> bool {
        if self.allowed_network_domains.is_empty() {
            return true; // 无限制
        }

        self.allowed_network_domains.iter().any(|allowed| {
            domain.ends_with(allowed)
        })
    }
}
```

## 11.8 技能变更监控

### 11.8.1 SkillWatcher 实现

技能系统提供了文件系统监控功能，用于检测技能文件的变更：

```rust
// 来源：codex-rs/core/src/skills_watcher.rs
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;

pub struct SkillsWatcher {
    watcher: RecommendedWatcher,
    receiver: mpsc::Receiver<SkillChangeEvent>,
    skills_manager: Arc<SkillsManager>,
}

#[derive(Debug, Clone)]
pub enum SkillChangeEvent {
    SkillAdded(PathBuf),
    SkillModified(PathBuf),
    SkillRemoved(PathBuf),
    SkillRenamed { from: PathBuf, to: PathBuf },
}

impl SkillsWatcher {
    pub fn new(
        skills_manager: Arc<SkillsManager>,
        skill_roots: Vec<PathBuf>,
    ) -> Result<Self, WatcherError> {
        let (sender, receiver) = mpsc::channel(100);

        let watcher = notify::recommended_watcher(move |res| {
            match res {
                Ok(event) => {
                    if let Some(skill_event) = convert_to_skill_event(event) {
                        let _ = sender.try_send(skill_event);
                    }
                }
                Err(err) => {
                    eprintln!("Skill watcher error: {:?}", err);
                }
            }
        })?;

        // 监控所有技能根目录
        for root in &skill_roots {
            watcher.watch(root, RecursiveMode::Recursive)?;
        }

        Ok(Self {
            watcher,
            receiver,
            skills_manager,
        })
    }

    pub async fn start_watching(&mut self) {
        while let Some(event) = self.receiver.recv().await {
            self.handle_skill_change(event).await;
        }
    }

    async fn handle_skill_change(&self, event: SkillChangeEvent) {
        match event {
            SkillChangeEvent::SkillModified(path) => {
                // 技能文件被修改，清理相关缓存
                if let Some(cwd) = path.parent() {
                    self.skills_manager.invalidate_cache_for_cwd(cwd);
                }
                tracing::info!("Skill modified: {}", path.display());
            }
            SkillChangeEvent::SkillAdded(path) => {
                // 新技能被添加
                self.skills_manager.invalidate_all_caches();
                tracing::info!("New skill added: {}", path.display());
            }
            SkillChangeEvent::SkillRemoved(path) => {
                // 技能被删除
                self.skills_manager.invalidate_all_caches();
                tracing::info!("Skill removed: {}", path.display());
            }
            SkillChangeEvent::SkillRenamed { from, to } => {
                // 技能被重命名
                self.skills_manager.invalidate_all_caches();
                tracing::info!("Skill renamed: {} -> {}", from.display(), to.display());
            }
        }
    }
}

fn convert_to_skill_event(event: notify::Event) -> Option<SkillChangeEvent> {
    use notify::EventKind;

    match event.kind {
        EventKind::Create(_) => {
            if let Some(path) = event.paths.first() {
                if path.file_name() == Some(OsStr::new("SKILL.md")) {
                    return Some(SkillChangeEvent::SkillAdded(path.clone()));
                }
            }
        }
        EventKind::Modify(_) => {
            if let Some(path) = event.paths.first() {
                if path.file_name() == Some(OsStr::new("SKILL.md")) {
                    return Some(SkillChangeEvent::SkillModified(path.clone()));
                }
            }
        }
        EventKind::Remove(_) => {
            if let Some(path) = event.paths.first() {
                if path.file_name() == Some(OsStr::new("SKILL.md")) {
                    return Some(SkillChangeEvent::SkillRemoved(path.clone()));
                }
            }
        }
        _ => {}
    }

    None
}
```

## 11.9 技能分析与遥测

### 11.9.1 技能使用分析

```rust
// 来源：codex-analytics/src/lib.rs (推断)
#[derive(Debug, Clone)]
pub struct SkillInvocation {
    pub skill_name: String,
    pub skill_scope: SkillScope,
    pub skill_path: PathBuf,
    pub invocation_type: InvocationType,
}

#[derive(Debug, Clone)]
pub enum InvocationType {
    Explicit,   // 显式调用
    Implicit,   // 隐式调用
}

pub struct AnalyticsEventsClient;

impl AnalyticsEventsClient {
    pub fn track_skill_invocations(
        &self,
        context: TrackEventsContext,
        invocations: Vec<SkillInvocation>,
    ) {
        for invocation in invocations {
            let event = AnalyticsEvent {
                event_type: "skill_invocation".to_string(),
                timestamp: chrono::Utc::now(),
                properties: json!({
                    "skill_name": invocation.skill_name,
                    "skill_scope": invocation.skill_scope,
                    "invocation_type": invocation.invocation_type,
                    "session_id": context.session_id,
                }),
            };

            self.send_event(event);
        }
    }

    pub fn track_skill_outcome(
        &self,
        skill_name: &str,
        success: bool,
        duration: Duration,
        error_message: Option<String>,
    ) {
        let event = AnalyticsEvent {
            event_type: "skill_outcome".to_string(),
            timestamp: chrono::Utc::now(),
            properties: json!({
                "skill_name": skill_name,
                "success": success,
                "duration_ms": duration.as_millis(),
                "error_message": error_message,
            }),
        };

        self.send_event(event);
    }
}
```

### 11.9.2 技能性能监控

```rust
// 来源：codex-rs/core-skills/src/metrics.rs (推断)
pub struct SkillMetrics {
    invocation_counter: Arc<AtomicU64>,
    success_counter: Arc<AtomicU64>,
    failure_counter: Arc<AtomicU64>,
    execution_times: Arc<Mutex<Vec<Duration>>>,
}

impl SkillMetrics {
    pub fn record_invocation(&self, skill_name: &str, invocation_type: InvocationType) {
        self.invocation_counter.fetch_add(1, Ordering::Relaxed);

        tracing::info!(
            skill = skill_name,
            invocation_type = ?invocation_type,
            "Skill invoked"
        );
    }

    pub fn record_outcome(
        &self,
        skill_name: &str,
        success: bool,
        duration: Duration,
    ) {
        if success {
            self.success_counter.fetch_add(1, Ordering::Relaxed);
        } else {
            self.failure_counter.fetch_add(1, Ordering::Relaxed);
        }

        // 记录执行时间
        if let Ok(mut times) = self.execution_times.lock() {
            times.push(duration);
            // 保持最近 1000 次记录
            if times.len() > 1000 {
                times.drain(0..times.len() - 1000);
            }
        }

        tracing::info!(
            skill = skill_name,
            success = success,
            duration_ms = duration.as_millis(),
            "Skill execution completed"
        );
    }

    pub fn get_statistics(&self) -> SkillStatistics {
        let invocations = self.invocation_counter.load(Ordering::Relaxed);
        let successes = self.success_counter.load(Ordering::Relaxed);
        let failures = self.failure_counter.load(Ordering::Relaxed);

        let times = self.execution_times.lock().unwrap();
        let avg_duration = if !times.is_empty() {
            times.iter().sum::<Duration>() / times.len() as u32
        } else {
            Duration::ZERO
        };

        SkillStatistics {
            total_invocations: invocations,
            successful_invocations: successes,
            failed_invocations: failures,
            success_rate: if invocations > 0 {
                successes as f64 / invocations as f64
            } else {
                0.0
            },
            average_execution_time: avg_duration,
        }
    }
}

pub struct SkillStatistics {
    pub total_invocations: u64,
    pub successful_invocations: u64,
    pub failed_invocations: u64,
    pub success_rate: f64,
    pub average_execution_time: Duration,
}
```

## 11.10 与 Claude Code Slash Commands 的对比

### 11.10.1 设计理念对比

| 维度 | Codex Skills | Claude Code Slash Commands |
|------|-------------|----------------------------|
| **定位** | 知识和经验注入 | 功能快捷方式 |
| **内容** | Markdown 格式的指导文档 | 预定义的功能调用 |
| **扩展性** | 用户可自由创建和修改 | 由系统预定义 |
| **激活方式** | 显式引用或隐式触发 | 斜杠命令触发 |
| **作用机制** | 增强 AI 推理能力 | 直接执行特定功能 |

### 11.10.2 使用场景对比

#### Codex Skills 适用场景

```markdown
---
name: code-review-best-practices
description: 代码评审最佳实践指导
---

# 代码评审最佳实践

## 评审重点

1. **代码逻辑**：检查算法正确性和边界条件
2. **代码风格**：确保符合团队编码规范
3. **性能考虑**：识别潜在的性能瓶颈
4. **安全性**：检查安全漏洞和数据泄露风险

## 评审流程

1. 先理解 PR 的目的和背景
2. 从高层架构开始评审
3. 深入到具体实现细节
4. 提供建设性的改进建议

## 常见问题模式

- 未处理的异常情况
- 硬编码的配置值
- 缺少单元测试覆盖
- 不必要的代码重复
```

#### Claude Code Slash Commands 适用场景

```
/commit -m "Add user authentication module"
/review-pr 123
/fix-lint
/run-tests
/deploy staging
```

### 11.10.3 协同工作模式

Codex Skills 和 Slash Commands 可以完美协同：

```markdown
用户：请使用 $code-review-best-practices 技能来评审这个 PR，然后用相应的命令执行必要的操作。

AI 响应：
1. [加载 code-review-best-practices 技能]
2. 根据技能指导进行 PR 评审
3. 发现问题后执行：/fix-lint
4. 修复完成后执行：/run-tests
5. 测试通过后执行：/commit -m "Fix linting issues and add missing tests"
```

## 11.11 技能生态与最佳实践

### 11.11.1 技能设计原则

#### 1. 单一职责原则

每个技能应该专注于一个特定的领域或任务：

```markdown
✅ 好的技能设计
---
name: docker-debugging
description: Docker 容器调试专用技能
---

❌ 避免的设计
---
name: full-stack-development
description: 全栈开发相关的所有技能
---
```

#### 2. 渐进式详细程度

技能内容应该从概览到细节逐步深入：

```markdown
# Docker 调试技能

## 快速诊断 (1-2 分钟)
- 检查容器状态：`docker ps -a`
- 查看资源使用：`docker stats`

## 深度分析 (5-10 分钟)
- 检查容器日志：`docker logs -f container-name`
- 进入容器调试：`docker exec -it container-name /bin/bash`

## 高级诊断 (15+ 分钟)
- 网络连接分析
- 存储挂载检查
- 性能瓶颈定位
```

#### 3. 实操性和可验证性

技能应该提供具体的、可执行的指导：

```markdown
## 验证步骤

执行以下命令验证修复效果：
```bash
# 1. 检查服务状态
curl -f http://localhost:8080/health

# 2. 验证数据库连接
docker exec app-container pg_isready -d mydb

# 3. 确认日志正常
docker logs --tail 10 app-container | grep "Started successfully"
```

预期结果：所有命令都应该返回成功状态。
```

### 11.11.2 技能组织结构

#### 推荐的技能目录结构

```
~/.codex/skills/
├── development/
│   ├── debugging/
│   │   ├── SKILL.md
│   │   └── scripts/
│   ├── testing/
│   │   ├── SKILL.md
│   │   └── examples/
│   └── deployment/
│       ├── SKILL.md
│       └── references/
├── operations/
│   ├── monitoring/
│   └── incident-response/
└── domain-specific/
    ├── machine-learning/
    └── blockchain/
```

#### 技能命名约定

```markdown
✅ 推荐的命名方式：
- docker-debugging
- git-workflow-optimization
- api-performance-tuning
- react-component-testing

❌ 避免的命名方式：
- debugging (太宽泛)
- fix-things (不明确)
- awesome-skill (无意义)
- myskill123 (不专业)
```

### 11.11.3 技能版本管理

```toml
# skill.toml
[metadata]
version = "1.2.0"
author = "team@company.com"
created_at = "2024-01-15"
updated_at = "2024-03-20"
compatibility = ["codex >= 0.12.0"]

[changelog]
"1.2.0" = "Added support for container orchestration debugging"
"1.1.0" = "Enhanced network troubleshooting steps"
"1.0.0" = "Initial version with basic Docker debugging"
```

## 11.12 总结

OpenAI Codex CLI 的 Skill 系统代表了 AI Agent 能力扩展的一个重要里程碑：

### 11.12.1 技术创新点

1. **知识注入机制**：通过 Markdown 文档直接增强 AI 的专业知识
2. **多层缓存系统**：CWD 缓存和配置缓存的双重优化
3. **隐式调用机制**：基于上下文的智能技能激活
4. **分层权限控制**：基于作用域的安全策略
5. **实时变更监控**：文件系统监控和缓存同步

### 11.12.2 架构优势

| 设计特性 | 技术实现 | 业务价值 |
|---------|----------|----------|
| **模块化设计** | 独立的技能文件和目录 | 易于创建和维护 |
| **层次化管理** | 系统/用户/项目三层架构 | 灵活的权限和作用域控制 |
| **智能缓存** | 双重缓存策略 | 优秀的性能表现 |
| **动态加载** | 运行时发现和注入 | 无需重启即可更新 |
| **丰富元数据** | 接口、依赖、策略配置 | 完整的生态系统支持 |

### 11.12.3 生态系统影响

Skill 系统为 AI Agent 创造了一个**自我进化的生态系统**：

- **用户贡献**：任何人都可以创建和分享技能
- **知识积累**：最佳实践和经验得以传承
- **持续优化**：技能可以不断改进和完善
- **社区驱动**：形成了知识共享的良性循环

Skill 系统不仅是技术实现的典范，更是 AI 时代**知识管理和能力传承**的全新范式。它展现了如何让 AI 系统不仅仅是工具的使用者，更是知识的学习者和传承者。

至此，我们完成了对 OpenAI Codex CLI 工具系统的全面剖析。从工具系统的总体架构，到 Shell 工具的安全执行，再到 File I/O 工具族的精密操作，最后到 Skill 系统的智慧传承——每个组件都体现了现代 AI 系统设计的最高水准。这不仅是一个工具集合，更是一个完整的 AI Agent 能力生态系统。