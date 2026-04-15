/**
 * SystemPromptFlow — ch06 interactive flow: 七层 System Prompt 组装过程
 * Migrated from rc-flow HTML+JS in the original mdBook.
 */
import StageFlow from '../shared/StageFlow';
import type { Stage } from '../shared/StageFlow';

const stages: Stage[] = [
  {
    title: 'L1 · Agent 身份',
    subtitle: 'SOUL.md 或 DEFAULT_AGENT_IDENTITY',
    section: '200–2,000 tokens',
    detail:
      'Agent 身份的来源有两个：<code>SOUL.md</code>（用户可定制人格）和硬编码的 <code>DEFAULT_AGENT_IDENTITY</code>。SOUL.md 优先且是<strong>替换</strong>而非追加——完全控制 Agent 的"灵魂"。默认身份的最后一句"Be targeted and efficient"与迭代预算机制形成配合。',
    funcs: ['load_soul_md()', 'DEFAULT_AGENT_IDENTITY', 'prompt_builder.py:133'],
  },
  {
    title: 'L2 · 工具行为指导',
    subtitle: 'MEMORY / SKILLS / TOOL_USE 按模型注入',
    section: '500–2,000 tokens',
    detail:
      '根据 Agent 加载了哪些工具，按需注入对应指导。<code>MEMORY_GUIDANCE</code> 定义记忆质量标准——"记住那些能减少用户未来纠正次数的东西"。<code>SKILLS_GUIDANCE</code> 驱动技能创建和修补的闭环。只注入已加载工具的指导，避免浪费上下文空间。',
    funcs: ['MEMORY_GUIDANCE', 'SESSION_SEARCH_GUIDANCE', 'SKILLS_GUIDANCE'],
  },
  {
    title: 'L3 · 工具执行力',
    subtitle: 'GPT/Gemini 专用强制工具使用指令',
    section: '按模型条件注入',
    detail:
      'GPT/Codex/Gemini 等模型倾向于<em>描述计划</em>而非<em>执行行动</em>。此层注入 <code>TOOL_USE_ENFORCEMENT_GUIDANCE</code> 强制要求"说了就做"。Claude 系列天然积极使用工具，不注入此层。GPT 还有额外的 XML 标签指令。',
    funcs: ['TOOL_USE_ENFORCEMENT_GUIDANCE', 'TOOL_USE_ENFORCEMENT_MODELS', 'OPENAI_MODEL_EXECUTION_GUIDANCE'],
  },
  {
    title: 'L4 · 用户/网关 System Prompt',
    subtitle: 'CLI 配置 / Gateway 平台消息',
    section: '0–1,000 tokens · 可选',
    detail:
      '来自调用者的自定义 System Prompt——CLI 从用户配置读取，Gateway 从平台消息提取。<strong>追加</strong>而非替换，保留前面所有层。注意 <code>ephemeral_system_prompt</code> 不在此处注入，它在消息准备流水线中追加，不进入缓存。',
    funcs: ['system_message', 'ephemeral_system_prompt'],
  },
  {
    title: 'L5 · 记忆快照',
    subtitle: 'MEMORY.md + USER.md + 外部 provider',
    section: '500–1,500 tokens',
    detail:
      '内置记忆（<code>MEMORY.md</code> / <code>USER.md</code>）和外部记忆提供商（Honcho、mem0）叠加注入。记忆内容在此刻被"<strong>冻结</strong>"——会话中写入的新记忆不会更新 System Prompt，直到压缩触发重建。这是 prompt caching 的刚性需求。',
    funcs: ['_memory_store.format_for_system_prompt()', '_memory_manager.build_system_prompt()'],
  },
  {
    title: 'L6 · 技能索引',
    subtitle: '78 个 SKILL 的 Tier 1 摘要',
    section: '1,000–3,000 tokens',
    detail:
      '加载所有 SKILL.md 的 Tier 1 信息（标题 + 一句话描述），构建紧凑的技能目录。78 个技能的完整内容无法放入上下文，但标题让模型知道"能做什么"，需要时通过 <code>skill_view</code> 加载完整内容（三级渐进式披露）。',
    funcs: ['build_skills_system_prompt()', 'skills_list', 'skill_view'],
  },
  {
    title: 'L7 · 上下文 · 时间 · 平台',
    subtitle: 'AGENTS.md + 时间戳 + PLATFORM_HINTS',
    section: '50–5,200 tokens',
    detail:
      '上下文文件（AGENTS.md、.cursorrules、.hermes.md）提供项目级指令。时间戳让模型知道"现在"。<code>PLATFORM_HINTS</code> 为 15 个平台定制格式指导——WhatsApp 用纯文本，Cron 模式告诉模型"没有用户在场，完全自主执行"。上下文文件硬限 20,000 字符。',
    funcs: ['build_context_files_prompt()', 'PLATFORM_HINTS', 'CONTEXT_FILE_MAX_CHARS'],
  },
];

export default function SystemPromptFlow() {
  return <StageFlow stages={stages} playLabel="播放组装" />;
}
