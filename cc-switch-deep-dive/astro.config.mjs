import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://book.cuiliang.ai',
  base: '/cc-switch-deep-dive/',
  integrations: [
    starlight({
      title: 'cc-switch 源码深度解析',
      description: 'AI 编码 CLI 统一管理桌面应用 cc-switch 的源码深度解析',
      defaultLocale: 'root',
      locales: {
        root: { label: '简体中文', lang: 'zh-CN' },
      },
      social: {
        github: 'https://github.com/farion1231/cc-switch',
      },
      customCss: ['./src/styles/custom.css'],
      favicon: '/favicon.svg',
      head: [
        {
          tag: 'script',
          content: `
            document.addEventListener('DOMContentLoaded', () => {
              const bar = document.createElement('div');
              bar.className = 'reading-progress';
              document.body.prepend(bar);
              const update = () => {
                const h = document.documentElement.scrollHeight - window.innerHeight;
                bar.style.width = h > 0 ? (window.scrollY / h * 100) + '%' : '0%';
              };
              window.addEventListener('scroll', update, { passive: true });
              update();
            });
          `,
        },
      ],
      sidebar: [
        {
          label: '第一部分 · 鸟瞰 cc-switch',
          items: [
            { label: '第 1 章：产品定位与设计目标', link: '/part-1/ch01-product-vision/' },
            { label: '第 2 章：技术选型与架构全景', link: '/part-1/ch02-architecture/' },
            { label: '第 3 章：十分钟心智模型', link: '/part-1/ch03-mental-model/' },
          ],
        },
        {
          label: '第二部分 · Tauri 双端骨架',
          items: [
            { label: '第 4 章：Tauri 2 应用生命周期', link: '/part-2/ch04-tauri-lifecycle/' },
            { label: '第 5 章：Rust 后端模块地图', link: '/part-2/ch05-rust-module-map/' },
            { label: '第 6 章：React 前端组件架构', link: '/part-2/ch06-react-architecture/' },
            { label: '第 7 章：IPC 通信与 Commands 层', link: '/part-2/ch07-ipc-commands/' },
          ],
        },
        {
          label: '第三部分 · 配置与 Provider',
          items: [
            { label: '第 8 章：Provider 数据模型', link: '/part-3/ch08-provider-model/' },
            { label: '第 9 章：多应用配置 (Claude/Codex/Gemini/OpenCode/OpenClaw)', link: '/part-3/ch09-multi-app-configs/' },
            { label: '第 10 章：原子写入与配置安全', link: '/part-3/ch10-atomic-writes/' },
            { label: '第 11 章：50+ Provider 预设', link: '/part-3/ch11-provider-presets/' },
          ],
        },
        {
          label: '第四部分 · 本地代理与热切换',
          items: [
            { label: '第 12 章：本地代理服务器架构', link: '/part-4/ch12-proxy-architecture/' },
            { label: '第 13 章：Provider Router 与转发链路', link: '/part-4/ch13-provider-router/' },
            { label: '第 14 章：Claude/Codex/Gemini 协议适配', link: '/part-4/ch14-protocol-adapters/' },
            { label: '第 15 章：熔断器与健康监测', link: '/part-4/ch15-circuit-breaker/' },
            { label: '第 16 章：自动 Failover 与切换锁', link: '/part-4/ch16-auto-failover/' },
            { label: '第 17 章：流式响应与 SSE', link: '/part-4/ch17-streaming-sse/' },
            { label: '第 18 章：思考预算矫正器', link: '/part-4/ch18-thinking-rectifier/' },
          ],
        },
        {
          label: '第五部分 · MCP / Skills / Prompts',
          items: [
            { label: '第 19 章：MCP 统一管理与双向同步', link: '/part-5/ch19-mcp-sync/' },
            { label: '第 20 章：Skills 系统与 SSOT', link: '/part-5/ch20-skills-system/' },
            { label: '第 21 章：Prompts 与系统提示管理', link: '/part-5/ch21-prompts/' },
            { label: '第 22 章：Deep Link 导入协议', link: '/part-5/ch22-deeplink/' },
          ],
        },
        {
          label: '第六部分 · 存储、用量与云同步',
          items: [
            { label: '第 23 章：SQLite DAO 与迁移', link: '/part-6/ch23-sqlite-dao/' },
            { label: '第 24 章：Session Manager 跨工具会话', link: '/part-6/ch24-session-manager/' },
            { label: '第 25 章：用量统计与成本追踪', link: '/part-6/ch25-usage-stats/' },
            { label: '第 26 章：WebDAV / 云盘同步', link: '/part-6/ch26-cloud-sync/' },
          ],
        },
        {
          label: '第七部分 · 横切关注点与扩展',
          items: [
            { label: '第 27 章：系统托盘与快速切换', link: '/part-7/ch27-tray/' },
            { label: '第 28 章：国际化与主题', link: '/part-7/ch28-i18n-theme/' },
            { label: '第 29 章：打包发布与自动更新', link: '/part-7/ch29-packaging/' },
            { label: '第 30 章：扩展实战与设计哲学', link: '/part-7/ch30-extension/' },
          ],
        },
        {
          label: '附录',
          items: [
            { label: '附录 A：源码锚点索引', link: '/appendix/appendix-a-source-index/' },
            { label: '附录 B：配置文件参考', link: '/appendix/appendix-b-config-reference/' },
          ],
        },
      ],
      expressiveCode: {
        themes: ['github-light', 'github-dark'],
      },
    }),
    react(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
