/**
 * StageFlow — shared interactive flow/stage component
 *
 * Replaces all hand-written rc-flow HTML+JS blocks.
 * Supports play/pause/reset/click-to-jump with Framer Motion transitions.
 * Automatically adapts to Starlight dark mode.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Stage {
  title: string;
  /** Subtitle shown below the title in the stage box */
  subtitle: string;
  /** Section reference, e.g. "详见 §5.2" or "200-2,000 tokens" */
  section: string;
  /** Rich-text description (HTML allowed) */
  detail: string;
  /** Key functions / source anchors */
  funcs: string[];
}

export interface StageFlowProps {
  stages: Stage[];
  /** Label for the play button. Default: "播放流程" */
  playLabel?: string;
  /** Whether one stage has a loop indicator. Pass the 0-based index. */
  loopStageIndex?: number;
  /** Autoplay interval in ms. Default: 1800 */
  interval?: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function useTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const root = document.documentElement;

    function detect() {
      const t = root.dataset.theme ?? root.getAttribute('data-theme');
      setTheme(t === 'dark' ? 'dark' : 'light');
    }

    detect();

    const obs = new MutationObserver(detect);
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  return theme;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function StageFlow({
  stages,
  playLabel = '播放流程',
  loopStageIndex,
  interval = 1800,
}: StageFlowProps) {
  const theme = useTheme();
  const isDark = theme === 'dark';

  const [current, setCurrent] = useState<number>(-1); // -1 = nothing selected
  const [playing, setPlaying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ---- Palette ---- */
  const palette = {
    bg: isDark ? '#1a1a2e' : '#ffffff',
    cardBg: isDark ? '#252545' : '#f8f9fa',
    cardBgActive: isDark ? '#2d2d5e' : '#fff5f0',
    border: isDark ? '#3a3a5e' : '#e2e8f0',
    borderActive: '#d97757',
    text: isDark ? '#e2e8f0' : '#2c3e50',
    textMuted: isDark ? '#a0aec0' : '#718096',
    accent: '#d97757',
    accentLight: isDark ? 'rgba(217,119,87,0.15)' : 'rgba(217,119,87,0.08)',
    detailBg: isDark ? '#1e1e3a' : '#fafafa',
    dotDone: isDark ? '#4a6fa5' : '#a0c4e8',
    dotActive: '#d97757',
    dotDefault: isDark ? '#3a3a5e' : '#d1d5db',
    funcBg: isDark ? '#2a2a4a' : '#f0f4f8',
    funcText: isDark ? '#e8a87c' : '#d97757',
    arrowColor: isDark ? '#4a5568' : '#a0aec0',
    arrowActive: '#d97757',
  };

  /* ---- Autoplay ---- */
  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setPlaying(false);
  }, []);

  const play = useCallback(() => {
    stopTimer();
    setPlaying(true);
    let step = 0;
    setCurrent(0);
    timerRef.current = setInterval(() => {
      step++;
      if (step >= stages.length) {
        stopTimer();
        return;
      }
      setCurrent(step);
    }, interval);
  }, [stages.length, interval, stopTimer]);

  const reset = useCallback(() => {
    stopTimer();
    setCurrent(-1);
  }, [stopTimer]);

  const clickStage = useCallback(
    (idx: number) => {
      stopTimer();
      setCurrent(idx);
    },
    [stopTimer],
  );

  useEffect(() => () => stopTimer(), [stopTimer]);

  /* ---- Detail pane ---- */
  const activeStage = current >= 0 ? stages[current] : null;

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
      {/* ---- Controls ---- */}
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
          onClick={play}
          disabled={playing}
          style={{
            padding: '6px 16px',
            borderRadius: 6,
            border: 'none',
            background: playing ? palette.textMuted : palette.accent,
            color: '#fff',
            cursor: playing ? 'not-allowed' : 'pointer',
            fontWeight: 600,
            fontSize: 14,
          }}
        >
          {playing ? '⏵ 播放中...' : `▶ ${current >= 0 ? '重新' : ''}${playLabel}`}
        </button>
        <button
          onClick={reset}
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
          重置
        </button>
      </div>

      {/* ---- Body: stages + detail ---- */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          minHeight: 300,
        }}
      >
        {/* Left: stage list */}
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 0 }}>
          {stages.map((s, i) => {
            const isActive = i === current;
            const isLoop = i === loopStageIndex;
            return (
              <div key={i}>
                {/* Stage box */}
                <motion.div
                  onClick={() => clickStage(i)}
                  animate={{
                    borderColor: isActive ? palette.borderActive : palette.border,
                    background: isActive ? palette.cardBgActive : palette.cardBg,
                    scale: isActive ? 1.02 : 1,
                  }}
                  transition={{ duration: 0.25 }}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: `2px solid ${palette.border}`,
                    cursor: 'pointer',
                    position: 'relative',
                    overflow: 'hidden',
                  }}
                >
                  {/* Active left accent bar */}
                  {isActive && (
                    <motion.div
                      layoutId="accent-bar"
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: 4,
                        background: palette.accent,
                        borderRadius: '4px 0 0 4px',
                      }}
                    />
                  )}
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 14,
                      color: isActive ? palette.accent : palette.text,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    {s.title}
                    {isLoop && (
                      <span
                        style={{
                          fontSize: 11,
                          background: palette.accent,
                          color: '#fff',
                          borderRadius: 4,
                          padding: '1px 6px',
                        }}
                      >
                        LOOP
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: palette.textMuted, marginTop: 2 }}>
                    {s.subtitle}
                  </div>
                </motion.div>

                {/* Arrow between stages */}
                {i < stages.length - 1 && (
                  <div
                    style={{
                      textAlign: 'center',
                      fontSize: 18,
                      lineHeight: '22px',
                      color:
                        i === current || i === current - 1
                          ? palette.arrowActive
                          : palette.arrowColor,
                      transition: 'color 0.3s',
                      userSelect: 'none',
                    }}
                  >
                    ↓
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Right: detail pane */}
        <div
          style={{
            borderLeft: `1px solid ${palette.border}`,
            padding: 20,
            background: palette.detailBg,
            display: 'flex',
            alignItems: 'flex-start',
          }}
        >
          <AnimatePresence mode="wait">
            {activeStage ? (
              <motion.div
                key={current}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.25 }}
                style={{ width: '100%' }}
              >
                <h4
                  style={{
                    margin: '0 0 4px',
                    fontSize: 16,
                    color: palette.accent,
                    fontWeight: 700,
                  }}
                >
                  {activeStage.title}
                </h4>
                <div
                  style={{
                    fontSize: 12,
                    color: palette.textMuted,
                    marginBottom: 12,
                    fontStyle: 'italic',
                  }}
                >
                  {activeStage.section}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    lineHeight: 1.7,
                    color: palette.text,
                  }}
                  dangerouslySetInnerHTML={{ __html: activeStage.detail }}
                />
                {/* Func tags */}
                {activeStage.funcs.length > 0 && (
                  <div
                    style={{
                      marginTop: 14,
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 6,
                    }}
                  >
                    {activeStage.funcs.map((fn, fi) => (
                      <code
                        key={fi}
                        style={{
                          fontSize: 12,
                          background: palette.funcBg,
                          color: palette.funcText,
                          padding: '2px 8px',
                          borderRadius: 4,
                          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                        }}
                      >
                        {fn}
                      </code>
                    ))}
                  </div>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="placeholder"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                style={{ color: palette.textMuted, fontSize: 14, fontStyle: 'italic' }}
              >
                ← 点击阶段方块或播放流程查看详情
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ---- Progress dots ---- */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 8,
          padding: '12px 0',
          borderTop: `1px solid ${palette.border}`,
          background: palette.cardBg,
        }}
      >
        {stages.map((_, i) => (
          <motion.div
            key={i}
            onClick={() => clickStage(i)}
            animate={{
              background:
                i === current
                  ? palette.dotActive
                  : i < current
                  ? palette.dotDone
                  : palette.dotDefault,
              scale: i === current ? 1.3 : 1,
            }}
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              cursor: 'pointer',
            }}
          />
        ))}
      </div>
    </div>
  );
}
