/**
 * @file agent-versions.ts
 * @purpose 查本机 agent CLI (Claude Code / Codex / OpenCode ...) 的已装版本与
 *   registry 最新版本,给新建页按钮上的状态点用;并按"实际怎么装的"给出升级命令。
 *
 * @关键设计:
 * - 只认内置 agent 模板 (AGENT_UPDATE_SPECS 固定表)。renderer 只传 templateId,
 *   升级命令由 main 根据安装位置推出来,renderer 无法让 main 跑任意命令。
 * - 升级命令看 PATH 上**第一份** (也就是真正会运行的那份) 装在哪:
 *   跟随符号链接后,路径落在 Homebrew Cellar / WinGet Packages / scoop apps /
 *   pipx venvs / uv tools / .bun / pnpm / node_modules 下,就用对应的包管理器升级;
 *   都不像时退回 agent 自带的升级子命令 (claude update 等);连这个也没有就不给
 *   升级按钮。这样不会出现"用 npm 升级一个 bun 装的 CLI,结果多装一份"的问题。
 * - PATH 上有多份时,把其余几份报给 renderer,tooltip 提示用户。
 * - 版本检测跑 `<命令> --version`;最新版查 npm registry 或 PyPI 的 JSON 接口。
 *   失败时降级为 'installed' / 'missing',绝不抛给 renderer。
 * - 结果带缓存:已装版本 10 分钟,最新版 6 小时。升级结束后 invalidate。
 * - 副作用 (PATH 扫描 / exec / fetch / 读文件) 都从构造参数注入,单测不碰真环境。
 *
 * @不要在这里做的事:
 * - 不要自己执行升级命令 (升级在可见的终端 tab 里跑,见 ipc.ts AGENT_UPGRADE)
 * - 不要检查 SSH / WSL 里的 agent (状态点只对本机路径有意义)
 */

import { exec } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join, posix } from 'node:path';
import type { AgentInstallMethod, AgentVersionInfo, AgentVersionStatus } from '@shared/protocol';
import type { PlatformAdapter } from './platform';

export interface AgentUpdateSpec {
  /** 内置模板 id,见 templates-manager.ts BUILTIN_TEMPLATES */
  templateId: string;
  /** PATH 上的命令名 */
  command: string;
  /** 最新版从哪里查;缺省表示没有公开 registry,只报告已装 */
  registry?: { kind: 'npm' | 'pypi'; name: string };
  /** agent 自带的升级子命令;安装方式认不出来时用它 */
  selfUpdate?: { command: string; args: string[] };
}

export const AGENT_UPDATE_SPECS: readonly AgentUpdateSpec[] = [
  {
    templateId: 'claude-code',
    command: 'claude',
    registry: { kind: 'npm', name: '@anthropic-ai/claude-code' },
    selfUpdate: { command: 'claude', args: ['update'] },
  },
  {
    templateId: 'codex',
    command: 'codex',
    registry: { kind: 'npm', name: '@openai/codex' },
  },
  {
    templateId: 'opencode',
    command: 'opencode',
    registry: { kind: 'npm', name: 'opencode-ai' },
    selfUpdate: { command: 'opencode', args: ['upgrade'] },
  },
  {
    templateId: 'gemini-cli',
    command: 'gemini',
    registry: { kind: 'npm', name: '@google/gemini-cli' },
  },
  {
    templateId: 'github-copilot',
    command: 'copilot',
    registry: { kind: 'npm', name: '@github/copilot' },
  },
  {
    templateId: 'cursor',
    command: 'agent',
    selfUpdate: { command: 'agent', args: ['update'] },
  },
  {
    templateId: 'aider',
    command: 'aider',
    registry: { kind: 'pypi', name: 'aider-chat' },
    selfUpdate: { command: 'aider', args: ['--upgrade'] },
  },
];

export function findAgentSpec(templateId: string): AgentUpdateSpec | undefined {
  return AGENT_UPDATE_SPECS.find((s) => s.templateId === templateId);
}

export interface UpgradePlan {
  method: AgentInstallMethod;
  command: string;
  args: string[];
}

/** "bun add -g @google/gemini-cli@latest" 这种给人看的形式 */
export function formatUpgradeCommand(plan: UpgradePlan): string {
  return [plan.command, ...plan.args].join(' ');
}

/** planUpgrade 需要的只读文件探针;单测里用假的 */
export interface FileProbe {
  exists: (path: string) => boolean;
  readText: (path: string) => string | null;
}

/**
 * 根据可执行文件位置推出升级命令。
 *
 * @param exePath PATH 上解析到的路径 (Windows 上可能是 .cmd / scoop shim)
 * @param realPath exePath 跟随符号链接后的真实路径 (brew / winget Links / pipx 都是链接)
 * @returns 认不出安装方式且 agent 没有自带升级命令时返回 null
 */
export function planUpgrade(
  spec: AgentUpdateSpec,
  exePath: string,
  realPath: string,
  probe: FileProbe,
): UpgradePlan | null {
  const p = realPath.replace(/\\/g, '/');
  let m: RegExpExecArray | null;

  // 系统包管理器:路径里直接带包名,不依赖我们猜包名
  if ((m = /\/Cellar\/([^/]+)\//i.exec(p))) {
    return { method: 'brew', command: 'brew', args: ['upgrade', m[1]!] };
  }
  if ((m = /\/Caskroom\/([^/]+)\//i.exec(p))) {
    return { method: 'brew', command: 'brew', args: ['upgrade', '--cask', m[1]!] };
  }
  // WinGet\Packages\<PackageId>_<Source>_<hash>\...
  if ((m = /\/WinGet\/Packages\/([^/_]+)_/i.exec(p))) {
    return { method: 'winget', command: 'winget', args: ['upgrade', '--id', m[1]!, '--exact'] };
  }
  const scoopApp = scoopAppName(p, exePath, probe);
  if (scoopApp) return { method: 'scoop', command: 'scoop', args: ['update', scoopApp] };
  if ((m = /\/pipx\/venvs\/([^/]+)\//i.exec(p))) {
    return { method: 'pipx', command: 'pipx', args: ['upgrade', m[1]!] };
  }
  if ((m = /\/uv\/tools\/([^/]+)\//i.exec(p))) {
    return { method: 'uv', command: 'uv', args: ['tool', 'upgrade', m[1]!] };
  }

  // JS 包管理器:只对 npm registry 上的 agent 有意义
  if (spec.registry?.kind === 'npm') {
    const pkg = spec.registry.name;
    if (/\/\.bun\//i.test(p)) {
      return { method: 'bun', command: 'bun', args: ['add', '-g', `${pkg}@latest`] };
    }
    if (/\/pnpm\//i.test(p)) {
      return { method: 'pnpm', command: 'pnpm', args: ['add', '-g', `${pkg}@latest`] };
    }
    // 统一成正斜杠再用 posix 路径函数:Windows 的 fs 接受正斜杠,
    // 单测在 macOS / Linux CI 上跑 Windows 路径也能得到同样结果
    const dir = posix.dirname(exePath.replace(/\\/g, '/'));
    const isNpm =
      p.toLowerCase().includes(`/node_modules/${pkg.toLowerCase()}/`) ||
      // Windows npm 前缀:<prefix>\codex.cmd 旁边是 <prefix>\node_modules\@openai\codex
      probe.exists(posix.join(dir, 'node_modules', pkg, 'package.json')) ||
      // POSIX npm 前缀:<prefix>/bin/codex 对应 <prefix>/lib/node_modules/@openai/codex
      probe.exists(posix.join(dir, '..', 'lib', 'node_modules', pkg, 'package.json'));
    if (isNpm) {
      return { method: 'npm', command: 'npm', args: ['install', '-g', `${pkg}@latest`] };
    }
  }

  if (spec.selfUpdate) return { method: 'self', ...spec.selfUpdate };
  return null;
}

/**
 * scoop 的 shims\codex.exe 不是链接,旁边的 codex.shim 写着
 * `path = "C:\Users\x\scoop\apps\codex\current\codex.exe"`,从这里拿 app 名。
 */
function scoopAppName(realPath: string, exePath: string, probe: FileProbe): string | null {
  const direct = /\/scoop\/apps\/([^/]+)\//i.exec(realPath);
  if (direct) return direct[1]!;
  if (!/\/scoop\/shims\//i.test(realPath)) return null;
  const exe = exePath.replace(/\\/g, '/');
  const shimFile = posix.join(
    posix.dirname(exe),
    `${posix.basename(exe, posix.extname(exe))}.shim`,
  );
  const text = probe.readText(shimFile);
  const m = text ? /[\\/]scoop[\\/]apps[\\/]([^\\/]+)[\\/]/i.exec(text) : null;
  return m ? m[1]! : null;
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
  /** 命令在 PATH 上的全部命中,按 PATH 顺序;第一份是真正会运行的那份 */
  findOnPath: (command: string) => string[];
  /** 跟随符号链接;失败时原样返回 */
  realPath: (path: string) => string;
  probe: FileProbe;
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

interface InstalledInfo {
  /** 真正会运行的那份;null 表示 PATH 上没有 */
  path: string | null;
  otherCopies: string[];
  version: string | null;
  plan: UpgradePlan | null;
}

interface Cached<T> {
  value: T;
  at: number;
}

export class AgentVersionChecker {
  private readonly installed = new Map<string, Cached<InstalledInfo>>();
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

  /** 该 agent 的升级命令 (按当前安装方式);未安装 / 认不出时 null */
  async upgradeFor(templateId: string): Promise<UpgradePlan | null> {
    const spec = findAgentSpec(templateId);
    if (!spec) return null;
    return (await this.getInstalled(spec)).plan;
  }

  /** 升级后调用:下次 list 重新扫 PATH、重新跑 --version */
  invalidate(templateId: string): void {
    this.installed.delete(templateId);
  }

  private async checkOne(spec: AgentUpdateSpec): Promise<AgentVersionInfo> {
    const [inst, latest] = await Promise.all([this.getInstalled(spec), this.getLatest(spec)]);
    const info: AgentVersionInfo = {
      templateId: spec.templateId,
      status: agentStatus(inst.path !== null, inst.version, latest),
    };
    if (inst.version) info.installed = inst.version;
    if (latest) info.latest = latest;
    if (inst.path) info.path = inst.path;
    if (inst.otherCopies.length > 0) info.otherCopies = inst.otherCopies;
    if (inst.plan) {
      info.installMethod = inst.plan.method;
      info.upgradeCommand = formatUpgradeCommand(inst.plan);
    }
    return info;
  }

  private async getInstalled(spec: AgentUpdateSpec): Promise<InstalledInfo> {
    const hit = this.installed.get(spec.templateId);
    if (hit && this.now() - hit.at < INSTALLED_TTL_MS) return hit.value;
    const [first, ...others] = this.deps.findOnPath(spec.command);
    let value: InstalledInfo;
    if (!first) {
      value = { path: null, otherCopies: [], version: null, plan: null };
    } else {
      const out = await this.deps.runVersion(first).catch(() => null);
      value = {
        path: first,
        otherCopies: others,
        version: out ? parseVersion(out) : null,
        plan: planUpgrade(spec, first, this.deps.realPath(first), this.deps.probe),
      };
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

/**
 * 按 PATH 顺序列出命令的所有命中 (每个目录最多一份)。PATHEXT 存在时 (Windows)
 * 按它补扩展名,否则只认裸命令名。npm 在 Windows 前缀目录里还放了一个无扩展名
 * 的 sh 脚本,PATHEXT 过滤正好把它排除掉。
 */
export function findOnPath(command: string, env: Record<string, string | undefined>): string[] {
  const pathVar = env.PATH ?? env.Path ?? '';
  const pathExt = env.PATHEXT ?? env.PathExt;
  const names = pathExt
    ? pathExt.split(';').filter(Boolean).map((ext) => command + ext.toLowerCase())
    : [command];
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const dir of pathVar.split(delimiter).map((d) => d.trim()).filter(Boolean)) {
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          hits.push(candidate);
          break;
        }
      } catch {
        // 读不了的 PATH 目录跳过
      }
    }
  }
  return hits;
}

const VERSION_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 8_000;

/**
 * 生产用的 checker:PATH 取平台层刷新后的值 (装完新 CLI 不用重启 Ceteris),
 * `--version` 通过 shell 跑,因为 Windows 上 npm 装的是 .cmd 包装脚本,
 * 不能直接 execFile。exe 路径来自 PATH 扫描,不是用户输入。
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
    findOnPath: (command) => findOnPath(command, buildEnv()),
    realPath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    },
    probe: {
      exists: (path) => existsSync(path),
      readText: (path) => {
        try {
          return readFileSync(path, 'utf-8');
        } catch {
          return null;
        }
      },
    },
    runVersion: (exePath) =>
      new Promise((resolve) => {
        exec(
          `"${exePath}" --version`,
          { env: buildEnv(), timeout: VERSION_TIMEOUT_MS, windowsHide: true },
          (err, stdout, stderr) => {
            const out = `${stdout}\n${stderr}`.trim();
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
