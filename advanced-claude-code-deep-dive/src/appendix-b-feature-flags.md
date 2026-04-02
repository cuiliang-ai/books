# 附录 B：Feature Flag 完整索引

> 本附录汇总 Claude Code v2.1.86 源码中通过 `feature('FLAG_NAME')` 引用的所有编译期 feature flag，按功能域分类，标注成熟度、用途及本书讨论章节。第 6 节还提供了将 Claude Code 的 feature flag 设计思想应用到你自己的 Python service 中的实战指南。

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

## 6. 实战：在你的服务中实现 Feature Flag

Claude Code 的 feature flag 体系并不依赖特定语言或框架 — 其核心是**两层架构**的设计思想。本节以 Python service 为例，演示如何将这套思想落地到你自己的 CI/CD 流程中。

### 6.1 架构设计：对标 Claude Code 的双层模型

```
┌─────────────────────────────────────────────────────────────────┐
│              Feature Flag 双层架构                                │
├──────────────────────────────┬──────────────────────────────────┤
│   第 1 层：构建时 Flag         │   第 2 层：运行时 Flag             │
│   CI/CD 流水线注入             │   远程配置服务                     │
├──────────────────────────────┼──────────────────────────────────┤
│ 对标：bun:bundle feature()    │ 对标：GrowthBook / Statsig       │
│ 时机：docker build / 打包阶段  │ 时机：程序运行中                   │
│ 效果：功能模块不参与构建         │ 效果：代码存在但逻辑跳过            │
│ 用途：内部/外部版本隔离         │ 用途：灰度发布、A/B、参数调优       │
│ 切换：需要重新构建部署          │ 切换：修改配置即时生效              │
└──────────────────────────────┴──────────────────────────────────┘
```

与 Claude Code 的对应关系：

| Claude Code | Python Service | 解决的问题 |
|:------------|:---------------|:-----------|
| `feature('KAIROS')` | 构建时环境变量 / 预处理器 | 内部功能不泄漏到外部构建 |
| `process.env.USER_TYPE` | `BUILD_VARIANT` 环境变量 | 区分 internal / staging / production |
| GrowthBook `isFeatureEnabled()` | 运行时配置文件 / 远程配置 | 不重新部署即可切换功能 |

### 6.2 第一层：构建时 Flag（环境变量注入）

这是最简单也最常用的方案，对标 Claude Code 的 `feature()` 编译时机制。

**核心模块**：

```python
# feature_flags.py
"""
构建时 feature flag 系统。
Flag 值在进程启动时从环境变量读取并冻结，运行中不可变更。

对标 Claude Code 的 import { feature } from 'bun:bundle'
区别：Python 无法做 dead code elimination，但可以做条件导入。
"""
import os
from functools import lru_cache

# CI/CD 通过环境变量注入：FEATURE_FLAGS="KAIROS,VOICE_MODE"
_RAW = os.environ.get("FEATURE_FLAGS", "")
_ENABLED: frozenset[str] = frozenset(
    f.strip() for f in _RAW.split(",") if f.strip()
)

@lru_cache(maxsize=None)
def feature(flag_name: str) -> bool:
    """
    编译时 feature flag 查询。
    结果在首次调用后缓存，等效于编译时常量。

    用法与 Claude Code 完全一致：
        if feature("KAIROS"):
            from services.kairos import scheduler
    """
    return flag_name in _ENABLED

def get_enabled_flags() -> frozenset[str]:
    """返回所有启用的 flag，用于日志和诊断。"""
    return _ENABLED
```

**使用方式** — 条件导入（对标 Claude Code `feature()` + `require()`）：

```python
# services/api.py
from feature_flags import feature

# 对标 Claude Code 的:
#   const SleepTool = feature('PROACTIVE') || feature('KAIROS')
#     ? require('./tools/SleepTool/SleepTool.js').SleepTool : null
if feature("KAIROS"):
    from services.kairos import KairosScheduler
    scheduler = KairosScheduler()
else:
    scheduler = None

def register_routes(app):
    app.add_route("/health", health_check)

    if feature("VOICE_MODE"):
        from api.voice import voice_routes
        app.include_router(voice_routes)

    if feature("COORDINATOR_MODE"):
        from api.coordinator import coordinator_routes
        app.include_router(coordinator_routes)
```

**CI/CD 集成**：

```yaml
# .github/workflows/deploy.yml
jobs:
  build:
    strategy:
      matrix:
        target: [internal, staging, production]
        include:
          - target: internal
            # 对标 Claude Code 的 ant 构建 — 所有功能开启
            flags: "KAIROS,COORDINATOR_MODE,VOICE_MODE,DEBUG_TOOLS"
          - target: staging
            flags: "VOICE_MODE"
          - target: production
            # 对标 Claude Code 的 external 构建 — 最小功能集
            flags: ""
    steps:
      - uses: actions/checkout@v4
      - name: Build
        run: |
          docker build \
            --build-arg FEATURE_FLAGS="${{ matrix.flags }}" \
            -t myservice:${{ matrix.target }} .
```

```dockerfile
# Dockerfile
ARG FEATURE_FLAGS=""
ENV FEATURE_FLAGS=${FEATURE_FLAGS}
```

> **与 Claude Code 的关键差异**：Python 的条件导入不会像 `bun:bundle` 那样从构建产物中**物理移除**代码。未启用的模块文件仍然存在于 Docker 镜像中，只是不会被 `import`。如果你有安全隔离需求（不希望反编译看到内部功能），需要第二种方案。

### 6.3 第一层进阶：源码预处理（真正的 Dead Code Elimination）

对标 Claude Code `feature()` 的完整行为 — 代码从构建产物中**物理消失**。

**预处理器**：

```python
# scripts/build_with_flags.py
"""
源码预处理器：在 CI/CD 构建阶段运行，
物理移除未启用 flag 保护的代码块。

对标 bun:bundle 的 dead code elimination。

用法：
    python scripts/build_with_flags.py \
        --flags KAIROS,VOICE_MODE \
        --src src/ --out dist/
"""
import re
import shutil
import argparse
from pathlib import Path

# 匹配 # FEATURE: FLAG_NAME ... # END_FEATURE: FLAG_NAME 块
FEATURE_BLOCK = re.compile(
    r'^\s*# FEATURE: (\w+)\s*\n(.*?)^\s*# END_FEATURE: \1\s*\n',
    re.MULTILINE | re.DOTALL,
)

def process_file(content: str, enabled: set[str]) -> str:
    def replacer(match: re.Match) -> str:
        flag = match.group(1)
        block = match.group(2)
        return block if flag in enabled else ""
    return FEATURE_BLOCK.sub(replacer, content)

def build(src: Path, out: Path, flags: set[str]):
    if out.exists():
        shutil.rmtree(out)
    for f in src.rglob("*.py"):
        rel = f.relative_to(src)
        dst = out / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        content = f.read_text(encoding="utf-8")
        dst.write_text(process_file(content, flags), encoding="utf-8")
    print(f"Built with flags: {flags or '{none}'}")

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--flags", default="")
    p.add_argument("--src", default="src")
    p.add_argument("--out", default="dist")
    args = p.parse_args()
    flags = {f.strip() for f in args.flags.split(",") if f.strip()}
    build(Path(args.src), Path(args.out), flags)
```

**源码中用注释标记保护块**：

```python
# services/api.py
def register_routes(app):
    app.add_route("/health", health_check)

    # FEATURE: KAIROS
    from services.kairos import kairos_router
    app.include_router(kairos_router, prefix="/kairos")
    # END_FEATURE: KAIROS

    # FEATURE: VOICE_MODE
    from services.voice import voice_router
    app.include_router(voice_router, prefix="/voice")
    # END_FEATURE: VOICE_MODE
```

构建后的 `dist/services/api.py`（`--flags ""`，对标 external 构建）：

```python
def register_routes(app):
    app.add_route("/health", health_check)

    # KAIROS 和 VOICE_MODE 的代码块被完全移除
    # 反编译 / 查看镜像也看不到任何痕迹
```

**CI/CD 集成**：

```yaml
      - name: Preprocess and build
        run: |
          python scripts/build_with_flags.py \
            --flags "${{ matrix.flags }}" \
            --src src --out dist
          docker build -f Dockerfile.dist -t myservice:${{ matrix.target }} .
```

### 6.4 第二层：运行时 Flag（灰度与参数控制）

对标 Claude Code 的 GrowthBook / Statsig 层。不需要重新构建即可切换功能。

```python
# runtime_flags.py
"""
运行时 feature flag 系统。
支持本地 JSON 配置 + 环境变量覆盖 + 热重载。

对标 Claude Code 的 GrowthBook 集成：
  - tengu_session_memory (布尔开关)
  - bridge_poll_interval_ms (参数值)

设计要点（借鉴 Claude Code query/config.ts 的 snapshot 模式）：
  在请求入口处快照一次 flag 状态，请求处理过程中使用快照，
  避免中途 flag 变更导致不一致。
"""
import json
import os
import threading
from pathlib import Path
from typing import Any

class RuntimeFlags:
    def __init__(self, config_path: str = "config/features.json"):
        self._path = Path(config_path)
        self._flags: dict[str, Any] = {}
        self._lock = threading.Lock()
        self._load()

    def _load(self):
        with self._lock:
            if self._path.exists():
                self._flags = json.loads(
                    self._path.read_text(encoding="utf-8")
                )
            # 环境变量覆盖：RUNTIME_FLAG_XXX=true
            for key, val in os.environ.items():
                if key.startswith("RUNTIME_FLAG_"):
                    name = key[len("RUNTIME_FLAG_"):]
                    self._flags[name] = val.lower() in ("true", "1")

    def is_enabled(self, name: str, default: bool = False) -> bool:
        with self._lock:
            return bool(self._flags.get(name, default))

    def get_value(self, name: str, default: Any = None) -> Any:
        with self._lock:
            return self._flags.get(name, default)

    def snapshot(self) -> dict[str, Any]:
        """
        快照当前所有 flag 状态。
        对标 Claude Code QueryConfig 的 snapshot isolation 模式：
        在请求入口处调用一次，后续逻辑使用快照而非实时查询。
        """
        with self._lock:
            return dict(self._flags)

    def reload(self):
        """热重载配置，可由 SIGHUP 信号或管理 API 触发。"""
        self._load()

# 全局单例
runtime_flags = RuntimeFlags()
```

配置文件：

```json
{
    "session_memory": true,
    "new_pricing_model": false,
    "max_concurrent_workers": 4,
    "poll_interval_ms": 5000
}
```

使用：

```python
from runtime_flags import runtime_flags

# 请求入口 — 快照（对标 Claude Code 的 QueryConfig）
def handle_request(request):
    flags = runtime_flags.snapshot()

    if flags.get("session_memory"):
        extract_session_memory(request.conversation)

    max_workers = flags.get("max_concurrent_workers", 2)
    process_with_workers(request, max_workers)
```

### 6.5 完整 CI/CD 流水线示例

将两层 flag 整合到一条流水线中：

```yaml
# .github/workflows/deploy.yml
name: Build & Deploy with Feature Flags

on:
  push:
    branches: [main]

jobs:
  build:
    strategy:
      matrix:
        target: [internal, staging, production]
        include:
          # 对标 Claude Code ant 构建
          - target: internal
            build_flags: "KAIROS,COORDINATOR_MODE,VOICE_MODE,DEBUG_TOOLS"
            runtime_config: config/features.internal.json
          # 灰度环境
          - target: staging
            build_flags: "VOICE_MODE"
            runtime_config: config/features.staging.json
          # 对标 Claude Code external 构建
          - target: production
            build_flags: ""
            runtime_config: config/features.production.json

    steps:
      - uses: actions/checkout@v4

      # 第 1 层：构建时 flag
      - name: Build with feature flags
        run: |
          docker build \
            --build-arg FEATURE_FLAGS="${{ matrix.build_flags }}" \
            -t myservice:${{ matrix.target }} .

      # 第 2 层：运行时 flag 配置
      - name: Deploy runtime config
        run: |
          kubectl create configmap feature-flags \
            --from-file=${{ matrix.runtime_config }} \
            --dry-run=client -o yaml | kubectl apply -f -

      - name: Deploy
        run: |
          kubectl set image deployment/myservice \
            app=myservice:${{ matrix.target }}
```

### 6.6 设计决策对照表

| 决策点 | Claude Code 的选择 | Python Service 建议 | 理由 |
|:-------|:-------------------|:-------------------|:-----|
| **构建时 flag 实现** | `bun:bundle` 编译器内置 | 环境变量 + 条件导入 | Python 无编译期，用启动时冻结替代 |
| **代码物理移除** | tree-shaking 自动完成 | 预处理器脚本（可选） | 仅在有安全隔离需求时使用 |
| **运行时 flag 服务** | GrowthBook + Statsig | JSON 配置 / LaunchDarkly / Unleash | 小团队用 JSON 够了，大团队上专业服务 |
| **flag 必须内联** | 是（打包器约束） | 否（Python 无此限制） | 但建议保持内联风格以提高可读性 |
| **快照隔离** | `QueryConfig` 入口快照 | `snapshot()` 方法 | 防止请求处理中 flag 变更导致不一致 |
| **内部/外部区分** | `USER_TYPE === 'ant'` | `BUILD_VARIANT` 环境变量 | 保持简单，一个变量控制构建变体 |

> **核心启示**：Claude Code 的 feature flag 设计精髓不在于具体的 `bun:bundle` API，而在于**两层分离的架构思想** — 构建时做功能隔离（安全），运行时做灰度控制（灵活）。这套思想可以用任何语言和 CI/CD 工具实现。

---

## 7. 如何在源码中追踪 Feature Flag

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
