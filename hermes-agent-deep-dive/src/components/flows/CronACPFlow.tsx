/**
 * CronACPFlow — ch23 Cron 调度 + ACP 集成 + 三种运行模式对比
 */
import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

const modes = [
  {
    name: 'Gateway',
    icon: '🌐',
    desc: '平台消息驱动的交互模式',
    dims: {
      '触发方式': '用户消息到达',
      '并发模型': '每用户一个 asyncio.Task',
      '消息来源': '15+ 平台适配器',
      '结果投递': '原平台回复',
      '会话持久化': '自动保存到 SessionDB',
      '工具限制': '完整工具集',
      '中断支持': '新消息中断当前回复',
      '记忆访问': '完整 Memory + Skills',
      '上下文文件': '按平台配置加载',
    },
  },
  {
    name: 'Cron',
    icon: '⏰',
    desc: '定时任务调度模式',
    dims: {
      '触发方式': 'tick() 定时检查 + 文件锁',
      '并发模型': '串行执行（文件锁互斥）',
      '消息来源': 'cron_jobs.json 配置',
      '结果投递': '跨平台投递或本地保存',
      '会话持久化': '保存到 SessionDB',
      '工具限制': '禁用 cronjob/messaging/clarify',
      '中断支持': '不支持',
      '记忆访问': '跳过 Memory 和 Skills',
      '上下文文件': '跳过 (skip_context_files=True)',
    },
  },
  {
    name: 'ACP',
    icon: '🔌',
    desc: 'IDE 集成的 Agent Communication Protocol',
    dims: {
      '触发方式': 'stdio JSON-RPC 请求',
      '并发模型': 'ThreadPoolExecutor(4)',
      '消息来源': 'IDE / 外部程序',
      '结果投递': 'JSON-RPC 响应 + 回调',
      '会话持久化': 'SessionManager 管理',
      '工具限制': '完整工具集 + MCP 服务器',
      '中断支持': '支持 (ACP cancel)',
      '记忆访问': '完整 Memory + Skills',
      '上下文文件': '正常加载',
    },
  },
];

const dimKeys = Object.keys(modes[0].dims);

function useTheme(): 'light'|'dark' { const [t,setT]=useState<'light'|'dark'>('light'); useEffect(()=>{const r=document.documentElement;const d=()=>setT(r.dataset.theme==='dark'?'dark':'light');d();const o=new MutationObserver(d);o.observe(r,{attributes:true,attributeFilter:['data-theme']});return()=>o.disconnect();},[]);return t; }

export default function CronACPFlow() {
  const isDark = useTheme() === 'dark';
  const [sel, setSel] = useState<number | null>(null);
  const p = { bg: isDark?'#1a1a2e':'#fff', border: isDark?'#3a3a5e':'#e2e8f0', text: isDark?'#e2e8f0':'#2c3e50', muted: isDark?'#a0aec0':'#718096', accent: '#d97757', cardBg: isDark?'#252545':'#f8f9fa', codeBg: isDark?'#2a2a4a':'#f0f4f8' };
  const colors = ['#3b82f6', '#f59e0b', '#10b981'];

  return (
    <div style={{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',margin:'1.5rem 0',border:`1px solid ${p.border}`,borderRadius:12,overflow:'hidden',background:p.bg}}>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${p.border}`,background:p.cardBg,fontSize:14,fontWeight:600,color:p.accent}}>三种运行模式对比 — Gateway / Cron / ACP</div>
      <div style={{padding:16}}>
        {/* Mode selector */}
        <div style={{display:'flex',gap:8,marginBottom:16}}>
          {modes.map((m, i) => (
            <motion.button key={i} onClick={()=>setSel(sel===i?null:i)} whileHover={{scale:1.02}} style={{flex:1,padding:'12px 16px',borderRadius:8,border:`2px solid ${sel===i?colors[i]:p.border}`,background:sel===i?`${colors[i]}15`:'transparent',cursor:'pointer',textAlign:'center',transition:'all 0.2s'}}>
              <div style={{fontSize:24}}>{m.icon}</div>
              <div style={{fontWeight:700,fontSize:14,color:sel===i?colors[i]:p.text,marginTop:4}}>{m.name}</div>
              <div style={{fontSize:11,color:p.muted,marginTop:2}}>{m.desc}</div>
            </motion.button>
          ))}
        </div>

        {/* Comparison table */}
        <div style={{borderRadius:8,overflow:'hidden',border:`1px solid ${p.border}`}}>
          {/* Header */}
          <div style={{display:'grid',gridTemplateColumns:'140px repeat(3, 1fr)',background:p.cardBg,borderBottom:`1px solid ${p.border}`}}>
            <div style={{padding:'8px 12px',fontSize:12,fontWeight:600,color:p.muted}}>维度</div>
            {modes.map((m, i) => (
              <div key={i} style={{padding:'8px 12px',fontSize:12,fontWeight:700,color:colors[i],textAlign:'center',borderLeft:`1px solid ${p.border}`,background:sel===i?`${colors[i]}10`:'transparent'}}>{m.icon} {m.name}</div>
            ))}
          </div>
          {/* Rows */}
          {dimKeys.map((dim, ri) => (
            <div key={dim} style={{display:'grid',gridTemplateColumns:'140px repeat(3, 1fr)',borderBottom:ri<dimKeys.length-1?`1px solid ${p.border}`:'none',background:ri%2===0?'transparent':`${p.codeBg}`}}>
              <div style={{padding:'8px 12px',fontSize:12,fontWeight:600,color:p.accent}}>{dim}</div>
              {modes.map((m, i) => (
                <div key={i} style={{padding:'8px 12px',fontSize:12,color:sel===i?p.text:p.muted,borderLeft:`1px solid ${p.border}`,background:sel===i?`${colors[i]}08`:'transparent',fontWeight:sel===i?600:400,transition:'all 0.2s'}}>
                  {(m.dims as Record<string,string>)[dim]}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
