/**
 * Migration script: mdBook → Astro Starlight MDX
 *
 * Reads from Q:\src\books\hermes-agent-deep-dive\src\
 * Writes to  Q:\src\books\hermes-agent-deep-dive-opt\src\content\docs\
 *
 * Does NOT modify the original files.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';

const SRC = 'Q:/src/books/hermes-agent-deep-dive/src';
const DEST = 'Q:/src/books/hermes-agent-deep-dive-opt/src/content/docs';

// Chapter metadata extracted from SUMMARY.md
const chapters = [
  { file: 'part-1/ch01-product-vision.md', title: '第 1 章：产品特性与设计目标', desc: '自进化 Agent 与传统 AI 工具的本质区别', order: 1 },
  { file: 'part-1/ch02-entry-points.md', title: '第 2 章：运行形态与入口点', desc: '六种运行模态如何共享同一个 AIAgent 核心', order: 2 },
  { file: 'part-1/ch03-mental-model.md', title: '第 3 章：十分钟心智模型', desc: '一张总图建立全局认知', order: 3 },
  { file: 'part-2/ch04-aiagent-class.md', title: '第 4 章：AIAgent 类全貌', desc: '构造参数、状态字段、生命周期', order: 4 },
  { file: 'part-2/ch05-main-loop.md', title: '第 5 章：主循环解剖', desc: 'run_conversation() 的完整时序', order: 5, hasRcFlow: true },
  { file: 'part-2/ch06-system-prompt.md', title: '第 6 章：System Prompt 装配与 Prompt Caching', desc: '七层 System Prompt 如何组装', order: 6, hasRcFlow: true },
  { file: 'part-2/ch07-context-compression.md', title: '第 7 章：上下文压缩与 Context Engine', desc: 'ContextEngine 的可插拔设计', order: 7 },
  { file: 'part-2/ch08-message-model.md', title: '第 8 章：消息模型、API 适配与流式', desc: '多模型如何统一抽象', order: 8 },
  { file: 'part-2/ch09-error-routing.md', title: '第 9 章：错误分类、限流与路由降级', desc: '自动 failover 如何工作', order: 9 },
  { file: 'part-3/ch10-tool-registry.md', title: '第 10 章：Tool Registry 与发现链', desc: '工具如何自注册、发现、调度', order: 10 },
  { file: 'part-3/ch11-toolset-algebra.md', title: '第 11 章：Toolset 代数与工具分类', desc: '40+ 工具如何分组与组合', order: 11 },
  { file: 'part-3/ch12-terminal-backends.md', title: '第 12 章：六种 Terminal 后端', desc: '统一抽象如何适配 6 种执行环境', order: 12 },
  { file: 'part-3/ch13-file-web-tools.md', title: '第 13 章：文件操作与 Web 工具族', desc: 'fuzzy patch 与多后端 Web 搜索', order: 13 },
  { file: 'part-3/ch14-browser-mcp.md', title: '第 14 章：Browser 自动化与 MCP 协议', desc: '无视觉浏览器操控与开放工具扩展', order: 14 },
  { file: 'part-3/ch15-code-exec-delegation.md', title: '第 15 章：代码执行与子 Agent 委派', desc: 'PTC 的 UDS RPC 与委派隔离模型', order: 15 },
  { file: 'part-4/ch16-session-db.md', title: '第 16 章：会话存储 SessionDB', desc: 'SQLite + FTS5 的持久化设计', order: 16 },
  { file: 'part-4/ch17-memory-system.md', title: '第 17 章：Memory 系统 — MEMORY.md 与 USER.md', desc: '冻结快照模式与插件化记忆后端', order: 17, hasRcFlow: true },
  { file: 'part-4/ch18-skills-system.md', title: '第 18 章：Skills 系统 — 程序化记忆', desc: '渐进式披露与 Skills Hub', order: 18, hasRcFlow: true },
  { file: 'part-4/ch19-session-search.md', title: '第 19 章：Session Search 与跨会话召回', desc: 'FTS5 + LLM 摘要的跨会话回忆', order: 19 },
  { file: 'part-4/ch20-learning-loop.md', title: '第 20 章：封闭学习循环 — 自我进化的闭环', desc: '自我进化闭环的完整数据流', order: 20 },
  { file: 'part-5/ch21-gateway-architecture.md', title: '第 21 章：Gateway 架构与 GatewayRunner', desc: '一个 Agent 如何服务 15 个平台', order: 21 },
  { file: 'part-5/ch22-platform-adapters.md', title: '第 22 章：Platform Adapter 模式', desc: '适配器的抽象与差异化实现', order: 22 },
  { file: 'part-5/ch23-cron-acp.md', title: '第 23 章：Cron 调度与 ACP 集成', desc: '定时任务投递与 IDE 集成', order: 23 },
  { file: 'part-6/ch24-cli-skin.md', title: '第 24 章：CLI 交互设计与 Skin Engine', desc: 'Rich + prompt_toolkit 的交互设计', order: 24 },
  { file: 'part-6/ch25-config-credentials.md', title: '第 25 章：配置、凭据与 Profiles', desc: '分层配置与多密钥轮换', order: 25 },
  { file: 'part-6/ch26-security.md', title: '第 26 章：安全纵深', desc: '命令审批、路径安全、注入防御', order: 26 },
  { file: 'part-6/ch27-threading-model.md', title: '第 27 章：同步异步桥接与线程模型', desc: '同步↔异步桥接的设计权衡', order: 27 },
  { file: 'part-7/ch28-extension-guide.md', title: '第 28 章：扩展实战 — 新增工具、平台与后端', desc: '实战扩展指南', order: 28 },
  { file: 'part-7/ch29-rl-trajectory.md', title: '第 29 章：RL 训练与 Trajectory 生成', desc: 'RL 训练流水线与轨迹生成', order: 29 },
  { file: 'part-7/ch30-design-philosophy.md', title: '第 30 章：设计哲学与同类对比', desc: '架构哲学与 Claude Code/Aider/Codex 对比', order: 30 },
];

const appendices = [
  { file: 'appendix-a-source-index.md', destFile: 'appendix/appendix-a-source-index.md', title: '附录 A：源码锚点索引与 Slash 命令速查', desc: '源码锚点索引', order: 31 },
  { file: 'appendix-b-config-reference.md', destFile: 'appendix/appendix-b-config-reference.md', title: '附录 B：配置 YAML Schema 与环境变量参考', desc: '配置参考', order: 32 },
];

/**
 * Remove inline <div class="rc-flow">...</div> and <script>...</script> blocks
 * Replace with a TODO placeholder for React component insertion
 */
function removeRcFlowBlocks(content, chapterSlug) {
  // Remove <div class="rc-flow" ...>...</div> blocks (multiline)
  // These are self-contained HTML blocks that end before the next markdown heading or paragraph
  let result = content;

  // Pattern: <div class="rc-flow" id="..."> ... </div> (including nested divs)
  // We need to handle nested divs carefully
  const rcFlowRegex = /<div class="rc-flow"[^>]*>[\s\S]*?(?=\n###?\s|\n<script>)/g;

  // Simpler approach: find all rc-flow blocks by tracking div nesting
  const lines = result.split('\n');
  const outputLines = [];
  let inRcFlow = false;
  let divDepth = 0;
  let rcFlowCount = 0;
  let inScript = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track script blocks within rc-flow context
    if (line.includes('<script>') && !inRcFlow) {
      // Check if this script is related to rc-flow (it follows an rc-flow block)
      // Look back to see if we just closed an rc-flow block
      const prevNonEmpty = outputLines.filter(l => l.trim()).slice(-1)[0] || '';
      if (prevNonEmpty.includes('{/* TODO:') || rcFlowCount > 0) {
        inScript = true;
        continue;
      }
    }

    if (inScript) {
      if (line.includes('</script>')) {
        inScript = false;
        rcFlowCount = 0;  // Reset after cleaning up associated script
      }
      continue;
    }

    // Detect rc-flow start
    if (line.includes('<div class="rc-flow"')) {
      inRcFlow = true;
      divDepth = 0;
      rcFlowCount++;
      // Insert placeholder
      outputLines.push(`{/* TODO: Insert interactive React component for ${chapterSlug} flow #${rcFlowCount} */}`);
      outputLines.push('');
    }

    if (inRcFlow) {
      // Count div opens and closes
      const opens = (line.match(/<div/g) || []).length;
      const closes = (line.match(/<\/div>/g) || []).length;
      divDepth += opens - closes;
      if (divDepth <= 0 && line.includes('</div>')) {
        inRcFlow = false;
      }
      continue;
    }

    outputLines.push(line);
  }

  return outputLines.join('\n');
}

/**
 * Fix internal links:
 *   (part-1/ch01-product-vision.md) → (/part-1/ch01-product-vision/)
 *   (../part-1/ch01-product-vision.md) → (/part-1/ch01-product-vision/)
 */
function fixLinks(content) {
  // Fix relative .md links
  return content.replace(
    /\]\((?:\.\.\/)*(?:\.\/)?((part-\d+\/ch\d+-[a-z-]+|appendix-[a-z]-[a-z-]+))\.md\)/g,
    (match, slug) => {
      // Convert appendix paths
      if (slug.startsWith('appendix-')) {
        return `](/appendix/${slug}/)`;
      }
      return `](/${slug}/)`;
    }
  );
}

/**
 * Remove the "← 返回书架" link from README
 */
function removeBookshelfLink(content) {
  return content.replace(/^\[← 返回书架\]\([^)]+\)\s*\n*/m, '');
}

/**
 * Remove the first H1 heading (it will be in frontmatter title)
 */
function removeFirstH1(content) {
  return content.replace(/^# .+\n*/m, '');
}

function migrateChapter(ch) {
  const srcPath = join(SRC, ch.file);
  // Use .mdx only for chapters with interactive React components (rc-flow);
  // use .md for all others to avoid MDX curly-brace interpretation issues
  const ext = ch.hasRcFlow ? '.mdx' : '.md';
  const destFileName = ch.file.replace('.md', ext);
  const destPath = join(DEST, destFileName);
  const chapterSlug = basename(ch.file, '.md');

  console.log(`  ${ch.file} → ${destFileName}`);

  let content = readFileSync(srcPath, 'utf-8');

  // Remove first H1 (will be in frontmatter)
  content = removeFirstH1(content);

  // Fix internal links
  content = fixLinks(content);

  // Remove rc-flow HTML+JS blocks if present
  if (ch.hasRcFlow) {
    content = removeRcFlowBlocks(content, chapterSlug);
    console.log(`    ↳ Removed rc-flow blocks, inserted TODO placeholders`);
  }

  // Build frontmatter
  const frontmatter = [
    '---',
    `title: "${ch.title}"`,
    `description: "${ch.desc}"`,
    `sidebar:`,
    `  order: ${ch.order}`,
    '---',
    '',
  ].join('\n');

  const final = frontmatter + content;

  // Ensure directory exists
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, final, 'utf-8');
}

function migrateReadme() {
  console.log(`  README.md → index.mdx`);

  const srcPath = join(SRC, 'README.md');
  let content = readFileSync(srcPath, 'utf-8');

  // Remove bookshelf link
  content = removeBookshelfLink(content);

  // Remove first H1
  content = removeFirstH1(content);

  // Fix internal links
  content = fixLinks(content);

  const frontmatter = [
    '---',
    'title: Hermes Agent 源码深度解析',
    'description: Nous Research 自进化 AI Agent 源码深度解析',
    'template: splash',
    'hero:',
    '  title: Hermes Agent 源码深度解析',
    '  tagline: Nous Research 自进化 AI Agent — 基于 Python 源码全面剖析 Agentic Loop、工具生态、学习闭环、多平台网关',
    '  actions:',
    '    - text: 开始阅读',
    '      link: /part-1/ch01-product-vision/',
    '      icon: right-arrow',
    '      variant: primary',
    '    - text: GitHub 源码',
    '      link: https://github.com/NousResearch/hermes-agent',
    '      icon: external',
    '      variant: minimal',
    '---',
    '',
  ].join('\n');

  const destPath = join(DEST, 'index.mdx');
  writeFileSync(destPath, frontmatter + content, 'utf-8');
}

function migrateAppendix(app) {
  console.log(`  ${app.file} → ${app.destFile}`);

  const srcPath = join(SRC, app.file);
  let content = readFileSync(srcPath, 'utf-8');

  content = removeFirstH1(content);
  content = fixLinks(content);

  const frontmatter = [
    '---',
    `title: "${app.title}"`,
    `description: "${app.desc}"`,
    `sidebar:`,
    `  order: ${app.order}`,
    '---',
    '',
  ].join('\n');

  const destPath = join(DEST, app.destFile);
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, frontmatter + content, 'utf-8');
}

// ---- Main ----
console.log('🚀 Migrating Hermes Agent Deep Dive: mdBook → Starlight\n');
console.log(`Source: ${SRC}`);
console.log(`Dest:   ${DEST}\n`);

console.log('📖 Migrating README (index page)...');
migrateReadme();

console.log('\n📚 Migrating 30 chapters...');
for (const ch of chapters) {
  migrateChapter(ch);
}

console.log('\n📎 Migrating 2 appendices...');
for (const app of appendices) {
  migrateAppendix(app);
}

console.log('\n✅ Migration complete!');
console.log(`   Total: 1 index + ${chapters.length} chapters + ${appendices.length} appendices = ${1 + chapters.length + appendices.length} files`);
console.log('\n⚠️  Next steps:');
console.log('   1. Review TODO placeholders in ch05, ch06, ch17, ch18 for React component insertion');
console.log('   2. Run "npm run dev" to verify the site builds correctly');
console.log('   3. Develop interactive React components');
