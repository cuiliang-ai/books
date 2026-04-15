/**
 * ConfigLayerStack — ch25 四层配置优先级堆栈图
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const layers = [
  {
    level: 4,
    name: '环境变量',
    icon: '🔧',
    priority: '最高',
    color: '#ef4444',
    examples: ['HERMES_MODEL=gpt-4', 'HERMES_TERMINAL_BACKEND=docker', 'OPENAI_API_KEY=sk-...'],
    desc: '环境变量拥有最高优先级，覆盖一切。适合 CI/CD、临时调试、密钥注入。通过 os.environ 直接读取，不写入配置文件。',
    source: 'os.environ',
  },
  {
    level: 3,
    name: '用户配置',
    icon: '👤',
    priority: '高',
    color: '#f59e0b',
    examples: ['~/.hermes/config.yaml', 'agent.default_model: claude-3.5-sonnet', 'display.skin: poseidon'],
    desc: '用户级配置文件，全局生效。deep merge 合并策略——字典递归合并，标量值直接覆盖。Profile 系统让每个 profile 拥有独立的用户配置。',
    source: '~/.hermes/config.yaml',
  },
  {
    level: 2,
    name: '项目配置',
    icon: '📁',
    priority: '中',
    color: '#3b82f6',
    examples: ['.hermes.yaml (项目根目录)', 'terminal.backend: docker', 'agent.allowed_tools: [terminal, file_read]'],
    desc: '项目级配置，仅在特定项目目录下生效。通常用于限定工具集、指定后端、配置项目专用的 context files。',
    source: '.hermes.yaml',
  },
  {
    level: 1,
    name: '硬编码默认值',
    icon: '⚙️',
    priority: '最低',
    color: '#10b981',
    examples: ['agent.max_turns: 100', 'terminal.timeout: 300', 'approvals.mode: smart'],
    desc: '代码中的硬编码默认值，作为兜底。确保所有配置项都有合理的初始值。不需要任何配置文件即可运行。',
    source: 'config_defaults.py',
  },
];

const credStrategies = [
  { name: 'fill_first', desc: '优先填满第一个凭据，耗尽后切换', icon: '1️⃣' },
  { name: 'round_robin', desc: '轮询分配请求到各凭据', icon: '🔄' },
  { name: 'random', desc: '随机选择可用凭据', icon: '🎲' },
  { name: 'least_used', desc: '选择使用次数最少的凭据', icon: '📊' },
];

function useTheme(): 'light'|'dark' { const [t,setT]=useState<'light'|'dark'>('light'); useEffect(()=>{const r=document.documentElement;const d=()=>setT(r.dataset.theme==='dark'?'dark':'light');d();const o=new MutationObserver(d);o.observe(r,{attributes:true,attributeFilter:['data-theme']});return()=>o.disconnect();},[]);return t; }

export default function ConfigLayerStack() {
  const isDark = useTheme() === 'dark';
  const [sel, setSel] = useState<number|null>(null);
  const p = { bg: isDark?'#1a1a2e':'#fff', border: isDark?'#3a3a5e':'#e2e8f0', text: isDark?'#e2e8f0':'#2c3e50', muted: isDark?'#a0aec0':'#718096', accent: '#d97757', cardBg: isDark?'#252545':'#f8f9fa', codeBg: isDark?'#2a2a4a':'#f0f4f8' };

  return (
    <div style={{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',margin:'1.5rem 0',border:`1px solid ${p.border}`,borderRadius:12,overflow:'hidden',background:p.bg}}>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${p.border}`,background:p.cardBg,fontSize:14,fontWeight:600,color:p.accent}}>配置优先级堆栈 — 从高到低覆盖</div>
      <div style={{padding:16}}>
        {/* Stack visualization */}
        <div style={{display:'flex',flexDirection:'column',gap:6,marginBottom:16}}>
          {layers.map((layer, i) => (
            <motion.div
              key={i}
              onClick={()=>setSel(sel===i?null:i)}
              whileHover={{scale:1.01}}
              animate={{borderColor:sel===i?layer.color:p.border}}
              style={{
                padding:'12px 16px',
                borderRadius:8,
                border:`2px solid ${p.border}`,
                cursor:'pointer',
                background:sel===i?`${layer.color}10`:'transparent',
                transition:'background 0.2s',
                display:'flex',
                alignItems:'center',
                gap:12,
              }}
            >
              <span style={{fontSize:20}}>{layer.icon}</span>
              <div style={{flex:1}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{fontWeight:700,fontSize:14,color:layer.color}}>{layer.name}</span>
                  <span style={{fontSize:11,padding:'1px 6px',borderRadius:4,background:`${layer.color}20`,color:layer.color}}>优先级: {layer.priority}</span>
                </div>
                <div style={{fontSize:12,color:p.muted,marginTop:2}}>来源: <code>{layer.source}</code></div>
              </div>
              <div style={{fontSize:11,color:p.muted}}>Level {layer.level}</div>
            </motion.div>
          ))}
        </div>

        {/* Detail */}
        <AnimatePresence mode="wait">
          {sel !== null && (
            <motion.div key={sel} initial={{opacity:0,height:0}} animate={{opacity:1,height:'auto'}} exit={{opacity:0,height:0}} style={{overflow:'hidden'}}>
              <div style={{padding:16,background:p.codeBg,borderRadius:8,borderLeft:`3px solid ${layers[sel].color}`}}>
                <p style={{fontSize:13,lineHeight:1.7,color:p.text,margin:'0 0 8px'}}>{layers[sel].desc}</p>
                <div style={{fontSize:12,fontWeight:600,color:p.accent,marginBottom:4}}>示例</div>
                {layers[sel].examples.map(ex => (
                  <code key={ex} style={{display:'block',fontSize:11,color:p.text,padding:'2px 0'}}>{ex}</code>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Credential strategies */}
        <div style={{marginTop:16,padding:'12px 16px',background:p.cardBg,borderRadius:8}}>
          <div style={{fontSize:13,fontWeight:600,color:p.accent,marginBottom:8}}>Credential Pool — 4 种分配策略</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4, 1fr)',gap:8}}>
            {credStrategies.map(cs => (
              <div key={cs.name} style={{padding:'8px 10px',background:p.codeBg,borderRadius:6,textAlign:'center'}}>
                <div style={{fontSize:18}}>{cs.icon}</div>
                <code style={{fontSize:11,color:p.accent,fontWeight:600}}>{cs.name}</code>
                <div style={{fontSize:10,color:p.muted,marginTop:4}}>{cs.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
