/**
 * ArchitectureOverview — ch03 interactive five-layer architecture diagram
 * Always-visible sub-module chips + click-for-detail + "play one request" trace.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface SubModule {
  id: string;
  name: string;
  path: string;
  desc: string;
}

interface SubGroup {
  label: string;
  ids: string[];
}

interface Layer {
  id: string;
  index: number;
  title: string;
  mainEntry?: { text: string; path: string };
  modules: SubModule[];
  groups?: SubGroup[];
  tintLight: string;
  tintDark: string;
}

const layers: Layer[] = [
  {
    id: 'L1',
    index: 1,
    title: '第 1 层 · 入口适配层',
    modules: [
      { id: 'cli', name: 'CLI', path: 'cli.py', desc: '开发者交互式 REPL,基于 prompt_toolkit 的聊天与 Slash 命令' },
      { id: 'gateway', name: 'Gateway', path: 'gateway/run.py', desc: '面向 Telegram / Slack / Discord 等 15 个消息平台的网关' },
      { id: 'acp', name: 'ACP', path: 'acp/', desc: 'Agent Client Protocol,面向 IDE 集成' },
      { id: 'batch', name: 'Batch', path: 'batch_runner.py', desc: 'RL 训练批处理入口,在无交互环境下跑大量任务' },
      { id: 'mcp_server', name: 'MCP Server', path: 'mcp_server/', desc: '把 Hermes 本身以 MCP 协议暴露给其他 Agent' },
      { id: 'rl', name: 'RL', path: 'rl/', desc: '强化学习训练入口,生成 trajectory' },
    ],
    tintLight: '#e8f4f8',
    tintDark: '#1a3a4a',
  },
  {
    id: 'L2',
    index: 2,
    title: '第 2 层 · 智能体引擎',
    mainEntry: { text: 'AIAgent.run_conversation()', path: 'run_agent.py:7544' },
    modules: [
      { id: 'prompt_builder', name: 'PromptBuilder', path: 'prompt_builder.py', desc: '七层 System Prompt 组装(身份 / 工具指导 / 记忆 / Skills / 上下文文件 / 元数据)' },
      { id: 'context_engine', name: 'ContextEngine', path: 'context_compressor.py', desc: '上下文预算与压缩管理,避免窗口溢出' },
      { id: 'credential_pool', name: 'CredentialPool', path: 'credential_pool.py', desc: '多凭据轮换 + SmartRouting 降级策略' },
    ],
    tintLight: '#fff5f0',
    tintDark: '#3a2820',
  },
  {
    id: 'L3',
    index: 3,
    title: '第 3 层 · 工具编排层',
    modules: [
      { id: 'model_tools', name: 'model_tools', path: 'model_tools.py', desc: 'LLM tool_call 响应的分发入口,把调用路由到具体工具实现' },
      { id: 'registry', name: 'ToolRegistry', path: 'tools/registry.py', desc: '中央工具注册表,统一管理 40+ 个工具' },
      { id: 'toolsets', name: 'Toolset', path: 'toolsets.py', desc: '工具组合的代数运算(交集 / 并集 / 差集)' },
      { id: 'discover', name: '_discover_tools', path: 'tools/__init__.py', desc: '启动时自动扫描并注册所有工具模块' },
    ],
    tintLight: '#f0f8e8',
    tintDark: '#2a3a20',
  },
  {
    id: 'L4',
    index: 4,
    title: '第 4 层 · 执行后端层',
    modules: [
      { id: 'term_local', name: 'Local', path: 'terminal/local.py', desc: '本地 PTY 终端,直接在宿主机执行' },
      { id: 'term_docker', name: 'Docker', path: 'terminal/docker.py', desc: 'Docker 容器内执行,隔离环境' },
      { id: 'term_ssh', name: 'SSH', path: 'terminal/ssh.py', desc: 'SSH 远程终端' },
      { id: 'term_modal', name: 'Modal', path: 'terminal/modal.py', desc: 'Modal 云 serverless 执行' },
      { id: 'term_daytona', name: 'Daytona', path: 'terminal/daytona.py', desc: 'Daytona 开发容器' },
      { id: 'term_sing', name: 'Singularity', path: 'terminal/singularity.py', desc: 'HPC 场景的 Singularity 容器' },
      { id: 'browser', name: 'Browser', path: 'tools/browser.py', desc: 'Playwright / Browserbase 无头浏览器自动化' },
      { id: 'web', name: 'Web', path: 'tools/web.py', desc: 'Exa / Firecrawl 搜索与网页抓取' },
      { id: 'file_io', name: 'File I/O', path: 'tools/file_ops.py', desc: '精确文件读写与 diff 操作' },
      { id: 'mcp_client', name: 'MCP Client', path: 'tools/mcp_client.py', desc: '连接外部 MCP server,复用生态工具' },
      { id: 'code_exec', name: 'Code Exec', path: 'tools/code_exec.py', desc: 'UDS RPC 的隔离代码执行' },
    ],
    groups: [
      { label: 'Terminal 后端(6 种)', ids: ['term_local', 'term_docker', 'term_ssh', 'term_modal', 'term_daytona', 'term_sing'] },
      { label: '网络工具', ids: ['browser', 'web'] },
      { label: '系统工具', ids: ['file_io', 'mcp_client', 'code_exec'] },
    ],
    tintLight: '#f8f0ff',
    tintDark: '#302040',
  },
  {
    id: 'L5',
    index: 5,
    title: '第 5 层 · 持久化与学习层',
    modules: [
      { id: 'session_db', name: 'SessionDB', path: 'hermes_state.py', desc: 'SQLite + FTS5 驱动的对话流水存储,支持全文检索' },
      { id: 'memory', name: 'Memory', path: 'memory/', desc: 'MEMORY.md + USER.md 的冻结快照,注入 System Prompt' },
      { id: 'skills', name: 'Skills', path: 'skills/', desc: '78 个可复用经验单元,Tier 1 摘要 + 按需加载' },
      { id: 'mem_plugins', name: 'Memory Plugins', path: 'memory_plugins/', desc: 'Honcho / mem0 / Holographic 等第三方记忆插件' },
    ],
    tintLight: '#fffff0',
    tintDark: '#3a3a20',
  },
];

interface TraceStep {
  layerId: string;
  moduleId: string;
  caption: string;
}

const trace: TraceStep[] = [
  { layerId: 'L1', moduleId: 'cli',             caption: '① 用户在 CLI 输入「查看当前目录下有哪些 Python 文件」' },
  { layerId: 'L2', moduleId: 'prompt_builder',  caption: '② PromptBuilder 组装七层 System Prompt(仅首轮)' },
  { layerId: 'L2', moduleId: 'context_engine',  caption: '③ ContextEngine 检查预算,进入主循环调用 LLM' },
  { layerId: 'L3', moduleId: 'model_tools',     caption: '④ LLM 回复 tool_call,model_tools 分发到编排层' },
  { layerId: 'L3', moduleId: 'registry',        caption: '⑤ ToolRegistry 查找 terminal.run 工具实现' },
  { layerId: 'L4', moduleId: 'term_local',      caption: '⑥ Local 后端执行 `find . -name "*.py"`,返回 stdout' },
  { layerId: 'L2', moduleId: 'credential_pool', caption: '⑦ 结果回 LLM 二次推理,CredentialPool 路由下一轮 API 调用' },
  { layerId: 'L5', moduleId: 'session_db',      caption: '⑧ 整轮对话写入 SessionDB,完成' },
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

export default function ArchitectureOverview() {
  const isDark = useTheme() === 'dark';
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [step, setStep] = useState<number>(-1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const palette = {
    bg: isDark ? '#1a1a2e' : '#ffffff',
    cardBg: isDark ? '#252545' : '#f8f9fa',
    border: isDark ? '#3a3a5e' : '#e2e8f0',
    text: isDark ? '#e2e8f0' : '#2c3e50',
    textMuted: isDark ? '#a0aec0' : '#718096',
    accent: '#d97757',
    chipBg: isDark ? '#2a2a4a' : '#ffffff',
    chipBorder: isDark ? '#4a4a6e' : '#d1d5db',
    chipActive: isDark ? '#3a2a1e' : '#fff1e6',
    footerBg: isDark ? '#1e1e3a' : '#fafafa',
    codeText: isDark ? '#e8a87c' : '#d97757',
    arrow: isDark ? '#4a5568' : '#a0aec0',
  };

  const stopTrace = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPlaying(false);
  }, []);

  const playTrace = useCallback(() => {
    stopTrace();
    setSelectedId(null);
    setPlaying(true);
    setStep(0);
  }, [stopTrace]);

  useEffect(() => {
    if (!playing) return;
    if (step < 0 || step >= trace.length) return;
    timerRef.current = setTimeout(() => {
      if (step + 1 >= trace.length) {
        setPlaying(false);
        return;
      }
      setStep(step + 1);
    }, 1800);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [playing, step]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const activeTraceId = playing && step >= 0 && step < trace.length ? trace[step].moduleId : null;
  const currentStep = playing && step >= 0 && step < trace.length ? trace[step] : null;
  const selectedModule = selectedId
    ? layers.flatMap((l) => l.modules).find((m) => m.id === selectedId)
    : null;

  const footerContent = currentStep ? (
    <div style={{ color: palette.text, fontSize: 14, lineHeight: 1.7 }}>
      <div style={{ color: palette.accent, fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
        播放中 · 步骤 {step + 1} / {trace.length}
      </div>
      {currentStep.caption}
    </div>
  ) : selectedModule ? (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: palette.accent }}>{selectedModule.name}</span>
        <code
          style={{
            fontSize: 12,
            fontFamily: '"JetBrains Mono", monospace',
            color: palette.codeText,
            background: isDark ? '#2a2a4a' : '#f0f4f8',
            padding: '2px 8px',
            borderRadius: 4,
          }}
        >
          {selectedModule.path}
        </code>
      </div>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7, color: palette.text }}>{selectedModule.desc}</p>
    </div>
  ) : (
    <div style={{ color: palette.textMuted, fontSize: 13, fontStyle: 'italic' }}>
      点击任意子模块查看详情,或按「▶ 播放一次请求」追踪一次完整调用链
    </div>
  );

  const renderChip = (m: SubModule) => {
    const isActive = activeTraceId === m.id;
    const isSelected = selectedId === m.id;
    const highlighted = isActive || isSelected;
    return (
      <motion.button
        key={m.id}
        type="button"
        onClick={() => {
          if (playing) stopTrace();
          setSelectedId(selectedId === m.id ? null : m.id);
        }}
        animate={{
          scale: isActive ? 1.08 : 1,
          borderColor: highlighted ? palette.accent : palette.chipBorder,
          background: highlighted ? palette.chipActive : palette.chipBg,
          boxShadow: isActive ? `0 0 0 3px ${palette.accent}40` : '0 0 0 0px transparent',
        }}
        whileHover={{ scale: 1.03 }}
        transition={{ duration: 0.25 }}
        style={{
          display: 'inline-flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          padding: '6px 10px',
          border: `1.5px solid ${palette.chipBorder}`,
          borderRadius: 6,
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'inherit',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: highlighted ? palette.accent : palette.text }}>
          {m.name}
        </span>
        <span
          style={{
            fontSize: 11,
            fontFamily: '"JetBrains Mono", monospace',
            color: palette.textMuted,
            marginTop: 1,
          }}
        >
          {m.path}
        </span>
      </motion.button>
    );
  };

  const renderLayer = (layer: Layer) => {
    const modulesById = Object.fromEntries(layer.modules.map((m) => [m.id, m]));
    const layerActive = activeTraceId && layer.modules.some((m) => m.id === activeTraceId);

    return (
      <motion.div
        key={layer.id}
        animate={{
          borderColor: layerActive ? palette.accent : palette.border,
        }}
        style={{
          border: `1.5px solid ${palette.border}`,
          borderRadius: 10,
          padding: 14,
          background: isDark ? layer.tintDark : layer.tintLight,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: palette.text }}>{layer.title}</div>
          <div style={{ fontSize: 11, color: palette.textMuted, fontFamily: '"JetBrains Mono", monospace' }}>
            L{layer.index}
          </div>
        </div>

        {layer.mainEntry && (
          <div
            style={{
              fontSize: 12,
              color: palette.textMuted,
              marginBottom: 10,
              fontFamily: '"JetBrains Mono", monospace',
            }}
          >
            <span style={{ color: palette.codeText, fontWeight: 600 }}>{layer.mainEntry.text}</span>
            <span style={{ marginLeft: 6 }}>— {layer.mainEntry.path}</span>
          </div>
        )}

        {layer.groups ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {layer.groups.map((g) => (
              <div key={g.label}>
                <div style={{ fontSize: 11, color: palette.textMuted, marginBottom: 4, fontWeight: 600 }}>
                  {g.label}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {g.ids.map((id) => renderChip(modulesById[id]))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {layer.modules.map(renderChip)}
          </div>
        )}
      </motion.div>
    );
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
      {/* Header + controls */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: `1px solid ${palette.border}`,
          background: palette.cardBg,
          flexWrap: 'wrap',
          gap: 10,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: palette.accent }}>
          Hermes Agent 五层架构 — 所有子模块一览,点击查看详情
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={playing ? stopTrace : playTrace}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: 'none',
              background: palette.accent,
              color: '#fff',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            {playing ? '⏹ 停止' : '▶ 播放一次请求'}
          </button>
          <button
            type="button"
            onClick={() => {
              stopTrace();
              setSelectedId(null);
              setStep(-1);
            }}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: `1px solid ${palette.border}`,
              background: 'transparent',
              color: palette.text,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            重置
          </button>
        </div>
      </div>

      {/* Layer stack */}
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 0 }}>
        {layers.map((layer, i) => (
          <div key={layer.id}>
            {renderLayer(layer)}
            {i < layers.length - 1 && (
              <div
                style={{
                  textAlign: 'center',
                  fontSize: 13,
                  color: palette.arrow,
                  lineHeight: '22px',
                  userSelect: 'none',
                  padding: '4px 0',
                }}
              >
                ↓ 调用
              </div>
            )}
          </div>
        ))}
        <div
          style={{
            textAlign: 'center',
            fontSize: 11,
            color: palette.textMuted,
            marginTop: 10,
            fontStyle: 'italic',
          }}
        >
          ↑ 严格单向调用,下层不回调上层(回调函数除外)
        </div>
      </div>

      {/* Footer detail / trace caption */}
      <div
        style={{
          padding: '14px 16px',
          borderTop: `1px solid ${palette.border}`,
          background: palette.footerBg,
          minHeight: 60,
        }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={currentStep ? `trace-${step}` : selectedId || 'placeholder'}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
          >
            {footerContent}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
