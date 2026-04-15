/**
 * ToolsetAlgebra — ch11 工具集合交/并/差运算的交互图
 */
import { useState, useEffect } from 'react';

const toolsets = [
  { name: 'default', tools: ['terminal', 'file_read', 'file_write', 'web_search', 'memory', 'session_search'], color: '#3b82f6', desc: '日常使用的核心工具集。包含终端、文件、搜索、记忆等基础能力。' },
  { name: 'code', tools: ['terminal', 'file_read', 'file_write', 'file_patch', 'code_exec', 'git'], color: '#10b981', desc: '代码编辑专用工具集。增加了 fuzzy patch、代码执行、git 操作。' },
  { name: 'web', tools: ['web_search', 'web_read', 'browser', 'web_download'], color: '#f59e0b', desc: 'Web 交互工具集。搜索、读取、浏览器自动化、文件下载。' },
  { name: 'research', tools: ['web_search', 'web_read', 'session_search', 'memory', 'skills'], color: '#8b5cf6', desc: '研究工具集。信息检索和知识管理能力的组合。' },
];

function useTheme(): 'light'|'dark' { const [t,setT]=useState<'light'|'dark'>('light'); useEffect(()=>{const r=document.documentElement;const d=()=>setT(r.dataset.theme==='dark'?'dark':'light');d();const o=new MutationObserver(d);o.observe(r,{attributes:true,attributeFilter:['data-theme']});return()=>o.disconnect();},[]);return t; }

export default function ToolsetAlgebra() {
  const isDark = useTheme() === 'dark';
  const [selected, setSelected] = useState<number[]>([0]);
  const p = { bg: isDark?'#1a1a2e':'#fff', border: isDark?'#3a3a5e':'#e2e8f0', text: isDark?'#e2e8f0':'#2c3e50', muted: isDark?'#a0aec0':'#718096', accent: '#d97757', cardBg: isDark?'#252545':'#f8f9fa', funcBg: isDark?'#2a2a4a':'#f0f4f8' };

  const toggle = (i: number) => { setSelected(prev => prev.includes(i) ? prev.filter(x=>x!==i) : [...prev, i]); };

  // Compute union of selected toolsets
  const unionTools = [...new Set(selected.flatMap(i => toolsets[i].tools))].sort();
  // Compute intersection if 2+ selected
  const intersectionTools = selected.length >= 2 ? toolsets[selected[0]].tools.filter(t => selected.every(i => toolsets[i].tools.includes(t))) : [];

  return (
    <div style={{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',margin:'1.5rem 0',border:`1px solid ${p.border}`,borderRadius:12,overflow:'hidden',background:p.bg}}>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${p.border}`,background:p.cardBg,fontSize:14,fontWeight:600,color:p.accent}}>Toolset 代数 — 选择多个工具集查看并集/交集</div>
      <div style={{padding:16}}>
        <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:16}}>
          {toolsets.map((ts, i) => (
            <button key={i} onClick={()=>toggle(i)} style={{padding:'6px 14px',borderRadius:6,border:`2px solid ${ts.color}`,background:selected.includes(i)?ts.color:'transparent',color:selected.includes(i)?'#fff':ts.color,cursor:'pointer',fontWeight:600,fontSize:13,transition:'all 0.2s'}}>{ts.name}</button>
          ))}
        </div>
        {selected.length > 0 && (
          <div>
            {selected.map(i => (
              <div key={i} style={{marginBottom:8,padding:'8px 12px',borderLeft:`3px solid ${toolsets[i].color}`,background:p.funcBg,borderRadius:'0 6px 6px 0'}}>
                <span style={{fontWeight:600,color:toolsets[i].color,fontSize:13}}>{toolsets[i].name}</span>
                <span style={{color:p.muted,fontSize:12,marginLeft:8}}>{toolsets[i].desc}</span>
              </div>
            ))}
            <div style={{marginTop:12}}>
              <div style={{fontWeight:600,fontSize:13,color:p.accent,marginBottom:6}}>并集 ({unionTools.length} 工具)</div>
              <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
                {unionTools.map(t => {
                  const inAll = selected.every(i => toolsets[i].tools.includes(t));
                  return <code key={t} style={{fontSize:11,background:inAll?(isDark?'#3a2a20':'#fff5f0'):p.funcBg,color:inAll?p.accent:(isDark?'#a0aec0':'#718096'),padding:'2px 8px',borderRadius:4,border:inAll?`1px solid ${p.accent}`:'1px solid transparent'}}>{t}</code>;
                })}
              </div>
              {selected.length >= 2 && intersectionTools.length > 0 && (
                <div style={{marginTop:10}}>
                  <div style={{fontWeight:600,fontSize:13,color:p.accent,marginBottom:6}}>交集 ({intersectionTools.length} 工具)</div>
                  <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
                    {intersectionTools.map(t => <code key={t} style={{fontSize:11,background:isDark?'#3a2a20':'#fff5f0',color:p.accent,padding:'2px 8px',borderRadius:4,border:`1px solid ${p.accent}`}}>{t}</code>)}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
