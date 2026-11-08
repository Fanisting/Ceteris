/**
 * @file src/renderer/custom-themes.ts
 * @purpose Keeps this window's copy of the user theme list (ADR-026): loads it once, follows
 *   evt:theme:custom-updated, and injects every theme's scoped CSS into one <style> element.
 *
 * @关键设计:
 * - One module level store instead of the app reducer: three readers (App for the fallback,
 *   TerminalView for the palette, ThemePicker for the menu) and no writer but main.
 * - All themes are injected at once. Their rules are scoped to their own data-theme value
 *   (see @shared/custom-themes), so only the selected one styles the page, and the menu
 *   swatches can show the others.
 * - The <style> element is appended to <head> after the app's own stylesheets. The scoped
 *   selector also outranks the built-in :root block, so order is a second safeguard only.
 *
 * @不要在这里做的事:
 * - No parsing; main sends ready parsed themes.
 */
import { useSyncExternalStore } from 'react';
import { COMMAND_CHANNELS, EVENT_CHANNELS } from '@shared/protocol';
import { isCustomThemeId, type CustomTheme } from '@shared/custom-themes';
import type { BuiltinThemeId, ThemeId } from '@shared/types';

let themes: CustomTheme[] = [];
const listeners = new Set<() => void>();
let styleEl: HTMLStyleElement | null = null;
let loaded = false;

function setThemes(next: CustomTheme[]): void {
  themes = next;
  loaded = true;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'ceteris-custom-themes';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = next.map((t) => `/* ${t.id} */\n${t.css}`).join('\n');
  for (const l of listeners) l();
}

/** Loads the list and subscribes to changes. Called once from index.tsx. */
export function initCustomThemes(): void {
  window.api
    .invoke<undefined, CustomTheme[]>(COMMAND_CHANNELS.THEME_LIST_CUSTOM, undefined)
    .then(setThemes)
    .catch((err) => console.warn('[themes] list-custom failed', err));
  window.api.on<CustomTheme[]>(EVENT_CHANNELS.CUSTOM_THEMES_UPDATED, setThemes);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The current user themes; re-renders the caller when a theme file changes. */
export function useCustomThemes(): CustomTheme[] {
  return useSyncExternalStore(subscribe, () => themes);
}

/** The current list without subscribing, for code outside React render (xterm options). */
export function getCustomThemes(): CustomTheme[] {
  return themes;
}

/** Built-in theme shown when the selected theme file is gone. Same as the settings default. */
export const MISSING_THEME_FALLBACK: BuiltinThemeId = 'light-pink';

/**
 * The theme to show for a saved theme id. A user theme whose file was deleted or renamed
 * falls back to the default theme, but only once the list has loaded, so start up does not
 * flash the default theme before the files arrive.
 */
export function resolveThemeId(id: ThemeId): ThemeId {
  if (!isCustomThemeId(id) || !loaded) return id;
  return themes.some((t) => t.id === id) ? id : MISSING_THEME_FALLBACK;
}
