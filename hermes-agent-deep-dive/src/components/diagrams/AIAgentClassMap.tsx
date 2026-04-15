/**
 * AIAgentClassMap — ch04 AIAgent 类的核心属性/方法分组，可折叠树状图
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface Group { name: string; icon: string; items: string[]; desc: string; }

const groups: Group[] = [
  { name: '构造参数', icon: '\u{1f3d7}\ufe0f', items: ['model', 'system_message', 'api_key', 'tools', 'terminal_env', 'api_mode', 'stream_delta_callback', 'tool_progress_callback'], desc: 'AIAgent.__init__() 的 45 个参数中最关键的 8 个。model 决定推理引擎，tools 定义能力范围，callback 连接入口层。' },
  { name: '状态字段', icon: '\u{1f4ca}', items: ['_cached_system_prompt', '_memory_store', '_credential_pool', '_iteration_budget', '_turns_since_memory', '_iters_since_skill', '_task_id', '_context_engine'], desc: '运行时状态字段。_cached_system_prompt 缓存七层组装结果；Nudge 计数器追踪记忆和技能刷新时机；_context_engine 管理上下文压缩。' },
  { name: '核心方法', icon: '\u2699\ufe0f', items: ['run_conversation()', '_build_system_prompt()', '_compress_context()', '_interruptible_streaming_api_call()', '_execute_tool_calls()', '_sanitize_api_messages()'], desc: '构成主循环的六大方法。run_conversation() 是入口（7544 行），_build_system_prompt() 组装七层 Prompt，_compress_context() 管理上下文窗口。' },
  { name: '工具管理', icon: '\u{1f9f0}', items: ['_discover_tools()', '_resolve_toolset()', '_available_tools', '_tool_registry', 'model_tools.py'], desc: '工具的发现、注册、解析链。_discover_tools() 扫描注册表，_resolve_toolset() 解析用户配置的工具集合组合。' },
  { name: '学习系统', icon: '\u{1f4d6}', items: ['_spawn_background_review()', '_flush_messages_to_session_db()', '_memory_store', '_skill_nudge_interval'], desc: '自进化的核心。影子 Agent 后台审查对话，记忆和 Skill 自动持久化。这是 Hermes 与其他 Agent 的本质区别。' },
];

function useTheme(): 'light' | 'dark' { const [t, setT] = useState<'light'|'dark'>('light'); useEffect(() => { const r = document.documentElement; const d = () => setT(r.dataset.theme==='dark'?'dark':'light'); d(); const o = new MutationObserver(d); o.observe(r, {attributes:true,attributeFilter:['data-theme']}); return ()=>o.disconnect(); }, []); return t; }

export default function AIAgentClassMap() {
  const isDark = useTheme() === 'dark';
  const [open, setOpen] = useState<Set<number>>(new Set([0]));
  const p = { bg: isDark?'#1a1a2e':'#fff', border: isDark?'#3a3a5e':'#e2e8f0', text: isDark?'#e2e8f0':'#2c3e50', muted: isDark?'#a0aec0':'#718096', accent: '#d97757', cardBg: isDark?'#252545':'#f8f9fa', funcBg: isDark?'#2a2a4a':'#f0f4f8', funcText: isDark?'#e8a87c':'#d97757' };

  const toggle = (i: number) => { const s = new Set(open); if (s.has(i)) s.delete(i); else s.add(i); setOpen(s); };

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', margin: '1.5rem 0', border: `1px solid ${p.border}`, borderRadius: 12, overflow: 'hidden', background: p.bg }}>
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${p.border}`, background: p.cardBg, fontSize: 14, fontWeight: 600, color: p.accent }}>AIAgent 类结构 — 点击展开/折叠</div>
      <div style={{ padding: 12 }}>
        {groups.map((g, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <motion.div onClick={() => toggle(i)} whileHover={{ scale: 1.01 }} style={{ padding: '10px 14px', borderRadius: 8, border: `1.5px solid ${open.has(i) ? p.accent : p.border}`, background: open.has(i) ? (isDark ? '#2d2d5e' : '#fff5f0') : p.cardBg, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>{g.icon}</span>
              <span style={{ fontWeight: 600, fontSize: 14, color: open.has(i) ? p.accent : p.text, flex: 1 }}>{g.name}</span>
              <span style={{ fontSize: 12, color: p.muted }}>{open.has(i) ? '▼' : '▶'} {g.items.length} 项</span>
            </motion.div>
            <AnimatePresence>
              {open.has(i) && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} style={{ overflow: 'hidden', paddingLeft: 16 }}>
                  <p style={{ fontSize: 13, lineHeight: 1.6, color: p.text, margin: '8px 0' }}>{g.desc}</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    {g.items.map((item, j) => (
                      <code key={j} style={{ fontSize: 11, background: p.funcBg, color: p.funcText, padding: '2px 8px', borderRadius: 4, fontFamily: '"JetBrains Mono", monospace' }}>{item}</code>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </div>
  );
}
