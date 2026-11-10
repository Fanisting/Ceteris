/**
 * @file src/renderer/index.tsx
 * @purpose Renderer 进程 entry。挂载 React 根组件到 #root。
 *
 * @关键设计:
 * - 故意不用 React.StrictMode (CP-1 起不挂):
 *   StrictMode 在 dev 模式会双挂载组件来"压力测试 effect cleanup",
 *   而 xterm.js + node-pty 这种持有 native 资源的库在双挂载下会:
 *     (1) 触发 xterm 内部 Viewport.syncScrollArea 访问已释放的
 *         _renderService.dimensions, 抛 "Cannot read 'dimensions'"
 *     (2) PTY 反复 kill/spawn,期间 send-input 可能命中 SessionNotFound
 *   这是 xterm 与 StrictMode 的已知不兼容 (Wave/Hyper 等同样关掉)。
 *   生产环境 (build) 下 StrictMode 本就不生效,关掉只影响 dev 的"压测"。
 *   AGENTS.md 13.2 没把 StrictMode 列为产品哲学红线,可关。
 *
 * - 通过 window.api (preload 暴露) 与 main 通信,renderer 内部不能直接
 *   require electron。
 *
 * @对应文档章节: 软件定义书.md 9.2.2
 */
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';
// 必须在 global.css 之后:Material 外观层靠加载顺序覆写同名选择器
import './styles/material.css';
// 必须在 material.css 之后:珠光主题要覆写 material.css 在 :root 推导的 --md-on-primary
import './styles/pearl-themes.css';
// 必须在 material.css 之后:Beamer 主题块要覆写它在 :root 推导的 --md-* 角色
import './styles/beamer-themes.css';
// 必须在 material.css 之后:梅子主题同样覆写 --md-* 角色
import './styles/meizi-theme.css';
// 必须在 material.css 之后:Legado MD3 主题块同样覆写 --md-* 角色
import './styles/legado-themes.css';
import './styles/legado-controls.css';
// 必须在 material.css 之后:Pili 主题块(ADR-031)同样覆写 --md-* 角色
import './styles/pili-themes.css';
import './styles/file-tree.css';
// Rendered .md files use the OnePage reading look (MIT, credited in README)
import './styles/markdown-onepage.css';
import './styles/path-tags.css';
import './styles/folder-blocks.css';
import './styles/quick-launch.css';
import './styles/theme-picker.css';
import './styles/coordinator-bar.css';
import './styles/celebrations.css';
import './styles/coordinator-tour.css';
import './styles/remote-setup-guide.css';
import './styles/ghost-tab.css';
// 动效层最后加载:它覆写前面各文件里同名选择器的 transition 和 animation
import './styles/motion.css';
import { initCustomThemes } from './custom-themes';
import { initLegadoDynamic } from './legado-dynamic';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error(
    '[renderer] #root element missing in index.html — ' +
      'Vite did not load the HTML correctly or the template was modified.',
  );
}

// 用户主题(ADR-026):在首次渲染前开始拉取,样式元素追加在上面所有样式表之后
initCustomThemes();
// ADR-030:Legado MD3 的种子色 / 强调色主题
initLegadoDynamic();
createRoot(rootEl).render(<App />);
