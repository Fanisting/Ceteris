/**
 * @file src/main/link/tailscale-path.ts
 * @purpose 连接测试(ADR-055)用:问本机的 Tailscale 到某个 Host 的流量是直连还是走中继。
 *
 * @关键设计:
 * - 读 `tailscale status --json`,只读不改。Tailscale 的命令行在各平台装在不同地方,
 *   先按 PATH 找,找不到再试平台适配层给的固定位置(tailscaleCliCandidates)。
 * - 判定:对端的 CurAddr 非空就是直连;为空时看 PeerRelay(Tailscale 的 peer relay)
 *   和 Relay(DERP 区域)。Relay 字段总是有值(那是对端的"家"中继),不能单凭它判中继。
 * - 匹配 Host 地址时三样都比:Tailscale IP、MagicDNS 全名(去掉末尾的点)、机器名
 *   (不分大小写,也比 MagicDNS 名的第一段)。用户在设置里填哪一种都能认出来。
 * - 读不到(没装、没登录、超时)一律返回 unknown,不抛错:测试的其余部分照常进行。
 *
 * @对应文档章节: docs/软件定义书.md ADR-055
 *
 * @不要在这里做的事:
 * - 不要调用任何会改 Tailscale 状态的子命令(up / down / set / ping 都不要)
 * - 不要在这里写 process.platform 分支(固定位置由 PlatformAdapter 给)
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { LinkTestPath } from '@shared/link-test';
import { getPlatformAdapter } from '../platform';
import { logger } from '../logger';

/** 读状态的超时。Tailscale 后台服务没起来时命令会卡住,不能让测试一直等 */
const STATUS_TIMEOUT_MS = 4_000;

/** `tailscale status --json` 里本函数用到的字段。其余字段忽略。 */
interface TailscaleNode {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  CurAddr?: string;
  Relay?: string;
  PeerRelay?: string;
  Online?: boolean;
}

interface TailscaleStatus {
  Self?: TailscaleNode;
  Peer?: Record<string, TailscaleNode>;
}

/**
 * 从 status JSON 判断到 host 的路径。纯函数。
 *
 * @param status `tailscale status --json` 解析后的对象;形状不可信
 * @param host 用户在设置里填的 Host 地址(IP、MagicDNS 名或机器名)
 */
export function pathFromTailscaleStatus(status: unknown, host: string): LinkTestPath {
  const s = (status ?? {}) as TailscaleStatus;
  const target = host.trim().toLowerCase().replace(/\.$/, '');
  if (isLoopback(target)) return { kind: 'local' };
  if (s.Self && nodeMatches(s.Self, target)) return { kind: 'local' };
  const peer = Object.values(s.Peer ?? {}).find((p) => nodeMatches(p, target));
  if (!peer) return { kind: 'not-tailscale' };
  if (peer.Online === false) return { kind: 'offline' };
  if (peer.CurAddr) return { kind: 'direct', endpoint: peer.CurAddr };
  if (peer.PeerRelay) return { kind: 'relay', relay: peer.PeerRelay };
  if (peer.Relay) return { kind: 'relay', relay: peer.Relay };
  return { kind: 'unknown' };
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function nodeMatches(node: TailscaleNode, target: string): boolean {
  if ((node.TailscaleIPs ?? []).some((ip) => ip.toLowerCase() === target)) return true;
  const dns = (node.DNSName ?? '').toLowerCase().replace(/\.$/, '');
  if (dns && (dns === target || dns.split('.')[0] === target)) return true;
  return (node.HostName ?? '').toLowerCase() === target;
}

/** 找 Tailscale 命令行。找不到返回 null。 */
function findTailscaleCli(): string | null {
  const adapter = getPlatformAdapter();
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
  const onPath = adapter.resolveExecutable('tailscale', env);
  if (onPath) return onPath;
  return (adapter.tailscaleCliCandidates?.() ?? []).find((p) => existsSync(p)) ?? null;
}

/**
 * 读本机 Tailscale 到 host 的路径。
 *
 * @returns 永不抛错;读不到时 kind 为 unknown
 * @副作用 起一个 `tailscale status --json` 子进程,最多 4 秒
 */
export async function readTailscalePath(host: string): Promise<LinkTestPath> {
  const cli = findTailscaleCli();
  if (!cli) {
    logger.info('LinkTest', '没找到 tailscale 命令行,路径记为 unknown');
    return { kind: 'unknown' };
  }
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        cli,
        ['status', '--json'],
        { timeout: STATUS_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });
    return pathFromTailscaleStatus(JSON.parse(stdout), host);
  } catch (err) {
    logger.warn(
      'LinkTest',
      `读 tailscale status 失败(cli=${cli}):${err instanceof Error ? err.message : String(err)}。` +
        `可能原因:Tailscale 后台服务没在运行,或本机没登录。路径记为 unknown`,
    );
    return { kind: 'unknown' };
  }
}
