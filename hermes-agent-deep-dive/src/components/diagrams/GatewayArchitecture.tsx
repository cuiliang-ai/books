/**
 * GatewayArchitecture — ch21 interactive diagram: 1 Agent → 15 platforms fan-out
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface Platform {
  name: string;
  icon: string;
  detail: string;
  features: string[];
}

const platforms: Platform[] = [
  { name: 'Telegram', icon: '📩', detail: 'python-telegram-bot 库，支持 Markdown 格式、图片、文件上传、分组聊天、reply-to 线程。', features: ['Markdown', '图片', '分组'] },
  { name: 'Discord', icon: '🎮', detail: 'discord.py 库，支持 embed 富文本、多服务器、thread 子线程、文件附件。', features: ['Embed', 'Threads', '多服务器'] },
  { name: 'Slack', icon: '💼', detail: 'Slack Bolt SDK，支持 Block Kit 富文本、工作区隔离、Thread 回复。', features: ['Block Kit', '工作区', 'Threads'] },
  { name: 'WhatsApp', icon: '📱', detail: 'WhatsApp Business Cloud API，纯文本输出（无 Markdown），4000 字符消息限制。', features: ['纯文本', '4K 限制'] },
  { name: 'Matrix', icon: '🌐', detail: 'matrix-nio SDK，支持端到端加密、去中心化服务器。', features: ['E2EE', '去中心化'] },
  { name: 'Signal', icon: '🔒', detail: 'signal-cli 桥接，加密通信，支持分组聊天。', features: ['加密', '分组'] },
  { name: 'IRC', icon: '💻', detail: 'irc3 SDK，纯文本协议，支持多频道。', features: ['纯文本', '多频道'] },
  { name: 'SMS', icon: '📲', detail: 'Twilio API 集成，160 字符 SMS 限制，需付费号码。', features: ['160 字符', 'Twilio'] },
  { name: 'Email', icon: '✉️', detail: 'IMAP/SMTP 集成，支持富文本、附件、多用户。', features: ['HTML', '附件'] },
  { name: 'Webhook', icon: '🔗', detail: '通用 HTTP webhook 端点，支持任意平台集成。', features: ['HTTP', '通用'] },
  { name: 'Cron', icon: '⏰', detail: '定时任务模式，PLATFORM_HINTS 告知“无用户在场，完全自主执行”。', features: ['自主', '定时'] },
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

export default function GatewayArchitecture() {
  const theme = useTheme();
  const isDark = theme === 'dark';
  const [selected, setSelected] = useState<string | null>(null);

  const palette = {
    bg: isDark ? '#1a1a2e' : '#ffffff',
    cardBg: isDark ? '#252545' : '#f8f9fa',
    border: isDark ? '#3a3a5e' : '#e2e8f0',
    text: isDark ? '#e2e8f0' : '#2c3e50',
    textMuted: isDark ? '#a0aec0' : '#718096',
    accent: '#d97757',
    detailBg: isDark ? '#1e1e3a' : '#fafafa',
    tagBg: isDark ? '#2a2a4a' : '#f0f4f8',
  };

  const activePlatform = platforms.find((p) => p.name === selected);

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
        Gateway 消息分发 — 1 个 AIAgent 进程 → 15 个平台
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', minHeight: 320 }}>
        {/* Hub-and-spoke layout */}
        <div style={{ padding: 16 }}>
          {/* Central AIAgent node */}
          <div
            style={{
              textAlign: 'center',
              margin: '12px 0 16px',
              padding: '12px',
              border: `2px solid ${palette.accent}`,
              borderRadius: 10,
              background: isDark ? '#2d2d5e' : '#fff5f0',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: palette.accent }}>
              GatewayRunner + AIAgent
            </div>
            <div style={{ fontSize: 12, color: palette.textMuted }}>
              gateway/run.py · BasePlatformAdapter
            </div>
          </div>

          {/* Fan-out arrow */}
          <div style={{ textAlign: 'center', fontSize: 16, color: palette.accent, margin: '4px 0' }}>↓ MessageEvent ↓</div>

          {/* Platform grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginTop: 8 }}>
            {platforms.map((p) => {
              const isActive = p.name === selected;
              return (
                <motion.div
                  key={p.name}
                  onClick={() => setSelected(isActive ? null : p.name)}
                  whileHover={{ scale: 1.05 }}
                  animate={{
                    borderColor: isActive ? palette.accent : palette.border,
                    background: isActive ? (isDark ? '#2d2d5e' : '#fff5f0') : palette.cardBg,
                  }}
                  style={{
                    padding: '8px 4px',
                    borderRadius: 8,
                    border: `1.5px solid ${palette.border}`,
                    cursor: 'pointer',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: 20 }}>{p.icon}</div>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: isActive ? palette.accent : palette.text,
                      marginTop: 2,
                    }}
                  >
                    {p.name}
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Detail pane */}
        <div style={{ borderLeft: `1px solid ${palette.border}`, padding: 20, background: palette.detailBg }}>
          <AnimatePresence mode="wait">
            {activePlatform ? (
              <motion.div
                key={activePlatform.name}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
              >
                <h4 style={{ margin: '0 0 8px', color: palette.accent, fontSize: 16 }}>
                  {activePlatform.icon} {activePlatform.name}
                </h4>
                <p style={{ fontSize: 14, lineHeight: 1.7, color: palette.text, margin: '0 0 12px' }}>
                  {activePlatform.detail}
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {activePlatform.features.map((f) => (
                    <span
                      key={f}
                      style={{
                        fontSize: 12,
                        background: palette.tagBg,
                        color: isDark ? '#e8a87c' : '#d97757',
                        padding: '2px 8px',
                        borderRadius: 4,
                      }}
                    >
                      {f}
                    </span>
                  ))}
                </div>
                <div
                  style={{
                    marginTop: 16,
                    padding: '8px 12px',
                    background: palette.tagBg,
                    borderRadius: 6,
                    fontSize: 12,
                    color: palette.textMuted,
                    lineHeight: 1.6,
                  }}
                >
                  架构模式：<code style={{ color: isDark ? '#e8a87c' : '#d97757' }}>BasePlatformAdapter</code> →{' '}
                  <code style={{ color: isDark ? '#e8a87c' : '#d97757' }}>{activePlatform.name}Adapter</code> → MessageEvent →
                  AIAgent
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="placeholder"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                style={{ color: palette.textMuted, fontSize: 14, fontStyle: 'italic' }}
              >
                ← 点击平台图标查看详情
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
