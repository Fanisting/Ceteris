/**
 * @file src/renderer/components/LinkTestResult.tsx
 * @purpose 设置 → 远程访问里一台已保存 Host 的连接测试(ADR-055):"测试"按钮和结果卡片。
 *
 * @关键设计:
 * - 结果只存在组件 state 里,离开设置页就没了。测试结果是"那一刻"的,存下来反而误导。
 * - 判读规则在 @shared/link-test(能单测),这里只把发现代码翻成中英文并给出建议。
 * - 重标签表只在有发现或有数据时出现。omp 这类每次换尺寸都整屏重画的 agent 会排在
 *   最上面,建议文字直接说明原因,用户不用自己猜是网络还是标签。
 * - 测试要几秒(20 个 ping 约 2 秒,两个方向测速各约 1 秒到几秒),按钮在这期间
 *   显示"测试中…"并禁用;旁边写明测试会让终端输出慢几秒。
 *
 * @对应文档章节: docs/软件定义书.md ADR-055;docs/远程访问指南.md
 *
 * @不要在这里做的事:
 * - 不要在这里算判读(放 @shared/link-test)
 * - 不要把结果写进设置或 localStorage
 */
import { useState } from 'react';
import { COMMAND_CHANNELS, type LinkTestPayload } from '@shared/protocol';
import {
  assessLinkTest,
  type LinkTabTraffic,
  type LinkTestFinding,
  type LinkTestResult,
} from '@shared/link-test';
import { useTranslation } from './LanguageProvider';

type Tx = (zh: string, en: string) => string;

/** 字节数的简短写法:B / KB / MB(1000 进制,与 MB/s 一致)。 */
function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

function formatSpeed(mbps: number | null): string {
  if (mbps === null) return '-';
  return mbps >= 10 ? `${Math.round(mbps)} MB/s` : `${mbps.toFixed(1)} MB/s`;
}

/** 路径一栏的文字。 */
function pathLabel(r: LinkTestResult, tx: Tx): string {
  switch (r.path.kind) {
    case 'local':
      return tx('本机', 'This computer');
    case 'direct':
      return tx('直连', 'Direct');
    case 'relay':
      return tx(`中继(${r.path.relay ?? '?'})`, `Relay (${r.path.relay ?? '?'})`);
    case 'offline':
      return tx('Tailscale 显示对方离线', 'Offline in Tailscale');
    case 'not-tailscale':
      return tx('不经过 Tailscale', 'Not through Tailscale');
    default:
      return tx('未知(读不到 Tailscale)', 'Unknown (no Tailscale CLI)');
  }
}

/** 一条发现的说明和建议。 */
function findingText(f: LinkTestFinding, r: LinkTestResult, tx: Tx): string {
  switch (f.code) {
    case 'unreachable':
      return tx(
        `连不上 ${r.address}(${r.connectError || '没有回应'})。看对方的 Ceteris 是否开着"允许其他机器连接",以及两台机器是否都在 Tailscale 里。`,
        `Cannot reach ${r.address} (${r.connectError || 'no answer'}). Check that Ceteris on the other machine lets other machines connect, and that both machines are on Tailscale.`,
      );
    case 'no-reply':
      return tx(
        '连着,但 20 个 ping 一个都没回来。Host 可能正被大量输出堵住,或者线路几乎不通。等一会儿再测;一直这样就断开重连。',
        'Connected, but none of the 20 pings came back. The host may be stuck behind a lot of output, or the network barely works. Test again in a moment; if it stays like this, disconnect and connect again.',
      );
    case 'speed-failed':
      return tx(
        r.speedSkipped === 'timeout'
          ? '测速 15 秒内没测完,这条线路非常慢。'
          : '测速没能完成,详情见日志里的 LinkClient。',
        r.speedSkipped === 'timeout'
          ? 'The speed test did not finish within 15 s, so this link is very slow.'
          : 'The speed test could not finish. See LinkClient in the log for details.',
      );
    case 'packet-loss':
      return tx(
        `20 个 ping 只回来 ${r.rtt?.received ?? 0} 个。网络在丢包,打字会时有时无。`,
        `Only ${r.rtt?.received ?? 0} of 20 pings came back. The network drops packets, so typing will stall at times.`,
      );
    case 'relay':
      return tx(
        '流量走的是 Tailscale 中继,没有直连。通常是一端的防火墙或路由器挡住了 UDP。在两台机器上都跑一次 tailscale netcheck 看原因。',
        'Traffic goes through a Tailscale relay instead of a direct path. A firewall or router usually blocks UDP on one side. Run tailscale netcheck on both machines to see why.',
      );
    case 'high-rtt':
      return tx(
        `往返中位数 ${r.rtt?.medianMs ?? '-'} ms,打字回显能感觉到拖。`,
        `Median round trip is ${r.rtt?.medianMs ?? '-'} ms, so typed characters show up late.`,
      );
    case 'jitter':
      return tx(
        `往返时快时慢(中位 ${r.rtt?.medianMs ?? '-'} ms,最慢的 5% 在 ${r.rtt?.p95Ms ?? '-'} ms 以上)。Wi-Fi 信号弱或网络拥挤时常见。`,
        `Round trip varies a lot (median ${r.rtt?.medianMs ?? '-'} ms, slowest 5% above ${r.rtt?.p95Ms ?? '-'} ms). Common on weak Wi-Fi or a busy network.`,
      );
    case 'slow-down':
      return tx(
        `从对方到这台机器只有 ${formatSpeed(r.downMBps)},整屏重画会一块一块地出来。`,
        `Only ${formatSpeed(r.downMBps)} from the other machine to this one, so full-screen redraws arrive in pieces.`,
      );
    case 'slow-up':
      return tx(
        `从这台机器到对方只有 ${formatSpeed(r.upMBps)},粘贴大段文字会慢。`,
        `Only ${formatSpeed(r.upMBps)} from this machine to the other one, so pasting long text is slow.`,
      );
    case 'heavy-tab': {
      const t = f.tab as LinkTabTraffic;
      const secs =
        r.downMBps !== null && r.downMBps > 0
          ? (t.largestBurstBytes / 1_000_000 / r.downMBps).toFixed(1)
          : null;
      return tx(
        `"${t.name}" 一次就发了 ${formatBytes(t.largestBurstBytes)}${secs ? `,按这条连接的速度要 ${secs} 秒` : ''}。omp 这类 agent 每次换窗口大小或切回标签都会把整段对话重画一遍。连接已经在压缩这类输出;仍然卡时,远程那边少拖动窗口大小会有帮助。`,
        `"${t.name}" sent ${formatBytes(t.largestBurstBytes)} at once${secs ? `, which takes ${secs} s at this link's speed` : ''}. Agents like omp redraw the whole conversation every time the window is resized or you switch back to the tab. The link already compresses this output; if it still lags, resize the remote window less often.`,
      );
    }
    case 'host-too-old':
      return tx(
        '对方的 Ceteris 版本较旧,不支持测速和压缩。把它升级到和这台一样的版本。',
        'Ceteris on the other machine is older and does not support the speed test or compression. Update it to the same version as this one.',
      );
    case 'not-connected':
      return tx(
        '还没连上,所以只测了能不能连通。连上之后再测一次,可以看到速度和各标签的输出量。',
        'Not connected yet, so only reachability was tested. Connect and test again to see speed and per-tab output.',
      );
    default:
      return '';
  }
}

/** 总体结论一句话。 */
function verdictText(level: 'ok' | 'warn' | 'bad', r: LinkTestResult, tx: Tx): string {
  if (level === 'bad') return tx('连接有问题。', 'The link has a problem.');
  if (level === 'warn') return tx('能用,但会慢。', 'Usable, but slow.');
  return r.connected
    ? tx('连接正常。', 'The link is healthy.')
    : tx('能连通。', 'The host is reachable.');
}

/** useLinkTest 的返回值,交给 LinkTestButton 和 LinkTestCard。 */
export interface LinkTestState {
  running: boolean;
  result: LinkTestResult | null;
  error: string | null;
  run: () => Promise<void>;
}

/**
 * 一台已保存 Host 的测试状态。按钮和结果卡片分开放(按钮在行右侧,卡片在整行下面),
 * 所以状态放在这个 hook 里,由行组件持有。
 *
 * @param host 设置里保存的地址
 * @param port 端口
 */
export function useLinkTest(host: string, port: number): LinkTestState {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<LinkTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      const r = await window.api.invoke<LinkTestPayload, LinkTestResult>(
        COMMAND_CHANNELS.LINK_TEST,
        { host, port },
      );
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };
  return { running, result, error, run };
}

/** "测试"按钮。 */
export function LinkTestButton({ test }: { test: LinkTestState }): JSX.Element {
  const { tx } = useTranslation();
  return (
    <button
      type="button"
      className="settings-button"
      disabled={test.running}
      title={tx(
        '测往返、速度和各标签的输出量,约 5 秒。测速期间终端输出会慢几秒。',
        'Measures round trip, speed and per-tab output in about 5 s. Terminal output slows for a few seconds while it runs.',
      )}
      onClick={() => void test.run()}
    >
      {test.running ? tx('测试中…', 'Testing…') : tx('测试', 'Test')}
    </button>
  );
}

/** 测试结果卡片。还没测过时不渲染。 */
export function LinkTestCard({ test }: { test: LinkTestState }): JSX.Element | null {
  const { tx } = useTranslation();
  const { result, error } = test;
  if (!result && !error) return null;
  const assessment = result ? assessLinkTest(result) : null;
  const heavyIds = new Set(
    assessment?.findings.filter((f) => f.code === 'heavy-tab').map((f) => f.tab?.sessionId) ?? [],
  );

  return (
    <div className="link-test-result" role="status">
      {error && <p className="link-test-verdict link-test-bad">{error}</p>}
      {result && assessment && (
        <>
          <p className={`link-test-verdict link-test-${assessment.level}`}>
            {verdictText(assessment.level, result, tx)}
          </p>
          <dl className="link-test-metrics">
            <div>
              <dt>{tx('路径', 'Path')}</dt>
              <dd>{pathLabel(result, tx)}</dd>
            </div>
            {result.connected ? (
              <>
                <div>
                  <dt>{tx('往返', 'Round trip')}</dt>
                  <dd>
                    {result.rtt ? `${result.rtt.medianMs} ms · p95 ${result.rtt.p95Ms}` : '-'}
                  </dd>
                </div>
                <div>
                  <dt>{tx('抖动 · 丢失', 'Jitter · lost')}</dt>
                  <dd>
                    {result.rtt
                      ? `${result.rtt.jitterMs} ms · ${result.rtt.sent - result.rtt.received}/${result.rtt.sent}`
                      : '-'}
                  </dd>
                </div>
              </>
            ) : (
              <div>
                <dt>{tx('建连', 'Connect')}</dt>
                <dd>
                  {result.connectMs !== null ? `${result.connectMs} ms` : tx('失败', 'Failed')}
                </dd>
              </div>
            )}
            {result.connected && (
              <>
                <div>
                  <dt>{tx('下行', 'Download')}</dt>
                  <dd>{formatSpeed(result.downMBps)}</dd>
                </div>
                <div>
                  <dt>{tx('上行', 'Upload')}</dt>
                  <dd>{formatSpeed(result.upMBps)}</dd>
                </div>
                <div>
                  <dt>{tx('压缩', 'Compression')}</dt>
                  <dd>{result.compressed ? tx('开', 'On') : tx('关', 'Off')}</dd>
                </div>
              </>
            )}
          </dl>
          {assessment.findings.length > 0 && (
            <ul className="link-test-findings">
              {assessment.findings.map((f, i) => (
                <li key={`${f.code}-${i}`} className={`link-test-${f.level}`}>
                  {findingText(f, result, tx)}
                </li>
              ))}
            </ul>
          )}
          {result.tabs.length > 0 && (
            <div className="link-test-table-wrap">
              <table className="link-test-tabs">
                <caption>
                  {tx('最近 5 分钟输出最多的标签', 'Tabs with the most output, last 5 min')}
                </caption>
                <thead>
                  <tr>
                    <th>{tx('标签', 'Tab')}</th>
                    <th>{tx('输出', 'Output')}</th>
                    <th>{tx('最大一阵', 'Largest burst')}</th>
                    <th>{tx('整屏重画', 'Full redraws')}</th>
                    <th>{tx('重放', 'Replays')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.tabs.map((t) => (
                    <tr
                      key={t.sessionId}
                      className={heavyIds.has(t.sessionId) ? 'link-test-heavy' : undefined}
                    >
                      <td>{t.name}</td>
                      <td>{formatBytes(t.bytes)}</td>
                      <td>{formatBytes(t.largestBurstBytes)}</td>
                      <td>{t.redraws}</td>
                      <td>{t.resyncs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
