/** ch14 — Browser 自动化与 MCP 协议链路 */
import StageFlow from '../shared/StageFlow';
import type { Stage } from '../shared/StageFlow';
const stages: Stage[] = [
  { title: '① 无视觉浏览器', subtitle: 'Playwright + Accessibility Tree', section: '§14.2', detail: '不截图、不用视觉模型——通过 Playwright 的 <code>accessibility.snapshot()</code> 获取页面的无障碍树（AX Tree），将 DOM 转换为文本结构。模型看到的是按钮、链接、输入框的语义描述，而非像素。', funcs: ['browser_action()', 'accessibility.snapshot()', 'Playwright'] },
  { title: '② 动作映射', subtitle: '8 种浏览器动作', section: '§14.3', detail: '支持 navigate/click/type/scroll/screenshot/get_text/execute_js/wait 八种动作。每个动作对应 Playwright 的 API 调用。元素通过 AX Tree 中的 role+name 定位，无需 CSS 选择器。', funcs: ['navigate', 'click', 'type', 'scroll', 'get_text'] },
  { title: '③ MCP 客户端', subtitle: 'Model Context Protocol', section: '§14.4', detail: 'MCP 将外部工具服务器抽象为标准化接口。Hermes 作为 MCP Client 连接任意 MCP Server（如数据库、API 网关）。通过 stdio 或 SSE 传输，自动发现并注册远程工具。', funcs: ['MCPClient', 'stdio transport', 'tools/list', 'tools/call'] },
  { title: '④ 工具注册集成', subtitle: 'mcp_{server}_前缀', section: '§14.5', detail: 'MCP 服务器的工具自动注册到 ToolRegistry，加上 <code>mcp_servername_</code> 前缀避免冲突。每个 MCP 服务器形成独立的 toolset，可通过 resolve_toolset() 按需加载。', funcs: ['mcp_{server}_prefix', 'ToolRegistry.register()', 'toolset isolation'] },
];
export default function BrowserMCPFlow() { return <StageFlow stages={stages} playLabel="播放链路" />; }
