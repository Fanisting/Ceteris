/**
 * @file agent-versions.ts
 * @purpose 查本机 agent CLI (Claude Code / Codex / OpenCode ...) 的已装版本与
 *   registry 最新版本,给新建页按钮上的状态点用;并给出每个 agent 的升级命令。
 *
 * @关键设计:
 * - 只认内置 agent 模板 (AGENT_UPDATE_SPECS 固定表)。renderer 只传 templateId,
 *   升级命令永远从这张表取,renderer 无法让 main 跑任意命令。
 * - 版本检测跑 `<命令> --version`;最新版查 npm registry 或 PyPI 的 JSON 接口。
 *   两者都失败时降级为 'installed' / 'missing',绝不抛给 renderer。
 * - 结果带缓存:已装版本 10 分钟,最新版 6 小时。升级后 invalidate 该 agent 的
 *   已装版本,下次打开新建页会重新检测。
 * - 副作用 (exec / fetch) 都从构造参数注入,单测不跑真进程、不联网。
 *
 * @不要在这里做的事:
 * - 不要自己执行升级命令 (升级在可见的终端 tab 里跑,见 ipc.ts AGENT_UPGRADE)
 * - 不要检查 SSH / WSL 里的 agent (状态点只对本机路径有意义)
 */

import { exec } from 'node:child_process';
import type { AgentVersionInfo, AgentVersionStatus } from '@shared/protocol';
import type { PlatformAdapter } from './platform';

export interface AgentUpdateSpec {
  /** 内置模板 id,见 templates-manager.ts BUILTIN_TEMPLATES */
  templateId: string;
  /** PATH 上的命令名 */
  command: string;
  /** 最新版从哪里查;缺省表示没有公开 registry,只报告已装 */
  registry?: { kind: 'npm' | 'pypi'; name: string };
  /** 升级命令 (在新终端 tab 里跑) */
  upgrade: { command: string; args: string[] };
}

/**
 * 每个 agent 的升级方式。有自带升级子命令的用它 (它知道自己是怎么装的);
 * 没有的走 npm 全局安装。
 */
export const AGENT_UPDATE_SPECS: readonly AgentUpdateSpec[] = [
  {
    templateId: 'claude-code',
    command: 'claude',
    registry: { kind: 'npm', name: '@anthropic-ai/claude-code' },
    upgrade: { command: 'claude', args: ['update'] },
  },
  {
    templateId: 'codex',
    command: 'codex',
    registry: { kind: 'npm', name: '@openai/codex' },
    upgrade: { command: 'npm', args: ['install', '-g', '@openai/codex@latest'] },
  },
  {
    templateId: 'opencode',
    command: 'opencode',
    registry: { kind: 'npm', name: 'opencode-ai' },
    upgrade: { command: 'opencode', args: ['upgrade'] },
  },
  {
    templateId: 'gemini-cli',
    command: 'gemini',
    registry: { kind: 'npm', name: '@google/gemini-cli' },
    upgrade: { command: 'npm', args: ['install', '-g', '@google/gemini-cli@latest'] },
  },
  {
    templateId: 'github-copilot',
    command: 'copilot',
    registry: { kind: 'npm', name: '@github/copilot' },
    upgrade: { command: 'npm', args: ['install', '-g', '@github/copilot@latest'] },
  },
  {
    templateId: 'cursor',
    command: 'agent',
    upgrade: { command: 'agent', args: ['update'] },
  },
  {
    templateId: 'aider',
    command: 'aider',
    registry: { kind: 'pypi', name: 'aider-chat' },
    upgrade: { command: 'aider', args: ['--upgrade'] },
  },
];

export function findAgentSpec(templateId: string): AgentUpdateSpec | undefined {
  return AGENT_UPDATE_SPECS.find((s) => s.templateId === templateId);
}

/** "claude update" 这种给人看的形式 */
export function formatUpgradeCommand(spec: AgentUpdateSpec): string {
  return [spec.upgrade.command, ...spec.upgrade.args].join(' ');
}

/**
 * 从 `--version` 输出里取第一个 x.y 或 x.y.z。
 * 例:"2.1.3 (Claude Code)" → "2.1.3";"codex-cli 0.46.0" → "0.46.0"。
 */
export function parseVersion(text: string): string | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  return m[3] !== undefined ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[2]}`;
}

/** 按数字逐段比较;缺的段按 0。a<b 返回负数。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function agentStatus(
  found: boolean,
  installed: string | null,
  latest: string | null,
): AgentVersionStatus {
  if (!found) return 'missing';
  if (!installed || !latest) return 'installed';
  return compareVersions(installed, latest) < 0 ? 'outdated' : 'current';
}

export interface AgentVersionDeps {
  /** 命令在 PATH 上的绝对路径;找不到返回 null */
  resolveExecutable: (command: string) => string | null;
  /** 跑 `<exe> --version`,返回 stdout+stderr;失败 / 超时返回 null */
  runVersion: (exePath: string) => Promise<string | null>;
  /** 拿 URL 的 JSON;失败返回 null */
  fetchJson: (url: string) => Promise<unknown>;
  now?: () => number;
}

const INSTALLED_TTL_MS = 10 * 60_000;
const LATEST_TTL_MS = 6 * 60 * 60_000;

export function registryUrl(registry: NonNullable<AgentUpdateSpec['registry']>): string {
  return registry.kind === 'npm'
    ? `https://registry.npmjs.org/${registry.name}/latest`
    : `https://pypi.org/pypi/${registry.name}/json`;
}

/** 从 registry 的 JSON 里取版本号。npm: { version };PyPI: { info: { version } } */
export function readRegistryVersion(kind: 'npm' | 'pypi', body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const raw =
    kind === 'npm'
      ? (body as { version?: unknown }).version
      : (body as { info?: { version?: unknown } }).info?.version;
  return typeof raw === 'string' ? parseVersion(raw) : null;
}

interface Cached<T> {
  value: T;
  at: number;
}

export class AgentVersionChecker {
  private readonly installed = new Map<string, Cached<{ found: boolean; version: string | null }>>();
  private readonly latest = new Map<string, Cached<string | null>>();
  private inFlight: Promise<AgentVersionInfo[]> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: AgentVersionDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * 返回全部 agent 的状态。并发调用共享同一次检查。
   * @param force true 时清空缓存再查
   */
  list(force = false): Promise<AgentVersionInfo[]> {
    if (force) {
      this.installed.clear();
      this.latest.clear();
    } else if (this.inFlight) {
      return this.inFlight;
    }
    const run = Promise.all(AGENT_UPDATE_SPECS.map((spec) => this.checkOne(spec))).finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  /** 升级后调用:下次 list 重新跑 --version */
  invalidate(templateId: string): void {
    this.installed.delete(templateId);
  }

  private async checkOne(spec: AgentUpdateSpec): Promise<AgentVersionInfo> {
    const [inst, latest] = await Promise.all([this.getInstalled(spec), this.getLatest(spec)]);
    const info: AgentVersionInfo = {
      templateId: spec.templateId,
      status: agentStatus(inst.found, inst.version, latest),
      upgradeCommand: formatUpgradeCommand(spec),
    };
    if (inst.version) info.installed = inst.version;
    if (latest) info.latest = latest;
    return info;
  }

  private async getInstalled(spec: AgentUpdateSpec): Promise<{ found: boolean; version: string | null }> {
    const hit = this.installed.get(spec.templateId);
    if (hit && this.now() - hit.at < INSTALLED_TTL_MS) return hit.value;
    const exe = this.deps.resolveExecutable(spec.command);
    let value: { found: boolean; version: string | null };
    if (!exe) {
      value = { found: false, version: null };
    } else {
      const out = await this.deps.runVersion(exe).catch(() => null);
      value = { found: true, version: out ? parseVersion(out) : null };
    }
    this.installed.set(spec.templateId, { value, at: this.now() });
    return value;
  }

  private async getLatest(spec: AgentUpdateSpec): Promise<string | null> {
    if (!spec.registry) return null;
    const hit = this.latest.get(spec.templateId);
    if (hit && this.now() - hit.at < LATEST_TTL_MS) return hit.value;
    const body = await this.deps.fetchJson(registryUrl(spec.registry)).catch(() => null);
    const value = readRegistryVersion(spec.registry.kind, body);
    // 失败不缓存,下次打开新建页再试
    if (value) this.latest.set(spec.templateId, { value, at: this.now() });
    return value;
  }
}

const VERSION_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 8_000;

/**
 * 生产用的 checker:PATH 取平台层刷新后的值 (装完新 CLI 不用重启 Ceteris),
 * `--version` 通过 shell 跑,因为 Windows 上 npm 装的是 .cmd 包装脚本,
 * 不能直接 execFile。exe 路径来自 resolveExecutable,不是用户输入。
 */
export function createAgentVersionChecker(adapter: PlatformAdapter): AgentVersionChecker {
  const buildEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    const path = adapter.getRefreshedPath();
    if (path) {
      env.PATH = path;
      env.Path = path;
    }
    adapter.normalizeSpawnEnv(env);
    return env;
  };
  return new AgentVersionChecker({
    resolveExecutable: (command) => adapter.resolveExecutable(command, buildEnv()),
    runVersion: (exePath) =>
      new Promise((resolve) => {
        exec(
          `"${exePath}" --version`,
          { env: buildEnv(), timeout: VERSION_TIMEOUT_MS, windowsHide: true },
          (err, stdout, stderr) => {
            const out = `${stdout}
${stderr}`.trim();
            resolve(err && !out ? null : out);
          },
        );
      }),
    fetchJson: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return null;
      return res.json();
    },
  });
}
