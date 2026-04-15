import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://book.cuiliang.ai',
  base: '/hermes-agent-deep-dive/',
  integrations: [
    starlight({
      title: 'Hermes Agent 源码深度解析',
      description: 'Nous Research 自进化 AI Agent 源码深度解析',
      defaultLocale: 'root',
      locales: {
        root: { label: '简体中文', lang: 'zh-CN' },
      },
      social: {
        github: 'https://github.com/NousResearch/hermes-agent',
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
          label: '第一部分 · 鸟瞰 Hermes Agent',
          items: [
            { label: '第 1 章：产品特性与设计目标', link: '/part-1/ch01-product-vision/' },
            { label: '第 2 章：运行形态与入口点', link: '/part-1/ch02-entry-points/' },
            { label: '第 3 章：十分钟心智模型', link: '/part-1/ch03-mental-model/' },
          ],
        },
        {
          label: '第二部分 · 智能体引擎',
          items: [
            { label: '第 4 章：AIAgent 类全貌', link: '/part-2/ch04-aiagent-class/' },
            { label: '第 5 章：主循环解剖', link: '/part-2/ch05-main-loop/' },
            { label: '第 6 章：System Prompt 装配', link: '/part-2/ch06-system-prompt/' },
            { label: '第 7 章：上下文压缩', link: '/part-2/ch07-context-compression/' },
            { label: '第 8 章：消息模型与 API 适配', link: '/part-2/ch08-message-model/' },
            { label: '第 9 章：错误分类与路由降级', link: '/part-2/ch09-error-routing/' },
          ],
        },
        {
          label: '第三部分 · 工具生态',
          items: [
            { label: '第 10 章：Tool Registry', link: '/part-3/ch10-tool-registry/' },
            { label: '第 11 章：Toolset 代数', link: '/part-3/ch11-toolset-algebra/' },
            { label: '第 12 章：六种 Terminal 后端', link: '/part-3/ch12-terminal-backends/' },
            { label: '第 13 章：文件与 Web 工具族', link: '/part-3/ch13-file-web-tools/' },
            { label: '第 14 章：Browser 与 MCP', link: '/part-3/ch14-browser-mcp/' },
            { label: '第 15 章：代码执行与子 Agent', link: '/part-3/ch15-code-exec-delegation/' },
          ],
        },
        {
          label: '第四部分 · 学习闭环',
          items: [
            { label: '第 16 章：SessionDB', link: '/part-4/ch16-session-db/' },
            { label: '第 17 章：Memory 系统', link: '/part-4/ch17-memory-system/' },
            { label: '第 18 章：Skills 系统', link: '/part-4/ch18-skills-system/' },
            { label: '第 19 章：Session Search', link: '/part-4/ch19-session-search/' },
            { label: '第 20 章：封闭学习循环', link: '/part-4/ch20-learning-loop/' },
          ],
        },
        {
          label: '第五部分 · 多平台网关',
          items: [
            { label: '第 21 章：Gateway 架构', link: '/part-5/ch21-gateway-architecture/' },
            { label: '第 22 章：Platform Adapter', link: '/part-5/ch22-platform-adapters/' },
            { label: '第 23 章：Cron 与 ACP', link: '/part-5/ch23-cron-acp/' },
          ],
        },
        {
          label: '第六部分 · 横切关注点',
          items: [
            { label: '第 24 章：CLI 与 Skin Engine', link: '/part-6/ch24-cli-skin/' },
            { label: '第 25 章：配置与凭据', link: '/part-6/ch25-config-credentials/' },
            { label: '第 26 章：安全纵深', link: '/part-6/ch26-security/' },
            { label: '第 27 章：线程模型', link: '/part-6/ch27-threading-model/' },
          ],
        },
        {
          label: '第七部分 · 扩展与展望',
          items: [
            { label: '第 28 章：扩展实战', link: '/part-7/ch28-extension-guide/' },
            { label: '第 29 章：RL 训练', link: '/part-7/ch29-rl-trajectory/' },
            { label: '第 30 章：设计哲学与对比', link: '/part-7/ch30-design-philosophy/' },
          ],
        },
        {
          label: '附录',
          items: [
            { label: '附录 A：源码锚点索引', link: '/appendix/appendix-a-source-index/' },
            { label: '附录 B：配置参考', link: '/appendix/appendix-b-config-reference/' },
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
