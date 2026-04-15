/** ch13 — 文件与 Web 工具流程 */
import StageFlow from '../shared/StageFlow';
import type { Stage } from '../shared/StageFlow';
const stages: Stage[] = [
  { title: '① fuzzy patch', subtitle: 'file_patch 工具', section: '§13.2', detail: '不要求精确匹配——用 difflib.SequenceMatcher 在目标文件中模糊定位要替换的代码段。容忍空白和缩进差异，大幅降低 LLM 生成 patch 的失败率。', funcs: ['file_patch()', 'SequenceMatcher', 'fuzzy_threshold=0.6'] },
  { title: '② 多后端 Web 搜索', subtitle: 'web_search 工具', section: '§13.3', detail: '支持 Exa、Google、Brave、Firecrawl 四种搜索后端，通过环境变量自动选择。结果格式统一为 title+url+snippet 列表。Exa 提供语义搜索，Google 提供精确搜索。', funcs: ['web_search()', 'Exa', 'Google CSE', 'Brave Search'] },
  { title: '③ Web 内容读取', subtitle: 'web_read 工具', section: '§13.4', detail: 'Trafilatura 提取网页正文（去广告/导航），readability-lxml 作为备选。提取后截断到 MAX_WEB_CONTENT_CHARS（默认 60,000）字符防止上下文溢出。', funcs: ['web_read()', 'trafilatura.extract()', 'MAX_WEB_CONTENT_CHARS'] },
  { title: '④ 文件操作族', subtitle: 'file_read / file_write / file_search', section: '§13.5', detail: '文件读取支持行号范围和编码检测；文件写入使用原子替换（tempfile→os.replace）；file_search 用 ripgrep 子进程实现高速全文搜索。', funcs: ['file_read()', 'file_write()', 'file_search()', 'ripgrep'] },
];
export default function FileWebToolsFlow() { return <StageFlow stages={stages} playLabel="播放工具链" />; }
