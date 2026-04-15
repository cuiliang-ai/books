/**
 * SessionDBSchema — ch16 SessionDB 表结构与生命周期交互图
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const tables = [
  {
    name: 'sessions',
    icon: '📋',
    columns: [
      { name: 'id', type: 'TEXT PK', desc: 'UUID v4 主键' },
      { name: 'title', type: 'TEXT', desc: 'LLM 生成的标题' },
      { name: 'status', type: 'TEXT', desc: 'active / ended' },
      { name: 'model', type: 'TEXT', desc: '使用的模型标识' },
      { name: 'parent_session_id', type: 'TEXT FK', desc: '压缩链父会话' },
      { name: 'created_at', type: 'REAL', desc: 'Unix 时间戳' },
      { name: 'ended_at', type: 'REAL', desc: '会话结束时间' },
      { name: 'total_tokens', type: 'INTEGER', desc: '累计 token 数' },
      { name: 'source', type: 'TEXT', desc: '来源（cli/gateway/cron）' },
      { name: 'platform', type: 'TEXT', desc: '平台标识 (v3+)' },
    ],
    detail: '25 列。每次 create_session() 插入一行，end_session() 更新 ended_at。parent_session_id 形成压缩链——上下文压缩后旧会话关闭，新会话通过此字段指向父会话。',
  },
  {
    name: 'messages',
    icon: '💬',
    columns: [
      { name: 'id', type: 'TEXT PK', desc: 'UUID v4 主键' },
      { name: 'session_id', type: 'TEXT FK', desc: '所属会话' },
      { name: 'role', type: 'TEXT', desc: 'user / assistant / tool / system' },
      { name: 'content', type: 'TEXT', desc: '消息内容' },
      { name: 'tool_name', type: 'TEXT', desc: '工具调用名称' },
      { name: 'tool_call_id', type: 'TEXT', desc: '工具调用 ID' },
      { name: 'model', type: 'TEXT', desc: '生成此消息的模型' },
      { name: 'timestamp', type: 'REAL', desc: 'Unix 时间戳' },
    ],
    detail: '13 列。append_message() 逐条插入。get_messages_as_conversation() 按时间排序重建对话历史。支持按 role 过滤。',
  },
  {
    name: 'messages_fts',
    icon: '🔍',
    columns: [
      { name: 'content', type: 'FTS5', desc: '全文索引列' },
      { name: 'role', type: 'FTS5', desc: '角色过滤列' },
      { name: 'session_id', type: 'FTS5', desc: '会话关联列' },
    ],
    detail: 'FTS5 虚拟表。通过 INSERT 触发器自动同步——每当 messages 表插入新行，触发器将 content/role/session_id 写入 FTS5 索引。支持 BM25 排序的全文搜索。',
  },
  {
    name: 'schema_version',
    icon: '🔧',
    columns: [
      { name: 'version', type: 'INTEGER', desc: '当前 Schema 版本号' },
    ],
    detail: '单行表，当前值为 6。启动时检查版本，低于 SCHEMA_VERSION 则逐步执行 ALTER TABLE ADD COLUMN 迁移。v1→v6 渐进式升级，不破坏现有数据。',
  },
];

const lifecycle = [
  { step: 'create_session()', desc: 'INSERT sessions 行 (status=active)', arrow: '→' },
  { step: 'append_message() ×N', desc: 'INSERT messages + 触发器同步 FTS5', arrow: '→' },
  { step: 'WAL checkpoint', desc: '每 50 次写入触发 PASSIVE checkpoint', arrow: '→' },
  { step: 'end_session()', desc: 'UPDATE ended_at, 可选 parent_session_id', arrow: '→' },
  { step: 'search_messages()', desc: 'FTS5 MATCH + BM25 排序查询', arrow: '' },
];

function useTheme(): 'light'|'dark' { const [t,setT]=useState<'light'|'dark'>('light'); useEffect(()=>{const r=document.documentElement;const d=()=>setT(r.dataset.theme==='dark'?'dark':'light');d();const o=new MutationObserver(d);o.observe(r,{attributes:true,attributeFilter:['data-theme']});return()=>o.disconnect();},[]);return t; }

export default function SessionDBSchema() {
  const isDark = useTheme() === 'dark';
  const [sel, setSel] = useState(0);
  const p = { bg: isDark?'#1a1a2e':'#fff', border: isDark?'#3a3a5e':'#e2e8f0', text: isDark?'#e2e8f0':'#2c3e50', muted: isDark?'#a0aec0':'#718096', accent: '#d97757', cardBg: isDark?'#252545':'#f8f9fa', detailBg: isDark?'#1e1e3a':'#fafafa', codeBg: isDark?'#2a2a4a':'#f0f4f8' };
  const tb = tables[sel];

  return (
    <div style={{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',margin:'1.5rem 0',border:`1px solid ${p.border}`,borderRadius:12,overflow:'hidden',background:p.bg}}>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${p.border}`,background:p.cardBg,fontSize:14,fontWeight:600,color:p.accent}}>SessionDB Schema — SQLite + FTS5 + WAL</div>

      {/* Table selector */}
      <div style={{display:'flex',borderBottom:`1px solid ${p.border}`}}>
        {tables.map((t, i) => (
          <button key={i} onClick={()=>setSel(i)} style={{flex:1,padding:'10px 8px',border:'none',borderBottom:i===sel?`3px solid ${p.accent}`:'3px solid transparent',background:i===sel?p.detailBg:'transparent',cursor:'pointer',fontSize:13,fontWeight:i===sel?700:400,color:i===sel?p.accent:p.text,transition:'all 0.2s'}}>
            {t.icon} {t.name}
          </button>
        ))}
      </div>

      {/* Table detail */}
      <AnimatePresence mode="wait">
        <motion.div key={sel} initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} exit={{opacity:0}} style={{padding:16}}>
          <p style={{fontSize:13,lineHeight:1.7,color:p.text,margin:'0 0 12px'}}>{tb.detail}</p>
          <div style={{display:'grid',gap:4}}>
            {tb.columns.map(col => (
              <div key={col.name} style={{display:'grid',gridTemplateColumns:'120px 100px 1fr',gap:8,padding:'6px 10px',background:p.codeBg,borderRadius:6,fontSize:12,alignItems:'center'}}>
                <code style={{color:p.accent,fontWeight:600}}>{col.name}</code>
                <span style={{color:p.muted,fontFamily:'monospace'}}>{col.type}</span>
                <span style={{color:p.text}}>{col.desc}</span>
              </div>
            ))}
          </div>
        </motion.div>
      </AnimatePresence>

      {/* Lifecycle bar */}
      <div style={{padding:'12px 16px',borderTop:`1px solid ${p.border}`,background:p.cardBg}}>
        <div style={{fontSize:12,fontWeight:600,color:p.accent,marginBottom:8}}>会话生命周期</div>
        <div style={{display:'flex',alignItems:'center',gap:4,flexWrap:'wrap'}}>
          {lifecycle.map((lc, i) => (
            <div key={i} style={{display:'flex',alignItems:'center',gap:4}}>
              <div style={{padding:'4px 10px',background:p.codeBg,borderRadius:6,fontSize:11}}>
                <code style={{color:p.accent}}>{lc.step}</code>
                <div style={{color:p.muted,fontSize:10}}>{lc.desc}</div>
              </div>
              {lc.arrow && <span style={{color:p.muted,fontSize:16}}>→</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
