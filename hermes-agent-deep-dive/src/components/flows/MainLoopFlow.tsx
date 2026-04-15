/**
 * MainLoopFlow — ch05 interactive flow: run_conversation() 六阶段执行过程
 * Migrated from rc-flow HTML+JS in the original mdBook.
 */
import StageFlow from '../shared/StageFlow';
import type { Stage } from '../shared/StageFlow';

const stages: Stage[] = [
  {
    title: '① 入口仪式',
    subtitle: '_install_safe_stdio → IterationBudget',
    section: '详见 §5.2',
    detail:
      '方法的前 300 行全是防御性初始化。<code>_install_safe_stdio()</code> 确保 stdout/stderr 不会因编码崩溃；<code>_restore_primary_runtime()</code> 将 fallback 模型恢复到主模型；<code>_sanitize_surrogates()</code> 清洗孤立代理字符。核心思想：<strong>不信任调用者的环境状态</strong>，每次进入都完整重置。',
    funcs: ['_install_safe_stdio()', '_restore_primary_runtime()', '_sanitize_surrogates()', 'IterationBudget'],
  },
  {
    title: '② System Prompt',
    subtitle: '缓存 / SQLite 恢复 / 从头构建',
    section: '详见 §5.3 · 第 6 章',
    detail:
      'System Prompt 构建成本高（7 层组装），采用"一次构建，整会话复用"策略。Gateway 模式下从 SQLite 恢复上次的 System Prompt，确保 Anthropic prompt cache 的前缀匹配命中。',
    funcs: ['_build_system_prompt()', '_cached_system_prompt', 'SessionDB.get_session()'],
  },
  {
    title: '③ 入口预压缩',
    subtitle: 'estimate_tokens → _compress_context × 3',
    section: '详见 §5.4 · 第 7 章',
    detail:
      '进入主循环前检查上下文长度。关键场景：用户从 200K 上下文的 Claude 切换到 64K 本地模型，会话历史已积累 150K tokens。预压缩最多 3 轮，防止首次 API 调用因上下文溢出返回 4xx 错误。',
    funcs: ['estimate_request_tokens_rough()', '_compress_context()', 'threshold_tokens'],
  },
  {
    title: '④ 插件钩子',
    subtitle: 'pre_llm_call → 注入用户消息',
    section: '详见 §5.5',
    detail:
      '<code>pre_llm_call</code> 钩子让第三方插件注入额外上下文（RAG 检索结果、外部知识库）。关键约束：插件上下文注入到<strong>用户消息</strong>中而非 System Prompt——保护缓存前缀不被破坏。',
    funcs: ['invoke_hook("pre_llm_call")', 'plugin_user_context'],
  },
  {
    title: '⑤ 主循环',
    subtitle: 'LLM 调用 → 工具执行 → 结果注入',
    section: '详见 §5.6–5.12',
    detail:
      'Agent 的核心心跳。每次迭代：中断检查 → 预算消耗 → 消息准备流水线 → API 调用（始终流式，90s 静默检测）→ 响应验证（三分支）→ finish_reason。工具调用则执行并注入结果；<code>stop</code> 则跳出。预算耗尽时注入"请总结"并允许一次恩典调用。',
    funcs: [
      '_interruptible_streaming_api_call()',
      '_execute_tool_calls()',
      '_sanitize_api_messages()',
      'iteration_budget',
    ],
  },
  {
    title: '⑥ 后处理',
    subtitle: '记忆 · 轨迹 · 持久化 · 技能推送',
    section: '详见 §5.14',
    detail:
      '循环结束后的清理和持久化。记忆刷新写入磁盘；轨迹保存写入 JSONL（供 RL 训练）；会话增量写入 SQLite；技能推送在工具密集轮次中提示创建 Skill。每一步都在为<strong>下一次会话</strong>做准备。',
    funcs: ['_flush_messages_to_session_db()', 'save_trajectories', '_skill_nudge_interval'],
  },
];

export default function MainLoopFlow() {
  return <StageFlow stages={stages} playLabel="播放流程" loopStageIndex={4} />;
}
