/**
 * PlatformAdapterCards — ch22 平台适配器模式对比卡片
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const adapters = [
  { name: 'Telegram', icon: '📱', transport: 'Webhook / Long Poll', limit: '4096 UTF-16', features: ['内联键盘', 'Markdown v2', '文件上传', '编辑已发消息'], challenge: 'UTF-16 长度计算——emoji 算 2 个字符' },
  { name: 'Discord', icon: '🎮', transport: 'Gateway WebSocket', limit: '2000 chars', features: ['Embed 富文本', '按钮交互', '线程', 'Slash 命令'], challenge: 'Rate limit 精细——每通道/全局/每消息独立限制' },
  { name: 'Slack', icon: '💼', transport: 'Socket Mode / Events API', limit: '39000 chars', features: ['Block Kit UI', '模态框', '线程回复', 'App Home'], challenge: 'Block Kit 需要结构化 JSON 而非纯文本' },
  { name: 'WhatsApp', icon: '📲', transport: 'Cloud API Webhook', limit: '4096 chars', features: ['模板消息', '交互按钮', '媒体消息', '状态已读'], challenge: '模板消息需预审批，24 小时会话窗口' },
  { name: 'Matrix', icon: '🌐', transport: 'Client-Server API', limit: '无硬性限制', features: ['E2EE 加密', '房间联邦', '富文本 HTML', '自定义事件'], challenge: '端到端加密需管理 Olm/Megolm 会话密钥' },
  { name: 'DingTalk', icon: '🔔', transport: 'Stream / Webhook', limit: '20000 chars', features: ['卡片消息', 'ActionCard', '群机器人', 'CoolApp'], challenge: '签名验证 + 企业内部应用/第三方应用双模式' },
  { name: 'Feishu', icon: '🐦', transport: 'Event Subscription', limit: '30000 chars', features: ['卡片消息', '富文本', '群机器人', '审批集成'], challenge: 'tenant_access_token 2 小时过期需自动刷新' },
  { name: 'WeCom', icon: '🏢', transport: 'Callback URL', limit: '2048 chars', features: ['应用消息', '图文混排', '小程序卡片', '审批'], challenge: 'AES 消息加解密 + 回调验证' },
  { name: 'Signal', icon: '🔒', transport: 'signal-cli REST', limit: '无限制', features: ['E2EE 默认', '群组V2', '贴纸', '引用回复'], challenge: '依赖 signal-cli 进程，注册需验证码' },
  { name: 'IRC', icon: '💬', transport: 'IRC Protocol', limit: '512 bytes/line', features: ['多频道', '简单文本', 'CTCP', 'DCC'], challenge: '512 字节限制需智能分行，无富文本' },
];

const dims = ['transport', 'limit', 'features', 'challenge'] as const;
const dimLabels: Record<string, string> = { transport: '传输协议', limit: '消息长度限制', features: '特色能力', challenge: '核心挑战' };

function useTheme(): 'light'|'dark' { const [t,setT]=useState<'light'|'dark'>('light'); useEffect(()=>{const r=document.documentElement;const d=()=>setT(r.dataset.theme==='dark'?'dark':'light');d();const o=new MutationObserver(d);o.observe(r,{attributes:true,attributeFilter:['data-theme']});return()=>o.disconnect();},[]);return t; }

export default function PlatformAdapterCards() {
  const isDark = useTheme() === 'dark';
  const [sel, setSel] = useState(0);
  const p = { bg: isDark?'#1a1a2e':'#fff', border: isDark?'#3a3a5e':'#e2e8f0', text: isDark?'#e2e8f0':'#2c3e50', muted: isDark?'#a0aec0':'#718096', accent: '#d97757', cardBg: isDark?'#252545':'#f8f9fa', detailBg: isDark?'#1e1e3a':'#fafafa', codeBg: isDark?'#2a2a4a':'#f0f4f8' };
  const ad = adapters[sel];

  return (
    <div style={{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',margin:'1.5rem 0',border:`1px solid ${p.border}`,borderRadius:12,overflow:'hidden',background:p.bg}}>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${p.border}`,background:p.cardBg,fontSize:14,fontWeight:600,color:p.accent}}>Platform Adapters — BasePlatformAdapter 统一抽象</div>
      <div style={{display:'grid',gridTemplateColumns:'200px 1fr',minHeight:300}}>
        {/* Platform list */}
        <div style={{borderRight:`1px solid ${p.border}`,padding:8,overflowY:'auto',maxHeight:400}}>
          {adapters.map((a, i) => (
            <motion.div key={i} onClick={()=>setSel(i)} whileHover={{x:2}} style={{padding:'8px 12px',borderRadius:8,cursor:'pointer',marginBottom:2,background:i===sel?(isDark?'#2d2d5e':'#fff5f0'):'transparent',borderLeft:i===sel?`3px solid ${p.accent}`:'3px solid transparent',transition:'background 0.2s'}}>
              <span style={{fontSize:14}}>{a.icon}</span>
              <span style={{fontSize:13,fontWeight:i===sel?700:400,color:i===sel?p.accent:p.text,marginLeft:6}}>{a.name}</span>
            </motion.div>
          ))}
        </div>
        {/* Detail */}
        <AnimatePresence mode="wait">
          <motion.div key={sel} initial={{opacity:0,x:20}} animate={{opacity:1,x:0}} exit={{opacity:0}} style={{padding:20}}>
            <h4 style={{margin:'0 0 12px',color:p.accent,fontSize:16}}>{ad.icon} {ad.name}</h4>
            <div style={{display:'grid',gap:10}}>
              <div style={{padding:'8px 12px',background:p.codeBg,borderRadius:8}}>
                <div style={{fontSize:11,fontWeight:600,color:p.muted,marginBottom:4}}>传输协议</div>
                <div style={{fontSize:13,color:p.text}}>{ad.transport}</div>
              </div>
              <div style={{padding:'8px 12px',background:p.codeBg,borderRadius:8}}>
                <div style={{fontSize:11,fontWeight:600,color:p.muted,marginBottom:4}}>消息长度限制</div>
                <code style={{fontSize:13,color:p.accent}}>{ad.limit}</code>
              </div>
              <div style={{padding:'8px 12px',background:p.codeBg,borderRadius:8}}>
                <div style={{fontSize:11,fontWeight:600,color:p.muted,marginBottom:4}}>特色能力</div>
                <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
                  {ad.features.map(f => <span key={f} style={{fontSize:11,padding:'2px 8px',borderRadius:4,background:isDark?'#3a2a20':'#fff5f0',color:p.accent,border:`1px solid ${p.accent}33`}}>{f}</span>)}
                </div>
              </div>
              <div style={{padding:'8px 12px',background:isDark?'#2a2040':'#fef3f2',borderRadius:8,borderLeft:'3px solid #ef4444'}}>
                <div style={{fontSize:11,fontWeight:600,color:'#ef4444',marginBottom:4}}>核心挑战</div>
                <div style={{fontSize:13,color:p.text}}>{ad.challenge}</div>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
