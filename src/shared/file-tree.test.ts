/**
 * @file src/shared/file-tree.test.ts
 * @purpose 覆盖文件树纯逻辑:文件名校验、根目录推导、慢速双击判定、行展开、路径修正、
 *   自动刷新的文件变化判断。
 */
import { describe, expect, it } from 'vitest';
import {
  SLOW_CLICK_MAX_MS,
  SLOW_CLICK_MIN_MS,
  classifyRowClick,
  flattenVisibleRows,
  isValidEntryName,
  remapPath,
  resolveFileTreeRoot,
  sameFileStat,
  sortEntries,
  type FileTreeEntry,
} from './file-tree';

const file = (name: string, dir = 'C:\\p'): FileTreeEntry => ({
  name,
  path: `${dir}\\${name}`,
  isDirectory: false,
});
const folder = (name: string, dir = 'C:\\p'): FileTreeEntry => ({ ...file(name, dir), isDirectory: true });

describe('sortEntries', () => {
  it('文件夹在前,数字按自然顺序,且不修改入参', () => {
    const input = [file('b10.txt'), folder('zeta'), file('b2.txt'), folder('Alpha')];
    expect(sortEntries(input).map((e) => e.name)).toEqual(['Alpha', 'zeta', 'b2.txt', 'b10.txt']);
    expect(input[0]?.name).toBe('b10.txt');
  });
});

describe('isValidEntryName', () => {
  it.each(['a.txt', '.gitignore', 'name with space.md', '中文.md', 'console.log', 'a'.repeat(255)])(
    '接受 %s',
    (name) => {
      expect(isValidEntryName(name)).toBe(true);
    },
  );

  it.each([
    '',
    '.',
    '..',
    '../escape',
    '..\\escape',
    'a/b',
    'a\\b',
    'a:b',
    'a*b',
    'a?b',
    'a"b',
    'a<b',
    'a|b',
    'tab\tname',
    'trailing.',
    'trailing ',
    ' leading',
    'CON',
    'nul.txt',
    'Lpt1',
    'a'.repeat(256),
  ])('拒绝 %j', (name) => {
    expect(isValidEntryName(name)).toBe(false);
  });
});

describe('resolveFileTreeRoot', () => {
  const local = { kind: 'local' } as const;

  it('跟随 cd 后的 currentCwd', () => {
    expect(
      resolveFileTreeRoot({ currentCwd: 'C:\\p\\src', originalCwd: 'C:\\p' }, local),
    ).toBe('C:\\p\\src');
  });

  it('SSH session 用上报的绝对路径', () => {
    expect(
      resolveFileTreeRoot({ currentCwd: '/home/x', originalCwd: '~' }, { kind: 'ssh' }),
    ).toBe('/home/x');
  });

  it('SSH 的 cwd 被解析成盘符路径时退回远程路径', () => {
    expect(
      resolveFileTreeRoot({ currentCwd: 'C:\\home\\x', originalCwd: '~/p' }, { kind: 'ssh' }),
    ).toBe('~/p');
  });

  it('SSH 没有 cwd 时从 home 开始', () => {
    expect(resolveFileTreeRoot({ currentCwd: '', originalCwd: '' }, { kind: 'ssh' })).toBe('~');
  });

  it('没有 session 或 path 时返回 null', () => {
    expect(resolveFileTreeRoot(null, local)).toBeNull();
    expect(resolveFileTreeRoot({ currentCwd: 'C:\\p', originalCwd: 'C:\\p' }, null)).toBeNull();
  });

  it('WSL 的 cwd 被解析成错误盘符路径时退回 UNC 的 originalCwd', () => {
    const originalCwd = '\\\\wsl$\\Ubuntu\\home\\x';
    expect(resolveFileTreeRoot({ currentCwd: 'C:\\home\\x', originalCwd }, local)).toBe(originalCwd);
  });

  it('WSL 内切到另一个 UNC 目录时跟随', () => {
    const originalCwd = '\\\\wsl$\\Ubuntu\\home\\x';
    const currentCwd = '\\\\wsl$\\Ubuntu\\home\\x\\src';
    expect(resolveFileTreeRoot({ currentCwd, originalCwd }, local)).toBe(currentCwd);
  });

  it('从盘符路径切到网络共享时跟随,不停留在旧目录', () => {
    const currentCwd = '\\\\nas\\share';
    expect(resolveFileTreeRoot({ currentCwd, originalCwd: 'C:\\p' }, local)).toBe(currentCwd);
  });

  it('currentCwd 为空时用 originalCwd', () => {
    expect(resolveFileTreeRoot({ currentCwd: '', originalCwd: 'C:\\p' }, local)).toBe('C:\\p');
  });
});

describe('flattenVisibleRows: 防御远端数据', () => {
  it('条目路径等于父目录时不会无限递归', () => {
    const loop: FileTreeEntry = { name: '', path: '/x', isDirectory: true };
    const rows = flattenVisibleRows('/x', new Map([['/x', [loop]]]), new Set(['/x']));
    expect(rows).toHaveLength(1);
  });
});

describe('classifyRowClick', () => {
  const last = { path: 'a', at: 1000 };

  it('首次点击或换行点击是普通点击', () => {
    expect(classifyRowClick(null, 'a', 1000, true)).toBe('activate');
    expect(classifyRowClick(last, 'b', 1800, true)).toBe('activate');
  });

  it('快速双击的第二下被忽略,不重命名', () => {
    expect(classifyRowClick(last, 'a', 1000 + SLOW_CLICK_MIN_MS - 1, true)).toBe('ignore');
  });

  it('窗口两端都算慢速双击', () => {
    expect(classifyRowClick(last, 'a', 1000 + SLOW_CLICK_MIN_MS, true)).toBe('rename');
    expect(classifyRowClick(last, 'a', 1000 + SLOW_CLICK_MAX_MS, true)).toBe('rename');
  });

  it('超出窗口或没点在文件名上时只是普通点击', () => {
    expect(classifyRowClick(last, 'a', 1000 + SLOW_CLICK_MAX_MS + 1, true)).toBe('activate');
    expect(classifyRowClick(last, 'a', 1000 + SLOW_CLICK_MIN_MS, false)).toBe('activate');
  });
});

describe('flattenVisibleRows', () => {
  const src = folder('src');
  const entries = new Map<string, FileTreeEntry[]>([
    ['C:\\p', [src, file('a.txt')]],
    [src.path, [file('b.ts', src.path)]],
  ]);

  it('折叠的文件夹不显示子项', () => {
    expect(flattenVisibleRows('C:\\p', entries, new Set()).map((r) => r.entry.name)).toEqual([
      'src',
      'a.txt',
    ]);
  });

  it('展开的文件夹显示子项并增加深度', () => {
    const rows = flattenVisibleRows('C:\\p', entries, new Set([src.path]));
    expect(rows.map((r) => [r.entry.name, r.depth])).toEqual([
      ['src', 0],
      ['b.ts', 1],
      ['a.txt', 0],
    ]);
    expect(rows[1]?.parentPath).toBe(src.path);
  });

  it('已展开但尚未加载的文件夹不报错', () => {
    expect(flattenVisibleRows('C:\\missing', entries, new Set())).toEqual([]);
  });
});

describe('remapPath', () => {
  it('替换自身和子路径,支持两种分隔符', () => {
    expect(remapPath('C:\\p\\old', 'C:\\p\\old', 'C:\\p\\new')).toBe('C:\\p\\new');
    expect(remapPath('C:\\p\\old\\x', 'C:\\p\\old', 'C:\\p\\new')).toBe('C:\\p\\new\\x');
    expect(remapPath('/p/old/x', '/p/old', '/p/new')).toBe('/p/new/x');
  });

  it('不误伤前缀相同的兄弟目录', () => {
    expect(remapPath('C:\\p\\older', 'C:\\p\\old', 'C:\\p\\new')).toBe('C:\\p\\older');
  });
});

describe('sameFileStat', () => {
  it('大小或修改时间任一变化都算变了:重编出来的 PDF 常常一样大', () => {
    const before = { size: 100, mtimeMs: 1000 };
    expect(sameFileStat(before, { size: 100, mtimeMs: 1000 })).toBe(true);
    expect(sameFileStat(before, { size: 100, mtimeMs: 2000 })).toBe(false);
    expect(sameFileStat(before, { size: 101, mtimeMs: 1000 })).toBe(false);
  });

  it('服务器不给修改时间时只看大小;没有基线时只和没有基线相同', () => {
    expect(sameFileStat({ size: 100, mtimeMs: null }, { size: 100, mtimeMs: null })).toBe(true);
    expect(sameFileStat({ size: 100, mtimeMs: null }, { size: 99, mtimeMs: null })).toBe(false);
    expect(sameFileStat({ size: 100, mtimeMs: 1000 }, { size: 100, mtimeMs: null })).toBe(false);
    expect(sameFileStat(null, { size: 100, mtimeMs: 1000 })).toBe(false);
    expect(sameFileStat(null, null)).toBe(true);
  });
});
