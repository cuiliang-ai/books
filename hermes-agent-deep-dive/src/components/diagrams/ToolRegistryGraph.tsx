/**
 * ToolRegistryGraph — ch10 工具自注册→发现→调度的流程
 */
import StageFlow from '../shared/StageFlow';
import type { Stage } from '../shared/StageFlow';

const stages: Stage[] = [
  { title: '① 声明式注册', subtitle: '@register_tool 装饰器', section: '§10.2', detail: '每个工具文件用 <code>@register_tool</code> 装饰器声明工具名、描述和参数 schema。装饰器在 import 时自动将工具元数据注册到全局 <code>ToolRegistry</code> 单例。零配置，零手动接线。', funcs: ['@register_tool', 'ToolRegistry', 'ToolEntry'] },
  { title: '② 工具发现', subtitle: '_discover_tools()', section: '§10.3', detail: '<code>_discover_tools()</code> 遍历 <code>tools/</code> 目录，动态 import 所有工具模块，触发 <code>@register_tool</code> 装饰器执行。发现完成后，ToolRegistry 持有所有可用工具的完整列表。', funcs: ['_discover_tools()', 'importlib.import_module()', 'tools/*.py'] },
  { title: '③ Toolset 解析', subtitle: 'resolve_toolset()', section: '§10.4 → ch11', detail: '用户配置的 toolset（如 "default"、"code + web"）被解析为具体的工具列表。Toolset 支持集合运算——并集(+)、差集(-)、交集(&)。解析结果是一个工具名集合。', funcs: ['resolve_toolset()', 'toolsets.py', 'ToolsetDefinition'] },
  { title: '④ Schema 生成', subtitle: 'get_tool_schemas()', section: '§10.5', detail: '根据已解析的工具列表，生成 OpenAI function calling 格式的 schema 数组。每个 schema 包含 name、description、parameters（JSON Schema）。这个数组随 API 请求发送给模型。', funcs: ['get_tool_schemas()', 'function calling', 'JSON Schema'] },
  { title: '⑤ 调用分发', subtitle: '_execute_tool_calls()', section: '§10.6', detail: '模型返回 tool_calls 后，按 name 在 ToolRegistry 中查找对应的处理函数并执行。结果序列化为 JSON 字符串，作为 tool role 消息注入对话历史。支持并行工具调用。', funcs: ['_execute_tool_calls()', 'registry.get(name)', 'tool_result()'] },
];

export default function ToolRegistryGraph() {
  return <StageFlow stages={stages} playLabel="播放注册→调度链" />;
}
