/**
 * ArchitectureOverview — ch03 interactive five-layer architecture diagram
 * Shows the 5-layer cake architecture of Hermes Agent with clickable layers.
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface Layer {
  id: number;
  title: string;
  modules: string;
  detail: string;
  color: string;
  colorDark: string;
}

const layers: Layer[] = [
  {
    id: 1,
    title: '第 1 层 \u00b7 入口适配层',
    modules: 'CLI (cli.py) / Gateway (gateway/run.py) / ACP / Batch / MCP / RL',
    detail:
      '六种入口形态共享同一个 AIAgent 核心。CLI 面向开发者交互，Gateway 面向 15 个消息平台，ACP 面向 IDE 集成，Batch Runner 面向 RL 训练，MCP Server 面向工具协议。入口层的职责是将外部请求转换为 AIAgent.run_conversation() 调用。',
    color: '#e8f4f8',
    colorDark: '#1a3a4a',
  },
  {
    id: 2,
    title: '第 2 层 \u00b7 智能体引擎',
    modules: 'AIAgent.run_conversation() \u2014 run_agent.py:7544',
    detail:
      '核心是 run_conversation() 的 while 循环。PromptBuilder 组装七层 System Prompt，ContextEngine 管理上下文压缩，CredentialPool 实现多凭据轮换和 failover。引擎层是 Hermes 的心脏——所有复杂性在此汇聚。',
    color: '#fff5f0',
    colorDark: '#3a2820',
  },
  {
    id: 3,
    title: '第 3 层 \u00b7 工具编排层',
    modules: 'model_tools.py \u2192 tools/registry.py \u2192 40+ tools',
    detail:
      'ToolRegistry 是中央注册表，ToolSet 定义工具组合的代数运算（交集、并集、差集）。工具发现链通过 _discover_tools 自动扫描并注册。编排层将 LLM 的 tool_call 请求路由到正确的工具实现。',
    color: '#f0f8e8',
    colorDark: '#2a3a20',
  },
  {
    id: 4,
    title: '第 4 层 \u00b7 执行后端层',
    modules: 'Terminal (6 种) / Browser / Web / File I/O / MCP / Code Exec',
    detail:
      '六种终端后端（Local/Docker/SSH/Modal/Daytona/Singularity）通过 BaseEnvironment 抽象统一。Browser 工具用 Playwright 实现无视觉操控。MCP Client 连接外部工具服务器。每个后端都有独立的沙箱和生命周期管理。',
    color: '#f8f0ff',
    colorDark: '#302040',
  },
  {
    id: 5,
    title: '第 5 层 \u00b7 持久化与学习层',
    modules: 'SessionDB / Memory / Skills / Memory Plugins',
    detail:
      'SQLite+FTS5 驱动的 SessionDB 存储对话流水。MEMORY.md/USER.md 以冻结快照模式持久化精炼知识。Skills 系统管理 78 个可复用经验单元。四个子系统形成封闭学习循环——Agent 越用越聪明。',
    color: '#fffff0',
    colorDark: '#3a3a20',
  },
];

function useTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    const root = document.documentElement;
    function detect() {
      setTheme(root.dataset.theme === 'dark' ? 'dark' : 'light');
    }
    detect();
    const obs = new MutationObserver(detect);
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

export default function ArchitectureOverview() {
  const theme = useTheme();
  const isDark = theme === 'dark';
  const [selected, setSelected] = useState<number | null>(null);

  const palette = {
    bg: isDark ? '#1a1a2e' : '#ffffff',
    border: isDark ? '#3a3a5e' : '#e2e8f0',
    text: isDark ? '#e2e8f0' : '#2c3e50',
    textMuted: isDark ? '#a0aec0' : '#718096',
    accent: '#d97757',
    detailBg: isDark ? '#1e1e3a' : '#fafafa',
    arrowColor: isDark ? '#4a5568' : '#a0aec0',
  };

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
          background: isDark ? '#252545' : '#f8f9fa',
          fontSize: 14,
          fontWeight: 600,
          color: palette.accent,
        }}
      >
        Hermes Agent 五层架构 — 点击任意层查看详情
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selected !== null ? '1fr 1fr' : '1fr', minHeight: 340 }}>
        {/* Layer stack */}
        <div style={{ padding: 16 }}>
          {layers.map((layer, i) => (
            <div key={layer.id}>
              <motion.div
                onClick={() => setSelected(selected === layer.id ? null : layer.id)}
                animate={{
                  scale: selected === layer.id ? 1.02 : 1,
                  borderColor: selected === layer.id ? palette.accent : palette.border,
                }}
                whileHover={{ scale: 1.01 }}
                style={{
                  padding: '12px 16px',
                  border: `2px solid ${palette.border}`,
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: isDark ? layer.colorDark : layer.color,
                  position: 'relative',
                }}
              >
                {selected === layer.id && (
                  <motion.div
                    layoutId="layer-accent"
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
                <div style={{ fontWeight: 700, fontSize: 14, color: selected === layer.id ? palette.accent : palette.text }}>
                  {layer.title}
                </div>
                <div style={{ fontSize: 12, color: palette.textMuted, marginTop: 2, fontFamily: '"JetBrains Mono", monospace' }}>
                  {layer.modules}
                </div>
              </motion.div>
              {i < layers.length - 1 && (
                <div style={{ textAlign: 'center', fontSize: 14, color: palette.arrowColor, lineHeight: '18px', userSelect: 'none' }}>
                  \u2193 调用
                </div>
              )}
            </div>
          ))}
          <div style={{ textAlign: 'center', fontSize: 12, color: palette.textMuted, marginTop: 8, fontStyle: 'italic' }}>
            \u2191 严格单向调用，下层不回调上层（回调函数除外）
          </div>
        </div>

        {/* Detail pane */}
        {selected !== null && (
          <div style={{ borderLeft: `1px solid ${palette.border}`, padding: 20, background: palette.detailBg }}>
            <AnimatePresence mode="wait">
              {layers
                .filter((l) => l.id === selected)
                .map((layer) => (
                  <motion.div
                    key={layer.id}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                  >
                    <h4 style={{ margin: '0 0 12px', color: palette.accent, fontSize: 16 }}>{layer.title}</h4>
                    <p style={{ fontSize: 14, lineHeight: 1.8, color: palette.text, margin: 0 }}>{layer.detail}</p>
                    <div
                      style={{
                        marginTop: 14,
                        padding: '8px 12px',
                        background: isDark ? '#2a2a4a' : '#f0f4f8',
                        borderRadius: 6,
                        fontSize: 12,
                        fontFamily: '"JetBrains Mono", monospace',
                        color: isDark ? '#e8a87c' : '#d97757',
                      }}
                    >
                      {layer.modules}
                    </div>
                  </motion.div>
                ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
