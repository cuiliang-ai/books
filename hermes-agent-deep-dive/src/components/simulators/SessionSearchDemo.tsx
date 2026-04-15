/**
 * SessionSearchDemo — ch19 Session Search 五步流水线交互演示
 */
import StageFlow from '../shared/StageFlow';
import type { Stage } from '../shared/StageFlow';

const stages: Stage[] = [
  {
    title: '① FTS5 查询',
    subtitle: '全文搜索匹配',
    section: '§19.3',
    detail: '用户查询经 _sanitize_fts5_query() 净化后，通过 FTS5 MATCH 在 messages_fts 虚拟表中执行全文搜索。BM25 排序确保最相关的消息排在前面。支持 role_filter 限制搜索范围。',
    funcs: ['FTS5 MATCH', 'BM25()', '_sanitize_fts5_query()', 'role_filter'],
  },
  {
    title: '② 会话去重',
    subtitle: '委派链解析',
    section: '§19.3',
    detail: '搜索结果按 session_id 分组。对每个会话调用 _resolve_to_parent() 沿 parent_session_id 链回溯到根会话（带 visited 集合防循环）。相同根会话的结果合并去重，避免压缩链产生的重复。',
    funcs: ['_resolve_to_parent()', 'parent_session_id', 'visited set', 'dedup'],
  },
  {
    title: '③ 加载与截断',
    subtitle: '上下文窗口友好',
    section: '§19.4',
    detail: '加载完整会话对话历史，_format_conversation() 将消息格式化为 "role: content" 文本。若超过 MAX_SESSION_CHARS (100K)，_truncate_around_matches() 在首个匹配位置周围截取 ±50K 字符的窗口，加截断标记。',
    funcs: ['_format_conversation()', '_truncate_around_matches()', 'MAX_SESSION_CHARS=100K'],
  },
  {
    title: '④ 并行 LLM 摘要',
    subtitle: 'asyncio.gather',
    section: '§19.5-6',
    detail: '对每个会话独立创建 LLM 摘要任务（temperature=0.1），通过 asyncio.gather() 并行执行。3 次重试带递增延迟(1s/2s/3s)。失败则优雅降级——返回原始文本前 500 字符作为预览。',
    funcs: ['asyncio.gather()', '_summarize_session()', 'temperature=0.1', 'graceful fallback'],
  },
  {
    title: '⑤ 结构化返回',
    subtitle: '工具结果输出',
    section: '§19.7',
    detail: '最终结果按 SESSION_SEARCH_SCHEMA 结构化返回：每个会话包含 session_id、title、summary、relevance_score。Schema 的 description 字段包含行为引导——告诉 Agent 如何解读和使用搜索结果。',
    funcs: ['SESSION_SEARCH_SCHEMA', 'session_id', 'summary', 'relevance_score'],
  },
];

export default function SessionSearchDemo() {
  return <StageFlow stages={stages} playLabel="播放搜索流程" />;
}
