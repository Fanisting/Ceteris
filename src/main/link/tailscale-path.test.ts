/**
 * @file src/main/link/tailscale-path.test.ts
 * @purpose ADR-055 从 `tailscale status --json` 判断直连还是中继。样本取自真实输出的字段形状,
 *   地址和名字都换成了占位值。
 */
import { describe, expect, it } from 'vitest';
import { pathFromTailscaleStatus } from './tailscale-path';

const status = {
  Self: {
    HostName: 'LAPTOP',
    DNSName: 'laptop.example-tailnet.ts.net.',
    TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
  },
  Peer: {
    'nodekey:1': {
      HostName: 'DESKTOP',
      DNSName: 'desktop.example-tailnet.ts.net.',
      TailscaleIPs: ['100.64.0.2'],
      CurAddr: '203.0.113.5:41641',
      Relay: 'tok',
      PeerRelay: '',
      Online: true,
    },
    'nodekey:2': {
      HostName: 'office-pc',
      DNSName: 'office-pc.example-tailnet.ts.net.',
      TailscaleIPs: ['100.64.0.3'],
      CurAddr: '',
      Relay: 'fra',
      PeerRelay: '',
      Online: true,
    },
    'nodekey:3': {
      HostName: 'old-box',
      DNSName: 'old-box.example-tailnet.ts.net.',
      TailscaleIPs: ['100.64.0.4'],
      CurAddr: '',
      Relay: 'tok',
      Online: false,
    },
    'nodekey:4': {
      HostName: 'nas',
      DNSName: 'nas.example-tailnet.ts.net.',
      TailscaleIPs: ['100.64.0.5'],
      CurAddr: '',
      Relay: 'tok',
      PeerRelay: '100.64.0.9:40000',
      Online: true,
    },
  },
};

describe('pathFromTailscaleStatus', () => {
  it('reports a direct path with the endpoint in use', () => {
    expect(pathFromTailscaleStatus(status, '100.64.0.2')).toEqual({
      kind: 'direct',
      endpoint: '203.0.113.5:41641',
    });
  });

  it('reports a DERP relay when there is no current address', () => {
    expect(pathFromTailscaleStatus(status, '100.64.0.3')).toEqual({ kind: 'relay', relay: 'fra' });
  });

  it('prefers the peer relay over the home DERP region', () => {
    expect(pathFromTailscaleStatus(status, 'nas')).toEqual({
      kind: 'relay',
      relay: '100.64.0.9:40000',
    });
  });

  it('reports an offline peer', () => {
    expect(pathFromTailscaleStatus(status, '100.64.0.4').kind).toBe('offline');
  });

  it('matches the full MagicDNS name, its first label, or the machine name in any case', () => {
    expect(pathFromTailscaleStatus(status, 'desktop.example-tailnet.ts.net.').kind).toBe('direct');
    expect(pathFromTailscaleStatus(status, 'desktop').kind).toBe('direct');
    expect(pathFromTailscaleStatus(status, 'Office-PC').kind).toBe('relay');
  });

  it('treats loopback and this machine as local', () => {
    expect(pathFromTailscaleStatus(status, '127.0.0.1').kind).toBe('local');
    expect(pathFromTailscaleStatus(status, 'localhost').kind).toBe('local');
    expect(pathFromTailscaleStatus(status, '100.64.0.1').kind).toBe('local');
  });

  it('says not-tailscale for an address outside the tailnet', () => {
    expect(pathFromTailscaleStatus(status, '192.168.1.20').kind).toBe('not-tailscale');
  });

  it('copes with a malformed status object', () => {
    expect(pathFromTailscaleStatus(null, '100.64.0.2').kind).toBe('not-tailscale');
    expect(pathFromTailscaleStatus({ Peer: 'x' }, '100.64.0.2').kind).toBe('not-tailscale');
  });
});
