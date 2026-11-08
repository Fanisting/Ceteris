/**
 * @file src/main/pdf-reader.test.ts
 * @purpose 测试 PDF 分块读取和校验,文件都在系统临时目录里。
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDF_MAX_BYTES } from '@shared/file-tree';
import {
  PDF_CHUNK_BYTES,
  readPdfChunk,
  readRemotePdfChunk,
  statRemoteViewFile,
  statViewFile,
} from './pdf-reader';
import { SftpError, SftpPathError } from './sftp-client';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'ceteris-test-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writePdf(name: string, size: number): Promise<string> {
  const path = join(dir, name);
  const content = Buffer.alloc(size, 0x41);
  content.write('%PDF-1.4');
  await fs.writeFile(path, content);
  return path;
}

describe('readPdfChunk', () => {
  it('小文件一块读完,带上修改时间给自动刷新做基线', async () => {
    const path = await writePdf('a.pdf', 100);
    const res = await readPdfChunk(path, 0);
    expect(res).toMatchObject({ ok: true, size: 100, nextOffset: null });
    expect(res.ok && Buffer.from(res.base64, 'base64').length).toBe(100);
    expect(res.ok && res.mtimeMs).toBe((await fs.stat(path)).mtimeMs);
  });

  it('大文件分块,拼起来与原文件一致', async () => {
    const size = PDF_CHUNK_BYTES + 1234;
    const path = await writePdf('b.pdf', size);
    const parts: Buffer[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const res = await readPdfChunk(path, offset);
      if (!res.ok) throw new Error(res.reason);
      parts.push(Buffer.from(res.base64, 'base64'));
      offset = res.nextOffset;
    }
    expect(parts).toHaveLength(2);
    expect(Buffer.concat(parts).equals(await fs.readFile(path))).toBe(true);
  });

  it('单块的 base64 放得进 Link 的 8 MiB 帧', () => {
    expect((PDF_CHUNK_BYTES / 3) * 4).toBeLessThan(8 * 1024 * 1024 - 64 * 1024);
  });

  it('非零偏移也校验文件头,不能绕过', async () => {
    const path = join(dir, 'fake.pdf');
    await fs.writeFile(path, Buffer.alloc(2000, 0x41));
    expect(await readPdfChunk(path, 1)).toEqual({ ok: false, reason: 'not-pdf' });
  });

  it('目录不能当文件读', async () => {
    const path = join(dir, 'folder.pdf');
    await fs.mkdir(path);
    const res = await readPdfChunk(path, 0);
    expect(res.ok).toBe(false);
  });

  it('扩展名是 pdf 但内容不是时拒绝', async () => {
    const path = join(dir, 'fake.pdf');
    await fs.writeFile(path, 'secret');
    expect(await readPdfChunk(path, 0)).toEqual({ ok: false, reason: 'not-pdf' });
  });

  it('不是 pdf 扩展名时拒绝,这条命令不能读任意文件', async () => {
    const path = join(dir, 'id_rsa');
    await fs.writeFile(path, '%PDF-1.4 secret');
    expect(await readPdfChunk(path, 0)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('相对路径和错误偏移被拒绝', async () => {
    const path = await writePdf('c.pdf', 10);
    expect(await readPdfChunk('c.pdf', 0)).toEqual({ ok: false, reason: 'not-found' });
    expect(await readPdfChunk(path, -1)).toEqual({ ok: false, reason: 'not-found' });
    expect(await readPdfChunk(path, 1.5)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('文件不存在', async () => {
    expect(await readPdfChunk(join(dir, 'no.pdf'), 0)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('超过上限时拒绝', async () => {
    const path = join(dir, 'big.pdf');
    const handle = await fs.open(path, 'w');
    await handle.truncate(PDF_MAX_BYTES + 1);
    await handle.close();
    expect(await readPdfChunk(path, 0)).toEqual({ ok: false, reason: 'too-large' });
  });
});

describe('text files', () => {
  it('ignores the 256 MiB limit and reads only what was asked', async () => {
    const path = join(dir, 'huge.txt');
    const file = await fs.open(path, 'w');
    await file.truncate(PDF_MAX_BYTES + 1024 * 1024);
    await file.close();
    const res = await readPdfChunk(path, PDF_MAX_BYTES, 4096);
    expect(res).toMatchObject({ ok: true, size: PDF_MAX_BYTES + 1024 * 1024 });
    expect(res.ok && Buffer.from(res.base64, 'base64').length).toBe(4096);
  });

  it('reports the modified time a save must quote', async () => {
    const path = join(dir, 'a.json');
    await fs.writeFile(path, '{}');
    const { mtimeMs } = await fs.stat(path);
    expect(await readPdfChunk(path, 0)).toMatchObject({ ok: true, mtimeMs });
  });

  it('never reads more than one chunk, whatever length is asked for', async () => {
    const path = join(dir, 'a.txt');
    await fs.writeFile(path, Buffer.alloc(PDF_CHUNK_BYTES + 10));
    const res = await readPdfChunk(path, 0, PDF_CHUNK_BYTES * 4);
    expect(res.ok && Buffer.from(res.base64, 'base64').length).toBe(PDF_CHUNK_BYTES);
  });
});

describe('readRemotePdfChunk', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(92)]);

  it('返回内容、下一块偏移和修改时间', async () => {
    const pool = {
      readChunk: vi.fn().mockResolvedValue({ chunk: pdf, size: 1000, mtimeMs: 5000 }),
    };
    const res = await readRemotePdfChunk(pool, 'p', '/r/a.pdf', 0);
    expect(res).toMatchObject({ ok: true, size: 1000, nextOffset: 100, mtimeMs: 5000 });
    expect(pool.readChunk).toHaveBeenCalledWith('p', '/r/a.pdf', 0, PDF_CHUNK_BYTES, {
      maxSize: PDF_MAX_BYTES,
    });
  });

  it('只有调用方说是用户点击时才传 fresh 和 interactive:自动刷新必须安静', async () => {
    const pool = {
      readChunk: vi.fn().mockResolvedValue({ chunk: pdf, size: 100, mtimeMs: null }),
    };
    await readRemotePdfChunk(pool, 'p', '/r/a.pdf', 0, {
      fresh: true,
      interactive: true,
      windowId: 'w1',
    });
    expect(pool.readChunk).toHaveBeenLastCalledWith('p', '/r/a.pdf', 0, PDF_CHUNK_BYTES, {
      fresh: true,
      interactive: true,
      windowId: 'w1',
      maxSize: PDF_MAX_BYTES,
    });
    await readRemotePdfChunk(pool, 'p', '/r/a.pdf', 0);
    expect(pool.readChunk.mock.lastCall?.[4]).toEqual({ maxSize: PDF_MAX_BYTES });
  });

  it('读到末尾时 nextOffset 为 null', async () => {
    const pool = { readChunk: vi.fn().mockResolvedValue({ chunk: pdf, size: 100 }) };
    expect(await readRemotePdfChunk(pool, 'p', '/r/a.pdf', 0)).toMatchObject({ nextOffset: null });
  });

  it('后续块也校验文件头', async () => {
    const pool = {
      readChunk: vi
        .fn()
        .mockResolvedValueOnce({ chunk: Buffer.alloc(10), size: 110 })
        .mockResolvedValueOnce({ chunk: Buffer.from('not a pdf'), size: 110 }),
    };
    expect(await readRemotePdfChunk(pool, 'p', '/r/a.pdf', 100)).toEqual({
      ok: false,
      reason: 'not-pdf',
    });
  });

  it('后续块文件头正确时返回内容', async () => {
    const pool = {
      readChunk: vi
        .fn()
        .mockResolvedValueOnce({ chunk: Buffer.alloc(10), size: 110 })
        .mockResolvedValueOnce({ chunk: pdf, size: 110 }),
    };
    expect(await readRemotePdfChunk(pool, 'p', '/r/a.pdf', 100)).toMatchObject({
      ok: true,
      nextOffset: null,
    });
  });

  it('文件被截短时报错,不把残缺的 PDF 当成读完', async () => {
    const pool = {
      readChunk: vi
        .fn()
        .mockResolvedValueOnce({ chunk: Buffer.alloc(0), size: 500 })
        .mockResolvedValueOnce({ chunk: pdf, size: 500 }),
    };
    expect(await readRemotePdfChunk(pool, 'p', '/r/a.pdf', 100)).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('内容不是 PDF 时拒绝', async () => {
    const pool = { readChunk: vi.fn().mockResolvedValue({ chunk: Buffer.from('html'), size: 4 }) };
    expect(await readRemotePdfChunk(pool, 'p', '/r/a.pdf', 0)).toEqual({
      ok: false,
      reason: 'not-pdf',
    });
  });

  it('text pages have no size limit, no header read and no modified time', async () => {
    const chunk = Buffer.from('page');
    const readChunk = vi.fn().mockResolvedValue({ chunk, size: PDF_MAX_BYTES * 2 });
    const res = await readRemotePdfChunk({ readChunk }, 'p', '/r/huge.json', 4096, {
      length: 1024,
    });
    expect(res).toEqual({
      ok: true,
      base64: chunk.toString('base64'),
      size: PDF_MAX_BYTES * 2,
      nextOffset: 4100,
    });
    expect(readChunk).toHaveBeenCalledTimes(1);
    expect(readChunk).toHaveBeenCalledWith('p', '/r/huge.json', 4096, 1024, {});
  });

  it('超过上限时拒绝', async () => {
    const pool = {
      readChunk: vi.fn().mockResolvedValue({ chunk: pdf, size: PDF_MAX_BYTES + 1 }),
    };
    expect(await readRemotePdfChunk(pool, 'p', '/r/a.pdf', 0)).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it('把连接和路径失败转成 reason', async () => {
    const auth = { readChunk: vi.fn().mockRejectedValue(new SftpError('auth', 'x')) };
    expect(await readRemotePdfChunk(auth, 'p', '/r/a.pdf', 0)).toEqual({
      ok: false,
      reason: 'auth',
    });
    const missing = { readChunk: vi.fn().mockRejectedValue(new SftpPathError('not-found')) };
    expect(await readRemotePdfChunk(missing, 'p', '/r/a.pdf', 0)).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('不是 pdf 扩展名时不发起请求', async () => {
    const pool = { readChunk: vi.fn() };
    expect(await readRemotePdfChunk(pool, 'p', '/etc/passwd', 0)).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(pool.readChunk).not.toHaveBeenCalled();
  });
});

describe('statViewFile', () => {
  it('返回普通文件的大小和修改时间', async () => {
    const path = await writePdf('a.pdf', 321);
    const stat = await fs.stat(path);
    expect(await statViewFile(path)).toEqual({ ok: true, size: 321, mtimeMs: stat.mtimeMs });
  });

  it('目录、相对路径和不可查看的扩展名都报 not-found,不能用来探测任意文件', async () => {
    const folder = join(dir, 'folder.pdf');
    await fs.mkdir(folder);
    expect(await statViewFile(folder)).toEqual({ ok: false, reason: 'not-found' });
    expect(await statViewFile('a.pdf')).toEqual({ ok: false, reason: 'not-found' });
    const secret = join(dir, 'id_rsa');
    await fs.writeFile(secret, 'x');
    expect(await statViewFile(secret)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('文件不存在', async () => {
    expect(await statViewFile(join(dir, 'no.pdf'))).toEqual({ ok: false, reason: 'not-found' });
  });

  it('超过上限时报 too-large', async () => {
    const path = join(dir, 'big.pdf');
    const handle = await fs.open(path, 'w');
    await handle.truncate(PDF_MAX_BYTES + 1);
    await handle.close();
    expect(await statViewFile(path)).toEqual({ ok: false, reason: 'too-large' });
  });
});

describe('statRemoteViewFile', () => {
  it('返回大小和修改时间,不传 fresh 或 interactive', async () => {
    const pool = { stat: vi.fn().mockResolvedValue({ size: 10, mtimeMs: 1000 }) };
    expect(await statRemoteViewFile(pool, 'p', '/r/a.pdf', { windowId: 'w1' })).toEqual({
      ok: true,
      size: 10,
      mtimeMs: 1000,
    });
    expect(pool.stat).toHaveBeenCalledWith('p', '/r/a.pdf', { windowId: 'w1' });
  });

  it('服务器不给修改时间时为 null', async () => {
    const pool = { stat: vi.fn().mockResolvedValue({ size: 10, mtimeMs: null }) };
    expect(await statRemoteViewFile(pool, 'p', '/r/a.pdf')).toEqual({
      ok: true,
      size: 10,
      mtimeMs: null,
    });
  });

  it('把连接和路径失败转成 reason', async () => {
    const gone = { stat: vi.fn().mockRejectedValue(new SftpPathError('not-found')) };
    expect(await statRemoteViewFile(gone, 'p', '/r/a.pdf')).toEqual({
      ok: false,
      reason: 'not-found',
    });
    const login = { stat: vi.fn().mockRejectedValue(new SftpError('login-required', 'x')) };
    expect(await statRemoteViewFile(login, 'p', '/r/a.pdf')).toEqual({
      ok: false,
      reason: 'login-required',
    });
  });

  it('不可查看的扩展名不发起请求', async () => {
    const pool = { stat: vi.fn() };
    expect(await statRemoteViewFile(pool, 'p', '/etc/passwd')).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(pool.stat).not.toHaveBeenCalled();
  });
});
