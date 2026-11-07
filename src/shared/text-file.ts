/**
 * @file src/shared/text-file.ts
 * @purpose Pure rules for showing and saving .txt and .json files: which bytes are safe to
 *   edit, how to give them back unchanged apart from the user's edits, and how to decode one
 *   page of a file too large to load.
 *
 * @关键设计:
 * - Only UTF-8 is editable. Saving always encodes UTF-8, so editing a GBK or UTF-16 file would
 *   rewrite every byte of it. Those files open read-only rather than being silently converted.
 * - A textarea turns CRLF into LF, so the line ending and BOM are kept here and restored on
 *   save. Without this, changing one word would rewrite every line ending in the file.
 * - Pages of a large file start at round byte offsets, which can land inside a character.
 *   decodeTextPage drops those partial bytes, so a page never shows a replacement character.
 *
 * @对应文档章节: 软件定义书.md 14.6, ADR-016
 *
 * @不要在这里做的事:
 * - 不要碰 fs 或 DOM,main 和 renderer 都用这个文件
 */

/** Files up to this size load whole and can be edited. Larger ones open as read-only pages. */
export const TEXT_EDIT_MAX_BYTES = 2 * 1024 * 1024;
/** One page of a large file. Small enough to render at once and to cross a slow Link. */
export const TEXT_PAGE_BYTES = 256 * 1024;
/** The largest save. Edits can grow a file, and one save must fit one 8 MiB Link frame. */
export const TEXT_WRITE_MAX_BYTES = 4 * 1024 * 1024;

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';

export interface DecodedText {
  text: string;
  encoding: TextEncodingName;
  bom: boolean;
  eol: '\n' | '\r\n';
  /** False when saving could not give the same bytes back. */
  editable: boolean;
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/**
 * Works out a file's encoding from its opening bytes.
 *
 * @param bytes the start of the file, which may end inside a character
 */
export function detectTextEncoding(bytes: Uint8Array): TextEncodingName {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  try {
    // stream: a sample can stop inside a character, which is not an error.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return 'utf-8';
  } catch {
    // Plain text on a Chinese Windows machine that is not UTF-8 is nearly always GBK,
    // and gb18030 is a superset of it.
    return 'gb18030';
  }
}

/** Decodes a whole file and records how to write it back. */
export function decodeTextFile(bytes: Uint8Array): DecodedText {
  const encoding = detectTextEncoding(bytes);
  const text = new TextDecoder(encoding).decode(bytes);
  return {
    text,
    encoding,
    bom: encoding === 'utf-8' && hasUtf8Bom(bytes),
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    // A NUL means this is not really text, whatever its name says.
    editable: encoding === 'utf-8' && !text.includes('\u0000'),
  };
}

/**
 * Encodes editor text for saving.
 *
 * @param value the textarea's value, whose line endings are always LF
 */
export function encodeTextFile(value: string, format: Pick<DecodedText, 'bom' | 'eol'>): Uint8Array {
  const text = format.eol === '\n' ? value : value.replace(/\r?\n/g, format.eol);
  const body = new TextEncoder().encode(text);
  if (!format.bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

/** What a textarea would report for this text. Compared with its value to detect edits. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** The length of the buffer without a UTF-8 character cut off by its end. */
function completeUtf8Length(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back += 1) {
    const byte = bytes[bytes.length - back] as number;
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

/**
 * Decodes one page of a large file.
 *
 * @param bytes the page
 * @param offset where the page starts in the file
 * @param size the file's total size
 */
export function decodeTextPage(
  bytes: Uint8Array,
  offset: number,
  size: number,
  encoding: TextEncodingName,
): string {
  if (encoding !== 'utf-8') return new TextDecoder(encoding).decode(bytes);
  let start = 0;
  if (offset > 0) {
    while (start < Math.min(3, bytes.length) && ((bytes[start] as number) & 0xc0) === 0x80) {
      start += 1;
    }
  }
  const end = offset + bytes.length < size ? completeUtf8Length(bytes) : bytes.length;
  return new TextDecoder('utf-8').decode(bytes.subarray(start, end));
}

/** The offset of the page that holds this byte. */
export function pageOffset(position: number, size: number): number {
  const last = Math.max(0, Math.ceil(size / TEXT_PAGE_BYTES) - 1);
  const page = Math.floor(Math.max(0, position) / TEXT_PAGE_BYTES);
  return Math.min(page, last) * TEXT_PAGE_BYTES;
}

/** Null when the text is valid JSON, otherwise the parser's message. */
export function jsonProblem(text: string): string | null {
  if (text.trim() === '') return null;
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid JSON';
  }
}

/** Base64 for the save command. Binary must be built first: btoa cannot be run on parts. */
export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  }
  return btoa(parts.join(''));
}
