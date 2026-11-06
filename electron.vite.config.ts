/**
 * @file electron.vite.config.ts
 * @purpose electron-vite 主配置:为 main / preload / renderer 三个进程分别配
 *   置 Vite 构建。dev 时 Vite 提供 HMR,build 时输出到 out/。
 *
 * @关键设计:
 * - 三个 entry: src/main/index.ts, src/preload/index.ts, src/renderer/index.html
 * - 共享类型从 src/shared/ 引入,通过 @shared/* alias 暴露给三方
 * - main / preload 走 Node 环境(externalize node-pty 等原生模块)
 * - renderer 走浏览器环境(React + xterm.js)
 * - CP-4 chunk 5: vite define 在编译时注入 git commit hash + 构建时间
 *   到 __CETERIS_BUILD_COMMIT__ / __CETERIS_BUILD_TIME__ 全局,关于页读取
 *
 * @对应文档章节: 软件定义书.md 第 9 章 (技术架构)、AGENTS.md 第 11 章 (工作流)
 *
 * @构建产物:
 * - out/main/index.js — Electron 主进程 entry,被 package.json "main" 字段引用
 * - out/preload/index.js — 预加载脚本
 * - out/renderer/ — 静态资源 + 入口 index.html
 */
import { resolve } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * 同步探测某端口在 127.0.0.1 上是否可 bind。
 *
 * Windows 上 Hyper-V/WinNAT 会动态保留大段端口(常见命中:
 * `netsh interface ipv4 show excludedportrange protocol=tcp`)。
 * Vite 自身只对 EADDRINUSE 自动 fallback,不处理 EACCES,所以保留段命中会
 * 直接挂在启动期。这里在 config 加载时帮 Vite 先挑一个能 listen 的。
 *
 * 实现:每个候选端口起一个短命子 node 进程跑 net.listen。子进程退出码:
 *   0 = 可 bind(server 已 close);非 0 = EACCES / EADDRINUSE / 超时。
 * 单次探测 ~30-80ms,候选 6 个 → 最坏 500ms 多一点,在 dev 启动期可接受。
 */
function tryListen(port: number): boolean {
  const script = `
    const net = require('net');
    const srv = net.createServer();
    let done = false;
    srv.once('error', () => { if (!done) { done = true; process.exit(1); } });
    srv.once('listening', () => {
      if (done) return;
      done = true;
      srv.close(() => process.exit(0));
    });
    srv.listen(${port}, '127.0.0.1');
    setTimeout(() => { if (!done) { done = true; process.exit(2); } }, 400);
  `;
  try {
    execFileSync(process.execPath, ['-e', script], {
      stdio: 'ignore',
      timeout: 1500,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 从候选端口列表里挑第一个能在 127.0.0.1 上 bind 的端口。
 * 全失败时落回列表首位 — Vite 自己再报 EACCES,至少给开发者看到原始错误。
 *
 * 候选列表特意挑了多个不相邻区间,避免 Windows 把某一段全划进 Hyper-V
 * 保留范围。开发者可用 EASYTERM_DEV_PORT 覆盖。
 */
function pickDevPort(): number {
  const override = Number(process.env.EASYTERM_DEV_PORT);
  if (override) {
    if (tryListen(override)) return override;
    console.warn(
      `[electron-vite] EASYTERM_DEV_PORT=${override} 不可用(端口被保留或占用),` +
        `自动 fallback 到候选列表`,
    );
  }
  // 候选区间(对应 Win11 常见的 excluded port ranges 之外):
  //   17173 / 9173 / 7173 — 较高、罕被工具占用
  //   3173 / 8173 — 中段补漏
  //   5173 — Vite 官方默认,Windows 上常落保留段所以放最后
  const candidates = [17173, 9173, 7173, 3173, 8173, 5173];
  for (const p of candidates) {
    if (tryListen(p)) return p;
  }
  console.warn(
    `[electron-vite] 所有候选端口均无法 bind!可能 OS 占用过多端口。` +
      `请跑 \`netsh interface ipv4 show excludedportrange protocol=tcp\` 自查,` +
      `然后设 EASYTERM_DEV_PORT=<空闲端口> 重试`,
  );
  return candidates[0]!;
}

const DEV_SERVER_PORT = pickDevPort();

/**
 * 构建期获取 git commit hash + 构建时间。
 * 仓库不可用时(如 release tarball)优雅降级。
 */
function getBuildInfo(): { commit: string; builtAt: string } {
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    /* 没在 git 仓库或 git 不可用 */
  }
  return {
    commit,
    builtAt: new Date().toISOString(),
  };
}

const buildInfo = getBuildInfo();
const buildInfoDefine = {
  __CETERIS_BUILD_COMMIT__: JSON.stringify(buildInfo.commit),
  __CETERIS_BUILD_TIME__: JSON.stringify(buildInfo.builtAt),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
    define: buildInfoDefine,
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    define: buildInfoDefine,
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer'),
      },
    },
    define: buildInfoDefine,
    build: {
      // 用绝对路径,避免 electron-vite 把相对 outDir 从 CWD(项目根)再向上拼路径,
      // 导致产物跑到 `E:/out/renderer/`(项目目录之外,完全不进 asar)。
      // 历史上写过 `../../out/renderer` 试图从 src/renderer/ 退回项目根,
      // 实际被解释成从项目根再向上两层 → 跑到磁盘根的 out/ 下,asar 里就没有 renderer。
      // 用 resolve() 直接给绝对路径最稳。
      outDir: resolve('out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
    server: {
      // 锁 IPv4,避免 Vite 默认 localhost 先解析到 IPv6 ::1 时
      // 撞 Windows IPv6 保留端口的 EACCES。
      host: '127.0.0.1',
      // 端口由 pickDevPort() 在 config 加载时**实际探测**选出(2026-05-16
      // DEV-COEXIST 改进 — 历史固定端口 5800 在 5711-5810 保留段命中)。
      // 候选区间 6 个,任何一个能 bind 就用。覆盖:export EASYTERM_DEV_PORT=<port>。
      // 启动时 console 看 "[vite] Local: http://127.0.0.1:<port>/" 确认实际端口。
      port: DEV_SERVER_PORT,
      // EACCES 时 Vite 不会自动回退(它只对 EADDRINUSE 自动 fallback)。
      // 我们已在 pickDevPort 里探测过,strictPort: true 让命中冲突直接报错,
      // 而不是悄悄移动到 +1 端口让人迷惑。
      strictPort: true,
    },
  },
});
