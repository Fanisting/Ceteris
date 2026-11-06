/**
 * @file src/main/link/link-manager.ts
 * @purpose Marina Link 的总装配点。持有 Host 侧的 LinkServer 与 Client 侧的
 *   若干 LinkClient,把它们与 settings、WindowManager、ipc 层接起来。
 *
 * @关键设计:
 * - **一个 Marina 实例可以同时是 Host 和 Client**。台式机开着 Host 给笔记本连,
 *   同时自己也连着公司的另一台机器 —— 这两件事互不干扰,所以这里是"一个
 *   server + 一组 client",而不是二选一的模式开关。
 * - **settings 是唯一驱动源**。用户改设置 → SettingsManager 发 settingsChanged
 *   → 这里 diff 出"要不要重启监听 / 要不要重连",而不是让 UI 直接命令
 *   server.start()。这样重启应用后的状态与设置永远一致。
 * - **命令转发器在这里注册**。ipc.ts 通过 setLinkCommandForwarder 拿到一个
 *   函数,内部按 windowId 找到对应的 LinkClient。ipc.ts 因此不需要 import
 *   任何 link 模块,避免循环依赖。
 *
 * @对应文档章节: docs/marina-link-protocol.md;docs/远程访问指南.md
 *
 * @不要在这里做的事:
 * - 不要放协议细节(在 link-server / link-client 里)
 * - 不要直接读 settings.json(走 SettingsManager)
 */
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import {
  LINK_BIND_RECHECK_MS,
  type LinkClientStatus,
  type LinkHostStatus,
} from '@shared/link-protocol';
import type { LinkConnectionStatePayload } from '@shared/protocol';
import type { LinkSettings } from '@shared/types';
import { LinkClient, type LinkClientConfig } from './link-client';
import { LinkServer } from './link-server';
import { setLinkCommandForwarder } from '../ipc';
import type { CreateWindowOptions, WindowManager } from '../window-manager';
import { logger } from '../logger';

export interface LinkManagerDeps {
  windowManager: WindowManager;
  getSettings: () => LinkSettings;
  getWindowOptions: () => CreateWindowOptions;
  /** Called for each new remote window. reveal: the user pressed Connect. */
  onRemoteWindowCreated?: (windowId: string, reveal: boolean) => void;
  /** 列出某窗口持有的 session,LinkServer 用它在重连后恢复归属。 */
  getOwnedSessionIds: (windowId: string) => string[];
  /** 连接状态变化时通知 renderer(设置页的状态条)。 */
  onStatusChange: () => void;
}

export class LinkManager {
  private readonly server: LinkServer;
  /** linkId → LinkClient。linkId 是本进程内的临时 id,不持久化。 */
  private readonly clients = new Map<string, LinkClient>();
  private bindWatchTimer: NodeJS.Timeout | null = null;
  private rebinding = false;

  constructor(private readonly deps: LinkManagerDeps) {
    this.server = new LinkServer({
      windowManager: deps.windowManager,
      getToken: () => this.deps.getSettings().hostToken,
      getOwnedSessionIds: deps.getOwnedSessionIds,
    });

    // ipc.ts 的 handleCommand 判定"这是远程窗口且该命令要转发"之后,会调这个
    // 函数。这里按 windowId 找到承载它的连接。
    setLinkCommandForwarder(async (windowId, channel, payload) => {
      const linkId = this.deps.windowManager.getRemoteLinkId(windowId);
      const client = linkId ? this.clients.get(linkId) : null;
      if (!client) {
        throw new Error(
          `[LinkManager] 窗口 ${windowId} 标记为远程,但找不到对应的连接` +
            `(linkId=${linkId ?? 'null'})。可能原因:连接已被移除但窗口未关闭。` +
            `建议:关闭该窗口重新连接。`,
        );
      }
      return client.forwardCommand(channel, payload);
    });

    // 用户关掉远程窗口 = "我不看了"。此时断开连接:Host 那边虚拟窗口注销,
    // 它持有的 session 转为无主继续跑,Host 本机可以立刻接管。
    deps.windowManager.onWindowClosed((windowId) => {
      const linkId = deps.windowManager.getRemoteLinkId(windowId);
      if (!linkId) return;
      const client = this.clients.get(linkId);
      if (!client) return;
      logger.info('LinkManager', `远程窗口 ${windowId} 已关闭,断开连接 ${linkId}`);
      client.disconnect('window-closed');
      this.clients.delete(linkId);
      this.deps.onStatusChange();
    });
  }

  /**
   * 按当前设置同步 Host 监听状态。应用启动时与用户改设置时各调一次。
   */
  async applyHostSettings(): Promise<void> {
    const s = this.deps.getSettings();
    if (!s.hostEnabled) {
      await this.server.stop();
      this.deps.onStatusChange();
      return;
    }
    if (!s.hostToken) {
      logger.warn('LinkManager', '已开启 Host 但 token 为空,拒绝监听');
      this.deps.onStatusChange();
      return;
    }
    const bindAddress = resolveBindAddress(s.hostBindAddress);
    await this.server.start({ bindAddress, port: s.hostPort });
    this.startBindWatch();
    this.deps.onStatusChange();
  }

  /**
   * 定期复查监听状态。覆盖两种无人值守时的故障:Marina 先于 Tailscale 启动,
   * 以及 Tailscale 地址变化或监听失败。
   */
  private startBindWatch(): void {
    if (this.bindWatchTimer) return;
    this.bindWatchTimer = setInterval(() => {
      void this.recheckBinding();
    }, LINK_BIND_RECHECK_MS);
    // 这个定时器不该阻止进程退出
    this.bindWatchTimer.unref();
  }

  private async recheckBinding(): Promise<void> {
    const s = this.deps.getSettings();
    if (!s.hostEnabled || !s.hostToken || this.rebinding) return;
    const desired = resolveBindAddress(s.hostBindAddress);
    if (!needsRebind(this.server.getStatus(), desired)) return;

    logger.info('LinkManager', `绑定地址需要更新,重新监听 ${desired}:${s.hostPort}`);
    this.rebinding = true;
    try {
      await this.applyHostSettings();
    } finally {
      this.rebinding = false;
    }
  }

  /**
   * 连接到一台远端 Host,成功后会自动开一个远程窗口。
   *
   * @returns 本次连接的 linkId
   */
  connectTo(config: LinkClientConfig, options: { reveal?: boolean } = {}): string {
    const linkId = randomUUID();
    const client = new LinkClient(linkId, config, {
      windowManager: this.deps.windowManager,
      getWindowOptions: this.deps.getWindowOptions,
      onStatusChange: () => this.deps.onStatusChange(),
      onRemoteWindowCreated: (windowId) =>
        this.deps.onRemoteWindowCreated?.(windowId, options.reveal ?? false),
    });
    this.clients.set(linkId, client);
    client.connect();
    logger.info('LinkManager', `发起连接:${config.label} → ${config.host}:${config.port}`);
    return linkId;
  }

  /** 断开一条连接并关闭它的远程窗口。 */
  disconnect(linkId: string): boolean {
    const client = this.clients.get(linkId);
    if (!client) return false;
    const windowId = client.boundWindowId;
    client.disconnect('user-request');
    this.clients.delete(linkId);
    if (windowId) {
      this.deps.windowManager.closeWindow(windowId);
    }
    this.deps.onStatusChange();
    return true;
  }

  /** Host 侧状态,供设置页展示。 */
  getHostStatus(): LinkHostStatus {
    const status = this.server.getStatus();
    const s = this.deps.getSettings();
    // 监听本身成功了,不提示的话用户只会看到"正在监听 127.0.0.1"并以为配置完成
    if (
      s.hostEnabled &&
      s.hostBindAddress === 'auto' &&
      status.listening &&
      status.boundAddress === '127.0.0.1' &&
      !status.lastError
    ) {
      return {
        ...status,
        lastError:
          '未检测到 Tailscale 地址,其他设备暂时无法连接。Tailscale 连上后最多 30 秒内会自动切换。',
      };
    }
    return status;
  }

  /** Title bar name of a remote window; null for a local window. */
  getWindowLabel(windowId: string): string | null {
    return this.findClientByWindow(windowId)?.label ?? null;
  }

  /** 某个远程窗口的连接状态;普通本地窗口返回 null。 */
  getWindowConnectionState(windowId: string): LinkConnectionStatePayload | null {
    return this.findClientByWindow(windowId)?.getConnectionState() ?? null;
  }

  /** 用户确认已看过某个远程窗口的"输入未确认"提示。 */
  acknowledgeUnconfirmed(windowId: string): void {
    this.findClientByWindow(windowId)?.acknowledgeUnconfirmed();
  }

  private findClientByWindow(windowId: string): LinkClient | null {
    const linkId = this.deps.windowManager.getRemoteLinkId(windowId);
    return linkId ? (this.clients.get(linkId) ?? null) : null;
  }

  /** Client 侧所有连接的状态,供设置页展示。 */
  getClientStatuses(): Array<LinkClientStatus & { linkId: string }> {
    return [...this.clients.entries()].map(([linkId, c]) => ({ linkId, ...c.getStatus() }));
  }

  /** Host 侧踢掉一个已连接客户端。 */
  disconnectHostClient(virtualWindowId: string): boolean {
    const ok = this.server.disconnectClient(virtualWindowId);
    if (ok) this.deps.onStatusChange();
    return ok;
  }

  /** 应用退出时清理。 */
  async shutdown(): Promise<void> {
    if (this.bindWatchTimer) clearInterval(this.bindWatchTimer);
    this.bindWatchTimer = null;
    setLinkCommandForwarder(null);
    for (const client of this.clients.values()) {
      client.disconnect('app-quit');
    }
    this.clients.clear();
    await this.server.stop();
  }
}

/**
 * 当前监听状态是否与期望地址不符。没在监听也算不符,这样监听失败后会自动重试。
 */
export function needsRebind(
  status: Pick<LinkHostStatus, 'listening' | 'boundAddress'>,
  desiredAddress: string,
): boolean {
  return !status.listening || status.boundAddress !== desiredAddress;
}

/**
 * 把设置里的绑定地址解析成一个真实可 bind 的地址。
 *
 * 'auto' 的语义是**优先 Tailscale**:如果本机有 100.64.0.0/10 段的地址
 * (Tailscale 的 CGNAT 段),就绑它。这是刻意的安全默认 —— 绑到 tailnet
 * 地址意味着这个端口只对你自己的设备可见,咖啡店 Wi-Fi 上的邻居扫不到。
 *
 * 找不到 Tailscale 时退回 127.0.0.1 而不是 0.0.0.0:宁可"连不上",也不要
 * 在用户没有明确要求的情况下把终端服务暴露到整个局域网。想要局域网访问的
 * 用户必须在设置里显式选择,那一刻 UI 会给出对应的警告。
 */
export function resolveBindAddress(configured: string): string {
  if (configured && configured !== 'auto') return configured;

  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      // Tailscale 用 100.64.0.0/10(RFC 6598 CGNAT 段)
      const octets = addr.address.split('.').map(Number);
      const first = octets[0] ?? 0;
      const second = octets[1] ?? 0;
      if (first === 100 && second >= 64 && second <= 127) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * 列出本机可用于绑定的候选地址,供设置页做下拉。
 *
 * 返回值里 Tailscale 地址会被标出来,让用户一眼看到该选哪个。
 */
export function listBindCandidates(): Array<{
  address: string;
  label: string;
  isTailscale: boolean;
}> {
  const out: Array<{ address: string; label: string; isTailscale: boolean }> = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const octets = addr.address.split('.').map(Number);
      const isTailscale =
        (octets[0] ?? 0) === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127;
      out.push({
        address: addr.address,
        label: isTailscale ? `${addr.address}(Tailscale,推荐)` : `${addr.address}(${name})`,
        isTailscale,
      });
    }
  }
  // Tailscale 排最前面,引导用户选最安全的那个
  out.sort((a, b) => Number(b.isTailscale) - Number(a.isTailscale));
  return out;
}
