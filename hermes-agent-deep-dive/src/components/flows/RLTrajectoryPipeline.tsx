/**
 * RLTrajectoryPipeline — ch29 RL 训练与 Trajectory 生成端到端流水线
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const pipelineStages = [
  {
    name: 'JSONL 数据集',
    icon: '📄',
    color: '#6b7280',
    desc: '训练 prompt 数据集，每行一个 JSON 对象包含 prompt 和元数据。支持多种来源——手工编写、合成生成、从日志提取。',
    detail: '输入格式灵活，核心字段是 prompt 字符串。可附带 toolsets（指定可用工具）、expected_output（期望结果）等元数据用于奖励计算。',
    outputs: ['prompt', 'metadata', 'expected_output'],
  },
  {
    name: 'Batch Runner',
    icon: '🏭',
    color: '#3b82f6',
    desc: 'multiprocessing.Pool 并行处理 prompt。每个 prompt 独立采样工具集、创建 AIAgent、运行对话、提取轨迹。',
    detail: '支持 checkpoint/resume（按内容哈希匹配已完成的 prompt）。质量过滤：reasoning coverage 检查（推理步骤是否充分）、tool legality 检查（是否使用了非法工具）。',
    outputs: ['ShareGPT trajectory', 'tool_stats', 'quality_score'],
  },
  {
    name: 'Toolset Sampling',
    icon: '🎲',
    color: '#8b5cf6',
    desc: '15+ 预设分布，每个工具集独立 Bernoulli 采样。如 "research" 分布：web_search=0.9, memory=0.8, terminal=0.3。',
    detail: '概率化工具可用性增加训练多样性。全空时回退到最高概率工具集。sample_toolsets_from_distribution() 在每个 prompt 处理前调用。',
    outputs: ['sampled_toolsets', 'distribution_name'],
  },
  {
    name: 'Trajectory 转换',
    icon: '🔄',
    color: '#f59e0b',
    desc: 'Agent 对话历史 → ShareGPT 格式（from/value 对）。convert_scratchpad_to_think() 将推理过程转为 <think> 标签。',
    detail: '格式标准化确保与多种训练框架兼容。has_incomplete_scratchpad() 检测未闭合的推理块。Arrow/Parquet schema 需要 _normalize_tool_stats() 保证一致性。',
    outputs: ['ShareGPT JSON', '<think> blocks', 'normalized stats'],
  },
  {
    name: 'Atropos RL',
    icon: '🧠',
    color: '#ef4444',
    desc: 'HermesAgentBaseEnv 集成 Atropos GRPO 强化学习。奖励函数通过 ToolContext 获得完整工具访问——可以运行 pytest 验证代码正确性。',
    detail: '5 个抽象方法：setup, get_next_item, format_prompt, compute_reward, evaluate。128 线程 ThreadPoolExecutor 并行执行 Agent 循环。ToolContext 共享 task_id 实现端到端验证。',
    outputs: ['reward_signal', 'model_checkpoint', 'eval_metrics'],
  },
  {
    name: '模型部署',
    icon: '🚀',
    color: '#10b981',
    desc: '训练后的模型 checkpoint 部署回生产环境。形成双层自进化闭环——运行时学习 + 训练时权重更新。',
    detail: '运行时闭环：执行→Skills/Memory→下次召回。训练闭环：轨迹收集→RL 训练→权重更新→部署。两个循环独立运行但相互增强。',
    outputs: ['deployed_model', 'self_improvement_loop'],
  },
];

function useTheme(): 'light'|'dark' { const [t,setT]=useState<'light'|'dark'>('light'); useEffect(()=>{const r=document.documentElement;const d=()=>setT(r.dataset.theme==='dark'?'dark':'light');d();const o=new MutationObserver(d);o.observe(r,{attributes:true,attributeFilter:['data-theme']});return()=>o.disconnect();},[]);return t; }

export default function RLTrajectoryPipeline() {
  const isDark = useTheme() === 'dark';
  const [sel, setSel] = useState(0);
  const [playing, setPlaying] = useState(false);
  const p = { bg: isDark?'#1a1a2e':'#fff', border: isDark?'#3a3a5e':'#e2e8f0', text: isDark?'#e2e8f0':'#2c3e50', muted: isDark?'#a0aec0':'#718096', accent: '#d97757', cardBg: isDark?'#252545':'#f8f9fa', codeBg: isDark?'#2a2a4a':'#f0f4f8' };

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setSel(s => (s + 1) % pipelineStages.length), 2500);
    return () => clearInterval(timer);
  }, [playing]);

  return (
    <div style={{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',margin:'1.5rem 0',border:`1px solid ${p.border}`,borderRadius:12,overflow:'hidden',background:p.bg}}>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${p.border}`,background:p.cardBg,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <span style={{fontSize:14,fontWeight:600,color:p.accent}}>RL 训练端到端流水线</span>
        <button onClick={()=>setPlaying(!playing)} style={{padding:'4px 12px',borderRadius:6,border:`1px solid ${p.accent}`,background:playing?p.accent:'transparent',color:playing?'#fff':p.accent,cursor:'pointer',fontSize:12}}>{playing?'⏸ 暂停':'▶ 播放'}</button>
      </div>

      {/* Pipeline visualization */}
      <div style={{padding:'16px 16px 8px',display:'flex',alignItems:'center',gap:4,overflowX:'auto'}}>
        {pipelineStages.map((stage, i) => (
          <div key={i} style={{display:'flex',alignItems:'center',gap:4}}>
            <motion.div
              onClick={()=>{setSel(i);setPlaying(false);}}
              animate={{
                scale: i===sel?1.1:1,
                borderColor: i===sel?stage.color:p.border,
                background: i===sel?`${stage.color}15`:'transparent',
              }}
              style={{
                padding:'8px 14px',
                borderRadius:8,
                border:`2px solid ${p.border}`,
                cursor:'pointer',
                textAlign:'center',
                minWidth:80,
                transition:'background 0.2s',
              }}
            >
              <div style={{fontSize:18}}>{stage.icon}</div>
              <div style={{fontSize:10,fontWeight:i===sel?700:400,color:i===sel?stage.color:p.text,marginTop:2,whiteSpace:'nowrap'}}>{stage.name}</div>
            </motion.div>
            {i < pipelineStages.length - 1 && (
              <motion.span animate={{color:i===sel||i+1===sel?p.accent:p.muted}} style={{fontSize:16}}>→</motion.span>
            )}
          </div>
        ))}
      </div>

      {/* Detail */}
      <div style={{padding:16}}>
        <AnimatePresence mode="wait">
          <motion.div key={sel} initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} exit={{opacity:0}}>
            <div style={{padding:16,background:p.codeBg,borderRadius:8,borderLeft:`3px solid ${pipelineStages[sel].color}`}}>
              <h4 style={{margin:'0 0 6px',color:pipelineStages[sel].color,fontSize:14}}>{pipelineStages[sel].icon} {pipelineStages[sel].name}</h4>
              <p style={{fontSize:13,lineHeight:1.7,color:p.text,margin:'0 0 8px'}}>{pipelineStages[sel].desc}</p>
              <p style={{fontSize:12,lineHeight:1.7,color:p.muted,margin:'0 0 8px'}}>{pipelineStages[sel].detail}</p>
              <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                {pipelineStages[sel].outputs.map(o => (
                  <code key={o} style={{fontSize:10,padding:'2px 8px',borderRadius:4,background:isDark?'#3a2a20':'#fff5f0',color:p.accent,border:`1px solid ${p.accent}33`}}>{o}</code>
                ))}
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
