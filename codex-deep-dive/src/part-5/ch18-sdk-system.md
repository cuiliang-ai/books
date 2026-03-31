# 第 18 章：SDK 体系 — 构建你的集成

> **核心问题**：如何在保持 Rust 核心性能优势的同时，为 Python 和 TypeScript 开发者提供原生般的开发体验？一个多语言 SDK 体系如何设计才能既类型安全又易于使用？

Codex CLI 的核心虽然用 Rust 实现，但绝大多数用户和集成商并不直接与 Rust 代码交互。相反，他们通过精心设计的 **Python SDK** 和 **TypeScript SDK** 来构建自己的应用。这个 SDK 体系是 Codex CLI 生态系统的重要组成部分，它需要在性能、类型安全和开发便利性之间找到最佳平衡点。

本章将深入分析 Codex CLI 的三层 SDK 架构：**Python SDK**（同步/异步 API）、**TypeScript SDK**（类型生成机制）和 **Python Runtime**（技能执行环境）。我们将探索它们与 App Server 的协议关系，剖析类型安全的实现机制，并通过实际示例展示如何构建自定义集成。

---

## 18.1 SDK 总览：三层架构的设计理念

### 18.1.1 SDK 体系架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                 USER APPLICATIONS                           │
│                                                                             │
│  ┌─ Python Apps ─┐  ┌─ TypeScript Apps ─┐  ┌─ Custom Skills ─┐           │
│  │ • Data Science │  │ • Web Backends    │  │ • Domain Logic   │           │
│  │ • ML Pipelines │  │ • CLI Tools       │  │ • External APIs  │           │
│  │ • Jupyter NB   │  │ • VS Code Ext     │  │ • Workflow Auto  │           │
│  └───────────────┘  └───────────────────┘  └─────────────────┘           │
│          │                     │                     │                     │
└──────────┼─────────────────────┼─────────────────────┼─────────────────────┘
           ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                 SDK LAYER                                   │
│                                                                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐          │
│  │  Python SDK      │  │  TypeScript SDK  │  │ Python Runtime   │          │
│  │                  │  │                  │  │                  │          │
│  │ • Sync/Async API │  │ • Type Generation│  │ • Skill Executor │          │
│  │ • Pydantic Models│  │ • Node.js Support│  │ • Sandboxed Env  │          │
│  │ • Context Mgmt   │  │ • Promise-based  │  │ • Lifecycle Hooks│          │
│  │ • Error Handling │  │ • Stream Support │  │ • Resource Mgmt  │          │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘          │
│           │                      │                      │                   │
│           └──────────────────────┼──────────────────────┘                   │
│                                  ▼                                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PROTOCOL LAYER                                 │
│                                                                             │
│                    ┌──────────────────────────────────┐                    │
│                    │        App Server Protocol       │                    │
│                    │                                  │                    │
│                    │ • JSON-RPC 2.0 over stdio       │                    │
│                    │ • Thread Management              │                    │
│                    │ • Tool Execution                 │                    │
│                    │ • Streaming Support              │                    │
│                    │ • Error Propagation              │                    │
│                    └──────────────────────────────────┘                    │
│                                  │                                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                               RUST CORE                                     │
│                                                                             │
│              ┌─ App Server ─┐         ┌─ Core Engine ─┐                   │
│              │ • RPC Handler │         │ • Agent Loop   │                   │
│              │ • Type Safety │         │ • Tool Dispatch│                   │
│              │ • Concurrency │         │ • Context Mgmt │                   │
│              └───────────────┘         └───────────────┘                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 18.1.2 设计原则

SDK 体系的设计遵循四个核心原则：

**1. 零成本抽象 (Zero-Cost Abstraction)**
```python
# Python SDK - 直接映射到 Rust 类型
@dataclass
class ThreadStartRequest:
    model: str
    thread_id: Optional[str] = None
    # 编译时生成，运行时零序列化成本
```

**2. 类型安全优先 (Type Safety First)**
```typescript
// TypeScript SDK - 完整类型定义
interface TurnRequest {
    messages: Message[];
    model: ModelConfig;
    tools?: ToolDefinition[];
    // 编译时类型检查，运行时无额外开销
}
```

**3. 开发者友好 (Developer Friendly)**
```python
# 简化的高级 API
with Codex() as codex:
    thread = codex.thread_start(model="gpt-4")
    result = thread.run("Analyze this code")
    # 自动资源管理，无需手动清理
```

**4. 向后兼容 (Backward Compatible)**
- SDK 版本与核心版本解耦
- 协议版本化支持
- 优雅的功能降级机制

---

## 18.2 Python SDK：同步异步的双重体验

### 18.2.1 API 设计哲学

Python SDK 提供了同步和异步两套 API，满足不同场景需求：

```python
# sdk/python/codex_app_server/__init__.py - 统一入口
from .sync_client import Codex as SyncCodex
from .async_client import AsyncCodex
from .models import *

# 同步 API - 适合脚本和 Jupyter
class Codex(SyncCodex):
    """Synchronous Codex client for scripts and interactive use."""
    pass

# 异步 API - 适合服务器和并发场景
__all__ = ["Codex", "AsyncCodex", "ThreadStartRequest", "TurnResult"]
```

### 18.2.2 同步 API：脚本友好的简洁接口

```python
# sdk/python/codex_app_server/sync_client.py
class Codex:
    def __init__(self, config: Optional[AppServerConfig] = None):
        self._config = config or AppServerConfig()
        self._server: Optional[AppServer] = None

    def __enter__(self) -> "Codex":
        """Context manager for automatic resource management."""
        self._server = AppServer.start(self._config)
        self._server.initialize()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Guaranteed cleanup even on exceptions."""
        if self._server:
            self._server.shutdown()
            self._server = None

    def thread_start(self, model: str, **kwargs) -> Thread:
        """Start a new conversation thread."""
        request = ThreadStartRequest(model=model, **kwargs)
        response = self._server.thread_start(request)
        return Thread(self._server, response.thread_id)

class Thread:
    """Represents an active conversation thread."""

    def run(self, message: str, **kwargs) -> TurnResult:
        """Execute a complete turn with automatic tool handling."""
        turn_request = TurnRequest(
            messages=[UserMessage(content=message)],
            **kwargs
        )

        # 流式处理但返回最终结果
        for item in self._server.turn_stream(turn_request):
            if isinstance(item, TurnComplete):
                return TurnResult(
                    final_response=item.final_message,
                    items=item.all_items,
                    usage=item.usage
                )
```

使用示例：

```python
# examples/01_quickstart_constructor/sync.py
from codex_app_server import Codex

def analyze_codebase():
    with Codex() as codex:
        thread = codex.thread_start(model="gpt-4")

        # 简单的一行调用
        result = thread.run("Find all TODO comments in this project")

        print(f"Found {len(result.items)} items:")
        for item in result.items:
            if item.type == "tool_use":
                print(f"- Tool: {item.tool_name}")
                print(f"  Result: {item.result[:100]}...")

        # 自动清理资源

if __name__ == "__main__":
    analyze_codebase()
```

### 18.2.3 异步 API：高性能并发支持

```python
# sdk/python/codex_app_server/async_client.py
import asyncio
from typing import AsyncIterator

class AsyncCodex:
    async def __aenter__(self) -> "AsyncCodex":
        """Async context manager."""
        self._server = await AppServer.start_async(self._config)
        await self._server.initialize()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async cleanup."""
        if self._server:
            await self._server.shutdown()

    async def thread_start(self, model: str, **kwargs) -> AsyncThread:
        """Start thread asynchronously."""
        request = ThreadStartRequest(model=model, **kwargs)
        response = await self._server.thread_start(request)
        return AsyncThread(self._server, response.thread_id)

class AsyncThread:
    async def run(self, message: str, **kwargs) -> TurnResult:
        """Non-blocking turn execution."""
        # 异步版本支持取消和超时
        turn_request = TurnRequest(messages=[UserMessage(content=message)])

        async for item in self._server.turn_stream(turn_request):
            if isinstance(item, TurnComplete):
                return TurnResult.from_completion(item)

    async def turn_stream(self, **kwargs) -> AsyncIterator[TurnItem]:
        """Direct access to streaming interface."""
        async for item in self._server.turn_stream(...):
            yield item
```

异步使用示例：

```python
# examples/01_quickstart_constructor/async.py
import asyncio
from codex_app_server import AsyncCodex

async def concurrent_analysis():
    async with AsyncCodex() as codex:
        thread = await codex.thread_start(model="gpt-4")

        # 并发执行多个任务
        tasks = [
            thread.run("Analyze security vulnerabilities"),
            thread.run("Check code style issues"),
            thread.run("Generate unit tests"),
        ]

        results = await asyncio.gather(*tasks)

        for i, result in enumerate(results):
            print(f"Task {i+1}: {result.final_response[:100]}...")

async def streaming_analysis():
    async with AsyncCodex() as codex:
        thread = await codex.thread_start(model="gpt-4")

        # 实时流式处理
        async for item in thread.turn_stream(
            messages=[UserMessage("Refactor this module")]
        ):
            if item.type == "text":
                print(item.content, end="", flush=True)
            elif item.type == "tool_use":
                print(f"\n[Using tool: {item.tool_name}]")

if __name__ == "__main__":
    asyncio.run(concurrent_analysis())
```

### 18.2.4 Pydantic 模型的类型安全

SDK 使用 Pydantic v2 提供编译时和运行时的双重类型检查：

```python
# sdk/python/codex_app_server/models.py - 自动生成的类型
from pydantic import BaseModel, Field
from typing import Union, Optional, List
from enum import Enum

class MessageRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"

class UserMessage(BaseModel):
    """User input message."""
    role: MessageRole = Field(default=MessageRole.USER)
    content: str = Field(..., description="Message content")

class ToolUse(BaseModel):
    """Tool invocation request."""
    type: str = Field(default="tool_use")
    id: str = Field(..., description="Unique tool call identifier")
    name: str = Field(..., description="Tool name")
    input: dict = Field(..., description="Tool input parameters")

class AssistantMessage(BaseModel):
    """Assistant response with mixed content."""
    role: MessageRole = Field(default=MessageRole.ASSISTANT)
    content: List[Union[str, ToolUse]] = Field(..., description="Mixed content blocks")

# 自动生成的类型映射
class TurnRequest(BaseModel):
    """Complete turn request specification."""
    messages: List[Union[UserMessage, AssistantMessage]]
    model: str = Field(..., description="Model identifier")
    tools: Optional[List[dict]] = Field(default=None)
    max_turns: Optional[int] = Field(default=10)

    class Config:
        # 与 Rust 结构体字段映射
        alias_generator = lambda field_name: field_name
        populate_by_name = True
```

类型生成脚本：

```python
# sdk/python/scripts/update_sdk_artifacts.py
def generate_types():
    """Generate Python types from Rust schema."""

    # 1. 执行 Rust 二进制获取 JSON Schema
    schema_json = subprocess.check_output([
        codex_bin, "app-server", "--dump-schema"
    ])

    # 2. 解析 JSON Schema
    schema = json.loads(schema_json)

    # 3. 生成 Pydantic 模型
    models_code = generate_pydantic_models(schema)

    # 4. 写入模型文件
    with open("codex_app_server/models.py", "w") as f:
        f.write(models_code)

    print("✅ Types generated from Rust schema")
```

这种类型生成机制确保了 Python SDK 与 Rust 核心的类型完全一致。

---

## 18.3 TypeScript SDK：原生开发体验

### 18.3.1 类型生成的完整流程

TypeScript SDK 通过更复杂的类型生成机制提供接近原生的开发体验：

```bash
# sdk/typescript/scripts/generate-types.js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 1. 从 Rust 导出 TypeScript 类型定义
const typeDefinitions = execSync(`${codexBin} app-server --export-ts-types`, {
    encoding: 'utf8'
});

// 2. 解析并增强类型定义
const enhancedTypes = enhanceTypeDefinitions(typeDefinitions);

// 3. 生成客户端代码
const clientCode = generateClientCode(enhancedTypes);

// 4. 写入文件
fs.writeFileSync('src/generated/types.ts', enhancedTypes);
fs.writeFileSync('src/generated/client.ts', clientCode);
```

生成的类型定义：

```typescript
// sdk/typescript/src/generated/types.ts - 自动生成
export interface ThreadStartRequest {
    model: string;
    thread_id?: string;
    max_turns?: number;
    tools?: ToolDefinition[];
}

export interface TurnRequest {
    messages: Message[];
    model?: string;
    tools?: ToolDefinition[];
    stream?: boolean;
}

export interface Message {
    role: 'user' | 'assistant' | 'system';
    content: string | ContentBlock[];
}

export type ContentBlock =
    | TextBlock
    | ToolUseBlock
    | ToolResultBlock;

export interface TextBlock {
    type: 'text';
    text: string;
}

export interface ToolUseBlock {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, any>;
}

// 完整的类型覆盖，与 Rust 定义完全一致
```

### 18.3.2 Promise-based 客户端实现

```typescript
// sdk/typescript/src/client.ts
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export class CodexClient extends EventEmitter {
    private process: ChildProcess | null = null;
    private requestId = 0;
    private pendingRequests = new Map<number, {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
    }>();

    async initialize(config?: AppServerConfig): Promise<void> {
        // 启动 Rust App Server 进程
        this.process = spawn(config?.codex_bin || 'codex', [
            'app-server',
            '--mode', 'stdio'
        ]);

        // 设置 JSON-RPC 通信
        this.setupJsonRpc();

        // 发送初始化请求
        await this.sendRequest('initialize', config || {});
    }

    async threadStart(request: ThreadStartRequest): Promise<ThreadStartResponse> {
        return this.sendRequest('thread_start', request);
    }

    async turn(request: TurnRequest): Promise<TurnResponse> {
        if (request.stream) {
            return this.turnStream(request);
        } else {
            return this.sendRequest('turn', request);
        }
    }

    private async turnStream(request: TurnRequest): Promise<AsyncIterableIterator<TurnItem>> {
        const requestId = ++this.requestId;

        // 返回异步迭代器
        return {
            [Symbol.asyncIterator]() {
                return this;
            },

            async next(): Promise<IteratorResult<TurnItem>> {
                return new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Stream timeout'));
                    }, 30000);

                    this.once(`stream:${requestId}:data`, (item: TurnItem) => {
                        clearTimeout(timeout);
                        resolve({ value: item, done: false });
                    });

                    this.once(`stream:${requestId}:end`, () => {
                        clearTimeout(timeout);
                        resolve({ value: undefined, done: true });
                    });
                });
            }
        };
    }

    private setupJsonRpc(): void {
        if (!this.process) return;

        // 处理 stdout 上的 JSON-RPC 响应
        let buffer = '';
        this.process.stdout?.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();

            // 处理完整的 JSON 行
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.trim()) {
                    this.handleJsonRpcMessage(JSON.parse(line));
                }
            }
        });

        // 错误处理
        this.process.stderr?.on('data', (chunk: Buffer) => {
            console.error('Codex stderr:', chunk.toString());
        });
    }

    private async sendRequest(method: string, params: any): Promise<any> {
        const id = ++this.requestId;

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });

            const request = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };

            this.process?.stdin?.write(JSON.stringify(request) + '\n');

            // 设置超时
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request timeout: ${method}`));
                }
            }, 30000);
        });
    }

    async shutdown(): Promise<void> {
        if (this.process) {
            await this.sendRequest('shutdown', {});
            this.process.kill();
            this.process = null;
        }
    }
}
```

### 18.3.3 高级 API 封装

```typescript
// sdk/typescript/src/high-level.ts - 开发者友好的接口
export class Codex {
    private client: CodexClient;

    constructor(config?: AppServerConfig) {
        this.client = new CodexClient();
    }

    async initialize(): Promise<void> {
        await this.client.initialize();
    }

    async createThread(model: string): Promise<Thread> {
        const response = await this.client.threadStart({ model });
        return new Thread(this.client, response.thread_id);
    }

    async shutdown(): Promise<void> {
        await this.client.shutdown();
    }
}

export class Thread {
    constructor(
        private client: CodexClient,
        private threadId: string
    ) {}

    async run(message: string): Promise<TurnResult> {
        const request: TurnRequest = {
            messages: [{ role: 'user', content: message }],
            stream: false
        };

        const response = await this.client.turn(request);
        return this.processTurnResponse(response);
    }

    async *runStream(message: string): AsyncIterableIterator<TurnItem> {
        const request: TurnRequest = {
            messages: [{ role: 'user', content: message }],
            stream: true
        };

        for await (const item of this.client.turn(request)) {
            yield item;
        }
    }

    private processTurnResponse(response: TurnResponse): TurnResult {
        // 提取最终回答和工具调用
        const finalMessage = response.items
            .filter(item => item.type === 'text')
            .map(item => (item as TextItem).content)
            .join('');

        return {
            final_response: finalMessage || null,
            items: response.items,
            usage: response.usage
        };
    }
}
```

使用示例：

```typescript
// examples/typescript-quickstart.ts
import { Codex } from '@openai/codex-sdk';

async function main() {
    const codex = new Codex();
    await codex.initialize();

    try {
        const thread = await codex.createThread('gpt-4');

        // 简单调用
        const result = await thread.run('Analyze this TypeScript project');
        console.log('Response:', result.final_response);

        // 流式调用
        console.log('\nStreaming response:');
        for await (const item of thread.runStream('Generate unit tests')) {
            if (item.type === 'text') {
                process.stdout.write(item.content);
            } else if (item.type === 'tool_use') {
                console.log(`\n[Tool: ${item.name}]`);
            }
        }

    } finally {
        await codex.shutdown();
    }
}

main().catch(console.error);
```

---

## 18.4 Python Runtime：技能执行的沙箱环境

### 18.4.1 Runtime 架构设计

Python Runtime 是一个特殊的 SDK 组件，专门用于**安全地执行用户定义的技能**：

```python
# sdk/python-runtime/codex_runtime/__init__.py
import sys
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional

class SkillRuntime:
    """Isolated execution environment for Codex skills."""

    def __init__(self, skill_path: Path, sandbox_config: Optional[Dict] = None):
        self.skill_path = skill_path
        self.sandbox_config = sandbox_config or {}
        self.env = self._create_isolated_env()

    def _create_isolated_env(self) -> Dict[str, str]:
        """Create isolated environment variables."""
        env = {
            'PYTHONPATH': str(self.skill_path.parent),
            'CODEX_SKILL_MODE': '1',
            'CODEX_RUNTIME_VERSION': '0.2.0',
        }

        # 限制网络访问（如果配置）
        if self.sandbox_config.get('restrict_network'):
            env['HTTP_PROXY'] = 'localhost:0'  # 无效代理
            env['HTTPS_PROXY'] = 'localhost:0'

        return env

    async def execute_skill(self, skill_name: str, input_data: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a skill in isolated environment."""

        # 1. 验证技能文件
        skill_file = self.skill_path / f"{skill_name}.py"
        if not skill_file.exists():
            raise SkillNotFoundError(f"Skill {skill_name} not found")

        # 2. 准备执行参数
        execution_script = self._generate_execution_script(skill_name, input_data)

        # 3. 在沙箱中执行
        result = await self._run_sandboxed(execution_script)

        return result

    def _generate_execution_script(self, skill_name: str, input_data: Dict[str, Any]) -> str:
        """Generate safe execution script."""
        return f"""
import sys
import json
from pathlib import Path

# 添加技能路径
sys.path.insert(0, '{self.skill_path}')

try:
    # 导入技能模块
    import {skill_name}

    # 执行技能
    if hasattr({skill_name}, 'execute'):
        input_data = {json.dumps(input_data)}
        result = {skill_name}.execute(input_data)
        print(json.dumps({{"success": True, "result": result}}))
    else:
        print(json.dumps({{"success": False, "error": "No execute function found"}}))

except Exception as e:
    print(json.dumps({{"success": False, "error": str(e)}}))
"""

    async def _run_sandboxed(self, script: str) -> Dict[str, Any]:
        """Run script in sandboxed subprocess."""

        # 创建临时脚本文件
        script_file = self.skill_path / "temp_execution.py"
        script_file.write_text(script)

        try:
            # 执行脚本
            proc = await subprocess.create_subprocess_exec(
                sys.executable, str(script_file),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=self.env,
                cwd=self.skill_path
            )

            stdout, stderr = await proc.communicate()

            # 解析结果
            if proc.returncode == 0:
                result = json.loads(stdout.decode())
                return result
            else:
                raise SkillExecutionError(f"Execution failed: {stderr.decode()}")

        finally:
            # 清理临时文件
            script_file.unlink(missing_ok=True)
```

### 18.4.2 技能定义规范

```python
# skill 示例：custom_analyzer.py
"""
自定义代码分析技能
"""
from typing import Dict, Any, List
import ast
import re

def execute(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """技能入口函数 - 必须实现."""

    file_path = input_data.get('file_path')
    analysis_type = input_data.get('type', 'complexity')

    if not file_path:
        return {"error": "file_path is required"}

    try:
        with open(file_path, 'r') as f:
            code = f.read()

        if analysis_type == 'complexity':
            result = analyze_complexity(code)
        elif analysis_type == 'security':
            result = analyze_security(code)
        else:
            result = {"error": f"Unknown analysis type: {analysis_type}"}

        return {
            "file_path": file_path,
            "analysis_type": analysis_type,
            "result": result
        }

    except Exception as e:
        return {"error": str(e)}

def analyze_complexity(code: str) -> Dict[str, Any]:
    """分析代码复杂度."""
    try:
        tree = ast.parse(code)

        complexity_metrics = {
            "functions": 0,
            "classes": 0,
            "lines": len(code.splitlines()),
            "cyclomatic_complexity": 0
        }

        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                complexity_metrics["functions"] += 1
            elif isinstance(node, ast.ClassDef):
                complexity_metrics["classes"] += 1
            elif isinstance(node, (ast.If, ast.For, ast.While, ast.With)):
                complexity_metrics["cyclomatic_complexity"] += 1

        return complexity_metrics

    except SyntaxError:
        return {"error": "Invalid Python syntax"}

def analyze_security(code: str) -> Dict[str, Any]:
    """分析安全问题."""
    security_issues = []

    # 检查常见安全问题
    patterns = {
        "eval_usage": r"eval\s*\(",
        "exec_usage": r"exec\s*\(",
        "shell_injection": r"os\.system\s*\(",
        "sql_injection": r"execute\s*\(\s*[\"'].*%.*[\"']",
    }

    for issue_type, pattern in patterns.items():
        matches = re.finditer(pattern, code)
        for match in matches:
            line_num = code[:match.start()].count('\n') + 1
            security_issues.append({
                "type": issue_type,
                "line": line_num,
                "code": match.group()
            })

    return {
        "issues_found": len(security_issues),
        "issues": security_issues
    }

# 技能元数据
__skill_metadata__ = {
    "name": "custom_analyzer",
    "version": "1.0.0",
    "description": "Custom Python code analyzer",
    "input_schema": {
        "type": "object",
        "properties": {
            "file_path": {"type": "string"},
            "type": {"type": "string", "enum": ["complexity", "security"]}
        },
        "required": ["file_path"]
    }
}
```

### 18.4.3 Runtime 与 App Server 的集成

```rust
// codex-rs/skills/src/python_runtime.rs - Rust 端集成
use tokio::process::Command;
use serde_json::Value;

pub struct PythonSkillExecutor {
    runtime_path: PathBuf,
    sandbox_config: SandboxConfig,
}

impl PythonSkillExecutor {
    pub async fn execute_skill(
        &self,
        skill_name: &str,
        input: Value
    ) -> Result<Value, SkillError> {

        // 1. 准备 Python 运行时环境
        let mut cmd = Command::new("python");
        cmd.arg("-m").arg("codex_runtime.executor")
           .arg("--skill").arg(skill_name)
           .arg("--input").arg(serde_json::to_string(&input)?);

        // 2. 应用沙箱限制
        self.apply_sandbox_restrictions(&mut cmd)?;

        // 3. 执行并收集结果
        let output = cmd.output().await?;

        if output.status.success() {
            let result: Value = serde_json::from_slice(&output.stdout)?;
            Ok(result)
        } else {
            let error = String::from_utf8_lossy(&output.stderr);
            Err(SkillError::ExecutionFailed(error.to_string()))
        }
    }

    fn apply_sandbox_restrictions(&self, cmd: &mut Command) -> Result<(), SkillError> {
        // 限制文件系统访问
        if let Some(allowed_paths) = &self.sandbox_config.allowed_paths {
            for path in allowed_paths {
                cmd.env("CODEX_ALLOWED_PATH", path);
            }
        }

        // 限制网络访问
        if self.sandbox_config.restrict_network {
            cmd.env("CODEX_NO_NETWORK", "1");
        }

        // 设置资源限制
        if let Some(memory_limit) = self.sandbox_config.memory_limit_mb {
            cmd.env("CODEX_MEMORY_LIMIT", memory_limit.to_string());
        }

        Ok(())
    }
}
```

---

## 18.5 App Server 协议：SDK 与核心的通信桥梁

### 18.5.1 JSON-RPC 2.0 协议设计

App Server 使用标准的 JSON-RPC 2.0 协议进行通信，确保跨语言兼容性：

```json
// 请求格式
{
    "jsonrpc": "2.0",
    "id": 123,
    "method": "thread_start",
    "params": {
        "model": "gpt-4",
        "max_turns": 10,
        "tools": [...]
    }
}

// 响应格式
{
    "jsonrpc": "2.0",
    "id": 123,
    "result": {
        "thread_id": "thread_abc123",
        "status": "ready"
    }
}

// 流式数据格式
{
    "jsonrpc": "2.0",
    "method": "turn_stream_data",
    "params": {
        "thread_id": "thread_abc123",
        "item": {
            "type": "text",
            "content": "I'll help you analyze..."
        }
    }
}
```

### 18.5.2 协议方法定义

```rust
// codex-rs/app-server-protocol/src/methods.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "method")]
pub enum AppServerMethod {
    Initialize {
        params: InitializeParams,
    },
    ThreadStart {
        params: ThreadStartParams,
    },
    Turn {
        params: TurnParams,
    },
    Shutdown {
        params: ShutdownParams,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InitializeParams {
    pub client_info: ClientInfo,
    pub capabilities: ClientCapabilities,
    pub config: Option<AppServerConfig>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
    pub language: String,  // "python" | "typescript" | "rust"
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClientCapabilities {
    pub supports_streaming: bool,
    pub supports_tools: bool,
    pub supports_concurrent_threads: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ThreadStartParams {
    pub model: String,
    pub thread_id: Option<String>,
    pub context: Option<ThreadContext>,
    pub tools: Option<Vec<ToolDefinition>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TurnParams {
    pub thread_id: String,
    pub messages: Vec<Message>,
    pub stream: bool,
    pub max_turns: Option<u32>,
}
```

### 18.5.3 错误处理和重试机制

```typescript
// SDK 中的错误处理
export class CodexError extends Error {
    constructor(
        message: string,
        public code: number,
        public data?: any
    ) {
        super(message);
        this.name = 'CodexError';
    }
}

export class RetryableCodexError extends CodexError {
    constructor(message: string, code: number, data?: any) {
        super(message, code, data);
        this.name = 'RetryableCodexError';
    }
}

// 自动重试逻辑
class CodexClient {
    private async sendRequestWithRetry<T>(
        method: string,
        params: any,
        retries = 3
    ): Promise<T> {

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await this.sendRequest(method, params);

            } catch (error) {
                // 判断是否可重试
                if (error instanceof RetryableCodexError && attempt < retries) {
                    const backoff = Math.min(1000 * Math.pow(2, attempt), 5000);
                    await new Promise(resolve => setTimeout(resolve, backoff));
                    continue;
                }

                throw error;
            }
        }

        throw new CodexError('Max retries exceeded', -32603);
    }
}
```

---

## 18.6 构建自定义集成：实战示例

### 18.6.1 数据科学工作流集成

```python
# data_science_integration.py - 数据科学工作流示例
from codex_app_server import AsyncCodex
from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt

class DataScienceAssistant:
    """Codex 驱动的数据科学助手."""

    def __init__(self):
        self.codex = AsyncCodex()
        self.workspace = Path("./analysis_workspace")
        self.workspace.mkdir(exist_ok=True)

    async def __aenter__(self):
        await self.codex.__aenter__()
        self.thread = await self.codex.thread_start(
            model="gpt-4",
            tools=["Read", "Write", "Edit", "Bash"]  # 限制可用工具
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.codex.__aexit__(exc_type, exc_val, exc_tb)

    async def analyze_dataset(self, dataset_path: str) -> dict:
        """分析数据集并生成报告."""

        # 1. 上传数据集到工作空间
        df = pd.read_csv(dataset_path)
        workspace_path = self.workspace / "dataset.csv"
        df.to_csv(workspace_path, index=False)

        # 2. 让 Codex 分析数据
        analysis_prompt = f"""
        请分析位于 {workspace_path} 的数据集：
        1. 生成数据概览和统计信息
        2. 识别数据质量问题
        3. 建议清洗和预处理步骤
        4. 创建可视化图表
        5. 将所有分析结果保存到 analysis_report.md
        """

        result = await self.thread.run(analysis_prompt)

        # 3. 收集生成的文件
        report_files = list(self.workspace.glob("*.md"))
        chart_files = list(self.workspace.glob("*.png"))

        return {
            "analysis_text": result.final_response,
            "report_files": [str(f) for f in report_files],
            "chart_files": [str(f) for f in chart_files],
            "token_usage": result.usage
        }

    async def generate_ml_pipeline(self, target_column: str) -> str:
        """生成机器学习管道代码."""

        ml_prompt = f"""
        基于已分析的数据集，生成一个完整的机器学习管道：
        1. 目标变量：{target_column}
        2. 包含数据预处理、特征工程、模型训练、评估
        3. 使用 scikit-learn 框架
        4. 将代码保存为 ml_pipeline.py
        5. 生成使用说明文档
        """

        result = await self.thread.run(ml_prompt)

        # 返回生成的代码路径
        pipeline_file = self.workspace / "ml_pipeline.py"
        return str(pipeline_file) if pipeline_file.exists() else None

# 使用示例
async def main():
    async with DataScienceAssistant() as assistant:

        # 分析数据集
        analysis = await assistant.analyze_dataset("sales_data.csv")
        print(f"Analysis completed. Generated {len(analysis['chart_files'])} charts.")

        # 生成 ML 管道
        pipeline_file = await assistant.generate_ml_pipeline("sales_amount")
        print(f"ML pipeline saved to: {pipeline_file}")

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
```

### 18.6.2 Web 后端服务集成

```typescript
// web_backend_integration.ts - Express.js 后端集成
import express from 'express';
import { Codex, Thread } from '@openai/codex-sdk';
import { Request, Response } from 'express';

interface CodeReviewRequest {
    repository: string;
    pull_request_id: number;
    review_type: 'security' | 'performance' | 'style' | 'all';
}

interface CodeReviewResponse {
    review_id: string;
    status: 'completed' | 'in_progress' | 'error';
    findings: Array<{
        file: string;
        line: number;
        severity: 'low' | 'medium' | 'high';
        message: string;
        suggestion?: string;
    }>;
    summary: string;
}

class CodeReviewService {
    private codex: Codex;
    private activeReviews = new Map<string, Thread>();

    constructor() {
        this.codex = new Codex({
            model: "gpt-4",
            tools: ["Read", "Grep", "Git", "WebFetch"]  // 代码审查需要的工具
        });
    }

    async initialize(): Promise<void> {
        await this.codex.initialize();
    }

    async startReview(request: CodeReviewRequest): Promise<{ review_id: string }> {
        const reviewId = `review_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // 创建专门的审查线程
        const thread = await this.codex.createThread("gpt-4");
        this.activeReviews.set(reviewId, thread);

        // 在后台开始审查
        this.performReview(reviewId, request).catch(console.error);

        return { review_id: reviewId };
    }

    private async performReview(
        reviewId: string,
        request: CodeReviewRequest
    ): Promise<void> {
        const thread = this.activeReviews.get(reviewId);
        if (!thread) return;

        try {
            // 构建审查提示
            const reviewPrompt = this.buildReviewPrompt(request);

            // 执行代码审查
            const result = await thread.run(reviewPrompt);

            // 解析结果并存储
            const findings = this.parseReviewResults(result.items);
            this.storeReviewResults(reviewId, {
                review_id: reviewId,
                status: 'completed',
                findings,
                summary: result.final_response || "Review completed"
            });

        } catch (error) {
            console.error(`Review ${reviewId} failed:`, error);
            this.storeReviewResults(reviewId, {
                review_id: reviewId,
                status: 'error',
                findings: [],
                summary: `Review failed: ${error.message}`
            });
        }
    }

    private buildReviewPrompt(request: CodeReviewRequest): string {
        const typeInstructions = {
            'security': 'Focus on security vulnerabilities, authentication issues, and data validation',
            'performance': 'Focus on performance bottlenecks, algorithmic efficiency, and resource usage',
            'style': 'Focus on code style, naming conventions, and maintainability',
            'all': 'Perform comprehensive review covering security, performance, and style'
        };

        return `
        Please perform a ${request.review_type} code review of pull request #${request.pull_request_id}
        in repository ${request.repository}.

        ${typeInstructions[request.review_type]}

        For each issue found:
        1. Identify the file and line number
        2. Classify severity (low/medium/high)
        3. Provide a clear explanation
        4. Suggest specific improvements

        Generate a structured summary of all findings.
        `;
    }

    private parseReviewResults(items: any[]): Array<any> {
        // 解析工具调用结果，提取代码审查发现
        const findings = [];

        for (const item of items) {
            if (item.type === 'tool_result' && item.tool_name === 'Grep') {
                // 解析 grep 结果找到问题代码
                const matches = this.extractCodeIssues(item.result);
                findings.push(...matches);
            }
        }

        return findings;
    }

    async getReviewStatus(reviewId: string): Promise<CodeReviewResponse | null> {
        // 从存储中获取审查结果
        return this.getStoredReviewResults(reviewId);
    }

    // 简化的存储实现（实际应该使用数据库）
    private reviewResults = new Map<string, CodeReviewResponse>();

    private storeReviewResults(reviewId: string, results: CodeReviewResponse): void {
        this.reviewResults.set(reviewId, results);
    }

    private getStoredReviewResults(reviewId: string): CodeReviewResponse | null {
        return this.reviewResults.get(reviewId) || null;
    }
}

// Express 路由设置
const app = express();
const reviewService = new CodeReviewService();

app.use(express.json());

// 启动代码审查
app.post('/api/review/start', async (req: Request, res: Response) => {
    try {
        const request = req.body as CodeReviewRequest;
        const result = await reviewService.startReview(request);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 获取审查状态
app.get('/api/review/:reviewId', async (req: Request, res: Response) => {
    try {
        const reviewId = req.params.reviewId;
        const result = await reviewService.getReviewStatus(reviewId);

        if (result) {
            res.json(result);
        } else {
            res.status(404).json({ error: 'Review not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 启动服务
async function startServer() {
    await reviewService.initialize();

    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`Code review service running on port ${port}`);
    });
}

startServer().catch(console.error);
```

### 18.6.3 自定义工具扩展

```python
# custom_tool_extension.py - 扩展自定义工具
from codex_app_server import Codex, ToolDefinition
import requests
import json

class DatabaseQueryTool:
    """自定义数据库查询工具."""

    def __init__(self, db_config: dict):
        self.db_config = db_config

    def to_tool_definition(self) -> ToolDefinition:
        """转换为 Codex 工具定义."""
        return ToolDefinition(
            name="DatabaseQuery",
            description="Execute SQL queries on the configured database",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "SQL query to execute"
                    },
                    "limit": {
                        "type": "integer",
                        "default": 100,
                        "description": "Maximum number of rows to return"
                    }
                },
                "required": ["query"]
            }
        )

    async def execute(self, query: str, limit: int = 100) -> dict:
        """执行数据库查询."""
        try:
            # 这里应该是真正的数据库连接逻辑
            # 为示例简化为 REST API 调用
            response = requests.post(
                f"{self.db_config['api_url']}/query",
                json={"sql": query, "limit": limit},
                headers={"Authorization": f"Bearer {self.db_config['token']}"}
            )

            if response.status_code == 200:
                data = response.json()
                return {
                    "success": True,
                    "rows": data.get("rows", []),
                    "row_count": len(data.get("rows", [])),
                    "query": query
                }
            else:
                return {
                    "success": False,
                    "error": f"Database error: {response.text}"
                }

        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }

class SlackNotificationTool:
    """Slack 通知工具."""

    def __init__(self, webhook_url: str):
        self.webhook_url = webhook_url

    def to_tool_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="SlackNotify",
            description="Send notifications to Slack channels",
            input_schema={
                "type": "object",
                "properties": {
                    "channel": {
                        "type": "string",
                        "description": "Slack channel name (without #)"
                    },
                    "message": {
                        "type": "string",
                        "description": "Message to send"
                    },
                    "priority": {
                        "type": "string",
                        "enum": ["low", "normal", "high", "urgent"],
                        "default": "normal"
                    }
                },
                "required": ["channel", "message"]
            }
        )

    async def execute(self, channel: str, message: str, priority: str = "normal") -> dict:
        """发送 Slack 通知."""
        try:
            # 根据优先级设置样式
            color_map = {
                "low": "#36a64f",      # green
                "normal": "#2eb886",   # blue
                "high": "#ff9500",     # orange
                "urgent": "#ff0000"    # red
            }

            payload = {
                "channel": f"#{channel}",
                "attachments": [{
                    "color": color_map.get(priority, "#2eb886"),
                    "text": message,
                    "footer": "Codex Assistant",
                    "ts": int(time.time())
                }]
            }

            response = requests.post(self.webhook_url, json=payload)

            if response.status_code == 200:
                return {
                    "success": True,
                    "message": "Notification sent successfully"
                }
            else:
                return {
                    "success": False,
                    "error": f"Slack API error: {response.text}"
                }

        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }

# 使用自定义工具的集成示例
class ExtendedCodexAssistant:
    """扩展了自定义工具的 Codex 助手."""

    def __init__(self, db_config: dict, slack_webhook: str):
        self.db_tool = DatabaseQueryTool(db_config)
        self.slack_tool = SlackNotificationTool(slack_webhook)
        self.codex = None

    async def __aenter__(self):
        # 创建带自定义工具的 Codex 实例
        self.codex = Codex(
            custom_tools=[
                self.db_tool.to_tool_definition(),
                self.slack_tool.to_tool_definition()
            ]
        )

        await self.codex.__aenter__()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.codex:
            await self.codex.__aexit__(exc_type, exc_val, exc_tb)

    async def analyze_user_activity(self) -> dict:
        """分析用户活动并发送报告."""
        thread = await self.codex.thread_start(model="gpt-4")

        analysis_prompt = """
        请帮我分析用户活动数据：
        1. 查询最近 7 天的活跃用户数量
        2. 分析用户行为趋势
        3. 识别异常活动模式
        4. 将分析结果发送到 #analytics 频道

        使用 DatabaseQuery 工具查询数据，使用 SlackNotify 工具发送通知。
        """

        result = await thread.run(analysis_prompt)
        return {
            "analysis": result.final_response,
            "actions_taken": [
                item for item in result.items
                if item.type == "tool_use"
            ]
        }

# 使用示例
async def main():
    db_config = {
        "api_url": "https://api.mycompany.com/db",
        "token": "your-db-token"
    }

    slack_webhook = "https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK"

    async with ExtendedCodexAssistant(db_config, slack_webhook) as assistant:
        result = await assistant.analyze_user_activity()
        print("Analysis completed:", result)

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
```

---

## 小结

Codex CLI 的 SDK 体系展现了一个精心设计的多语言生态系统：

| 组件 | 核心价值 | 技术亮点 |
|------|---------|----------|
| **Python SDK** | 数据科学友好 | 同步/异步双 API + Pydantic 类型安全 |
| **TypeScript SDK** | 企业集成便利 | 完整类型生成 + Promise-based 流式 |
| **Python Runtime** | 安全技能执行 | 沙箱隔离 + 生命周期管理 |
| **App Server 协议** | 跨语言统一 | JSON-RPC 2.0 + 自动重试 + 错误处理 |

这种设计的精妙之处在于**分层抽象的一致性**：
1. **协议层**保证跨语言兼容
2. **SDK层**提供语言原生体验
3. **应用层**支持任意复杂度的集成

在下一章中，我们将进行最终的对比分析，深入探讨 Codex CLI 与 Claude Code 在设计理念、技术选型和产品策略上的根本差异，帮助读者理解两种架构哲学的适用场景。

> **给集成开发者的建议**：选择 SDK 时要考虑具体场景：Python SDK 适合数据处理和快速原型，TypeScript SDK 适合 Web 服务和企业集成，Python Runtime 适合需要沙箱安全的自定义技能。三者可以在同一个项目中组合使用，发挥各自优势。