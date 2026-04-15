/**
 * LearningLoopDiagram — ch20 interactive diagram: 自我进化闭环的完整数据流
 * Shows the closed-loop learning cycle: Execute → Nudge → Shadow Agent → Persist → Recall
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface LoopNode {
  id: string;
  label: string;
  icon: string;
  detail: string;
  funcs: string[];
}

const nodes: LoopNode[] = [
  {
    id: 'execute',
    label: '执行对话',
    icon: '\u{1f4ac}',
    detail:
      'Agent 与用户进行多轮对话，每轮可能涉及工具调用、代码执行、文件操作等。执行过程中，Nudge 计数器持续追踪轮次数和迭代数。',
    funcs: ['run_conversation()', '_turns_since_memory++', '_iters_since_skill++'],
  },
  {
    id: 'nudge',
    label: 'Nudge \u68c0\u6d4b',
    icon: '\u{1f514}',
    detail:
      '对话结束时检查两个阈值：记忆 Nudge（默认每 3 轮用户对话触发）和技能 Nudge（默认每 25 次工具迭代触发）。阈值到达时设置标志位，触发后台审查。',
    funcs: ['_memory_nudge_interval', '_skill_nudge_interval', '_should_review_memory'],
  },
  {
    id: 'shadow',
    label: '\u5f71\u5b50 Agent',
    icon: '\u{1f47b}',
    detail:
      '_spawn_background_review() 在 daemon 线程中启动一个独立的 AIAgent。影子 Agent 共享原始会话的 _memory_store 引用，回顾对话快照，自主决定记忆哪些内容、创建哪些 Skill。',
    funcs: ['_spawn_background_review()', 'AIAgent(daemon=True)', 'memory()', 'skill_manage()'],
  },
  {
    id: 'persist',
    label: '\u6301\u4e45\u5316',
    icon: '\u{1f4be}',
    detail:
      '影子 Agent 的输出写入三个存储：MEMORY.md/USER.md（精炼事实）、SKILL.md 文件（程序化知识）、SessionDB（对话快照 + FTS5 索引）。所有写入使用原子操作 + 文件锁。',
    funcs: ['MEMORY.md', 'USER.md', 'SKILL.md', 'SessionDB.save_session()'],
  },
  {
    id: 'recall',
    label: '\u4e0b\u6b21\u4f1a\u8bdd\u53ec\u56de',
    icon: '\u{1f504}',
    detail:
      '下次会话启动时：load_from_disk() 加载最新记忆生成冻结快照注入 System Prompt；Skills 系统通过渐进式披露提供程序化知识；session_search 通过 FTS5 全文检索历史经验。Agent 越来越"懂"用户。',
    funcs: ['load_from_disk()', 'build_skills_system_prompt()', 'session_search()'],
  },
];

function useTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    const root = document.documentElement;
    function detect() { setTheme(root.dataset.theme === 'dark' ? 'dark' : 'light'); }
    detect();
    const obs = new MutationObserver(detect);
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

export default function LearningLoopDiagram() {
  const theme = useTheme();
  const isDark = theme === 'dark';
  const [selected, setSelected] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stepRef = useRef(0);

  const palette = {
    bg: isDark ? '#1a1a2e' : '#ffffff',
    cardBg: isDark ? '#252545' : '#f8f9fa',
    border: isDark ? '#3a3a5e' : '#e2e8f0',
    text: isDark ? '#e2e8f0' : '#2c3e50',
    textMuted: isDark ? '#a0aec0' : '#718096',
    accent: '#d97757',
    detailBg: isDark ? '#1e1e3a' : '#fafafa',
    funcBg: isDark ? '#2a2a4a' : '#f0f4f8',
    funcText: isDark ? '#e8a87c' : '#d97757',
    nodeActive: isDark ? '#2d2d5e' : '#fff5f0',
    arrowColor: isDark ? '#4a5568' : '#a0aec0',
  };

  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setPlaying(false);
  }, []);

  const play = useCallback(() => {
    stopTimer();
    setPlaying(true);
    stepRef.current = 0;
    setSelected(nodes[0].id);
    timerRef.current = setInterval(() => {
      stepRef.current++;
      if (stepRef.current >= nodes.length) {
        // Loop back to show it's a cycle
        stepRef.current = 0;
      }
      setSelected(nodes[stepRef.current].id);
    }, 2000);
  }, [stopTimer]);

  useEffect(() => () => stopTimer(), [stopTimer]);

  const activeNode = nodes.find((n) => n.id === selected);

  return (
    <div
      style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        margin: '1.5rem 0',
        border: `1px solid ${palette.border}`,
        borderRadius: 12,
        overflow: 'hidden',
        background: palette.bg,
      }}
    >
      {/* Controls */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: '12px 16px',
          borderBottom: `1px solid ${palette.border}`,
          background: palette.cardBg,
        }}
      >
        <button
          onClick={playing ? stopTimer : play}
          style={{
            padding: '6px 16px',
            borderRadius: 6,
            border: 'none',
            background: palette.accent,
            color: '#fff',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 14,
          }}
        >
          {playing ? '\u23f9 \u505c\u6b62' : '\u25b6 \u64ad\u653e\u5faa\u73af'}
        </button>
        <button
          onClick={() => { stopTimer(); setSelected(null); }}
          style={{
            padding: '6px 16px',
            borderRadius: 6,
            border: `1px solid ${palette.border}`,
            background: 'transparent',
            color: palette.text,
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          \u91cd\u7f6e
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', minHeight: 280 }}>
        {/* Circular loop visualization */}
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          {/* Render nodes in a circular arrangement */}
          <div style={{ position: 'relative', width: 280, height: 280 }}>
            {nodes.map((node, i) => {
              const angle = (i / nodes.length) * 2 * Math.PI - Math.PI / 2;
              const radius = 110;
              const x = 140 + radius * Math.cos(angle) - 45;
              const y = 140 + radius * Math.sin(angle) - 30;
              const isActive = node.id === selected;

              return (
                <motion.div
                  key={node.id}
                  onClick={() => { stopTimer(); setSelected(node.id); }}
                  animate={{
                    scale: isActive ? 1.1 : 1,
                    borderColor: isActive ? palette.accent : palette.border,
                    background: isActive ? palette.nodeActive : palette.cardBg,
                  }}
                  style={{
                    position: 'absolute',
                    left: x,
                    top: y,
                    width: 90,
                    height: 60,
                    borderRadius: 10,
                    border: `2px solid ${palette.border}`,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    zIndex: isActive ? 2 : 1,
                  }}
                >
                  <div style={{ fontSize: 20 }}>{node.icon}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: isActive ? palette.accent : palette.text, textAlign: 'center', lineHeight: 1.2 }}>
                    {node.label}
                  </div>
                </motion.div>
              );
            })}
            {/* Center label */}
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                fontSize: 13,
                fontWeight: 700,
                color: palette.accent,
                textAlign: 'center',
                lineHeight: 1.4,
              }}
            >
              \u5c01\u95ed\u5b66\u4e60
              <br />
              \u5faa\u73af
            </div>
            {/* SVG arrows between nodes */}
            <svg
              style={{ position: 'absolute', top: 0, left: 0, width: 280, height: 280, pointerEvents: 'none' }}
              viewBox="0 0 280 280"
            >
              {nodes.map((_, i) => {
                const a1 = (i / nodes.length) * 2 * Math.PI - Math.PI / 2;
                const a2 = ((i + 1) / nodes.length) * 2 * Math.PI - Math.PI / 2;
                const isHighlighted =
                  selected === nodes[i].id || selected === nodes[(i + 1) % nodes.length].id;
                return (
                  <line
                    key={i}
                    x1={140 + 65 * Math.cos(a1)}
                    y1={140 + 65 * Math.sin(a1)}
                    x2={140 + 65 * Math.cos(a2)}
                    y2={140 + 65 * Math.sin(a2)}
                    stroke={isHighlighted ? palette.accent : palette.arrowColor}
                    strokeWidth={isHighlighted ? 2 : 1}
                    strokeDasharray={isHighlighted ? 'none' : '4 4'}
                    opacity={0.6}
                  />
                );
              })}
            </svg>
          </div>
        </div>

        {/* Detail pane */}
        <div style={{ borderLeft: `1px solid ${palette.border}`, padding: 20, background: palette.detailBg }}>
          <AnimatePresence mode="wait">
            {activeNode ? (
              <motion.div
                key={activeNode.id}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
              >
                <h4 style={{ margin: '0 0 4px', color: palette.accent, fontSize: 16 }}>
                  {activeNode.icon} {activeNode.label}
                </h4>
                <p style={{ fontSize: 14, lineHeight: 1.7, color: palette.text, margin: '8px 0' }}>
                  {activeNode.detail}
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
                  {activeNode.funcs.map((fn, fi) => (
                    <code
                      key={fi}
                      style={{
                        fontSize: 12,
                        background: palette.funcBg,
                        color: palette.funcText,
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontFamily: '"JetBrains Mono", monospace',
                      }}
                    >
                      {fn}
                    </code>
                  ))}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="placeholder"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                style={{ color: palette.textMuted, fontSize: 14, fontStyle: 'italic' }}
              >
                \u2190 \u70b9\u51fb\u5faa\u73af\u8282\u70b9\u6216\u64ad\u653e\u67e5\u770b\u8be6\u60c5
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
