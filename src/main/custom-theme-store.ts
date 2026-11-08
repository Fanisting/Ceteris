/**
 * @file src/main/custom-theme-store.ts
 * @purpose Reads the user's theme files from <data folder>/themes, watches the folder so an
 *   edit shows up in every window as soon as the file is saved, and creates new theme files
 *   from the standard template (ADR-026).
 *
 * @关键设计:
 * - The folder and its _template.css are created on first use, so a user who opens the
 *   folder always finds the template to copy.
 * - Parsing is in @shared/custom-themes and never throws: a half written file still lists,
 *   with warnings, so the user sees the effect of each save while editing.
 * - fs.watch on Windows fires several events per save (editors write a temp file, then
 *   rename). One debounce collapses them into a single reload.
 * - Themes are local to this machine. Under Ceteris Link the commands are local only,
 *   and the theme of a remote window already follows this machine (link-theme.ts).
 *
 * @对应文档章节: 软件定义书.md 5.1.9 (ADR-026)
 *
 * @不要在这里做的事:
 * - No parsing rules here; they belong to @shared/custom-themes so the tests cover them.
 * - Never delete files in the folder. It belongs to the user.
 */
import { promises as fs, watch, type FSWatcher } from 'fs';
import { join } from 'path';
import {
  buildThemeTemplate,
  CETERIS_DARK_TEMPLATE,
  parseCustomTheme,
  slugify,
  TEMPLATE_FILE_NAME,
  themeIdForFile,
  type CustomTheme,
  type CustomThemeId,
  type TemplateValues,
} from '@shared/custom-themes';
import { logger } from './logger';

/** Files bigger than this are skipped; a colour theme is a few KB. */
const MAX_FILE_BYTES = 256 * 1024;
/** Upper bound on files read per reload, so a wrong folder cannot stall the app. */
const MAX_FILES = 100;
const WATCH_DEBOUNCE_MS = 150;

export class CustomThemeStore {
  private themes: CustomTheme[] = [];
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private loaded: Promise<void> | null = null;

  /**
   * @param dir The themes folder, normally join(app.getPath('userData'), 'themes').
   * @param onChange Called with the full list after every reload caused by a file change.
   */
  constructor(
    readonly dir: string,
    private readonly onChange: (themes: CustomTheme[]) => void,
  ) {}

  /** Creates the folder and template if needed, reads the themes and starts watching. */
  async start(): Promise<void> {
    await this.ensureFolder();
    await this.reload();
    try {
      this.watcher = watch(this.dir, () => this.scheduleReload());
      this.watcher.on('error', (err) => logger.warn('themes', `watch error dir=${this.dir}`, err));
    } catch (err) {
      // Without a watcher themes still load at start and after create(); only live edit is lost.
      logger.warn('themes', `cannot watch ${this.dir}; edits apply after a restart`, err);
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Current themes, sorted by name. Waits for the first read when called early. */
  async list(): Promise<CustomTheme[]> {
    if (!this.loaded) this.loaded = this.reload();
    await this.loaded;
    return this.themes;
  }

  /**
   * Writes a new theme file from the template and returns its id and full path.
   * The file name comes from the name; "-2", "-3" and so on are added when it is taken, and
   * the menu name gets the same number so two themes never share a label.
   */
  async create(values: TemplateValues): Promise<{ id: CustomThemeId; path: string }> {
    await this.ensureFolder();
    const base = slugify(values.name) || 'my-theme';
    for (let n = 1; n < 1000; n++) {
      const file = `${n === 1 ? base : `${base}-${n}`}.css`;
      const path = join(this.dir, file);
      const name = n === 1 ? values.name : `${values.name} ${n}`;
      try {
        // 'wx' fails when the file exists, so two clicks never overwrite each other.
        await fs.writeFile(path, buildThemeTemplate({ ...values, name }), {
          encoding: 'utf8',
          flag: 'wx',
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw new Error(
          `[CustomThemeStore] create failed for "${path}". Possible causes: (1) the themes ` +
            `folder is read only, (2) the disk is full. Original error: ${String(err)}`,
        );
      }
      logger.info('themes', `created theme file ${path}`);
      await this.reload();
      const id = themeIdForFile(file);
      if (!id) throw new Error(`[CustomThemeStore] "${file}" does not map to a theme id`);
      return { id, path };
    }
    throw new Error(`[CustomThemeStore] no free file name for "${base}" in ${this.dir}`);
  }

  /** Full path of a theme's file, or null when the id is not loaded. */
  pathOf(id: string): string | null {
    const theme = this.themes.find((t) => t.id === id);
    return theme ? join(this.dir, theme.file) : null;
  }

  private async ensureFolder(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const template = join(this.dir, TEMPLATE_FILE_NAME);
    try {
      await fs.writeFile(template, buildThemeTemplate(CETERIS_DARK_TEMPLATE), {
        encoding: 'utf8',
        flag: 'wx',
      });
      logger.info('themes', `wrote ${template}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        logger.warn('themes', `cannot write ${template}`, err);
      }
    }
  }

  private scheduleReload(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reload().then(() => this.onChange(this.themes));
    }, WATCH_DEBOUNCE_MS);
  }

  private async reload(): Promise<void> {
    let files: string[];
    try {
      files = await fs.readdir(this.dir);
    } catch (err) {
      logger.warn('themes', `cannot read ${this.dir}`, err);
      this.themes = [];
      return;
    }
    const seen = new Set<string>();
    const out: CustomTheme[] = [];
    for (const file of files
      .filter((f) => themeIdForFile(f))
      .sort()
      .slice(0, MAX_FILES)) {
      try {
        const path = join(this.dir, file);
        const stat = await fs.stat(path);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
        const theme = parseCustomTheme(file, await fs.readFile(path, 'utf8'));
        // "My Theme.css" and "my-theme.css" give the same id; the first one wins.
        if (!theme || seen.has(theme.id)) continue;
        seen.add(theme.id);
        if (theme.warnings.length > 0) {
          logger.warn('themes', `${file}: ${theme.warnings.join(' ')}`);
        }
        out.push(theme);
      } catch (err) {
        // A file can vanish between readdir and read while an editor saves it.
        logger.warn('themes', `cannot read theme file ${file}`, err);
      }
    }
    this.themes = out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    logger.info('themes', `loaded ${out.length} custom theme(s) from ${this.dir}`);
  }
}
