/**
 * AgentComparisonRadar — ch30 radar chart comparing Hermes vs Claude Code vs Aider vs Codex CLI
 * Pure SVG radar chart with interactive hover/click.
 */
import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';

const dimensions = [
  { key: 'learning', label: '自进化学习' },
  { key: 'multiModel', label: '多模型支持' },
  { key: 'platforms', label: '多平台网关' },
  { key: 'tools', label: '工具生态' },
  { key: 'security', label: '安全纵深' },
  { key: 'rl', label: 'RL 训练' },
  { key: 'community', label: '社区/生态' },
  { key: 'codeEdit', label: '代码编辑' },
];

interface AgentProfile {
  name: string;
  color: string;
  scores: Record<string, number>;
  summary: string;
}

const agents: AgentProfile[] = [
  {
    name: 'Hermes Agent',
    color: '#d97757',
    scores: { learning: 95, multiModel: 95, platforms: 95, tools: 90, security: 80, rl: 90, community: 50, codeEdit: 75 },
    summary: '全维度自进化 Agent，强项是学习闭环、多模型、多平台、RL 训练。社区生态尚在早期。',
  },
  {
    name: 'Claude Code',
    color: '#6366f1',
    scores: { learning: 30, multiModel: 10, platforms: 40, tools: 85, security: 90, rl: 10, community: 90, codeEdit: 95 },
    summary: 'Anthropic 官方编程助手，代码编辑和安全性极强，但锁定 Claude 模型，无学习闭环。',
  },
  {
    name: 'Aider',
    color: '#10b981',
    scores: { learning: 20, multiModel: 80, platforms: 10, tools: 40, security: 40, rl: 5, community: 85, codeEdit: 90 },
    summary: 'git-aware 代码编辑专家，代码编辑和多模型支持强，但不是通用 Agent。',
  },
  {
    name: 'Codex CLI',
    color: '#f59e0b',
    scores: { learning: 15, multiModel: 20, platforms: 15, tools: 50, security: 70, rl: 5, community: 70, codeEdit: 80 },
    summary: 'OpenAI 官方终端工具，简洁高效，但功能范围有限。',
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

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

export default function AgentComparisonRadar() {
  const theme = useTheme();
  const isDark = theme === 'dark';
  const [visibleAgents, setVisibleAgents] = useState<Set<string>>(new Set(agents.map((a) => a.name)));
  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);

  const palette = {
    bg: isDark ? '#1a1a2e' : '#ffffff',
    cardBg: isDark ? '#252545' : '#f8f9fa',
    border: isDark ? '#3a3a5e' : '#e2e8f0',
    text: isDark ? '#e2e8f0' : '#2c3e50',
    textMuted: isDark ? '#a0aec0' : '#718096',
    gridLine: isDark ? '#2a2a4a' : '#e8e8e8',
    accent: '#d97757',
    detailBg: isDark ? '#1e1e3a' : '#fafafa',
  };

  const cx = 180, cy = 180, maxR = 140;
  const angleStep = 360 / dimensions.length;

  // Grid rings
  const rings = [20, 40, 60, 80, 100];

  // Axis lines + labels
  const axes = dimensions.map((d, i) => {
    const angle = i * angleStep;
    const outer = polarToCartesian(cx, cy, maxR + 18, angle);
    const end = polarToCartesian(cx, cy, maxR, angle);
    return { ...d, angle, labelX: outer.x, labelY: outer.y, lineX2: end.x, lineY2: end.y };
  });

  // Agent polygons
  const polygons = useMemo(
    () =>
      agents.map((agent) => {
        const points = dimensions
          .map((d, i) => {
            const angle = i * angleStep;
            const r = (agent.scores[d.key] / 100) * maxR;
            const pt = polarToCartesian(cx, cy, r, angle);
            return `${pt.x},${pt.y}`;
          })
          .join(' ');
        return { ...agent, points };
      }),
    [],
  );

  const toggleAgent = (name: string) => {
    setVisibleAgents((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const activeAgent = hoveredAgent ? agents.find((a) => a.name === hoveredAgent) : null;

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
      <div
        style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${palette.border}`,
          background: palette.cardBg,
          fontSize: 14,
          fontWeight: 600,
          color: palette.accent,
        }}
      >
        四产品雷达图对比 — 点击图例切换显示
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', minHeight: 400 }}>
        {/* Radar chart */}
        <div style={{ padding: 8, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <svg viewBox="0 0 360 360" width="100%" style={{ maxWidth: 360 }}>
            {/* Grid rings */}
            {rings.map((pct) => {
              const r = (pct / 100) * maxR;
              const pts = dimensions
                .map((_, i) => {
                  const pt = polarToCartesian(cx, cy, r, i * angleStep);
                  return `${pt.x},${pt.y}`;
                })
                .join(' ');
              return (
                <polygon
                  key={pct}
                  points={pts}
                  fill="none"
                  stroke={palette.gridLine}
                  strokeWidth={0.5}
                />
              );
            })}
            {/* Axis lines */}
            {axes.map((axis) => (
              <line
                key={axis.key}
                x1={cx}
                y1={cy}
                x2={axis.lineX2}
                y2={axis.lineY2}
                stroke={palette.gridLine}
                strokeWidth={0.5}
              />
            ))}
            {/* Agent polygons */}
            {polygons.map(
              (p) =>
                visibleAgents.has(p.name) && (
                  <motion.polygon
                    key={p.name}
                    points={p.points}
                    fill={p.color}
                    fillOpacity={hoveredAgent === p.name ? 0.35 : 0.12}
                    stroke={p.color}
                    strokeWidth={hoveredAgent === p.name ? 2.5 : 1.5}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={() => setHoveredAgent(p.name)}
                    onMouseLeave={() => setHoveredAgent(null)}
                  />
                ),
            )}
            {/* Axis labels */}
            {axes.map((axis) => (
              <text
                key={axis.key}
                x={axis.labelX}
                y={axis.labelY}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={11}
                fill={palette.text}
                fontWeight={500}
              >
                {axis.label}
              </text>
            ))}
          </svg>
        </div>

        {/* Legend + detail */}
        <div style={{ borderLeft: `1px solid ${palette.border}`, padding: 20, background: palette.detailBg }}>
          {/* Legend toggles */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {agents.map((a) => {
              const visible = visibleAgents.has(a.name);
              return (
                <button
                  key={a.name}
                  onClick={() => toggleAgent(a.name)}
                  onMouseEnter={() => setHoveredAgent(a.name)}
                  onMouseLeave={() => setHoveredAgent(null)}
                  style={{
                    padding: '4px 12px',
                    borderRadius: 6,
                    border: `2px solid ${a.color}`,
                    background: visible ? a.color : 'transparent',
                    color: visible ? '#fff' : a.color,
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: 600,
                    opacity: visible ? 1 : 0.5,
                    transition: 'all 0.2s',
                  }}
                >
                  {a.name}
                </button>
              );
            })}
          </div>

          {/* Detail for hovered agent */}
          {activeAgent ? (
            <motion.div
              key={activeAgent.name}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.15 }}
            >
              <h4 style={{ margin: '0 0 8px', color: activeAgent.color, fontSize: 15 }}>
                {activeAgent.name}
              </h4>
              <p style={{ fontSize: 13, lineHeight: 1.6, color: palette.text, margin: '0 0 12px' }}>
                {activeAgent.summary}
              </p>
              {/* Score bars */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {dimensions.map((d) => (
                  <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 80, fontSize: 11, color: palette.textMuted, textAlign: 'right' }}>
                      {d.label}
                    </div>
                    <div
                      style={{
                        flex: 1,
                        height: 8,
                        background: palette.gridLine,
                        borderRadius: 4,
                        overflow: 'hidden',
                      }}
                    >
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${activeAgent.scores[d.key]}%` }}
                        transition={{ duration: 0.3 }}
                        style={{
                          height: '100%',
                          background: activeAgent.color,
                          borderRadius: 4,
                        }}
                      />
                    </div>
                    <div style={{ width: 28, fontSize: 11, color: palette.textMuted }}>
                      {activeAgent.scores[d.key]}
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          ) : (
            <div style={{ color: palette.textMuted, fontSize: 13, fontStyle: 'italic', marginTop: 12 }}>
              将鼠标悬停在产品名称或雷达图区域上查看详情
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
