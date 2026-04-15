/**
 * SecurityLayersDiagram — ch26 安全纵深四层防御交互图
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const securityLayers = [
  {
    layer: 1,
    name: '危险命令审批',
    icon: '🛡️',
    color: '#ef4444',
    catches: '文件系统破坏 / 提权 / 远程代码执行 / Git 历史破坏',
    mechanisms: [
      { name: 'DANGEROUS_PATTERNS', desc: '30+ 正则模式匹配（rm -rf, sudo, curl|sh 等）' },
      { name: '_normalize_command', desc: 'ANSI 转义 + null 字节 + NFKC 规范化——绕过不了' },
      { name: 'Smart Approval', desc: 'LLM 辅助判断：理解命令语义而非仅模式匹配' },
      { name: 'contextvars 隔离', desc: '每个会话独立的审批状态——Gateway 多用户安全' },
    ],
    flow: '命令输入 → 容器豁免检查 → YOLO 检查 → Tirith 扫描 → 模式匹配 → 已审批缓存 → Smart Approval → 用户确认',
  },
  {
    layer: 2,
    name: '路径安全',
    icon: '📂',
    color: '#f59e0b',
    catches: '路径遍历攻击 / 越权文件访问 / 符号链接攻击',
    mechanisms: [
      { name: 'validate_within_dir()', desc: 'resolve() + relative_to() 确保路径在允许目录内' },
      { name: 'has_traversal_component()', desc: '检测 ../ 组件防止目录穿越' },
      { name: '工作目录限制', desc: '文件操作限制在项目目录和 ~/.hermes/ 内' },
    ],
    flow: '文件路径 → resolve 解析符号链接 → relative_to 检查 → 穿越组件检测 → 允许/拒绝',
  },
  {
    layer: 3,
    name: 'Prompt 注入防御',
    icon: '🔍',
    color: '#3b82f6',
    catches: '指令劫持 / 隐藏载荷 / 数据泄露 / 角色伪装',
    mechanisms: [
      { name: '_CONTEXT_THREAT_PATTERNS', desc: '10 种注入模式检测（ignore previous, act as 等）' },
      { name: '_CONTEXT_INVISIBLE_CHARS', desc: '10 种不可见 Unicode 字符检测' },
      { name: '_MEMORY_THREAT_PATTERNS', desc: '7 种记忆投毒模式（含 role_hijack）' },
      { name: '[BLOCKED] 替换', desc: '检测到威胁不是抛异常，而是静默替换为安全标记' },
    ],
    flow: '上下文内容 → 不可见字符扫描 → 威胁模式匹配 → 替换为 [BLOCKED] / 放行',
  },
  {
    layer: 4,
    name: '沙箱执行',
    icon: '📦',
    color: '#10b981',
    catches: '恶意代码执行 / 资源耗尽 / 工具滥用',
    mechanisms: [
      { name: 'SANDBOX_ALLOWED_TOOLS', desc: '仅 7 种工具可在沙箱中使用' },
      { name: 'PTC 进程隔离', desc: 'UDS 或文件 RPC 通信，独立进程执行' },
      { name: '资源限制', desc: '300s 超时 / 50 次工具调用上限 / 50KB stdout' },
    ],
    flow: '代码执行请求 → 工具白名单检查 → 进程隔离 → 资源限制 → 结果返回',
  },
];

function useTheme(): 'light'|'dark' { const [t,setT]=useState<'light'|'dark'>('light'); useEffect(()=>{const r=document.documentElement;const d=()=>setT(r.dataset.theme==='dark'?'dark':'light');d();const o=new MutationObserver(d);o.observe(r,{attributes:true,attributeFilter:['data-theme']});return()=>o.disconnect();},[]);return t; }

export default function SecurityLayersDiagram() {
  const isDark = useTheme() === 'dark';
  const [sel, setSel] = useState(0);
  const p = { bg: isDark?'#1a1a2e':'#fff', border: isDark?'#3a3a5e':'#e2e8f0', text: isDark?'#e2e8f0':'#2c3e50', muted: isDark?'#a0aec0':'#718096', accent: '#d97757', cardBg: isDark?'#252545':'#f8f9fa', codeBg: isDark?'#2a2a4a':'#f0f4f8' };
  const layer = securityLayers[sel];

  return (
    <div style={{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',margin:'1.5rem 0',border:`1px solid ${p.border}`,borderRadius:12,overflow:'hidden',background:p.bg}}>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${p.border}`,background:p.cardBg,fontSize:14,fontWeight:600,color:p.accent}}>安全纵深 — 四层防御体系</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',minHeight:320}}>
        {/* Layer stack */}
        <div style={{padding:16,display:'flex',flexDirection:'column',gap:8}}>
          {securityLayers.map((sl, i) => (
            <motion.div
              key={i}
              onClick={()=>setSel(i)}
              whileHover={{scale:1.02}}
              style={{
                padding:'14px 16px',
                borderRadius:8,
                border:`2px solid ${i===sel?sl.color:p.border}`,
                background:i===sel?`${sl.color}12`:'transparent',
                cursor:'pointer',
                transition:'all 0.2s',
              }}
            >
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{fontSize:20}}>{sl.icon}</span>
                <div>
                  <div style={{fontWeight:700,fontSize:13,color:i===sel?sl.color:p.text}}>Layer {sl.layer}: {sl.name}</div>
                  <div style={{fontSize:11,color:p.muted,marginTop:2}}>拦截: {sl.catches.split(' / ').slice(0, 2).join('、')}...</div>
                </div>
              </div>
            </motion.div>
          ))}
          {/* Arrow indicator */}
          <div style={{textAlign:'center',fontSize:12,color:p.muted,marginTop:4}}>
            ↑ 外层（先检查）&nbsp;&nbsp;&nbsp;&nbsp; ↓ 内层（后检查）
          </div>
        </div>

        {/* Detail */}
        <div style={{borderLeft:`1px solid ${p.border}`,padding:20}}>
          <AnimatePresence mode="wait">
            <motion.div key={sel} initial={{opacity:0,x:20}} animate={{opacity:1,x:0}} exit={{opacity:0}}>
              <h4 style={{margin:'0 0 8px',color:layer.color,fontSize:15}}>{layer.icon} Layer {layer.layer}: {layer.name}</h4>

              <div style={{fontSize:12,color:'#ef4444',padding:'6px 10px',background:isDark?'#2a2040':'#fef3f2',borderRadius:6,marginBottom:12}}>
                <strong>拦截对象：</strong>{layer.catches}
              </div>

              <div style={{fontSize:12,fontWeight:600,color:p.accent,marginBottom:6}}>防御机制</div>
              {layer.mechanisms.map(m => (
                <div key={m.name} style={{padding:'6px 10px',background:p.codeBg,borderRadius:6,marginBottom:4}}>
                  <code style={{fontSize:11,color:layer.color,fontWeight:600}}>{m.name}</code>
                  <div style={{fontSize:11,color:p.text,marginTop:2}}>{m.desc}</div>
                </div>
              ))}

              <div style={{fontSize:12,fontWeight:600,color:p.accent,marginTop:12,marginBottom:6}}>执行流程</div>
              <div style={{fontSize:11,color:p.text,padding:'6px 10px',background:p.codeBg,borderRadius:6,lineHeight:1.8}}>{layer.flow}</div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
