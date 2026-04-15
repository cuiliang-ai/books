/**
 * Fix curly braces in MDX files — escape { and } outside code fences and inline code
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const BASE = 'Q:/src/books/hermes-agent-deep-dive-opt/src/content/docs';

const files = [
  'part-2/ch04-aiagent-class.mdx',
  'part-2/ch08-message-model.mdx',
  'part-3/ch10-tool-registry.mdx',
  'part-3/ch11-toolset-algebra.mdx',
  'part-3/ch12-terminal-backends.mdx',
  'part-3/ch14-browser-mcp.mdx',
  'part-4/ch16-session-db.mdx',
  'part-5/ch22-platform-adapters.mdx',
  'part-5/ch23-cron-acp.mdx',
  'part-6/ch25-config-credentials.mdx',
  'part-7/ch28-extension-guide.mdx',
];

function escapeLine(line) {
  // Split by backtick segments — only escape { } in non-code parts
  let result = '';
  let inInlineCode = false;
  for (let j = 0; j < line.length; j++) {
    if (line[j] === '`') {
      inInlineCode = !inInlineCode;
      result += '`';
    } else if (!inInlineCode && line[j] === '{') {
      result += '\\{';
    } else if (!inInlineCode && line[j] === '}') {
      result += '\\}';
    } else {
      result += line[j];
    }
  }
  return result;
}

for (const f of files) {
  const path = join(BASE, f);
  const lines = readFileSync(path, 'utf-8').split('\n');
  let inCode = false;
  let fmCount = 0;
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---') { fmCount++; continue; }
    if (fmCount < 2) continue;
    if (t.startsWith('```')) { inCode = !inCode; continue; }

    // Skip import lines and JSX component lines
    if (t.startsWith('import ') || t.startsWith('<')) continue;

    if (!inCode && (lines[i].includes('{') || lines[i].includes('}'))) {
      const fixed = escapeLine(lines[i]);
      if (fixed !== lines[i]) {
        lines[i] = fixed;
        changed = true;
        console.log(`  Fixed line ${i + 1} in ${f}`);
      }
    }
  }

  if (changed) {
    writeFileSync(path, lines.join('\n'), 'utf-8');
    console.log(`✅ ${f} — saved`);
  } else {
    console.log(`⏭️  ${f} — no changes needed`);
  }
}
