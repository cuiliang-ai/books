/**
 * ArchitectureOverview — cc-switch ch03 interactive architecture diagram
 * 分层展示所有子模块 + 点击查看详情 + ▶ 播放一次代理请求追踪
 * 无第三方动画库依赖，纯 React + inline style。
 */
import { useState, useEffect, useCallback, useRef } from 'react';

interface SubModule {
  id: string;
  name: string;
  path: string;
  desc: string;
}

interface Layer {
  id: string;
  index: number;
  title: string;
  subtitle?: string;
  modules: SubModule[];
  tintLight: string;
  tintDark: string;
}

const layers: Layer[] = [
  {
    id: 'L1',
    index: 1,
    title: '第 1 层 · 前端交互层',
    subtitle: 'React 18 WebView · 系统托盘',
    modules: [
      { id: 'ui_panel',    name: 'UI Panel',        path: 'src/App.tsx',                    desc: 'React 主面板,Tab 切换 5 个 CLI,Provider 卡片列表与拖拽排序' },
      { id: 'query',       name: 'TanStack Query',  path: 'src/hooks/',                     desc: '缓存 IPC 结果,provider-switched 事件触发失效刷新' },
      { id: 'shadcn',      name: 'shadcn/ui',       path: 'src/components/ui/',             desc: 'Radix + Tailwind 组件库,对话框/下拉/Toast' },
      { id: 'i18n',        name: 'i18next',         path: 'src/i18n/',                      desc: '中 / 英 / 日三语,与 Rust 后端共享错误 key' },
      { id: 'tray',        name: 'System Tray',     path: 'src-tauri/src/tray.rs',          desc: '动态生成托盘菜单,点击直接切换 Provider,不打开窗口' },
    ],
    tintLight: '#e8f4f8',
    tintDark: '#1a3a4a',
  },
  {
    id: 'L2',
    index: 2,
    title: '第 2 层 · IPC Commands 层',
    subtitle: 'Tauri invoke() 入口,前后端唯一桥',
    modules: [
      { id: 'cmd_provider', name: 'provider.rs',      path: 'commands/provider.rs',          desc: 'Provider CRUD + switch_provider,最常调用的 commands 文件' },
      { id: 'cmd_proxy',    name: 'proxy.rs',         path: 'commands/proxy.rs',             desc: '启停代理、读写 ProxyConfig、触发 Failover' },
      { id: 'cmd_skill',    name: 'skill.rs',         path: 'commands/skill.rs',             desc: 'Skills 导入/启用/卸载,调用 SkillStore' },
      { id: 'cmd_mcp',      name: 'mcp.rs',           path: 'commands/mcp.rs',               desc: 'MCP Server 增删改,驱动跨 CLI 双向同步' },
      { id: 'cmd_deeplink', name: 'deeplink.rs',      path: 'commands/deeplink.rs',          desc: 'ccswitch:// URL 解析,Deep Link 导入' },
      { id: 'cmd_misc',     name: 'misc.rs (1518 行)', path: 'commands/misc.rs',             desc: '杂项命令:设置、导入导出、窗口控制、更新检查' },
    ],
    tintLight: '#fff5f0',
    tintDark: '#3a2820',
  },
  {
    id: 'L3',
    index: 3,
    title: '第 3 层 · 服务层 (Services)',
    subtitle: '业务逻辑核心,协调数据与副作用',
    modules: [
      { id: 'svc_config',   name: 'ConfigService',    path: 'services/config.rs',            desc: '读写 SSOT,switch_provider 的实际执行者' },
      { id: 'svc_skill',    name: 'SkillStore',       path: 'services/skill.rs (2957 行)',   desc: '全书最大模块,Skills SSOT + 跨 CLI 目录同步' },
      { id: 'svc_usage',    name: 'UsageStats',       path: 'services/usage_stats.rs',       desc: 'Token / 成本聚合,双数据源(API + 会话文件)' },
      { id: 'svc_stream',   name: 'StreamCheck',      path: 'services/stream_check.rs',      desc: '流式连通性测试,SSE 探针 + 延迟统计' },
      { id: 'svc_session',  name: 'SessionManager',   path: 'session_manager/',              desc: '跨 6 种 CLI 解析对话记录,统一模型' },
      { id: 'svc_webdav',   name: 'WebDAV Sync',      path: 'services/webdav_sync.rs',       desc: '云盘同步 config.json,多设备一致性' },
    ],
    tintLight: '#f0f8e8',
    tintDark: '#2a3a20',
  },
  {
    id: 'L4',
    index: 4,
    title: '第 4 层 · 代理引擎 (可选)',
    subtitle: '127.0.0.1:PORT · Axum + Hyper + rustls',
    modules: [
      { id: 'proxy_server', name: 'ProxyServer',      path: 'proxy/server.rs',               desc: '手写 hyper accept loop,preserve_header_case 保持 header 原样' },
      { id: 'router',       name: 'ProviderRouter',   path: 'proxy/provider_router.rs',      desc: '按当前 Provider 选 Adapter,耦合熔断器状态' },
      { id: 'breaker',      name: 'CircuitBreaker',   path: 'proxy/circuit_breaker.rs',      desc: '三态机 Closed/Open/HalfOpen,失败阈值 4 次 / 60s' },
      { id: 'failover',     name: 'FailoverSwitch',   path: 'proxy/failover_switch.rs',      desc: 'pending_switches HashSet 去重,触发后发事件到前端' },
      { id: 'sse',          name: 'SSE Stream',       path: 'proxy/sse.rs',                  desc: '流式事件解析/合成,Gemini thoughtSignature 影子回放' },
      { id: 'transform',    name: '协议转换',         path: 'proxy/providers/transform_*.rs', desc: 'Claude ↔ OpenAI ↔ Gemini ↔ Responses 4 向互转' },
      { id: 'rectifier',    name: 'Thinking 矫正',    path: 'proxy/thinking_rectifier.rs',    desc: '剥离不兼容字段 + 预算夹取,跨模型思考链兼容' },
    ],
    tintLight: '#ffecec',
    tintDark: '#3a1e1e',
  },
  {
    id: 'L5',
    index: 5,
    title: '第 5 层 · 数据持久化层',
    subtitle: 'SSOT + 原子写入 + 多 CLI Live 文件',
    modules: [
      { id: 'ssot_json',  name: 'config.json (SSOT)',  path: '~/.cc-switch/config.json',     desc: 'MultiAppConfig 主配置,5 个 CLI 的 ProviderManager 统一入口' },
      { id: 'sqlite',     name: 'cc-switch.db',        path: '~/.cc-switch/cc-switch.db',    desc: 'rusqlite + WAL,热数据/索引/Usage/ProxyCfg/Skill/MCP' },
      { id: 'atomic',     name: 'atomic_write',        path: 'config.rs',                    desc: 'tempfile + rename,崩溃安全的 Live 配置写入' },
      { id: 'live_claude', name: '~/.claude/*',        path: '~/.claude/settings.json',      desc: 'Claude Code CLI 实际读取的配置文件' },
      { id: 'live_codex',  name: '~/.codex/*',         path: 'config.toml + auth-*.json',    desc: 'Codex CLI,profile 驱动的多 Provider 独立 auth 文件' },
      { id: 'live_gemini', name: '~/.gemini/*',        path: '~/.gemini/settings.json',      desc: 'Gemini CLI' },
      { id: 'live_opencode', name: '~/.config/opencode', path: '~/.config/opencode/',        desc: 'OpenCode' },
      { id: 'live_openclaw', name: '~/.openclaw/*',    path: '~/.openclaw/',                 desc: 'OpenClaw(不支持 MCP)' },
    ],
    tintLight: '#f8f0ff',
    tintDark: '#302040',
  },
  {
    id: 'L6',
    index: 6,
    title: '第 6 层 · LLM Providers (远端)',
    subtitle: 'HTTPS 出站 · 50+ 预设',
    modules: [
      { id: 'anthropic', name: 'Anthropic',  path: 'api.anthropic.com',          desc: 'Claude 原生协议' },
      { id: 'openai',    name: 'OpenAI',     path: 'api.openai.com',             desc: 'Chat Completions + Responses API' },
      { id: 'google',    name: 'Google AI',  path: 'generativelanguage.googleapis.com', desc: 'Gemini 2.x,thoughtSignature 需影子重放' },
      { id: 'copilot',   name: 'GitHub Copilot', path: 'copilot_auth.rs',        desc: '完整 OAuth + 订阅管理' },
      { id: 'deepseek',  name: 'DeepSeek',   path: 'api.deepseek.com',           desc: 'OpenAI 兼容,国产首选' },
      { id: 'moonshot',  name: 'Moonshot/智谱/通义',  path: '国产集合',         desc: '十数家国产 Provider,多数 OpenAI 兼容' },
    ],
    tintLight: '#fdf2f8',
    tintDark: '#3a1c30',
  },
];

interface TraceStep {
  layerId: string;
  moduleId: string;
  caption: string;
}

// 播放一次请求:代理模式下 Claude CLI 发出一次 /v1/messages,过程中遇到 Provider A 失败,自动 Failover 到 Provider B
const trace: TraceStep[] = [
  { layerId: 'L1', moduleId: 'ui_panel',      caption: '① 用户在 UI 中选中 Claude,并启用了"代理模式"' },
  { layerId: 'L2', moduleId: 'cmd_proxy',     caption: '② commands/proxy.rs 启动 ProxyServer,监听 127.0.0.1:PORT' },
  { layerId: 'L5', moduleId: 'ssot_json',     caption: '③ 从 SSOT 读取当前 claude.current + failover 队列' },
  { layerId: 'L4', moduleId: 'proxy_server',  caption: '④ Claude CLI 发出 POST /v1/messages 到本地代理' },
  { layerId: 'L4', moduleId: 'router',        caption: '⑤ ProviderRouter 选中 Provider A(熔断器状态 Closed)' },
  { layerId: 'L4', moduleId: 'transform',     caption: '⑥ transform_* 如需跨协议转发(如 Gemini 后端)' },
  { layerId: 'L6', moduleId: 'anthropic',     caption: '⑦ HTTPS 转发到 Provider A,SSE 流式返回' },
  { layerId: 'L4', moduleId: 'breaker',       caption: '⑧ Provider A 连续 4 次失败 → CircuitBreaker 打开' },
  { layerId: 'L4', moduleId: 'failover',      caption: '⑨ FailoverSwitch.try_switch() 选下一个 Provider B' },
  { layerId: 'L2', moduleId: 'cmd_provider',  caption: '⑩ 发 "provider-switched" 事件到前端' },
  { layerId: 'L1', moduleId: 'ui_panel',      caption: '⑪ TanStack Query 失效缓存,UI + 托盘菜单同步更新' },
  { layerId: 'L4', moduleId: 'sse',           caption: '⑫ SSE 流继续透传给 CLI,用户无感知完成切换' },
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
    accent: '#e94560',
    chipBg: isDark ? '#2a2a4a' : '#ffffff',
    chipBorder: isDark ? '#4a4a6e' : '#d1d5db',
    chipActive: isDark ? '#4a1c28' : '#ffe8ec',
    footerBg: isDark ? '#1e1e3a' : '#fafafa',
    codeText: isDark ? '#fca5a5' : '#be123c',
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
    }, 1700);
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
            fontFamily: '"JetBrains Mono", ui-monospace, monospace',
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
      点击任意子模块查看详情,或按「▶ 播放一次代理请求」追踪一次 Failover 完整链路
    </div>
  );

  const renderChip = (m: SubModule) => {
    const isActive = activeTraceId === m.id;
    const isSelected = selectedId === m.id;
    const highlighted = isActive || isSelected;
    return (
      <button
        key={m.id}
        type="button"
        onClick={() => {
          if (playing) stopTrace();
          setSelectedId(selectedId === m.id ? null : m.id);
        }}
        style={{
          display: 'inline-flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          padding: '6px 10px',
          border: `1.5px solid ${highlighted ? palette.accent : palette.chipBorder}`,
          borderRadius: 6,
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'inherit',
          background: highlighted ? palette.chipActive : palette.chipBg,
          transform: isActive ? 'scale(1.08)' : 'scale(1)',
          boxShadow: isActive ? `0 0 0 3px ${palette.accent}40` : 'none',
          transition: 'transform 0.25s, box-shadow 0.25s, border-color 0.25s, background 0.25s',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: highlighted ? palette.accent : palette.text }}>
          {m.name}
        </span>
        <span
          style={{
            fontSize: 11,
            fontFamily: '"JetBrains Mono", ui-monospace, monospace',
            color: palette.textMuted,
            marginTop: 1,
          }}
        >
          {m.path}
        </span>
      </button>
    );
  };

  const renderLayer = (layer: Layer) => {
    const layerActive = activeTraceId && layer.modules.some((m) => m.id === activeTraceId);

    return (
      <div
        key={layer.id}
        style={{
          border: `1.5px solid ${layerActive ? palette.accent : palette.border}`,
          borderRadius: 10,
          padding: 14,
          background: isDark ? layer.tintDark : layer.tintLight,
          transition: 'border-color 0.25s',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
          <div>
            <span style={{ fontWeight: 700, fontSize: 14, color: palette.text }}>{layer.title}</span>
            {layer.subtitle && (
              <span style={{ fontSize: 12, color: palette.textMuted, marginLeft: 10 }}>
                · {layer.subtitle}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: palette.textMuted, fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}>
            L{layer.index}
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {layer.modules.map(renderChip)}
        </div>
      </div>
    );
  };

  return (
    <div
      style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", Roboto, sans-serif',
        margin: '1.5rem 0',
        border: `1px solid ${palette.border}`,
        borderRadius: 12,
        overflow: 'hidden',
        background: palette.bg,
      }}
    >
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
          cc-switch 六层架构 — 所有子模块一览,点击查看详情
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
            {playing ? '⏹ 停止' : '▶ 播放一次代理请求'}
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

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(240px, 320px)',
          gap: 0,
        }}
        className="cc-arch-grid"
      >
        {/* Left: layer stack */}
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 0, minWidth: 0 }}>
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
                  ↓ 调用 / 写入
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
            ↑ 用户态 · 本地进程 · 远端 HTTPS;代理层可选旁路
          </div>
        </div>

        {/* Right: sticky detail panel */}
        <aside
          style={{
            borderLeft: `1px solid ${palette.border}`,
            background: palette.footerBg,
            padding: 16,
            alignSelf: 'start',
            position: 'sticky',
            top: 16,
          }}
          className="cc-arch-aside"
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.5,
              color: palette.textMuted,
              textTransform: 'uppercase',
              marginBottom: 10,
            }}
          >
            {currentStep ? '请求追踪' : selectedModule ? '模块详情' : '提示'}
          </div>
          <div style={{ minHeight: 120 }}>{footerContent}</div>
        </aside>
      </div>

      <style>{`
        @media (max-width: 820px) {
          .cc-arch-grid { grid-template-columns: 1fr !important; }
          .cc-arch-aside {
            border-left: none !important;
            border-top: 1px solid ${palette.border};
            position: static !important;
          }
        }
      `}</style>
    </div>
  );
}
