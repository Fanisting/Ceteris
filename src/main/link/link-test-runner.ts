/**
 * @file src/main/link/link-test-runner.ts
 * @purpose 设置页"测试"按钮背后的流程(ADR-055):已连上就测往返、速度和重标签,
 *   没连上就只测能不能建 TCP 连接;两种情况都读 Tailscale 路径。
 *
 * @关键设计:
 * - 没连上时只做一次裸 TCP 建连再立刻关掉,不握手、不认证。Host 那边会记一条
 *   "连接关闭"的 info 日志,不会占用虚拟窗口。这样能区分"网络不通"和"令牌不对"。
 * - Tailscale 路径在网络测试之后读:测速的流量会让 Tailscale 尽快打通直连,
 *   这时读到的才是这条连接真正在走的路。
 *
 * @对应文档章节: docs/软件定义书.md ADR-055;docs/ipc-protocol.md cmd:link:test
 *
 * @不要在这里做的事:
 * - 不要在这里开新的 LinkClient(会在 Host 上注册虚拟窗口,远程窗口还会弹出来)
 */
import { connect } from 'node:net';
import type { LinkTestResult } from '@shared/link-test';
import type { LinkClient } from './link-client';
import { readTailscalePath } from './tailscale-path';
import { logger } from '../logger';

/** 裸 TCP 建连的等待上限 */
const TCP_PROBE_TIMEOUT_MS = 5_000;

/**
 * 测一次到 host:port 的 TCP 建连用时。
 *
 * @returns ms 与错误说明二选一;永不抛错
 * @副作用 建一个 TCP 连接,连上立刻关掉
 */
export function measureTcpConnect(
  host: string,
  port: number,
): Promise<{ ms: number | null; error: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = connect({ host, port });
    const done = (ms: number | null, error: string): void => {
      socket.removeAllListeners();
      socket.on('error', () => undefined); // destroy 之后迟到的错误
      socket.destroy();
      resolve({ ms, error });
    };
    socket.setTimeout(TCP_PROBE_TIMEOUT_MS, () =>
      done(null, `${TCP_PROBE_TIMEOUT_MS / 1000} 秒内没连上`),
    );
    socket.once('connect', () => done(Date.now() - start, ''));
    socket.once('error', (err: NodeJS.ErrnoException) => done(null, err.code ?? err.message));
  });
}

/**
 * 跑一次连接测试。
 *
 * @param host 设置里保存的 Host 地址
 * @param port 端口
 * @param client 这个地址上已经连上的 LinkClient;没有时只测建连
 * @returns 测试结果;网络部分失败时记在结果里,不抛错
 * @throws Error 已连上、测试途中连接断开时(runNetworkTest 的 assertStillConnected)
 */
export async function runLinkTest(
  host: string,
  port: number,
  client: LinkClient | null,
): Promise<LinkTestResult> {
  const address = `${host}:${port}`;
  if (client) {
    const net = await client.runNetworkTest();
    const [path, tabs] = await Promise.all([readTailscalePath(host), client.getTabTraffic()]);
    return {
      at: Date.now(),
      address,
      connected: true,
      connectMs: null,
      connectError: '',
      path,
      ...net,
      tabs,
    };
  }
  const tcp = await measureTcpConnect(host, port);
  const path = await readTailscalePath(host);
  logger.info(
    'LinkTest',
    `未连接时测试 ${address}:建连 ${tcp.ms ?? '失败'}${tcp.error ? `(${tcp.error})` : ''},` +
      `路径 ${path.kind}`,
  );
  return {
    at: Date.now(),
    address,
    connected: false,
    connectMs: tcp.ms,
    connectError: tcp.error,
    path,
    rtt: null,
    downMBps: null,
    upMBps: null,
    speedSkipped: 'not-connected',
    compressed: false,
    tabs: [],
  };
}
