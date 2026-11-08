/**
 * @file claude-math-images.ts
 * @purpose Main-process half of the "Claude Code formula images" extension (ADR-019,
 *          settings.extensions.claudeMathImages).
 *
 * @关键设计:
 * - The latex-math Claude Code plugin cannot ask the terminal for its colours or cell shape. The
 *   renderer measures them (cmd:extensions:report-terminal-look) and main keeps them in a small
 *   JSON file, `extensions/terminal-look.json` in the data folder.
 * - Each new session with the extension on gets LATEX_MATH_LOOK_FILE (that file's path) and, on
 *   Windows, LATEX_MATH_BASH (the Git Bash Ceteris detected). The plugin reads the file whenever it
 *   draws, so a session started before any terminal reported a look, or a theme changed later,
 *   still gets the current colours. An environment variable alone would freeze them at spawn.
 * - The other parts of the extension live elsewhere: renderer/inline-images.ts (image addon and
 *   XTVERSION), placeholder-filter.ts, and the useConptyDll switch in session-manager.ts.
 *
 * @不要在这里做的事:
 * - Do not read settings here: session-manager.ts decides per spawn whether the extension is on.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** What a terminal looks like, as the renderer measured it. */
export interface TerminalLook {
  /** Text colour, #rrggbb */
  foreground: string;
  /** Background colour, #rrggbb */
  background: string;
  /** Cell width divided by cell height, e.g. 0.407 for 7.33x18 px */
  cellAspect: number;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Checks a look reported over IPC. Returns null for anything malformed, so a bad report is
 * dropped instead of reaching the plugin.
 */
export function parseTerminalLook(input: unknown): TerminalLook | null {
  if (!input || typeof input !== 'object') return null;
  const { foreground, background, cellAspect } = input as Record<string, unknown>;
  if (typeof foreground !== 'string' || !HEX.test(foreground)) return null;
  if (typeof background !== 'string' || !HEX.test(background)) return null;
  if (typeof cellAspect !== 'number' || !Number.isFinite(cellAspect)) return null;
  if (cellAspect < 0.2 || cellAspect > 1) return null;
  return {
    foreground: foreground.toLowerCase(),
    background: background.toLowerCase(),
    cellAspect: Math.round(cellAspect * 1000) / 1000,
  };
}

/**
 * The environment a new session gets while the extension is on.
 *
 * @param lookFile path of terminal-look.json (it may not exist yet; the plugin then guesses)
 * @param gitBash Git Bash detected for the shell list; a bare `bash` on Windows can be WSL's
 */
export function mathImagesEnv(
  lookFile: string | undefined,
  gitBash?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (lookFile) env.LATEX_MATH_LOOK_FILE = lookFile;
  if (gitBash) env.LATEX_MATH_BASH = gitBash;
  return env;
}

/** Keeps terminal-look.json in step with the last look a renderer reported. */
export class TerminalLookFile {
  private last = '';
  private pending: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  /**
   * Writes the look when it changed. Writes go one after another and land by rename, so the
   * plugin never reads half a file.
   */
  update(look: TerminalLook): Promise<void> {
    const text = `${JSON.stringify(look)}\n`;
    if (text === this.last) return this.pending;
    this.last = text;
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, this.path);
    });
    return this.pending;
  }
}

/**
 * The folder Claude Code adds as a local plugin marketplace: `extensions/` with its
 * `.claude-plugin/marketplace.json`. An installed Ceteris ships it in `resources/extensions`
 * (electron-builder extraResources, outside asar so Claude Code can read it); a dev run uses the
 * repository's own folder.
 */
export function bundledMarketplaceDir(where: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return join(where.isPackaged ? where.resourcesPath : where.appPath, 'extensions');
}
