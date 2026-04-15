/** ch15 — 代码执行与子 Agent 委派 */
import StageFlow from '../shared/StageFlow';
import type { Stage } from '../shared/StageFlow';
const stages: Stage[] = [
  { title: '① PTC 沙箱', subtitle: 'Python Tool Code', section: '§15.2', detail: 'code_exec 工具在独立进程中执行用户代码。通过 Unix Domain Socket（UDS）RPC 通信——主进程发送代码字符串，沙箱进程执行并返回 stdout/stderr/return_value。', funcs: ['code_exec()', 'UDS RPC', 'subprocess isolation'] },
  { title: '② ToolContext 传递', subtitle: 'reward function 的秘密武器', section: '§15.3', detail: 'ToolContext 允许沙箱中的代码调用 Agent 的工具——如在 reward function 中运行 pytest 验证代码正确性。这是 Hermes RL 训练的关键能力：端到端验证而非字符串匹配。', funcs: ['ToolContext', 'context.terminal()', 'reward_function'] },
  { title: '③ 子 Agent 委派', subtitle: 'delegate_tool', section: '§15.4', detail: 'delegate 工具创建一个子 AIAgent 实例处理子任务。子 Agent 有独立的上下文窗口、独立的工具集，但共享父 Agent 的凭据池和记忆存储。任务完成后结果返回父 Agent。', funcs: ['delegate()', 'AIAgent(parent=self)', 'task isolation'] },
  { title: '④ 隔离与通信', subtitle: '单向数据流', section: '§15.5', detail: '子 Agent 不能修改父 Agent 的消息历史。通信是单向的——父→子传递任务描述，子→父返回结果字符串。这防止了子 Agent 的错误污染父会话上下文。', funcs: ['result_string', 'context isolation', 'daemon thread'] },
];
export default function CodeExecDelegation() { return <StageFlow stages={stages} playLabel="播放委派流程" />; }
