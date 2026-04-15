/**
 * MessageModelAdapter — ch08 多模型→统一抽象→API 调用的适配器流程图
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const adapters = [
  { name: 'OpenAI', color: '#10a37f', desc: '原生格式。消息直接以 Chat Completions 格式发送，无需转换。GPT-4o/4.1/o3 等模型。', features: ['原生格式', 'function calling', 'structured output'] },
  { name: 'Anthropic', color: '#d4a574', desc: 'anthropic_adapter.py 将 OpenAI 格式转换为 Messages API 格式。处理 system/user/assistant 角色映射、tool_use block、content block 数组等差异。', features: ['Messages API', 'tool_use blocks', 'prompt caching'] },
  { name: 'Google', color: '#4285f4', desc: 'Gemini API 适配。通过 OpenAI 兼容端点或原生 API，处理 function_declarations 格式差异和 safety_settings。', features: ['Gemini API', 'function_declarations', 'safety_settings'] },
  { name: 'OpenRouter', color: '#7c3aed', desc: '统一网关，支持 200+ 模型。使用 OpenAI 兼容格式，额外的 HTTP headers 传递路由偏好（如 provider routing）。', features: ['200+ 模型', 'provider routing', 'OpenAI 兼容'] },
  { name: 'Ollama', color: '#333', desc: '本地模型推理。通过 OpenAI 兼容 API 端点连接，支持 Llama/Qwen/DeepSeek 等开源模型。零延迟、零成本。', features: ['本地推理', '零成本', '开源模型'] },
];

function useTheme(): 'light'|'dark' { const [t,setT]=useState<'light'|'dark'>('light'); useEffect(()=>{const r=document.documentElement;const d=()=>setT(r.dataset.theme==='dark'?'dark':'light');d();const o=new MutationObserver(d);o.observe(r,{attributes:true,attributeFilter:['data-theme']});return()=>o.disconnect();},[]);return t; }

export default function MessageModelAdapter() {
  const isDark = useTheme() === 'dark';
  const [sel, setSel] = useState<number|null>(null);
  const p = { bg: isDark?'#1a1a2e':'#fff', border: isDark?'#3a3a5e':'#e2e8f0', text: isDark?'#e2e8f0':'#2c3e50', muted: isDark?'#a0aec0':'#718096', accent: '#d97757', cardBg: isDark?'#252545':'#f8f9fa', detailBg: isDark?'#1e1e3a':'#fafafa', tagBg: isDark?'#2a2a4a':'#f0f4f8' };
  const active = sel !== null ? adapters[sel] : null;

  return (
    <div style={{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',margin:'1.5rem 0',border:`1px solid ${p.border}`,borderRadius:12,overflow:'hidden',background:p.bg}}>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${p.border}`,background:p.cardBg,fontSize:14,fontWeight:600,color:p.accent}}>多模型适配 — OpenAI 内部格式 → API 适配器 → 各提供商</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',minHeight:260}}>
        <div style={{padding:16}}>
          <div style={{textAlign:'center',padding:8,border:`2px solid ${p.accent}`,borderRadius:8,background:isDark?'#2d2d5e':'#fff5f0',marginBottom:10}}>
            <div style={{fontWeight:700,fontSize:13,color:p.accent}}>内部统一格式</div>
            <div style={{fontSize:11,color:p.muted}}>OpenAI Chat Completions</div>
          </div>
          <div style={{textAlign:'center',color:p.accent,fontSize:14,margin:'4px 0'}}>↓ api_mode 路由 ↓</div>
          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            {adapters.map((a,i) => (
              <motion.div key={i} onClick={()=>setSel(sel===i?null:i)} whileHover={{scale:1.01}} animate={{borderColor:sel===i?a.color:p.border}} style={{padding:'8px 12px',borderRadius:8,border:`2px solid ${p.border}`,cursor:'pointer',display:'flex',alignItems:'center',gap:10,background:sel===i?(isDark?'#2d2d5e':'#fff5f0'):p.cardBg}}>
                <div style={{width:10,height:10,borderRadius:'50%',background:a.color,flexShrink:0}}/>
                <span style={{fontWeight:600,fontSize:13,color:sel===i?a.color:p.text}}>{a.name}</span>
              </motion.div>
            ))}
          </div>
        </div>
        <div style={{borderLeft:`1px solid ${p.border}`,padding:20,background:p.detailBg}}>
          <AnimatePresence mode="wait">
            {active?(
              <motion.div key={sel} initial={{opacity:0,x:20}} animate={{opacity:1,x:0}} exit={{opacity:0}}>
                <h4 style={{margin:'0 0 8px',color:active.color,fontSize:15}}>{active.name}</h4>
                <p style={{fontSize:13,lineHeight:1.7,color:p.text,margin:'0 0 12px'}}>{active.desc}</p>
                <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                  {active.features.map(f=><span key={f} style={{fontSize:11,background:p.tagBg,color:isDark?'#e8a87c':p.accent,padding:'2px 8px',borderRadius:4}}>{f}</span>)}
                </div>
              </motion.div>
            ):(
              <motion.div key="ph" initial={{opacity:0}} animate={{opacity:1}} style={{color:p.muted,fontSize:14,fontStyle:'italic'}}>← 点击适配器查看详情</motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
