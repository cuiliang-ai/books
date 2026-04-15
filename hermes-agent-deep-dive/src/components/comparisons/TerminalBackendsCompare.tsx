/**
 * TerminalBackendsCompare — ch12 六种终端后端对比卡片
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const backends = [
  { name: 'Local', icon: '💻', pros: ['零延迟', '完整文件系统', '原生性能'], cons: ['无隔离', '安全风险'], desc: '直接在宿主机执行命令。subprocess.run() 驱动，支持 CWD 追踪和超时控制。' },
  { name: 'Docker', icon: '🐳', pros: ['进程隔离', '可复现环境', '持久文件系统'], cons: ['启动延迟', '需要 Docker'], desc: '每个 task_id 一个容器。bind mount 实现持久文件系统，docker exec 执行命令。' },
  { name: 'SSH', icon: '🔐', pros: ['远程执行', '复用现有基础设施'], cons: ['网络延迟', '需要密钥配置'], desc: 'paramiko 库驱动。支持密钥认证和密码认证，持久 SSH session 复用连接。' },
  { name: 'Modal', icon: '☁️', pros: ['无服务器', '按需 GPU', '自动扩缩'], cons: ['冷启动延迟', '需要 Modal 账号'], desc: 'Modal.com 无服务器平台集成。支持 GPU 实例和自定义镜像，休眠-唤醒模式。' },
  { name: 'Daytona', icon: '🏗️', pros: ['云开发环境', 'IDE 集成'], cons: ['需要 Daytona 服务'], desc: 'Daytona SDK 集成，云端开发环境。支持预配置的开发容器和工作区。' },
  { name: 'Singularity', icon: '🔬', pros: ['HPC 兼容', '无需 root', '可复现'], cons: ['主要用于 HPC 集群'], desc: 'Singularity/Apptainer 容器。面向 HPC 集群环境，用户级容器运行，无需特权。' },
];

function useTheme(): 'light'|'dark' { const [t,setT]=useState<'light'|'dark'>('light'); useEffect(()=>{const r=document.documentElement;const d=()=>setT(r.dataset.theme==='dark'?'dark':'light');d();const o=new MutationObserver(d);o.observe(r,{attributes:true,attributeFilter:['data-theme']});return()=>o.disconnect();},[]);return t; }

export default function TerminalBackendsCompare() {
  const isDark = useTheme() === 'dark';
  const [sel, setSel] = useState(0);
  const p = { bg: isDark?'#1a1a2e':'#fff', border: isDark?'#3a3a5e':'#e2e8f0', text: isDark?'#e2e8f0':'#2c3e50', muted: isDark?'#a0aec0':'#718096', accent: '#d97757', cardBg: isDark?'#252545':'#f8f9fa', detailBg: isDark?'#1e1e3a':'#fafafa' };
  const b = backends[sel];

  return (
    <div style={{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',margin:'1.5rem 0',border:`1px solid ${p.border}`,borderRadius:12,overflow:'hidden',background:p.bg}}>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${p.border}`,background:p.cardBg,fontSize:14,fontWeight:600,color:p.accent}}>六种终端后端 — BaseEnvironment 统一抽象</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',minHeight:260}}>
        <div style={{padding:12,display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,alignContent:'start'}}>
          {backends.map((be,i)=>(
            <motion.div key={i} onClick={()=>setSel(i)} whileHover={{scale:1.03}} animate={{borderColor:i===sel?p.accent:p.border,background:i===sel?(isDark?'#2d2d5e':'#fff5f0'):p.cardBg}} style={{padding:'12px 8px',borderRadius:8,border:`2px solid ${p.border}`,cursor:'pointer',textAlign:'center'}}>
              <div style={{fontSize:24}}>{be.icon}</div>
              <div style={{fontWeight:600,fontSize:12,color:i===sel?p.accent:p.text,marginTop:4}}>{be.name}</div>
            </motion.div>
          ))}
        </div>
        <div style={{borderLeft:`1px solid ${p.border}`,padding:20,background:p.detailBg}}>
          <AnimatePresence mode="wait">
            <motion.div key={sel} initial={{opacity:0,x:20}} animate={{opacity:1,x:0}} exit={{opacity:0}}>
              <h4 style={{margin:'0 0 8px',color:p.accent,fontSize:15}}>{b.icon} {b.name}</h4>
              <p style={{fontSize:13,lineHeight:1.7,color:p.text,margin:'0 0 10px'}}>{b.desc}</p>
              <div style={{display:'flex',gap:12}}>
                <div><div style={{fontWeight:600,fontSize:12,color:'#10b981',marginBottom:4}}>优势</div>{b.pros.map(x=><div key={x} style={{fontSize:12,color:p.text}}>✓ {x}</div>)}</div>
                <div><div style={{fontWeight:600,fontSize:12,color:'#ef4444',marginBottom:4}}>局限</div>{b.cons.map(x=><div key={x} style={{fontSize:12,color:p.muted}}>△ {x}</div>)}</div>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
