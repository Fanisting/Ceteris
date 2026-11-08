/**
 * @file placeholder-filter.ts
 * @purpose Turns the placeholder cells that Claude Code writes under an inline image into blank cells.
 *
 * @关键设计:
 * - Claude Code's iTerm2 image route fills every cell of an image box with U+2800 (BRAILLE PATTERN
 *   BLANK) followed by combining marks that encode the image id, row and column. It then draws the
 *   picture over the box. A font without braille glyphs draws U+2800 as a box, and the marks stack
 *   above it, so the edges of the box and the row above it show glyphs.
 * - Every U+2800 becomes a space (both are one cell wide and blank in a font that has braille), and
 *   the combining marks (\p{Mn}) right after it are dropped. Other braille patterns and combining
 *   marks after any other character pass untouched.
 * - One filter per session, fed the passthrough bytes after Osc1337Parser. It keeps at most 3 bytes
 *   of an unfinished UTF-8 sequence between chunks, and remembers whether the last chunk ended
 *   inside a placeholder.
 *
 * @不要在这里做的事:
 * - Do not parse escape sequences here: osc1337-parser.ts owns OSC handling. Base64 image data is
 *   ASCII and never contains the bytes this filter looks for.
 */

/** UTF-8 for U+2800. */
const BRAILLE_BLANK = [0xe2, 0xa0, 0x80] as const;
const SPACE = 0x20;
const NONSPACING_MARK = /^\p{Mn}$/u;

/** Bytes in the UTF-8 sequence that starts with `lead`; 1 for ASCII and for a stray byte. */
function sequenceLength(lead: number): number {
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

export class PlaceholderFilter {
  /** The start of a UTF-8 sequence that the last chunk cut off. */
  private stash: Buffer = Buffer.alloc(0);
  /** True while the bytes just emitted ended with a placeholder, so marks that follow are dropped. */
  private afterPlaceholder = false;

  /**
   * Filters one chunk of terminal output.
   *
   * @param chunk passthrough bytes from Osc1337Parser
   * @returns the bytes for xterm: the same as `chunk` when it holds no U+2800
   */
  filter(chunk: Buffer): Buffer {
    const input = this.stash.length === 0 ? chunk : Buffer.concat([this.stash, chunk]);
    this.stash = Buffer.alloc(0);
    // Fast path: nothing to change and no state to carry.
    if (!this.afterPlaceholder && input.indexOf(0xe2) === -1) return input;

    const pieces: Buffer[] = [];
    let segmentStart = 0;
    let i = 0;
    while (i < input.length) {
      const lead = input[i]!;
      const length = sequenceLength(lead);
      if (i + length > input.length) {
        // An unfinished sequence at the end: keep it for the next chunk.
        this.stash = Buffer.from(input.subarray(i));
        break;
      }
      if (this.afterPlaceholder && length > 1) {
        const char = input.subarray(i, i + length).toString('utf8');
        if (NONSPACING_MARK.test(char)) {
          pieces.push(input.subarray(segmentStart, i));
          i += length;
          segmentStart = i;
          continue;
        }
      }
      this.afterPlaceholder = false;
      if (
        length === 3 &&
        lead === BRAILLE_BLANK[0] &&
        input[i + 1] === BRAILLE_BLANK[1] &&
        input[i + 2] === BRAILLE_BLANK[2]
      ) {
        pieces.push(input.subarray(segmentStart, i), Buffer.from([SPACE]));
        i += 3;
        segmentStart = i;
        this.afterPlaceholder = true;
        continue;
      }
      i += length;
    }
    pieces.push(input.subarray(segmentStart, i));
    return pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces);
  }
}
