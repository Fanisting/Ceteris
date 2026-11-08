/**
 * @file src/shared/custom-themes.ts
 * @purpose User themes: one .css file per theme in the data folder's themes folder. This
 *   module defines the file format, parses a file into what the app needs, and writes the
 *   commented template that new theme files start from.
 *
 * @关键设计:
 * - The file is plain CSS. Colours go in a `:root { ... }` block as custom properties with the
 *   same names the built-in themes use (the Layer 2 tokens in global.css), so a theme author
 *   writes what the app itself reads. Any other rules in the file are allowed too.
 * - The renderer injects every theme file at once, each wrapped in a nested rule scoped to
 *   `[data-theme='custom:<slug>']`, with `:root` rewritten to `&`. Only the selected theme
 *   matches the page, while the menu swatches (spans with their own data-theme) still show
 *   every theme's colours. Chromium 120+ supports this nesting natively.
 * - The terminal (xterm) cannot read CSS, so the parser also turns the `--terminal-*`
 *   properties into a palette. Each one is optional and falls back to the UI colours or to
 *   a stock ANSI set, so a theme that only sets the 15 UI colours still has a usable terminal.
 * - Lives in shared, not main or renderer, so settings validation, the main process store and
 *   the renderer all agree on ids, and vitest can cover it.
 *
 * @对应文档章节: 软件定义书.md 5.1.9 (ADR-026)
 *
 * @不要在这里做的事:
 * - No file system access. Reading and watching the folder is src/main/custom-theme-store.ts.
 * - No DOM access. Injecting the CSS is src/renderer/custom-themes.ts.
 */
import type { TerminalPalette } from './beamer-themes';

/** Every custom theme id starts with this, so it can never collide with a built-in id. */
export const CUSTOM_THEME_PREFIX = 'custom:';

export type CustomThemeId = `custom:${string}`;

/** Files starting with this are skipped by the loader. The shipped template uses it. */
export const IGNORED_FILE_PREFIX = '_';

/** Name of the reference copy of the template written into the themes folder. */
export const TEMPLATE_FILE_NAME = '_template.css';

/** Slugs are what follows the prefix: lower case letters, digits and single hyphens. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The 15 UI colour tokens every built-in theme defines (global.css Layer 2). */
export const UI_TOKENS = [
  ['--color-bg-primary', 'Main background: terminal area, settings page'],
  ['--color-bg-secondary', 'Side bar, title bar, tab strip'],
  ['--color-bg-elevated', 'Menus, dialogs, cards'],
  ['--color-bg-hover', 'Row under the mouse'],
  ['--color-bg-active', 'Selected row or tab'],
  ['--color-bg-strong', 'Scroll bar thumb, strong fills'],
  ['--color-text-primary', 'Main text'],
  ['--color-text-secondary', 'Secondary text, subtitles'],
  ['--color-text-muted', 'Hints, placeholders, counts'],
  ['--color-danger', 'Errors, close buttons'],
  ['--color-warning', 'Warnings'],
  ['--color-success', 'Running and success states'],
  ['--color-info', 'Links and information'],
  ['--color-accent-secondary', 'Second accent'],
  ['--color-accent-special', 'Main accent: buttons, focus rings, selection'],
] as const;

export type UiToken = (typeof UI_TOKENS)[number][0];

/** Terminal property name for each palette key. */
const TERMINAL_PROPS: ReadonlyArray<readonly [keyof TerminalPalette, string]> = [
  ['background', '--terminal-background'],
  ['foreground', '--terminal-foreground'],
  ['cursor', '--terminal-cursor'],
  ['cursorAccent', '--terminal-cursor-text'],
  ['selectionBackground', '--terminal-selection'],
  ['black', '--terminal-black'],
  ['red', '--terminal-red'],
  ['green', '--terminal-green'],
  ['yellow', '--terminal-yellow'],
  ['blue', '--terminal-blue'],
  ['magenta', '--terminal-magenta'],
  ['cyan', '--terminal-cyan'],
  ['white', '--terminal-white'],
  ['brightBlack', '--terminal-bright-black'],
  ['brightRed', '--terminal-bright-red'],
  ['brightGreen', '--terminal-bright-green'],
  ['brightYellow', '--terminal-bright-yellow'],
  ['brightBlue', '--terminal-bright-blue'],
  ['brightMagenta', '--terminal-bright-magenta'],
  ['brightCyan', '--terminal-bright-cyan'],
  ['brightWhite', '--terminal-bright-white'],
];

type AnsiKey = Exclude<
  keyof TerminalPalette,
  'background' | 'foreground' | 'cursor' | 'cursorAccent' | 'selectionBackground'
>;

/** Stock ANSI colours for themes that leave them out (Windows Terminal Campbell). */
const DARK_ANSI: Record<AnsiKey, string> = {
  black: '#0c0c0c',
  red: '#e74856',
  green: '#16c60c',
  yellow: '#f9f1a5',
  blue: '#3b78ff',
  magenta: '#b4009e',
  cyan: '#61d6d6',
  white: '#cccccc',
  brightBlack: '#767676',
  brightRed: '#ff6b77',
  brightGreen: '#5be35b',
  brightYellow: '#fff8c4',
  brightBlue: '#78a6ff',
  brightMagenta: '#e05ad0',
  brightCyan: '#9ff1f1',
  brightWhite: '#f2f2f2',
};

/** Stock ANSI colours for light themes, dark enough to read on a white background. */
const LIGHT_ANSI: Record<AnsiKey, string> = {
  black: '#1f2328',
  red: '#c2232f',
  green: '#1a7f37',
  yellow: '#8a6100',
  blue: '#0b5cc4',
  magenta: '#8e3fb5',
  cyan: '#0f7480',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a0111f',
  brightGreen: '#116329',
  brightYellow: '#6c4a00',
  brightBlue: '#0a4699',
  brightMagenta: '#6e2b91',
  brightCyan: '#0a5a63',
  brightWhite: '#24292f',
};

export interface CustomTheme {
  id: CustomThemeId;
  /** Shown in the theme menu. From the `@name` line, or the file name. */
  name: string;
  /** File name inside the themes folder, e.g. "my-theme.css". */
  file: string;
  dark: boolean;
  /** The file's CSS scoped to this theme's data-theme value, ready to inject. */
  css: string;
  terminal: TerminalPalette;
  /** Problems found while parsing, shown under the theme menu. Empty when the file is fine. */
  warnings: string[];
}

export function isCustomThemeId(id: string): id is CustomThemeId {
  return id.startsWith(CUSTOM_THEME_PREFIX) && SLUG_RE.test(id.slice(CUSTOM_THEME_PREFIX.length));
}

/**
 * Turns any text into a slug: lower case ASCII letters and digits joined by single hyphens.
 * Returns "" when nothing usable is left (for example a name written only in Chinese).
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Theme id for a file name, or null when the file is not a theme (not .css, starts with
 * "_", or has no usable characters in its name).
 */
export function themeIdForFile(file: string): CustomThemeId | null {
  if (!file.toLowerCase().endsWith('.css') || file.startsWith(IGNORED_FILE_PREFIX)) return null;
  const slug = slugify(file.slice(0, -4));
  return slug ? (`${CUSTOM_THEME_PREFIX}${slug}` as CustomThemeId) : null;
}

/** Removes CSS comments. Strings in theme files hold no comment markers, so a regex is enough. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Finds the body of the first top-level `:root { ... }` block by brace counting.
 * Returns null when there is none.
 */
function findRootBlock(css: string): string | null {
  const m = /(^|[\s;}]):root\s*\{/.exec(css);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i);
  }
  return null;
}

/** Reads `name: value;` declarations at the top level of a block. Nested rules are skipped. */
function readDeclarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let current = '';
  for (const ch of block) {
    if (ch === '{') depth++;
    if (depth === 0 && ch !== ';' && ch !== '}') current += ch;
    if (ch === '}') depth = Math.max(0, depth - 1);
    if ((ch === ';' || ch === '}') && depth === 0) {
      const colon = current.indexOf(':');
      if (colon > 0) out.set(current.slice(0, colon).trim(), current.slice(colon + 1).trim());
      current = '';
    }
  }
  const colon = current.indexOf(':');
  if (colon > 0) out.set(current.slice(0, colon).trim(), current.slice(colon + 1).trim());
  return out;
}

/**
 * Follows `var(--x)` and `var(--x, fallback)` through the declarations, up to a few steps,
 * so a terminal colour can point at a UI token. Anything else is returned as written.
 */
function resolveValue(value: string, decls: Map<string, string>, depth = 0): string {
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(value.trim());
  if (!m || depth > 8) return value.trim();
  const target = decls.get(m[1] ?? '');
  if (target !== undefined) return resolveValue(target, decls, depth + 1);
  return m[2] ? resolveValue(m[2], decls, depth + 1) : value.trim();
}

/** Parses #rgb / #rrggbb (alpha ignored). Returns null for anything else. */
function hexToRgb(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (!m || !m[1]) return null;
  const h = m[1].length <= 4 ? [...m[1].slice(0, 3)].map((c) => c + c).join('') : m[1].slice(0, 6);
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance of a hex colour, or null when it is not a hex colour. */
function luminance(color: string): number | null {
  const rgb = hexToRgb(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Wraps the file in a rule scoped to the theme id. `:root` becomes `&`, so the colour block
 * applies to whatever element carries the theme's data-theme value. `html` in the selector
 * list lifts specificity just above the built-in `:root` block, so injection order never
 * decides which theme wins.
 */
function scopeCss(id: CustomThemeId, css: string): string {
  const selector = `html[data-theme='${id}'], [data-theme='${id}']`;
  return `${selector} {\n${stripComments(css).replace(/:root\b/g, '&')}\n}\n`;
}

/**
 * Parses one theme file. Never throws: problems become warnings and missing values fall back,
 * so a half written file still shows up in the menu while the user is editing it.
 *
 * @param file File name inside the themes folder. Must give a theme id (see themeIdForFile).
 * @param text File contents.
 * @returns null when the file name is not a theme file.
 */
export function parseCustomTheme(file: string, text: string): CustomTheme | null {
  const id = themeIdForFile(file);
  if (!id) return null;
  const warnings: string[] = [];

  const nameMatch = /@name\s+([^\n*]+)/.exec(text);
  const name = nameMatch?.[1]?.trim() || file.slice(0, -4);

  const body = stripComments(text);
  const root = findRootBlock(body);
  if (root === null) warnings.push('No :root { ... } block found, so no colours were read.');
  const decls = readDeclarations(root ?? '');

  const missing = UI_TOKENS.map(([t]) => t).filter((t) => !decls.has(t));
  if (root !== null && missing.length > 0) {
    warnings.push(`Missing ${missing.join(', ')}. The built-in default colours fill these in.`);
  }

  const get = (prop: string): string | undefined => {
    const v = decls.get(prop);
    return v === undefined ? undefined : resolveValue(v, decls);
  };

  const scheme = get('color-scheme')?.toLowerCase() ?? '';
  const bg = get('--color-bg-primary') ?? '';
  const bgLum = luminance(bg);
  const dark =
    scheme.includes('light') && !scheme.includes('dark')
      ? false
      : scheme.includes('dark')
        ? true
        : bgLum === null
          ? true
          : bgLum < 0.4;

  const ansi = dark ? DARK_ANSI : LIGHT_ANSI;
  const background = get('--terminal-background') ?? (bg || (dark ? '#1e1e1e' : '#ffffff'));
  const defaults: Record<keyof TerminalPalette, string> = {
    background,
    foreground: get('--color-text-primary') ?? (dark ? '#e6e6e6' : '#1f2328'),
    cursor: get('--color-accent-special') ?? (dark ? '#e6e6e6' : '#1f2328'),
    cursorAccent: background,
    selectionBackground: get('--color-bg-active') ?? (dark ? '#264f78' : '#add6ff'),
    ...ansi,
  };
  const terminal = Object.fromEntries(
    TERMINAL_PROPS.map(([key, prop]) => [key, get(prop) ?? defaults[key]]),
  ) as unknown as TerminalPalette;

  return { id, name, file, dark, css: scopeCss(id, text), terminal, warnings };
}

export interface TemplateValues {
  /** Theme name for the `@name` line. */
  name: string;
  dark: boolean;
  /** Values for the 15 UI tokens. Missing ones are left empty for the user to fill. */
  tokens: Partial<Record<UiToken, string>>;
  terminal: TerminalPalette;
}

/** Colours of the default theme (Ceteris Dark), used for the reference template. */
export const CETERIS_DARK_TEMPLATE: TemplateValues = {
  name: 'My Theme',
  dark: true,
  tokens: {
    '--color-bg-primary': '#0e1514',
    '--color-bg-secondary': '#1a2121',
    '--color-bg-elevated': '#242b2b',
    '--color-bg-hover': '#1f2626',
    '--color-bg-active': '#2f3636',
    '--color-bg-strong': '#3f4948',
    '--color-text-primary': '#dde4e3',
    '--color-text-secondary': '#bec9c8',
    '--color-text-muted': '#889392',
    '--color-danger': '#ffb4ab',
    '--color-warning': '#e9c46a',
    '--color-success': '#8bd6a3',
    '--color-info': '#a8c8ff',
    '--color-accent-secondary': '#b3c8e8',
    '--color-accent-special': '#80d5d4',
  },
  terminal: {
    background: '#0e1514',
    foreground: '#dde4e3',
    cursor: '#80d5d4',
    cursorAccent: '#0e1514',
    selectionBackground: '#004f4f',
    black: '#2f3636',
    red: '#ffb4ab',
    green: '#8bd6a3',
    yellow: '#e9c46a',
    blue: '#a8c8ff',
    magenta: '#d3bbff',
    cyan: '#80d5d4',
    white: '#dde4e3',
    brightBlack: '#889392',
    brightRed: '#ffdad6',
    brightGreen: '#a6f2be',
    brightYellow: '#ffe08e',
    brightBlue: '#d3e4ff',
    brightMagenta: '#eaddff',
    brightCyan: '#9cf1f0',
    brightWhite: '#ffffff',
  },
};

/**
 * Writes the standard theme file: every property the app reads, each with a comment saying
 * where it shows up, filled with the given colours. New themes are created from this, and the
 * folder keeps a reference copy as _template.css.
 */
export function buildThemeTemplate(v: TemplateValues): string {
  const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(1, n - s.length));
  const ui = UI_TOKENS.map(
    ([token, where]) => `  ${pad(`${token}: ${v.tokens[token] ?? ''};`, 44)}/* ${where} */`,
  );
  const term = TERMINAL_PROPS.map(([key, prop]) => `  ${prop}: ${v.terminal[key]};`);
  return `/*
 * @name ${v.name}
 *
 * A Ceteris theme. Edit the colours below and save: open windows update right away.
 *
 * How it works
 *   Each .css file in this folder is one theme, listed under "Custom" in
 *   Settings > Appearance > Theme. The file name becomes the theme id, so renaming
 *   the file means picking the theme again. The @name line above is the menu label.
 *   Files whose names start with an underscore are skipped (like _template.css).
 *
 *   Colours can be any CSS colour: #hex, rgb(), hsl(), or var(--another-property).
 *   The terminal reads only #hex values and var() links, so keep those as hex.
 */

:root {
  /* Light or dark. Sets native scroll bars and menus, and which stock terminal
     colours fill any terminal property you delete. */
  color-scheme: ${v.dark ? 'dark' : 'light'};

  /* Interface colours. Every built-in theme defines these 15. */
${ui.join('\n')}

  /* Terminal colours. Delete any line to fall back: background, text, cursor and
     selection follow the interface colours above, the 16 ANSI colours use a stock set. */
${term.join('\n')}

  /* Optional: the interface font. */
  /* --ui-font-family: 'Segoe UI', system-ui, sans-serif; */
}

/*
 * Optional: any other CSS rules. They apply only while this theme is selected.
 * Example, square tabs:
 *
 * .tab { border-radius: 0; }
 */
`;
}
