/**
 * @file src/shared/text-file.test.ts
 * @purpose The rules that keep an edited file's other bytes unchanged, and pages clean.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeTextFile,
  decodeTextPage,
  detectTextEncoding,
  encodeBase64,
  encodeTextFile,
  jsonProblem,
  normalizeNewlines,
  pageOffset,
  TEXT_PAGE_BYTES,
} from './text-file';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('decodeTextFile and encodeTextFile', () => {
  it.each([
    ['LF', 'a\nb\n'],
    ['CRLF', 'a\r\nb\r\n'],
    ['Chinese with CRLF', '中文\r\n第二行'],
  ])('gives %s back byte for byte through a textarea', (_name, source) => {
    const bytes = utf8(source);
    const decoded = decodeTextFile(bytes);
    const out = encodeTextFile(normalizeNewlines(decoded.text), decoded);
    expect(out).toEqual(bytes);
  });

  it('keeps a UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    const decoded = decodeTextFile(bytes);
    expect(decoded.text).toBe('a');
    expect(encodeTextFile(decoded.text, decoded)).toEqual(bytes);
  });

  it.each([
    ['GBK', new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), '中文'],
    ['UTF-16', new Uint8Array([0xff, 0xfe, 0x61, 0x00]), 'a'],
    ['UTF-16 big endian', new Uint8Array([0xfe, 0xff, 0x00, 0x61]), 'a'],
  ])('shows %s but refuses to edit it, as saving would change the encoding', (_n, bytes, text) => {
    const decoded = decodeTextFile(bytes);
    expect(decoded.text).toBe(text);
    expect(decoded.editable).toBe(false);
  });

  it('refuses to edit a file holding NUL bytes', () => {
    expect(decodeTextFile(new Uint8Array([0x61, 0x00, 0x62])).editable).toBe(false);
  });
});

describe('detectTextEncoding', () => {
  it('accepts a sample that stops inside a character', () => {
    expect(detectTextEncoding(utf8('中').subarray(0, 2))).toBe('utf-8');
  });
});

describe('decodeTextPage', () => {
  const bytes = utf8('中文字');

  it('drops a character cut by the start of the page', () => {
    expect(decodeTextPage(bytes.subarray(1), 1, 9, 'utf-8')).toBe('文字');
  });

  it('drops a character cut by the end of the page', () => {
    expect(decodeTextPage(bytes.subarray(0, 7), 0, 9, 'utf-8')).toBe('中文');
  });

  it('keeps a complete character at the end of the page', () => {
    expect(decodeTextPage(bytes.subarray(0, 6), 0, 9, 'utf-8')).toBe('中文');
  });

  it('keeps a 4 byte character cut after 3 bytes out of the page', () => {
    expect(decodeTextPage(utf8('a😀').subarray(0, 4), 0, 5, 'utf-8')).toBe('a');
  });

  it('keeps a complete 4 byte character at the end of the page', () => {
    expect(decodeTextPage(utf8('a😀b').subarray(0, 5), 0, 6, 'utf-8')).toBe('a😀');
  });

  it('drops all three trailing bytes of a 4 byte character cut by the start of the page', () => {
    expect(decodeTextPage(utf8('😀b').subarray(1), 1, 5, 'utf-8')).toBe('b');
  });

  it('does not trim the end of the file', () => {
    expect(decodeTextPage(utf8('a').subarray(0, 1), 0, 1, 'utf-8')).toBe('a');
  });
});

describe('pageOffset', () => {
  it('rounds down to a page and stays inside the file', () => {
    expect(pageOffset(TEXT_PAGE_BYTES + 5, TEXT_PAGE_BYTES * 3)).toBe(TEXT_PAGE_BYTES);
    expect(pageOffset(TEXT_PAGE_BYTES * 9, TEXT_PAGE_BYTES * 3)).toBe(TEXT_PAGE_BYTES * 2);
    expect(pageOffset(-1, TEXT_PAGE_BYTES * 3)).toBe(0);
  });

  it('gives a file of whole pages no empty page after its end', () => {
    expect(pageOffset(TEXT_PAGE_BYTES * 2, TEXT_PAGE_BYTES * 2)).toBe(TEXT_PAGE_BYTES);
    expect(pageOffset(0, 0)).toBe(0);
  });
});

describe('jsonProblem', () => {
  it('reports broken JSON and passes valid or empty text', () => {
    expect(jsonProblem('{"a":1}')).toBeNull();
    expect(jsonProblem('  ')).toBeNull();
    expect(jsonProblem('{"a":')).toEqual(expect.any(String));
  });
});

describe('encodeBase64', () => {
  it('matches Buffer on sizes past its internal block', () => {
    const bytes = new Uint8Array(0x8000 + 7).map((_v, i) => i % 251);
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});
