/**
 * SixEntryPoints — ch02 六种入口点→共享 AIAgent 核心的放射图
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const entries = [
  { name: 'CLI', icon: '\u{1f4bb}', file: 'cli.py', desc: 'prompt_toolkit 交互式终端，开发者日常使用的主入口。支持 Slash 命令、多行输入、流式输出。' },
  { name: 'Gateway', icon: '\u{1f310}', file: 'gateway/run.py', desc: '消息平台网关，一个进程同时服务 Telegram/Discord/Slack 等 15 个平台。asyncio 事件循环驱动。' },
  { name: 'ACP', icon: '\u{1f50c}', file: 'acp_adapter/', desc: 'Agent Communication Protocol 服务器，面向 IDE（VS Code、Cursor）集成。HTTP JSON-RPC 协议。' },
  { name: 'MCP Server', icon: '\u{1f9e9}', file: 'mcp_serve.py', desc: 'Model Context Protocol 服务器模式，让其他 Agent 把 Hermes 当作工具使用。stdio 传输。' },
  { name: 'Batch Runner', icon: '\u{1f4e6}', file: 'batch_runner.py', desc: '批量轨迹生成器，多进程并行运行预定义任务，生成 JSONL 格式训练数据。RL 训练的数据源。' },
  { name: 'RL CLI', icon: '\u{1f9ea}', file: 'rl_cli.py', desc: 'Atropos RL 训练集成入口。将 Agent 接入强化学习训练流水线，支持 reward shaping。' },
];

function useTheme(): 'light' | 'dark' {
  const [t, setT] = useState<'light' | 'dark'>('light');
  useEffect(() => { const r = document.documentElement; const d = () => setT(r.dataset.theme === 'dark' ? 'dark' : 'light'); d(); const o = new MutationObserver(d); o.observe(r, { attributes: true, attributeFilter: ['data-theme'] }); return () => o.disconnect(); }, []);
  return t;
}

export default function SixEntryPoints() {
  const isDark = useTheme() === 'dark';
  const [sel, setSel] = useState<number | null>(null);
  const p = { bg: isDark ? '#1a1a2e' : '#fff', border: isDark ? '#3a3a5e' : '#e2e8f0', text: isDark ? '#e2e8f0' : '#2c3e50', muted: isDark ? '#a0aec0' : '#718096', accent: '#d97757', cardBg: isDark ? '#252545' : '#f8f9fa', activeBg: isDark ? '#2d2d5e' : '#fff5f0', detailBg: isDark ? '#1e1e3a' : '#fafafa', funcBg: isDark ? '#2a2a4a' : '#f0f4f8' };
  const active = sel !== null ? entries[sel] : null;

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', margin: '1.5rem 0', border: `1px solid ${p.border}`, borderRadius: 12, overflow: 'hidden', background: p.bg }}>
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${p.border}`, background: p.cardBg, fontSize: 14, fontWeight: 600, color: p.accent }}>六种入口 → 共享 AIAgent 核心</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', minHeight: 280 }}>
        <div style={{ padding: 16 }}>
          {/* Central AIAgent */}
          <div style={{ textAlign: 'center', padding: 10, border: `2px solid ${p.accent}`, borderRadius: 10, background: p.activeBg, marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: p.accent }}>AIAgent.run_conversation()</div>
            <div style={{ fontSize: 11, color: p.muted }}>run_agent.py · 10.6K 行</div>
          </div>
          <div style={{ textAlign: 'center', color: p.accent, fontSize: 14, margin: '4px 0' }}>↑ 统一调用 ↑</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {entries.map((e, i) => (
              <motion.div key={i} onClick={() => setSel(sel === i ? null : i)} whileHover={{ scale: 1.05 }} animate={{ borderColor: sel === i ? p.accent : p.border, background: sel === i ? p.activeBg : p.cardBg }} style={{ padding: '10px 6px', borderRadius: 8, border: `1.5px solid ${p.border}`, cursor: 'pointer', textAlign: 'center' }}>
                <div style={{ fontSize: 22 }}>{e.icon}</div>
                <div style={{ fontSize: 11, fontWeight: 600, color: sel === i ? p.accent : p.text, marginTop: 2 }}>{e.name}</div>
              </motion.div>
            ))}
          </div>
        </div>
        <div style={{ borderLeft: `1px solid ${p.border}`, padding: 20, background: p.detailBg }}>
          <AnimatePresence mode="wait">
            {active ? (
              <motion.div key={sel} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <h4 style={{ margin: '0 0 4px', color: p.accent, fontSize: 16 }}>{active.icon} {active.name}</h4>
                <code style={{ fontSize: 12, background: p.funcBg, color: isDark ? '#e8a87c' : p.accent, padding: '2px 8px', borderRadius: 4 }}>{active.file}</code>
                <p style={{ fontSize: 14, lineHeight: 1.7, color: p.text, marginTop: 10 }}>{active.desc}</p>
              </motion.div>
            ) : (
              <motion.div key="ph" initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ color: p.muted, fontSize: 14, fontStyle: 'italic' }}>← 点击入口图标查看详情</motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
