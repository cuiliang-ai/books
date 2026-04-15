/**
 * ContextCompressorDemo — ch07 上下文压缩 4 层可视化
 */
import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import StageFlow from '../shared/StageFlow';
import type { Stage } from '../shared/StageFlow';

const stages: Stage[] = [
  { title: '① 阈值检测', subtitle: 'estimate_request_tokens_rough()', section: '§7.2', detail: '估算当前消息列表的 token 总量。使用近似公式（字符数 × 系数）快速计算，避免精确 tokenize 的高成本。当估算值超过模型 context_window 的 80% 时触发压缩。', funcs: ['estimate_request_tokens_rough()', 'threshold_tokens', 'context_window'] },
  { title: '② 策略选择', subtitle: 'ContextEngine.compress()', section: '§7.3', detail: '可插拔的压缩策略。内置引擎使用 LLM 生成摘要——将旧消息压缩为 1-2 段总结，保留关键信息丢弃细节。压缩后的摘要替换原始消息，释放上下文空间。', funcs: ['ContextEngine', '_compress_context()', 'summary_prompt'] },
  { title: '③ 迭代压缩', subtitle: '最多 3 轮', section: '§7.4', detail: '压缩不一定一次到位。如果压缩后仍超阈值（如从 200K 切到 64K 模型），循环最多执行 3 轮。每轮压缩比约 3-5x。3 轮足以处理 200K→64K 的极端场景。', funcs: ['max_compression_rounds=3', 'while tokens > threshold'] },
  { title: '④ 副作用处理', subtitle: '重建 System Prompt', section: '§7.5', detail: '压缩触发 System Prompt 重建——因为记忆可能已在会话中更新，重建后可以包含最新记忆。这是冻结快照模式的唯一刷新时机。同时更新 _cached_system_prompt。', funcs: ['_build_system_prompt()', '_cached_system_prompt', '_memory_store.load_from_disk()'] },
];

export default function ContextCompressorDemo() {
  return <StageFlow stages={stages} playLabel="播放压缩流程" />;
}
