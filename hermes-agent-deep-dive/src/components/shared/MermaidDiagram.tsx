/**
 * MermaidDiagram — 客户端 Mermaid 图表渲染
 * 使用 CDN 加载 mermaid.js，避免服务端依赖
 */
import { useEffect, useRef, useState } from 'react';

interface Props {
  chart: string;
}

export default function MermaidDiagram({ chart }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        // Dynamically import mermaid from CDN
        const mermaidModule = await import(
          /* @vite-ignore */
          // @ts-expect-error CDN URL has no type declarations
          'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
        );
        const mermaid = mermaidModule.default;

        if (cancelled) return;

        // Detect theme
        const isDark = document.documentElement.dataset.theme === 'dark';

        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? 'dark' : 'default',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          fontSize: 13,
        });

        const id = `mermaid-${Math.random().toString(36).slice(2, 8)}`;
        const { svg } = await mermaid.render(id, chart.trim());

        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = svg;
        setRendered(true);
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
        }
      }
    }

    render();
    return () => { cancelled = true; };
  }, [chart]);

  if (error) {
    return (
      <pre style={{ padding: 16, background: '#f8f9fa', borderRadius: 8, fontSize: 12, overflow: 'auto' }}>
        {chart}
      </pre>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        textAlign: 'center',
        margin: '1.5em 0',
        padding: '1em 0',
        opacity: rendered ? 1 : 0.3,
        transition: 'opacity 0.3s',
      }}
    >
      {!rendered && <span style={{ color: '#718096', fontSize: 13 }}>Loading diagram...</span>}
    </div>
  );
}
