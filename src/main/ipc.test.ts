/**
 * @file src/main/ipc.test.ts
 * @purpose IPC handler 集成测试 — 验证 envelope 解包、Manager 调用契约、关键
 *   分支的回归。
 *
 * v1.3 起加(TST-2):覆盖 IPC-1 修复 — SESSION_CREATE 的 `takeOwnership=false`
 * 分支以前会先创建带 owner 再调 releaseOwner,因 createSession 把空 owner 折叠
 * 成 null → releaseOwner 抛 NotOwner,该路径在 IPC 层根本走不通。修复后:
 * takeOwnership=false 直接传空 owner,不再事后 release;ownerWindowId 落到 null。
 *
 * 关键设计:
 * - vi.hoisted + vi.mock 替换 electron 的 ipcMain,捕获 (channel, handler) 对
 * - vi.mock('./index') 打断 ipc.ts → index.ts 的循环 import(测试期不需要 setQuitting)
 * - vi.mock('./explorer-integration') 屏蔽 PowerShell / native 调用
 * - Manager 用最小桩(只实现 SESSION_CREATE 路径用到的方法),不拉真 PTY
 * - 每个 test 用 beforeEach 重置 handler registry + installed 标志
 *
 * 不在这里覆盖:大部分 handler 走 manager 内部逻辑,manager 自己有完整单测;
 * ipc.ts 是薄编排层,只测那些"编排本身就能错"的命令。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_CHANNELS } from '@shared/protocol';
import type { CommandEnvelope, CreateSessionPayload } from '@shared/protocol';
import type { SessionInfo } from '@shared/types';
import type * as IpcModule from './ipc';
import { makePathId } from './path-manager';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

// ──────────────────────────────────────────────────────────────────
// electron mock — ipcMain.handle 捕获 handler 到 handlers Map
// ──────────────────────────────────────────────────────────────────

vi.stubEnv('ELECTRON_RENDERER_URL', 'http://ceteris.test');

const { handlers, mockApp, mockBrowserWindow, mockClipboard, mockDialog, mockShell, mockIpcMain } =
  vi.hoisted(() => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const mockIpcMain = {
      handle: (channel: string, handler: (...args: unknown[]) => unknown): void => {
        // 真实 event 都带 senderFrame。测试传 {} 时补上应用页面,
        // 显式给 senderFrame 的用例用来测来源检查
        handlers.set(channel, (event: unknown, ...rest: unknown[]) => {
          const given = (event ?? {}) as Record<string, unknown>;
          const withFrame =
            'senderFrame' in given
              ? given
              : { senderFrame: { url: 'http://ceteris.test/' }, ...given };
          return handler(withFrame, ...rest);
        });
      },
      removeHandler: (channel: string): void => {
        handlers.delete(channel);
      },
    };
    const mockApp = {
      getPath: (): string => '/tmp/ceteris-test',
      getVersion: (): string => '0.0.0-test',
      on: (): void => {},
      quit: (): void => {},
      isPackaged: false,
    };
    const mockBrowserWindow = {
      getAllWindows: (): unknown[] => [],
      fromWebContents: (): unknown => null,
    };
    const mockClipboard = {
      readText: (): string => '',
      writeText: (): void => {},
    };
    const mockDialog = {
      showSaveDialog: (): Promise<unknown> => Promise.resolve({ canceled: true }),
      showOpenDialog: (): Promise<unknown> => Promise.resolve({ canceled: true }),
    };
    const mockShell = {
      openExternal: (): Promise<void> => Promise.resolve(),
      openPath: (): Promise<string> => Promise.resolve(''),
      showItemInFolder: (): void => {},
    };
    return { handlers, mockApp, mockBrowserWindow, mockClipboard, mockDialog, mockShell, mockIpcMain };
  });

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
  clipboard: mockClipboard,
  dialog: mockDialog,
  shell: mockShell,
}));

// 打断 ipc.ts → index.ts 的循环 import(测试期不需要真实 setQuitting)
vi.mock('./index', () => ({
  setQuitting: vi.fn(),
}));

// explorer-integration 走 native 命令,测试期不应触发
vi.mock('./explorer-integration', () => ({
  getExplorerIntegrationStatus: vi.fn(async () => ({})),
  setClassicIntegration: vi.fn(async () => ({ ok: true, message: '', status: {} })),
  setModernIntegration: vi.fn(async () => ({ ok: true, message: '', status: {} })),
  getPsCommands: vi.fn(() => ({
    installModern: '',
    uninstallModern: '',
    installClassic: '',
    uninstallClassic: '',
  })),
}));

// build-type 是纯函数但读 app.isPackaged,mock 安全
vi.mock('./build-type', () => ({
  getBuildType: vi.fn(() => 'dev'),
  getChannel: vi.fn(() => 'dev'),
}));

// ──────────────────────────────────────────────────────────────────
// 桩 Manager — 只实现 SESSION_CREATE 路径需要的方法
// ──────────────────────────────────────────────────────────────────

interface CreateSessionCall {
  pathId: string;
  templateId: string;
  ownerWindowId: string;
  cols: number;
  rows: number;
  shellIdOverride?: string;
  sshProfile?: {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    authType: 'agent' | 'keyFile' | 'password';
    tmuxMode?: 'disabled' | 'attach-or-create';
    tmuxOnMissing?: 'fallback-shell' | 'fail';
  };
}

function makeStubs() {
  const createCalls: CreateSessionCall[] = [];
  const stubSession: SessionInfo = {
    id: 'sess-1',
    pathId: '',
    templateId: 'shell',
    originalCwd: '/tmp',
    currentCwd: '/tmp',
    cols: 80,
    rows: 24,
    pid: 1234,
    displayName: 'shell',
    ownerWindowId: null,
    state: 'active',
    createdAt: Date.now(),
  };

  const sessionManager = {
    createSession: vi.fn(async (input: CreateSessionCall): Promise<SessionInfo> => {
      createCalls.push(input);
      return {
        ...stubSession,
        // 模拟真实 SessionManager 的折叠语义:`'' || null` → null
        ownerWindowId: input.ownerWindowId || null,
      };
    }),
    // 关键:releaseOwner 若被错误调用,要抛 NotOwner — 这是 IPC-1 回归检测点
    releaseOwner: vi.fn((_sessionId: string, _windowId: string) => {
      throw new Error('IPC-1 regression: releaseOwner should NOT be called');
    }),
    list: vi.fn(() => []),
    handleWindowClosed: vi.fn(),
    on: vi.fn(),
  };

  interface TreeNode {
    id: string;
    path: string;
  }
  interface PathTreeShape {
    bookmarked: TreeNode[];
    temporary: TreeNode[];
  }
  const pathManager = {
    getTree: vi.fn<[], PathTreeShape>(() => ({
      bookmarked: [],
      temporary: [],
    })),
    on: vi.fn(),
    listBookmarks: vi.fn(() => []),
    listRecent: vi.fn(() => []),
  };

  const templatesManager = {
    getDefaultTemplateId: vi.fn(() => 'shell'),
    list: vi.fn(() => []),
    on: vi.fn(),
  };

  const settingsManager = {
    get: vi.fn(() => ({})),
    on: vi.fn(),
  };

  const windowManager = {
    list: vi.fn(() => []),
    count: vi.fn(() => 0),
    getById: vi.fn(() => null),
    onWindowCreated: vi.fn(),
    onWindowClosed: vi.fn(),
    on: vi.fn(),
    // Ceteris Link:handleCommand 在每条命令入口都会问"发起窗口是不是远程窗口"。
    // 这些测试跑的都是本地窗口场景,恒 false = 所有命令走本地 handler,
    // 与 Link 出现之前的行为完全一致。
    isWindowRemote: vi.fn(() => false),
    getRemoteLinkId: vi.fn(() => null),
    deliverEvent: vi.fn(() => false),
    forEachVirtualWindow: vi.fn(),
  };

  const sshProfileFixture = (id: string) =>
    id === 'ssh-1'
      ? {
          id: 'ssh-1',
          name: 'prod',
          host: 'example.com',
          port: 22,
          username: 'alice',
          authType: 'agent' as const,
          tmuxMode: 'attach-or-create' as const,
          tmuxOnMissing: 'fail' as const,
          addedAt: 1,
        }
      : null;

  const sshProfileManager = {
    get: vi.fn(sshProfileFixture),
    getInternal: vi.fn(sshProfileFixture),
    list: vi.fn(() => []),
    on: vi.fn(),
  };

  return {
    createCalls,
    deps: {
      sessionManager: sessionManager as unknown,
      pathManager: pathManager as unknown,
      templatesManager: templatesManager as unknown,
      settingsManager: settingsManager as unknown,
      windowManager: windowManager as unknown,
      sshProfileManager: sshProfileManager as unknown,
    },
    stubs: {
      sessionManager,
      pathManager,
      templatesManager,
      settingsManager,
      windowManager,
      sshProfileManager,
    },
  };
}

// ──────────────────────────────────────────────────────────────────
// 测试 fixture — 每个 it 重新装载 ipc.ts(installed 单例需要 reset)
// ──────────────────────────────────────────────────────────────────

async function freshIpc(): Promise<typeof IpcModule> {
  vi.resetModules();
  // 重新 mock 在 resetModules 后仍然生效(vi.mock 由 vi.hoisted 提到模块顶部)
  return (await import('./ipc')) as typeof IpcModule;
}

beforeEach(() => {
  handlers.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ──────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────

describe('IPC SESSION_CREATE', () => {
  it('takeOwnership=true(默认): 把 envelope.windowId 透传为 ownerWindowId', async () => {
    const { installIpcLayer } = await freshIpc();
    const { createCalls, deps, stubs } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const handler = handlers.get(COMMAND_CHANNELS.SESSION_CREATE);
    expect(handler).toBeTruthy();

    const envelope: CommandEnvelope<CreateSessionPayload> = {
      windowId: 'win-aaa',
      requestId: 'req-1',
      payload: { pathId: 'C:\\foo', cols: 80, rows: 24 }, // takeOwnership 默认 true
    };

    const result = (await handler!({}, envelope)) as { session: SessionInfo; pathTreeChanged: boolean };
    expect(result.session.id).toBe('sess-1');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.ownerWindowId).toBe('win-aaa');
    // 不应触发 releaseOwner
    expect(stubs.sessionManager.releaseOwner).not.toHaveBeenCalled();
  });

  it('takeOwnership=false(IPC-1 修复): 传空 owner,绝不调 releaseOwner', async () => {
    const { installIpcLayer } = await freshIpc();
    const { createCalls, deps, stubs } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const handler = handlers.get(COMMAND_CHANNELS.SESSION_CREATE);
    const envelope: CommandEnvelope<CreateSessionPayload> = {
      windowId: 'win-bbb',
      requestId: 'req-2',
      payload: { pathId: 'C:\\foo', cols: 80, rows: 24, takeOwnership: false },
    };

    // 旧实现会抛 NotOwner(stub.releaseOwner 模拟该行为);新实现应不调 releaseOwner
    // 且 ownerWindowId 应为空串(createSession 内部再折叠为 null)
    const result = (await handler!({}, envelope)) as { session: SessionInfo };

    expect(result.session.ownerWindowId).toBeNull();
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.ownerWindowId).toBe('');
    expect(stubs.sessionManager.releaseOwner).not.toHaveBeenCalled();
  });

  it('templateId 缺省 → 用 templatesManager.getDefaultTemplateId()', async () => {
    const { installIpcLayer } = await freshIpc();
    const { createCalls, deps, stubs } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const handler = handlers.get(COMMAND_CHANNELS.SESSION_CREATE);
    const envelope: CommandEnvelope<CreateSessionPayload> = {
      windowId: 'win-ccc',
      requestId: 'req-3',
      payload: { cols: 80, rows: 24 }, // 无 templateId / pathId
    };

    await handler!({}, envelope);
    expect(stubs.templatesManager.getDefaultTemplateId).toHaveBeenCalled();
    expect(createCalls[0]!.templateId).toBe('shell');
    expect(createCalls[0]!.pathId).toBe(''); // pathId ?? ''
  });

  it('pathTreeChanged 由 getTree() 前后 JSON 对比得出', async () => {
    const { installIpcLayer } = await freshIpc();
    const { deps, stubs } = makeStubs();
    // 模拟 createSession 触发了 path 树变化:第二次 getTree 返回不同结构
    let callN = 0;
    stubs.pathManager.getTree.mockImplementation(() => {
      callN++;
      return callN === 1
        ? { bookmarked: [], temporary: [] }
        : { bookmarked: [], temporary: [{ id: 'C:\\new', path: 'C:\\new' }] };
    });
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const handler = handlers.get(COMMAND_CHANNELS.SESSION_CREATE);
    const envelope: CommandEnvelope<CreateSessionPayload> = {
      windowId: 'win-ddd',
      requestId: 'req-4',
      payload: { pathId: 'C:\\new', cols: 80, rows: 24 },
    };

    const result = (await handler!({}, envelope)) as { pathTreeChanged: boolean };
    expect(result.pathTreeChanged).toBe(true);
  });

  it('SSH 普通连接忽略旧 profile tmux 设置,强制 plain ssh', async () => {
    const { installIpcLayer } = await freshIpc();
    const { createCalls, deps } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const pathId = makePathId({ kind: 'ssh', sshProfileId: 'ssh-1', path: '~/repo' });
    const handler = handlers.get(COMMAND_CHANNELS.SESSION_CREATE);
    const envelope: CommandEnvelope<CreateSessionPayload> = {
      windowId: 'win-ssh',
      requestId: 'req-ssh-1',
      payload: { pathId, cols: 80, rows: 24, sshTmuxMode: 'disabled' },
    };

    await handler!({}, envelope);
    expect(createCalls[0]!.sshProfile).toMatchObject({
      id: 'ssh-1',
      tmuxMode: 'disabled',
      tmuxOnMissing: 'fallback-shell',
    });
  });

  it('SSH tmux 入口按本次启动参数启用 tmux,失败时回退 shell', async () => {
    const { installIpcLayer } = await freshIpc();
    const { createCalls, deps } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const pathId = makePathId({ kind: 'ssh', sshProfileId: 'ssh-1', path: '~/repo' });
    const handler = handlers.get(COMMAND_CHANNELS.SESSION_CREATE);
    const envelope: CommandEnvelope<CreateSessionPayload> = {
      windowId: 'win-ssh',
      requestId: 'req-ssh-2',
      payload: { pathId, cols: 80, rows: 24, sshTmuxMode: 'attach-or-create' },
    };

    await handler!({}, envelope);
    expect(createCalls[0]!.sshProfile).toMatchObject({
      id: 'ssh-1',
      tmuxMode: 'attach-or-create',
      tmuxOnMissing: 'fallback-shell',
    });
  });
});

describe('Link 远程窗口的主题跟随本机', () => {
  const REMOTE = 'win-remote';
  const hostSettings = {
    appearance: { theme: 'dracula', terminalFontSize: 18 },
  };

  async function setup() {
    const ipc = await freshIpc();
    const { deps, stubs } = makeStubs();
    const localSettings = { appearance: { theme: 'ceteris-dark' } };
    const settingsListeners: Array<(e: unknown) => void> = [];
    const update = vi.fn();
    Object.assign(stubs.settingsManager, {
      get: vi.fn(() => localSettings),
      update,
      on: vi.fn((name: string, fn: (e: unknown) => void) => {
        if (name === 'settingsChanged') settingsListeners.push(fn);
      }),
    });
    stubs.windowManager.isWindowRemote.mockImplementation(((id: string) => id === REMOTE) as never);
    stubs.windowManager.list.mockReturnValue([
      { id: REMOTE, electronWindowId: 2 },
      { id: 'win-local', electronWindowId: 1 },
    ] as never);
    const forward = vi.fn(
      async (_windowId: string, channel: string, _payload: unknown): Promise<unknown> =>
        channel === COMMAND_CHANNELS.SETTINGS_GET ? { settings: hostSettings } : undefined,
    );
    ipc.installIpcLayer(deps as Parameters<typeof ipc.installIpcLayer>[0]);
    ipc.setLinkCommandForwarder(forward);
    const invoke = (channel: string, payload: unknown): Promise<unknown> =>
      Promise.resolve(handlers.get(channel)!({}, { windowId: REMOTE, requestId: 'r', payload }));
    return { ipc, stubs, update, forward, invoke, settingsListeners };
  }

  it('在远程窗口切主题:写到本机,不转发给 Host', async () => {
    const { update, forward, invoke } = await setup();

    await invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, { partial: { appearance: { theme: 'cutie' } } });

    expect(update).toHaveBeenCalledWith({ appearance: { theme: 'cutie' } });
    expect(forward).not.toHaveBeenCalled();
  });

  it('混合更新:主题留在本机,其余转发给 Host', async () => {
    const { update, forward, invoke } = await setup();

    await invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, {
      partial: { appearance: { theme: 'cutie', terminalFontSize: 14 } },
    });

    expect(update).toHaveBeenCalledWith({ appearance: { theme: 'cutie' } });
    expect(forward).toHaveBeenCalledWith(REMOTE, COMMAND_CHANNELS.SETTINGS_UPDATE, {
      partial: { appearance: { terminalFontSize: 14 } },
    });
  });

  it('不含主题的更新:本机设置不动,整体转发', async () => {
    const { update, forward, invoke } = await setup();
    const partial = { appearance: { terminalFontSize: 14 } };

    await invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, { partial });

    expect(update).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledWith(REMOTE, COMMAND_CHANNELS.SETTINGS_UPDATE, { partial });
  });

  it('读设置:返回 Host 的设置,但主题是本机的', async () => {
    const { invoke } = await setup();

    const res = (await invoke(COMMAND_CHANNELS.SETTINGS_GET, undefined)) as {
      settings: typeof hostSettings;
    };

    expect(res.settings.appearance).toEqual({ theme: 'ceteris-dark', terminalFontSize: 18 });
  });

  it('Host 推来的 settings 事件被覆盖,其它事件原样通过', async () => {
    const { ipc } = await setup();
    const envelope = { eventId: 'e', timestamp: 1, payload: { settings: hostSettings, changedKeys: [] } };

    const result = ipc.applyLocalThemeToLinkEvent('evt:settings:changed', envelope) as typeof envelope;

    expect(result.payload.settings.appearance.theme).toBe('ceteris-dark');
    expect(ipc.applyLocalThemeToLinkEvent('evt:session:output', envelope)).toBe(envelope);
  });

  it('本机切主题:推给远程窗口,不推给本地窗口', async () => {
    const { stubs, settingsListeners } = await setup();

    settingsListeners.forEach((fn) =>
      fn({ settings: { appearance: { theme: 'cutie' } }, changedKeys: ['appearance.theme'] }),
    );
    await vi.waitFor(() => expect(stubs.windowManager.deliverEvent).toHaveBeenCalled());

    expect(stubs.windowManager.deliverEvent).toHaveBeenCalledTimes(1);
    const [windowId, channel, envelope] = stubs.windowManager.deliverEvent.mock.calls[0] as unknown as [
      string,
      string,
      { payload: { settings: typeof hostSettings } },
    ];
    expect(windowId).toBe(REMOTE);
    expect(channel).toBe('evt:settings:changed');
    expect(envelope.payload.settings.appearance).toEqual({ theme: 'cutie', terminalFontSize: 18 });
  });

  it('本机其它设置变化不打扰远程窗口', async () => {
    const { forward, settingsListeners } = await setup();

    settingsListeners.forEach((fn) =>
      fn({ settings: { appearance: { theme: 'cutie' } }, changedKeys: ['behavior.selectOnCopy'] }),
    );

    expect(forward).not.toHaveBeenCalled();
  });
});

describe('IPC 来源检查', () => {
  const channel = COMMAND_CHANNELS.SESSION_CREATE;

  it.each([
    ['外部网页', { senderFrame: { url: 'http://127.0.0.1:18765/link-click' } }],
    ['已销毁的 frame (undefined)', { senderFrame: undefined }],
    ['已销毁的 frame (null)', { senderFrame: null }],
  ])('拒绝%s', async (_name, event) => {
    const { installIpcLayer } = await freshIpc();
    const { createCalls, deps } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);
    await expect(handlers.get(channel)!(event, { payload: {} })).rejects.toThrow(/ForbiddenSender/);
    expect(createCalls).toHaveLength(0);
  });
});

describe('IPC PDF 自动刷新与登录提示', () => {
  function installWith(extra: Record<string, unknown>) {
    return freshIpc().then(({ installIpcLayer }) => {
      const { deps } = makeStubs();
      installIpcLayer({ ...deps, ...extra } as Parameters<typeof installIpcLayer>[0]);
    });
  }

  it('stat-file 查远端时是安静请求:不跳过失败缓存,也不允许弹登录提示', async () => {
    const stat = vi.fn(async () => ({ size: 5, mtimeMs: 1000 }));
    await installWith({ sftpPool: { stat } });
    const res = await handlers.get(COMMAND_CHANNELS.FS_STAT_FILE)!(
      {},
      { windowId: 'w1', requestId: 'r', payload: { path: '/r/a.pdf', sshProfileId: 'ssh-1' } },
    );
    expect(res).toEqual({ ok: true, size: 5, mtimeMs: 1000 });
    expect(stat).toHaveBeenCalledWith('ssh-1', '/r/a.pdf', { windowId: 'w1' });
  });

  it('read-pdf 只有用户点击 (fresh) 才允许弹登录提示,自动重读不允许', async () => {
    const readChunk = vi.fn(async () => ({ chunk: Buffer.from('%PDF-1.4'), size: 8, mtimeMs: 1 }));
    await installWith({ sftpPool: { readChunk } });
    const read = handlers.get(COMMAND_CHANNELS.FS_READ_PDF)!;
    const payload = { path: '/r/a.pdf', sshProfileId: 'ssh-1', offset: 0 };
    await read({}, { windowId: 'w1', requestId: 'r1', payload });
    await read({}, { windowId: 'w1', requestId: 'r2', payload: { ...payload, fresh: true } });
    const options = readChunk.mock.calls.map((call) => (call as unknown[])[4]);
    expect(options[0]).toMatchObject({ windowId: 'w1' });
    expect((options[0] as { interactive?: boolean }).interactive).toBeFalsy();
    expect((options[0] as { fresh?: boolean }).fresh).toBeFalsy();
    expect(options[1]).toMatchObject({ windowId: 'w1', fresh: true, interactive: true });
  });

  it('askpass-answer 拒绝格式不对的答案,不交给 PromptBroker', async () => {
    const answer = vi.fn(() => true);
    await installWith({ promptBroker: { answer } });
    const reply = handlers.get(COMMAND_CHANNELS.SSH_ASKPASS_ANSWER)!;
    const send = (payload: unknown) => reply({}, { windowId: 'w1', requestId: 'r', payload });
    expect(await send({ promptId: 5, answer: 'x' })).toBe(false);
    expect(await send({ promptId: 'id', answer: 7 })).toBe(false);
    expect(answer).not.toHaveBeenCalled();
    expect(await send({ promptId: 'id', answer: null })).toBe(true);
    expect(answer).toHaveBeenCalledWith('id', null);
  });
});

describe('IPC show-in-explorer', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(joinPath(tmpdir(), 'ceteris-explorer-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  async function show(payload: { path: string; open?: boolean }): Promise<void> {
    const { installIpcLayer } = await freshIpc();
    installIpcLayer(makeStubs().deps as Parameters<typeof installIpcLayer>[0]);
    await handlers.get(COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER)!(
      {},
      { windowId: 'w1', requestId: 'r', payload },
    );
  }

  it('open 只打开文件夹本身;文件从不交给 openPath (会运行它),只在父目录里选中', async () => {
    const openPath = vi.spyOn(mockShell, 'openPath');
    const select = vi.spyOn(mockShell, 'showItemInFolder');
    const file = joinPath(dir, 'run.bat');
    await fsp.writeFile(file, 'echo hi');

    await show({ path: dir, open: true });
    expect(openPath).toHaveBeenCalledWith(dir);
    expect(select).not.toHaveBeenCalled();

    await show({ path: file, open: true });
    await show({ path: joinPath(dir, 'missing'), open: true });
    await show({ path: dir });
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(select.mock.calls.map((c) => (c as unknown[])[0])).toEqual([file, joinPath(dir, 'missing'), dir]);
  });

  it('openPath 打不开文件夹时退回选中它', async () => {
    vi.spyOn(mockShell, 'openPath').mockResolvedValueOnce('no handler');
    const select = vi.spyOn(mockShell, 'showItemInFolder');
    await show({ path: dir, open: true });
    expect(select).toHaveBeenCalledWith(dir);
  });
});
