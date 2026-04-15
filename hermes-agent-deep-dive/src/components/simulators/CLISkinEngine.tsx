/**
 * CLISkinEngine — ch24 CLI 交互设计与 Skin Engine 可视化
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const skins = [
  { name: 'default', color: '#d97757', spinner: 'dots', verb: 'Thinking', ascii: '🤖', desc: '默认皮肤。Terracotta 主色调，点阵 spinner，简洁专业。' },
  { name: 'ares', color: '#ef4444', spinner: 'bounce', verb: 'Strategizing', ascii: '⚔️', desc: '战神主题。红色系，弹跳 spinner，攻击性用语。' },
  { name: 'mono', color: '#6b7280', spinner: 'dots', verb: 'Processing', ascii: '⬛', desc: '极简单色。灰色调，无装饰，适合终端纯净主义者。' },
  { name: 'slate', color: '#64748b', spinner: 'grow', verb: 'Analyzing', ascii: '🪨', desc: '石板主题。蓝灰色调，生长 spinner，冷静分析感。' },
  { name: 'poseidon', color: '#0ea5e9', spinner: 'star', verb: 'Diving', ascii: '🔱', desc: '海神主题。海蓝色，星形 spinner，深海探索隐喻。' },
  { name: 'sisyphus', color: '#8b5cf6', spinner: 'bounce', verb: 'Pushing', ascii: '🪨', desc: '西西弗斯主题。紫色调，弹跳象征推石，永恒努力。' },
  { name: 'charizard', color: '#f97316', spinner: 'brain', verb: 'Breathing fire', ascii: '🔥', desc: '喷火龙主题。橙色系，脑形 spinner，火焰特效。' },
];

const spinnerFrames: Record<string, string[]> = {
  dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  bounce: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
  grow: ['▁', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃'],
  star: ['✶', '✸', '✹', '✺', '✹', '✸'],
  brain: ['🧠', '💭', '💡', '⚡', '💡', '💭'],
};

function useTheme(): 'light'|'dark' { const [t,setT]=useState<'light'|'dark'>('light'); useEffect(()=>{const r=document.documentElement;const d=()=>setT(r.dataset.theme==='dark'?'dark':'light');d();const o=new MutationObserver(d);o.observe(r,{attributes:true,attributeFilter:['data-theme']});return()=>o.disconnect();},[]);return t; }

export default function CLISkinEngine() {
  const isDark = useTheme() === 'dark';
  const [sel, setSel] = useState(0);
  const [frame, setFrame] = useState(0);
  const p = { bg: isDark?'#1a1a2e':'#fff', border: isDark?'#3a3a5e':'#e2e8f0', text: isDark?'#e2e8f0':'#2c3e50', muted: isDark?'#a0aec0':'#718096', accent: '#d97757', cardBg: isDark?'#252545':'#f8f9fa', termBg: isDark?'#0d1117':'#1e1e1e' };
  const skin = skins[sel];
  const frames = spinnerFrames[skin.spinner];

  useEffect(() => {
    const timer = setInterval(() => setFrame(f => (f + 1) % frames.length), 120);
    return () => clearInterval(timer);
  }, [sel, frames.length]);

  return (
    <div style={{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',margin:'1.5rem 0',border:`1px solid ${p.border}`,borderRadius:12,overflow:'hidden',background:p.bg}}>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${p.border}`,background:p.cardBg,fontSize:14,fontWeight:600,color:p.accent}}>Skin Engine — 7 种内置皮肤主题</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',minHeight:280}}>
        {/* Skin selector */}
        <div style={{padding:12,display:'grid',gap:4}}>
          {skins.map((s, i) => (
            <motion.div key={i} onClick={()=>{setSel(i);setFrame(0);}} whileHover={{x:2}} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',borderRadius:8,cursor:'pointer',background:i===sel?(isDark?'#2d2d5e':'#fff5f0'):'transparent',borderLeft:`3px solid ${i===sel?s.color:'transparent'}`,transition:'all 0.2s'}}>
              <span style={{fontSize:16}}>{s.ascii}</span>
              <div>
                <div style={{fontSize:13,fontWeight:i===sel?700:400,color:i===sel?s.color:p.text}}>{s.name}</div>
                <div style={{fontSize:11,color:p.muted}}>{s.desc.slice(0, 30)}...</div>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Preview */}
        <div style={{borderLeft:`1px solid ${p.border}`,padding:16}}>
          <AnimatePresence mode="wait">
            <motion.div key={sel} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}>
              {/* Terminal preview */}
              <div style={{background:p.termBg,borderRadius:8,overflow:'hidden',marginBottom:12}}>
                <div style={{padding:'6px 12px',background:'#2d333b',display:'flex',gap:6}}>
                  <span style={{width:10,height:10,borderRadius:'50%',background:'#ff5f57'}}/>
                  <span style={{width:10,height:10,borderRadius:'50%',background:'#febc2e'}}/>
                  <span style={{width:10,height:10,borderRadius:'50%',background:'#28c840'}}/>
                  <span style={{fontSize:11,color:'#8b949e',marginLeft:8}}>hermes — {skin.name}</span>
                </div>
                <div style={{padding:16,fontFamily:'JetBrains Mono, monospace',fontSize:13}}>
                  <div style={{color:'#8b949e'}}>$ hermes</div>
                  <div style={{marginTop:8,display:'flex',alignItems:'center',gap:8}}>
                    <span style={{color:skin.color,fontSize:16}}>{frames[frame]}</span>
                    <span style={{color:skin.color}}>{skin.verb}...</span>
                  </div>
                  <div style={{marginTop:12,color:skin.color,fontWeight:700}}>{'>'} <span style={{color:'#c9d1d9',fontWeight:400}}>Hello, I am Hermes!</span></div>
                </div>
              </div>

              {/* Skin details */}
              <div style={{fontSize:13,lineHeight:1.7,color:p.text,marginBottom:8}}>{skin.desc}</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                <div style={{padding:'6px 10px',background:isDark?'#2a2a4a':'#f0f4f8',borderRadius:6}}>
                  <div style={{fontSize:11,color:p.muted}}>Spinner</div>
                  <code style={{fontSize:12,color:skin.color}}>{skin.spinner}</code>
                </div>
                <div style={{padding:'6px 10px',background:isDark?'#2a2a4a':'#f0f4f8',borderRadius:6}}>
                  <div style={{fontSize:11,color:p.muted}}>主色调</div>
                  <div style={{display:'flex',alignItems:'center',gap:6}}>
                    <span style={{width:12,height:12,borderRadius:3,background:skin.color}}/>
                    <code style={{fontSize:12,color:p.text}}>{skin.color}</code>
                  </div>
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
