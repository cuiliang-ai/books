/**
 * MemoryFlow — ch17 interactive flow: 记忆从写入到生效的完整链路
 * Migrated from rc-flow HTML+JS in the original mdBook.
 */
import StageFlow from '../shared/StageFlow';
import type { Stage } from '../shared/StageFlow';

const stages: Stage[] = [
  {
    title: '① 磁盘加载',
    subtitle: 'load_from_disk()',
    section: '§17.3 MemoryStore',
    detail:
      'Hermes 启动时，<code>MemoryStore.load_from_disk()</code> 从 <code>~/.hermes/memories/</code> 读取 MEMORY.md 和 USER.md，用 <code>§</code> 分隔符解析为条目列表。<strong>去重逻辑</strong>用 <code>dict.fromkeys()</code> 保持顺序并去除精确重复——防止多进程并发写入导致的条目堆积。',
    funcs: ['load_from_disk()', '_read_file()', 'dict.fromkeys()'],
  },
  {
    title: '② 冻结快照',
    subtitle: '_system_prompt_snapshot',
    section: '核心设计决策',
    detail:
      '加载完成后，当前状态被拍成<strong>冻结快照</strong>（<code>_system_prompt_snapshot</code>）。此后无论 Agent 怎么修改记忆，快照都不变。<br><br><strong>为什么冻结？</strong>现代 LLM API 支持 prefix caching——如果 system prompt 不变，API 可以缓存 KV cache，每轮只处理新消息。实时更新记忆会使 cache 失效，增加延迟和成本。',
    funcs: ['_system_prompt_snapshot', 'prefix caching'],
  },
  {
    title: '③ 注入 System Prompt',
    subtitle: 'format_for_system_prompt()',
    section: '§6 章 System Prompt 第 3 层',
    detail:
      '<code>format_for_system_prompt()</code> 返回冻结快照（不是活跃状态），由 <code>_build_system_prompt()</code> 注入到第 6 章的七层 System Prompt 中。MEMORY.md 默认限 <strong>2200 字符</strong>，USER.md 默认限 <strong>1375 字符</strong>——用字符而非 token，因为字符计数与模型无关。',
    funcs: ['format_for_system_prompt()', '_build_system_prompt()'],
  },
  {
    title: '④ 会话中修改',
    subtitle: 'add / replace / remove',
    section: '§17.5 记忆操作',
    detail:
      'Agent 通过 <code>memory</code> 工具执行 <strong>add</strong>（追加）、<strong>replace</strong>（子串匹配替换）、<strong>remove</strong>（子串匹配删除）。修改立刻反映在工具返回值中（Agent 看到最新状态），但<strong>不更新</strong> system prompt 中的冻结快照。写入前经过注入检测（§17.6）。',
    funcs: ['add()', 'replace()', 'remove()', '_scan_memory_content()'],
  },
  {
    title: '⑤ 写入磁盘',
    subtitle: '原子写入 + 文件锁',
    section: '§17.4 原子写入',
    detail:
      '修改通过<strong>文件锁</strong>（<code>fcntl.flock</code>）+ <strong>原子替换</strong>（<code>tempfile.mkstemp</code> → <code>os.replace</code>）写入磁盘。锁文件和数据文件分开（<code>MEMORY.md.lock</code>），避免替换操作使锁失效。读者永远看到完整文件，没有中间状态。',
    funcs: ['_file_lock()', '_write_file()', 'os.replace()', 'os.fsync()'],
  },
  {
    title: '⑥ 下次会话生效',
    subtitle: '新快照 = 最新磁盘状态',
    section: '冻结快照模式',
    detail:
      '下次启动时 <code>load_from_disk()</code> 重新执行，读取磁盘上的最新内容，生成新快照。<strong>上次会话中的修改此时才对 system prompt 可见</strong>。这是一个性能（prefix cache 稳定）与一致性（延迟一个会话）之间的精确权衡。',
    funcs: ['load_from_disk()', '_system_prompt_snapshot'],
  },
];

export default function MemoryFlow() {
  return <StageFlow stages={stages} playLabel="播放流程" loopStageIndex={3} />;
}
