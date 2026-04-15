/**
 * ExtensionGuideFlow — ch28 扩展指南步骤向导
 */
import StageFlow from '../shared/StageFlow';
import type { Stage } from '../shared/StageFlow';

const stages: Stage[] = [
  {
    title: '① 新增工具',
    subtitle: '最常见的扩展方式',
    section: '§28.1',
    detail: '在 tools/ 目录新建模块，用 @tool 装饰器注册。定义 TOOL_SCHEMA（JSON Schema）和执行函数。工具自动被 ToolRegistry 发现和注册——无需修改注册中心。支持同步和异步执行函数。',
    funcs: ['@tool decorator', 'TOOL_SCHEMA', 'ToolRegistry.discover()', 'async def execute()'],
  },
  {
    title: '② 新增平台适配器',
    subtitle: '连接新的聊天平台',
    section: '§28.2',
    detail: '继承 BasePlatformAdapter，实现三个抽象方法：connect()、disconnect()、send()。在 platforms/__init__.py 注册。消息归一化为 MessageEvent，发送结果包装为 SendResult。可选覆盖 9 个钩子方法。',
    funcs: ['BasePlatformAdapter', 'connect()', 'disconnect()', 'send()', 'MessageEvent'],
  },
  {
    title: '③ 新增终端后端',
    subtitle: '支持新的执行环境',
    section: '§28.3',
    detail: '继承 BaseEnvironment，实现 execute_command() 和 lifecycle 方法（start/stop/cleanup）。在 terminal/backends/ 注册。通过 config.yaml 的 terminal.backend 字段选择。所有后端共享统一的命令执行接口。',
    funcs: ['BaseEnvironment', 'execute_command()', 'start()', 'stop()', 'cleanup()'],
  },
  {
    title: '④ 新增模型适配器',
    subtitle: '支持新的 LLM 提供商',
    section: '§28.4',
    detail: '继承 BaseModelAdapter，实现 chat_completion() 和 streaming 方法。在 PROVIDER_REGISTRY 注册。需要处理消息格式转换（统一格式→提供商特定格式）和认证流程。',
    funcs: ['BaseModelAdapter', 'chat_completion()', 'PROVIDER_REGISTRY', 'auth flow'],
  },
  {
    title: '⑤ 新增 Skill',
    subtitle: '可复用的能力模块',
    section: '§28.5',
    detail: '在 ~/.hermes/skills/ 或项目目录创建 Skill YAML 文件。定义触发条件、提示模板、依赖工具。Skill 系统自动发现并按需注入 System Prompt。支持平台过滤和安全检查。',
    funcs: ['skill.yaml', 'trigger conditions', 'prompt template', 'auto-discovery'],
  },
];

export default function ExtensionGuideFlow() {
  return <StageFlow stages={stages} playLabel="播放扩展指南" />;
}
