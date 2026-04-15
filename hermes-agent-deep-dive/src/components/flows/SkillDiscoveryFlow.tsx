/**
 * SkillDiscoveryFlow — ch18 interactive flow: Skill 从发现到使用的完整链路
 * Migrated from rc-flow HTML+JS in the original mdBook.
 */
import StageFlow from '../shared/StageFlow';
import type { Stage } from '../shared/StageFlow';

const stages: Stage[] = [
  {
    title: '① 扫描发现',
    subtitle: '_find_all_skills()',
    section: '§18.4 Skill 发现与平台过滤',
    detail:
      '<code>_find_all_skills()</code> 递归扫描 <code>~/.hermes/skills/</code> 及配置的外部目录，收集所有 <code>SKILL.md</code> 文件。解析每个文件的 YAML frontmatter 提取 name、description、platforms 等元数据。<strong>容错设计</strong>：如果 YAML 格式错误，自动回退到逐行 <code>key: value</code> 解析，宁可拿到不完美的元数据也不丢掉整个 Skill。',
    funcs: ['_find_all_skills()', 'parse_frontmatter()', "rglob('SKILL.md')"],
  },
  {
    title: '② 平台过滤',
    subtitle: 'skill_matches_platform()',
    section: '§18.4 平台兼容性',
    detail:
      'Skill 可在 frontmatter 中声明 <code>platforms: [macos, linux]</code>。<code>PLATFORM_MAP</code> 将人类友好的名称映射到 <code>sys.platform</code> 前缀：macos→darwin、linux→linux、windows→win32。<strong>不匹配的 Skill 被静默跳过</strong>，Windows 用户不会看到 macOS 专属的 Apple Notes Skill。同时检查 <code>disabled_skills</code> 配置（支持全局禁用和平台特定禁用）。',
    funcs: ['skill_matches_platform()', 'PLATFORM_MAP', 'disabled_skills'],
  },
  {
    title: '③ 渐进式披露',
    subtitle: 'Tier 0 → 1 → 2 → 3',
    section: '§18.3 三级渐进式披露',
    detail:
      '这是 Skills 系统最核心的设计。Agent 按需逐层加载：<br><br><strong>Tier 0</strong> <code>skills_categories()</code> — 只看分类名称，token 极低<br><strong>Tier 1</strong> <code>skills_list()</code> — 所有 Skill 的 name + description<br><strong>Tier 2</strong> <code>skill_view(name)</code> — 完整 SKILL.md 内容<br><strong>Tier 3</strong> <code>skill_view(name, file)</code> — 链接的参考文档/模板<br><br>这解决了"78 个 Skill 全文放不进 200K 上下文窗口"的根本矛盾。',
    funcs: ['skills_categories()', 'skills_list()', 'skill_view()'],
  },
  {
    title: '④ 安全检查',
    subtitle: '注入检测 + 路径遍历防护',
    section: '§18.7 安全检查',
    detail:
      '<code>skill_view</code> 在返回内容前执行两层检查。<strong>注入模式检测</strong>：扫描 9 种 prompt injection 模式（"ignore previous instructions" 等），检测到时<strong>发出警告而非阻止</strong>——因为 Skill 可能合法地讨论注入（如 red-teaming Skill）。<strong>路径遍历防护</strong>：对链接文件检查 <code>..</code> 路径组件 + 解析后的绝对路径验证，双重防御 symlink 和 Unicode 攻击。',
    funcs: ['_INJECTION_PATTERNS', 'has_traversal_component', 'validate_within_dir'],
  },
  {
    title: '⑤ 注入上下文',
    subtitle: 'slash 命令 / --skill 预加载',
    section: '§18.5 Slash 命令系统',
    detail:
      'Skill 通过两种方式进入 Agent 上下文：<br><br><strong>Slash 命令</strong>（<code>/axolotl fine-tune my model</code>）— <code>build_skill_invocation_message()</code> 加载 Skill 内容，附带激活注释，作为<strong>单条用户消息</strong>注入。<br><br><strong>--skill 预加载</strong>（<code>hermes --skill axolotl</code>）— 在会话开始时将 Skill 注入 <strong>system prompt</strong>，全程有效而非单条消息。',
    funcs: ['scan_skill_commands()', 'build_skill_invocation_message()', '--skill'],
  },
  {
    title: '⑥ Agent 执行',
    subtitle: '按指令操作 → 可能创建新 Skill',
    section: '§18.5 + §20 章学习循环',
    detail:
      'Agent 收到 Skill 指令后按步骤执行。如果执行过程中发现了更好的方法或遇到了需要变通的情况，第 20 章的<strong>影子 Agent</strong> 可能会在后台自动更新或创建新的 Skill（通过 <code>skill_manage</code> 工具）。<br><br>这形成了一个<strong>闭环</strong>：Skill 指导执行 → 执行产生经验 → 经验提炼为新 Skill → 新 Skill 指导下次执行。',
    funcs: ['skill_manage()', '_spawn_background_review()', 'SKILL.md'],
  },
];

export default function SkillDiscoveryFlow() {
  return <StageFlow stages={stages} playLabel="播放流程" loopStageIndex={5} />;
}
