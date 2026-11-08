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
import './styles/file-tree.css';
import './styles/path-tags.css';
import './styles/quick-launch.css';
// 动效层最后加载:它覆写前面各文件里同名选择器的 transition 和 animation
import './styles/motion.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error(
    '[renderer] #root element missing in index.html — ' +
      'Vite did not load the HTML correctly or the template was modified.',
  );
}

createRoot(rootEl).render(<App />);
