/**
 * LearningLoopIntro — ch01 四阶段闭环动画（执行→提炼→记忆→召回）
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface Phase {
  icon: string;
  label: string;
  detail: string;
}

const phases: Phase[] = [
  { icon: '🔧', label: '执行', detail: 'Agent 使用工具解决用户问题——运行终端命令、搜索网页、编辑文件。每次成功的解决方案都是潜在的可复用知识。' },
  { icon: '💡', label: '提炼', detail: '影子 Agent 自动审查对话，从中提取值得持久化的经验：用户偏好、环境事实、操作步骤、解决方案模式。' },
  { icon: '💾', label: '记忆', detail: '提炼的知识写入三层存储：MEMORY.md（事实）、SKILL.md（程序化知识）、SessionDB（对话索引）。原子写入+文件锁确保一致性。' },
  { icon: '🔄', label: '召回', detail: '下次会话启动时，记忆注入 System Prompt、Skills 按需披露、Session Search 全文检索。Agent 越用越懂你。' },
];

function useTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    const root = document.documentElement;
    const detect = () => setTheme(root.dataset.theme === 'dark' ? 'dark' : 'light');
    detect();
    const obs = new MutationObserver(detect);
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

export default function LearningLoopIntro() {
  const isDark = useTheme() === 'dark';
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } setPlaying(false); }, []);
  const play = useCallback(() => { stop(); setPlaying(true); let s = 0; setActive(0); timerRef.current = setInterval(() => { s = (s + 1) % phases.length; setActive(s); }, 1500); }, [stop]);
  useEffect(() => () => stop(), [stop]);

  const p = { bg: isDark ? '#1a1a2e' : '#fff', border: isDark ? '#3a3a5e' : '#e2e8f0', text: isDark ? '#e2e8f0' : '#2c3e50', muted: isDark ? '#a0aec0' : '#718096', accent: '#d97757', cardBg: isDark ? '#252545' : '#f8f9fa', activeBg: isDark ? '#2d2d5e' : '#fff5f0' };

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', margin: '1.5rem 0', border: `1px solid ${p.border}`, borderRadius: 12, overflow: 'hidden', background: p.bg }}>
      <div style={{ display: 'flex', gap: 8, padding: '10px 16px', borderBottom: `1px solid ${p.border}`, background: p.cardBg }}>
        <button onClick={playing ? stop : play} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: p.accent, color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>{playing ? '⏹ 停止' : '▶ 播放闭环'}</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, padding: 16, alignItems: 'start' }}>
        {phases.map((ph, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <motion.div onClick={() => { stop(); setActive(i); }} animate={{ borderColor: i === active ? p.accent : p.border, background: i === active ? p.activeBg : p.cardBg, scale: i === active ? 1.03 : 1 }} style={{ padding: 14, borderRadius: 10, border: `2px solid ${p.border}`, cursor: 'pointer', textAlign: 'center', flex: 1 }}>
              <div style={{ fontSize: 28 }}>{ph.icon}</div>
              <div style={{ fontWeight: 700, fontSize: 14, color: i === active ? p.accent : p.text, marginTop: 4 }}>{ph.label}</div>
            </motion.div>
            {i < phases.length - 1 && <span style={{ color: p.muted, fontSize: 18, flexShrink: 0 }}>→</span>}
          </div>
        ))}
      </div>
      <AnimatePresence mode="wait">
        <motion.div key={active} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} style={{ padding: '0 16px 16px', fontSize: 14, lineHeight: 1.7, color: p.text }}>{phases[active].detail}</motion.div>
      </AnimatePresence>
    </div>
  );
}
