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
  { name: 'Telegram', icon: '\u{1f4e9}', detail: 'python-telegram-bot \u5e93\uff0c\u652f\u6301 Markdown \u683c\u5f0f\u3001\u56fe\u7247\u3001\u6587\u4ef6\u4e0a\u4f20\u3001\u5206\u7ec4\u804a\u5929\u3001reply-to \u7ebf\u7a0b\u3002', features: ['Markdown', '\u56fe\u7247', '\u5206\u7ec4'] },
  { name: 'Discord', icon: '\u{1f3ae}', detail: 'discord.py \u5e93\uff0c\u652f\u6301 embed \u5bcc\u6587\u672c\u3001\u591a\u670d\u52a1\u5668\u3001thread \u5b50\u7ebf\u7a0b\u3001\u6587\u4ef6\u9644\u4ef6\u3002', features: ['Embed', 'Threads', '\u591a\u670d\u52a1\u5668'] },
  { name: 'Slack', icon: '\u{1f4bc}', detail: 'Slack Bolt SDK\uff0c\u652f\u6301 Block Kit \u5bcc\u6587\u672c\u3001\u5de5\u4f5c\u533a\u9694\u79bb\u3001Thread \u56de\u590d\u3002', features: ['Block Kit', '\u5de5\u4f5c\u533a', 'Threads'] },
  { name: 'WhatsApp', icon: '\u{1f4f1}', detail: 'WhatsApp Business Cloud API\uff0c\u7eaf\u6587\u672c\u8f93\u51fa\uff08\u65e0 Markdown\uff09\uff0c4000 \u5b57\u7b26\u6d88\u606f\u9650\u5236\u3002', features: ['\u7eaf\u6587\u672c', '4K \u9650\u5236'] },
  { name: 'Matrix', icon: '\u{1f310}', detail: 'matrix-nio SDK\uff0c\u652f\u6301\u7aef\u5230\u7aef\u52a0\u5bc6\u3001\u53bb\u4e2d\u5fc3\u5316\u670d\u52a1\u5668\u3002', features: ['E2EE', '\u53bb\u4e2d\u5fc3\u5316'] },
  { name: 'Signal', icon: '\u{1f512}', detail: 'signal-cli \u6865\u63a5\uff0c\u52a0\u5bc6\u901a\u4fe1\uff0c\u652f\u6301\u5206\u7ec4\u804a\u5929\u3002', features: ['\u52a0\u5bc6', '\u5206\u7ec4'] },
  { name: 'IRC', icon: '\u{1f4bb}', detail: 'irc3 SDK\uff0c\u7eaf\u6587\u672c\u534f\u8bae\uff0c\u652f\u6301\u591a\u9891\u9053\u3002', features: ['\u7eaf\u6587\u672c', '\u591a\u9891\u9053'] },
  { name: 'SMS', icon: '\u{1f4f2}', detail: 'Twilio API \u96c6\u6210\uff0c160 \u5b57\u7b26 SMS \u9650\u5236\uff0c\u9700\u4ed8\u8d39\u53f7\u7801\u3002', features: ['160 \u5b57\u7b26', 'Twilio'] },
  { name: 'Email', icon: '\u2709\ufe0f', detail: 'IMAP/SMTP \u96c6\u6210\uff0c\u652f\u6301\u5bcc\u6587\u672c\u3001\u9644\u4ef6\u3001\u591a\u7528\u6237\u3002', features: ['HTML', '\u9644\u4ef6'] },
  { name: 'Webhook', icon: '\u{1f517}', detail: '\u901a\u7528 HTTP webhook \u7aef\u70b9\uff0c\u652f\u6301\u4efb\u610f\u5e73\u53f0\u96c6\u6210\u3002', features: ['HTTP', '\u901a\u7528'] },
  { name: 'Cron', icon: '\u23f0', detail: '\u5b9a\u65f6\u4efb\u52a1\u6a21\u5f0f\uff0cPLATFORM_HINTS \u544a\u77e5\u201c\u65e0\u7528\u6237\u5728\u573a\uff0c\u5b8c\u5168\u81ea\u4e3b\u6267\u884c\u201d\u3002', features: ['\u81ea\u4e3b', '\u5b9a\u65f6'] },
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
        Gateway \u6d88\u606f\u5206\u53d1 \u2014 1 \u4e2a AIAgent \u8fdb\u7a0b \u2192 15 \u4e2a\u5e73\u53f0
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
              gateway/run.py \u00b7 BasePlatformAdapter
            </div>
          </div>

          {/* Fan-out arrow */}
          <div style={{ textAlign: 'center', fontSize: 16, color: palette.accent, margin: '4px 0' }}>\u2193 MessageEvent \u2193</div>

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
                  \u67b6\u6784\u6a21\u5f0f\uff1a<code style={{ color: isDark ? '#e8a87c' : '#d97757' }}>BasePlatformAdapter</code> \u2192{' '}
                  <code style={{ color: isDark ? '#e8a87c' : '#d97757' }}>{activePlatform.name}Adapter</code> \u2192 MessageEvent \u2192
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
                \u2190 \u70b9\u51fb\u5e73\u53f0\u56fe\u6807\u67e5\u770b\u8be6\u60c5
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
