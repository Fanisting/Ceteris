/**
 * @file custom-themes.test.ts
 * @purpose User theme files (ADR-026): file name to id, parsing, fallbacks and the template.
 */
import { describe, expect, it } from 'vitest';
import {
  buildThemeTemplate,
  CETERIS_DARK_TEMPLATE,
  isCustomThemeId,
  parseCustomTheme,
  themeIdForFile,
} from './custom-themes';

describe('custom theme files', () => {
  it('maps file names to ids and skips non themes', () => {
    expect(themeIdForFile('My Theme.CSS')).toBe('custom:my-theme');
    expect(themeIdForFile('_template.css')).toBeNull();
    expect(themeIdForFile('notes.txt')).toBeNull();
    expect(themeIdForFile('主题.css')).toBeNull();
    expect(isCustomThemeId('custom:my-theme')).toBe(true);
    expect(isCustomThemeId('custom:My Theme')).toBe(false);
    expect(isCustomThemeId('dracula')).toBe(false);
  });

  it('reads colours, follows var() and scopes the CSS to the theme id', () => {
    const t = parseCustomTheme(
      'ocean.css',
      `/* @name Deep Ocean */
       :root {
         color-scheme: dark;
         --color-bg-primary: #001122;
         --color-accent-special: #33ccff;
         --terminal-red: #ff0000;
         --terminal-cursor: var(--color-accent-special);
       }
       .tab { border-radius: 0; }`,
    );
    expect(t).toMatchObject({ id: 'custom:ocean', name: 'Deep Ocean', dark: true });
    expect(t?.terminal).toMatchObject({
      background: '#001122',
      cursor: '#33ccff',
      red: '#ff0000',
    });
    expect(t?.css).toContain("html[data-theme='custom:ocean'], [data-theme='custom:ocean'] {");
    expect(t?.css).toContain('& {');
    expect(t?.css).not.toContain(':root');
    expect(t?.css).not.toContain('@name');
  });

  it('decides light or dark from color-scheme, else from the background', () => {
    const light = (body: string): boolean | undefined =>
      parseCustomTheme('t.css', `:root { ${body} }`)?.dark === false;
    expect(light('color-scheme: light;')).toBe(true);
    expect(light('--color-bg-primary: #fafafa;')).toBe(true);
    expect(light('--color-bg-primary: #111;')).toBe(false);
    expect(light('color-scheme: dark; --color-bg-primary: #fafafa;')).toBe(false);
  });

  it('warns about a missing :root block or missing tokens but still parses', () => {
    expect(parseCustomTheme('a.css', '.x { color: red; }')?.warnings[0]).toMatch(/:root/);
    const partial = parseCustomTheme('b.css', ':root { --color-bg-primary: #000; }');
    expect(partial?.warnings[0]).toMatch(/--color-text-primary/);
    // Missing terminal colours fall back to the UI colours and a stock ANSI set
    expect(partial?.terminal.background).toBe('#000');
    expect(partial?.terminal.red).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('parses the standard template back to the values it was built from', () => {
    const t = parseCustomTheme('my.css', buildThemeTemplate(CETERIS_DARK_TEMPLATE));
    expect(t?.warnings).toEqual([]);
    expect(t?.name).toBe(CETERIS_DARK_TEMPLATE.name);
    expect(t?.dark).toBe(true);
    expect(t?.terminal).toEqual(CETERIS_DARK_TEMPLATE.terminal);
    const light = parseCustomTheme(
      'l.css',
      buildThemeTemplate({ ...CETERIS_DARK_TEMPLATE, dark: false }),
    );
    expect(light?.dark).toBe(false);
  });
});
