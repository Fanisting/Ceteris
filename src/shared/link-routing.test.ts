/**
 * @file src/shared/link-routing.test.ts
 * @purpose 守护 Marina Link 的命令路由表。
 *
 * @为什么这个测试重要:
 * LINK_LOCAL_ONLY_CHANNELS 里存的是 channel 字符串字面量,而不是
 * COMMAND_CHANNELS 常量引用(link-protocol.ts 是协议定义层,不宜反向依赖
 * protocol.ts)。字面量的风险是显而易见的:有人重命名了某个 channel,
 * 这张表静默失配,而**失配的后果是静默且危险的**。
 *
 * 具体后果举两个:
 * - 'cmd:app:quit' 若失配 → 远程用户点"退出",命令被转发到 Host,
 *   把 Host 上跑着的所有 agent 全杀掉。
 * - 'cmd:system:clipboard-write-text' 若失配 → 用户复制的内容被写进
 *   Host 的剪贴板,自己面前这台机器什么都没有。
 *
 * 所以这里断言表里每一项都真实存在于 COMMAND_CHANNELS,并且反过来断言
 * 那些**必须**本地执行的命令确实在表里。
 */
import { describe, expect, it } from 'vitest';
import { COMMAND_CHANNELS } from './protocol';
import { LINK_LOCAL_ONLY_CHANNELS, shouldForwardToHost } from './link-protocol';

const ALL_COMMAND_CHANNELS = new Set<string>(Object.values(COMMAND_CHANNELS));

describe('LINK_LOCAL_ONLY_CHANNELS 与 COMMAND_CHANNELS 的一致性', () => {
  it('表里每一项都是真实存在的 channel(防止改名后静默失配)', () => {
    const orphans = [...LINK_LOCAL_ONLY_CHANNELS].filter((c) => !ALL_COMMAND_CHANNELS.has(c));
    expect(orphans).toEqual([]);
  });

  it('表里没有重复项', () => {
    expect(LINK_LOCAL_ONLY_CHANNELS.size).toBe([...LINK_LOCAL_ONLY_CHANNELS].length);
  });
});

describe('必须本地执行的命令', () => {
  /**
   * 这些命令一旦被转发出去就会造成实际损害,逐条断言。
   * 每条后面的注释说明"转发了会发生什么"。
   */
  const mustBeLocal: Array<[string, string]> = [
    [COMMAND_CHANNELS.APP_QUIT, '会杀掉 Host 上所有正在跑的 agent'],
    [COMMAND_CHANNELS.WINDOW_CLOSE_SELF, '会关掉 Host 上的窗口而不是本地远程窗口'],
    [COMMAND_CHANNELS.WINDOW_CLOSE_ALL, '会关掉 Host 上所有窗口'],
    [COMMAND_CHANNELS.WINDOW_MINIMIZE, '会最小化 Host 的窗口,本地窗口无反应'],
    [COMMAND_CHANNELS.WINDOW_TOGGLE_MAXIMIZE, '同上'],
    [COMMAND_CHANNELS.WINDOW_GET_MAX_STATE, '会返回 Host 窗口的状态,本地按钮图标错乱'],
    [COMMAND_CHANNELS.WINDOW_CREATE, '会在 Host 屏幕上开窗,用户看不到'],
    [COMMAND_CHANNELS.SYSTEM_CLIPBOARD_WRITE_TEXT, '复制的内容会写进 Host 的剪贴板,本机粘贴不到'],
    [
      COMMAND_CHANNELS.SYSTEM_CLIPBOARD_READ_TEXT,
      '粘贴时读的是 Host 的剪贴板,不是用户刚复制的内容',
    ],
    [COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL, '链接会在 Host 的浏览器里打开,用户看不到'],
    [COMMAND_CHANNELS.APP_GET_PROTOCOL_VERSION, '握手必须在本地完成'],
  ];

  it.each(mustBeLocal)('%s 不转发(否则:%s)', (channel) => {
    expect(shouldForwardToHost(channel)).toBe(false);
  });
});

describe('必须转发到 Host 的命令', () => {
  /**
   * 这些命令操作的是 Host 侧的数据。留在本地执行的话,本机根本没有对应的
   * session / path,表现为"点了没反应"或"报 SessionNotFound"。
   */
  const mustForward: string[] = [
    COMMAND_CHANNELS.APP_GET_SNAPSHOT,
    COMMAND_CHANNELS.SESSION_CREATE,
    COMMAND_CHANNELS.SESSION_CLOSE,
    COMMAND_CHANNELS.SESSION_CLAIM,
    COMMAND_CHANNELS.SESSION_RELEASE,
    COMMAND_CHANNELS.SESSION_SEND_INPUT,
    COMMAND_CHANNELS.SESSION_RESIZE,
    COMMAND_CHANNELS.SESSION_GET_SCROLLBACK,
    COMMAND_CHANNELS.SESSION_RENAME,
    COMMAND_CHANNELS.BOOKMARK_ADD,
    COMMAND_CHANNELS.BOOKMARK_REMOVE,
    COMMAND_CHANNELS.PATH_REMOVE_FROM_RECENT,
    COMMAND_CHANNELS.TEMPLATE_ADD,
    COMMAND_CHANNELS.SETTINGS_GET,
    COMMAND_CHANNELS.SETTINGS_UPDATE,
    COMMAND_CHANNELS.SSH_PROFILE_LIST,
    // 文件树的路径是 Host 的路径。若在 Client 本地执行,可能改到本机同路径的文件。
    COMMAND_CHANNELS.FS_LIST_DIR,
    COMMAND_CHANNELS.FS_RENAME,
    COMMAND_CHANNELS.FS_READ_PDF,
  ];

  it.each(mustForward)('%s 会被转发', (channel) => {
    expect(shouldForwardToHost(channel)).toBe(true);
  });
});

describe('Link 自身的管理命令', () => {
  /**
   * cmd:link:* 全部本地执行。在远程窗口里点"断开",断的必须是本机这条连接;
   * 转发给 Host 会变成"让 Host 断开它自己的某条连接",语义完全错误 ——
   * 而且用户会发现按钮点了以后自己这条连接还在。
   */
  const linkChannels = [
    COMMAND_CHANNELS.LINK_GET_STATUS,
    COMMAND_CHANNELS.LINK_REGENERATE_TOKEN,
    COMMAND_CHANNELS.LINK_CONNECT,
    COMMAND_CHANNELS.LINK_DISCONNECT,
    COMMAND_CHANNELS.LINK_KICK_CLIENT,
    COMMAND_CHANNELS.LINK_LIST_BIND_CANDIDATES,
  ];

  it.each(linkChannels)('%s 不转发', (channel) => {
    expect(shouldForwardToHost(channel)).toBe(false);
  });
});

describe('默认行为', () => {
  it('未知 channel 默认转发(新增命令时默认是安全的一侧)', () => {
    // 这条断言锁定了一个刻意的设计决定:白名单是"本地执行",不在名单里的
    // 一律转发。原因是新增的业务命令几乎总是操作 Host 数据的;若默认本地
    // 执行,新命令会在远程窗口里静默地对错误的机器生效。
    expect(shouldForwardToHost('cmd:future:not-yet-invented')).toBe(true);
  });

  it('channel 名区分大小写,不做模糊匹配', () => {
    expect(shouldForwardToHost('CMD:APP:QUIT')).toBe(true);
  });
});
