/**
 * ThreadingBridge — ch27 同步异步桥接与线程模型交互图
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const branches = [
  {
    name: 'Gateway / RL 分支',
    icon: '🌐',
    color: '#3b82f6',
    condition: '已有运行中的事件循环',
    solution: 'ThreadPoolExecutor(1) → 新线程 → asyncio.run(coro)',
    detail: 'Gateway 和 RL 训练在异步上下文中运行。当工具代码（同步）需要调用异步函数时，不能在当前循环中 run_until_complete()——会死锁。解决方案：在新线程中创建全新的事件循环。',
    thread: '新建线程（ThreadPoolExecutor）',
    loop: '全新事件循环（asyncio.run）',
    lifetime: '短期——任务完成即销毁',
  },
  {
    name: 'Worker 线程分支',
    icon: '⚙️',
    color: '#f59e0b',
    condition: '非主线程 + 无运行中循环',
    solution: 'threading.local() → _get_worker_loop() → run_until_complete()',
    detail: '并行工具执行的 worker 线程。每个线程通过 threading.local() 持有自己的事件循环，长期复用。避免反复创建/销毁循环的开销。',
    thread: '当前 worker 线程',
    loop: 'threading.local 持有的长期循环',
    lifetime: '长期——线程存活期间复用',
  },
  {
    name: 'CLI 主线程分支',
    icon: '💻',
    color: '#10b981',
    condition: '主线程 + 无运行中循环',
    solution: '_get_tool_loop() → 模块级长期循环 → run_until_complete()',
    detail: 'CLI 的主线程是同步的。使用模块级变量 _tool_loop 持有一个长期事件循环。所有工具的异步调用都在这个循环中执行，保证 MCP 客户端的连接状态不丢失。',
    thread: '主线程',
    loop: '模块级 _tool_loop（长期存活）',
    lifetime: '长期——进程存活期间复用',
  },
];

const parallelTools = {
  safe: ['web_search', 'web_read', 'file_read', 'session_search', 'memory_read', 'skills_list', 'browser_read', 'code_exec', 'delegate', 'health_check', 'version', 'help'],
  never: ['clarify'],
  pathScoped: ['file_read', 'file_write', 'file_patch'],
};

function useTheme(): 'light'|'dark' { const [t,setT]=useState<'light'|'dark'>('light'); useEffect(()=>{const r=document.documentElement;const d=()=>setT(r.dataset.theme==='dark'?'dark':'light');d();const o=new MutationObserver(d);o.observe(r,{attributes:true,attributeFilter:['data-theme']});return()=>o.disconnect();},[]);return t; }

export default function ThreadingBridge() {
  const isDark = useTheme() === 'dark';
  const [sel, setSel] = useState(0);
  const p = { bg: isDark?'#1a1a2e':'#fff', border: isDark?'#3a3a5e':'#e2e8f0', text: isDark?'#e2e8f0':'#2c3e50', muted: isDark?'#a0aec0':'#718096', accent: '#d97757', cardBg: isDark?'#252545':'#f8f9fa', codeBg: isDark?'#2a2a4a':'#f0f4f8' };
  const br = branches[sel];

  return (
    <div style={{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',margin:'1.5rem 0',border:`1px solid ${p.border}`,borderRadius:12,overflow:'hidden',background:p.bg}}>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${p.border}`,background:p.cardBg,fontSize:14,fontWeight:600,color:p.accent}}>_run_async() 三分支决策树 — 同步↔异步桥接</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',minHeight:340}}>
        {/* Branch selector */}
        <div style={{padding:16}}>
          <div style={{fontSize:12,fontWeight:600,color:p.muted,marginBottom:8}}>调用 _run_async(coro) 时的三种路径：</div>
          {branches.map((b, i) => (
            <motion.div key={i} onClick={()=>setSel(i)} whileHover={{x:2}} style={{padding:'12px 14px',borderRadius:8,marginBottom:6,cursor:'pointer',border:`2px solid ${i===sel?b.color:p.border}`,background:i===sel?`${b.color}10`:'transparent',transition:'all 0.2s'}}>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{fontSize:18}}>{b.icon}</span>
                <div>
                  <div style={{fontWeight:700,fontSize:13,color:i===sel?b.color:p.text}}>{b.name}</div>
                  <div style={{fontSize:11,color:p.muted,marginTop:2}}>条件: {b.condition}</div>
                </div>
              </div>
            </motion.div>
          ))}

          {/* Parallel tool safety */}
          <div style={{marginTop:12,padding:'10px 12px',background:p.codeBg,borderRadius:8}}>
            <div style={{fontSize:12,fontWeight:600,color:p.accent,marginBottom:6}}>并行安全分类 (MAX_WORKERS=8)</div>
            <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
              <span style={{fontSize:10,padding:'2px 6px',borderRadius:4,background:'#10b98120',color:'#10b981',border:'1px solid #10b98140'}}>安全: {parallelTools.safe.length} 工具</span>
              <span style={{fontSize:10,padding:'2px 6px',borderRadius:4,background:'#ef444420',color:'#ef4444',border:'1px solid #ef444440'}}>禁止: {parallelTools.never.length} 工具</span>
              <span style={{fontSize:10,padding:'2px 6px',borderRadius:4,background:'#f59e0b20',color:'#f59e0b',border:'1px solid #f59e0b40'}}>路径隔离: {parallelTools.pathScoped.length} 工具</span>
            </div>
          </div>
        </div>

        {/* Detail */}
        <div style={{borderLeft:`1px solid ${p.border}`,padding:20}}>
          <AnimatePresence mode="wait">
            <motion.div key={sel} initial={{opacity:0,x:20}} animate={{opacity:1,x:0}} exit={{opacity:0}}>
              <h4 style={{margin:'0 0 8px',color:br.color,fontSize:15}}>{br.icon} {br.name}</h4>
              <p style={{fontSize:13,lineHeight:1.7,color:p.text,margin:'0 0 12px'}}>{br.detail}</p>

              <div style={{display:'grid',gap:8}}>
                <div style={{padding:'8px 12px',background:p.codeBg,borderRadius:6}}>
                  <div style={{fontSize:11,fontWeight:600,color:p.muted}}>方案</div>
                  <code style={{fontSize:12,color:br.color}}>{br.solution}</code>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                  <div style={{padding:'8px 12px',background:p.codeBg,borderRadius:6}}>
                    <div style={{fontSize:11,fontWeight:600,color:p.muted}}>线程</div>
                    <div style={{fontSize:12,color:p.text}}>{br.thread}</div>
                  </div>
                  <div style={{padding:'8px 12px',background:p.codeBg,borderRadius:6}}>
                    <div style={{fontSize:11,fontWeight:600,color:p.muted}}>事件循环</div>
                    <div style={{fontSize:12,color:p.text}}>{br.loop}</div>
                  </div>
                </div>
                <div style={{padding:'8px 12px',background:p.codeBg,borderRadius:6}}>
                  <div style={{fontSize:11,fontWeight:600,color:p.muted}}>生命周期</div>
                  <div style={{fontSize:12,color:p.text}}>{br.lifetime}</div>
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
