// Mermaid.js client-side rendering for mdBook
// Converts ```mermaid code blocks into rendered SVG diagrams
// No preprocessor needed — loaded via additional-js in book.toml

(async () => {
  // Dynamically import Mermaid from CDN
  const { default: mermaid } = await import(
    'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
  );

  // Detect dark theme
  const htmlEl = document.documentElement;
  const isDark =
    htmlEl.classList.contains('coal') ||
    htmlEl.classList.contains('navy') ||
    htmlEl.classList.contains('ayu');

  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    securityLevel: 'loose',
    flowchart: { useMaxWidth: true, htmlLabels: true },
  });

  // mdBook renders ```mermaid as <code class="language-mermaid"> inside <pre>
  // We need to: unwrap from <pre>, add .mermaid class, let mermaid render
  document.querySelectorAll('code.language-mermaid').forEach((codeEl) => {
    const pre = codeEl.parentElement;
    const div = document.createElement('div');
    div.classList.add('mermaid');
    div.textContent = codeEl.textContent;
    pre.replaceWith(div);
  });

  await mermaid.run({ querySelector: '.mermaid' });
})();
