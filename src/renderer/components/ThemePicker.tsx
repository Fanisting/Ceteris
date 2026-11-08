/**
 * @file ThemePicker.tsx
 * @purpose 设置 → 外观里的主题选择器:Material 3 下拉菜单,系列主题折叠成一项,再用一排
 *   filter chip 选具体变体。
 *
 * @关键设计:
 * - 珠光(7 款)和 Beamer(6 款)在菜单里各占一行;选中系列后,下方出现该系列的变体 chip。
 *   单个主题直接在菜单里选。
 * - 菜单里的名字一律英文,包括明暗标记,不随界面语言切换。
 * - 色块是一个带 data-theme 属性的 span,直接读该主题自己的 CSS 变量,所以永远与主题
 *   实际配色一致,不用在这里重复维护色值。
 * - 键盘:字段上 Enter / 空格 / 下箭头打开,菜单内上下箭头移动,Enter 选择,Esc 关闭并把
 *   焦点还给字段。点菜单外面关闭。
 * - 用户主题(ADR-026)是菜单末尾的 Custom 系列,列表来自 ../custom-themes,文件一保存就更新。
 *   菜单下方一排按钮:以当前主题为底新建主题文件、编辑当前主题文件、打开主题文件夹。
 *
 * @对应文档章节:软件定义书.md 5.1.9 节
 *
 * @不要在这里做的事:
 * - 不要写设置,选择通过 onChange 交给调用方(SettingsView 负责 updateSettings)
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ThemeId } from '@shared/types';
import { BEAMER_THEMES, type TerminalPalette } from '@shared/beamer-themes';
import {
  isCustomThemeId,
  UI_TOKENS,
  type CustomTheme,
  type TemplateValues,
} from '@shared/custom-themes';
import { COMMAND_CHANNELS } from '@shared/protocol';
import { Check, ExpandMore } from './material-symbols';
import { useTranslation } from './LanguageProvider';
import { useCustomThemes } from '../custom-themes';
import { getXtermTheme } from './TerminalView';

interface ThemeOption {
  id: ThemeId;
  label: string;
  dark: boolean;
  /** 菜单里明暗标记后面的附注,英文 */
  note?: string;
}

interface ThemeFamily {
  key: string;
  label: string;
  options: ThemeOption[];
}

type MenuEntry = { kind: 'theme'; option: ThemeOption } | { kind: 'family'; family: ThemeFamily };

const SINGLE_THEMES: ThemeOption[] = [
  { id: 'ceteris-dark', label: 'Ceteris Dark', dark: true, note: 'Default' },
  { id: 'ceteris-light', label: 'Ceteris Light', dark: false },
  { id: 'rose-pine', label: 'Rose Pine', dark: true },
  { id: 'rose-pine-dawn', label: 'Rose Pine Dawn', dark: false },
  { id: 'rose-pine-moon', label: 'Rose Pine Moon', dark: true },
  { id: 'cutie', label: 'Cutie', dark: false, note: 'Kawaii' },
  { id: 'light-pink', label: 'Light Pink', dark: false, note: 'Kawaii' },
  { id: 'fairyfloss', label: 'Fairyfloss', dark: true, note: 'Kawaii' },
  { id: 'business', label: 'Business', dark: true },
  { id: 'ubuntu', label: 'Ubuntu', dark: true },
  { id: 'windows-terminal', label: 'Windows Terminal', dark: true },
  { id: 'one-dark-pro', label: 'One Dark Pro', dark: true },
  { id: 'dracula', label: 'Dracula', dark: true },
  { id: 'tokyo-night', label: 'Tokyo Night', dark: true },
  { id: 'tokyo-night-day', label: 'Tokyo Night Day', dark: false },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', dark: true },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', dark: false },
];

const PEARL: ThemeFamily = {
  key: 'pearl',
  label: 'Pearl',
  options: [
    { id: 'pearl-lapis', label: 'Lapis', dark: false },
    { id: 'pearl-sapphire', label: 'Sapphire', dark: false },
    { id: 'pearl-rose', label: 'Rose Dew', dark: false },
    { id: 'pearl-ember', label: 'Ember', dark: false },
    { id: 'pearl-jade', label: 'Jade', dark: false },
    { id: 'pearl-moon', label: 'Moonlight', dark: false },
    { id: 'pearl-frost', label: 'Frost', dark: false },
  ],
};

const BEAMER: ThemeFamily = {
  key: 'beamer',
  label: 'Beamer',
  options: BEAMER_THEMES.map((t) => ({ id: t.id, label: t.label, dark: t.tone === '深色' })),
};

/** 用户主题系列;没有主题文件时不出现在菜单里。 */
function customFamily(themes: CustomTheme[]): ThemeFamily {
  return {
    key: 'custom',
    label: 'Custom',
    options: themes.map((t) => ({ id: t.id, label: t.name, dark: t.dark })),
  };
}

function buildEntries(custom: ThemeFamily): MenuEntry[] {
  const families = custom.options.length > 0 ? [PEARL, BEAMER, custom] : [PEARL, BEAMER];
  return [
    ...SINGLE_THEMES.map((option): MenuEntry => ({ kind: 'theme', option })),
    ...families.map((family): MenuEntry => ({ kind: 'family', family })),
  ];
}

function familyOf(id: ThemeId, entries: MenuEntry[]): ThemeFamily | null {
  for (const e of entries) {
    if (e.kind === 'family' && e.family.options.some((o) => o.id === id)) return e.family;
  }
  return null;
}

/** 当前主题的标签,用作新主题文件的名字。 */
function labelOf(id: ThemeId, entries: MenuEntry[]): string {
  const single = SINGLE_THEMES.find((o) => o.id === id);
  if (single) return single.label;
  const fam = familyOf(id, entries);
  const opt = fam?.options.find((o) => o.id === id);
  if (!fam || !opt) return 'Theme';
  return fam.key === 'custom' ? opt.label : `${fam.label} ${opt.label}`;
}

/**
 * 读出当前页面正在用的配色,作为新主题文件的初值。界面色取 <html> 上算好的
 * CSS 变量(var() 链已展开),终端色取 xterm 当前用的配色。
 */
function currentThemeValues(id: ThemeId, name: string): TemplateValues {
  const style = getComputedStyle(document.documentElement);
  const tokens = Object.fromEntries(
    UI_TOKENS.map(([token]) => [token, style.getPropertyValue(token).trim()]),
  );
  const x = getXtermTheme(id);
  const bg = x.background ?? tokens['--color-bg-primary'] ?? '#000000';
  const terminal: TerminalPalette = {
    background: bg,
    foreground: x.foreground ?? '#ffffff',
    cursor: x.cursor ?? x.foreground ?? '#ffffff',
    cursorAccent: x.cursorAccent ?? bg,
    selectionBackground: x.selectionBackground ?? '#555555',
    black: x.black ?? '#000000',
    red: x.red ?? '#cd3131',
    green: x.green ?? '#0dbc79',
    yellow: x.yellow ?? '#e5e510',
    blue: x.blue ?? '#2472c8',
    magenta: x.magenta ?? '#bc3fbc',
    cyan: x.cyan ?? '#11a8cd',
    white: x.white ?? '#e5e5e5',
    brightBlack: x.brightBlack ?? '#666666',
    brightRed: x.brightRed ?? '#f14c4c',
    brightGreen: x.brightGreen ?? '#23d18b',
    brightYellow: x.brightYellow ?? '#f5f543',
    brightBlue: x.brightBlue ?? '#3b8eea',
    brightMagenta: x.brightMagenta ?? '#d670d6',
    brightCyan: x.brightCyan ?? '#29b8db',
    brightWhite: x.brightWhite ?? '#ffffff',
  };
  const dark = style.getPropertyValue('color-scheme').trim() !== 'light';
  return { name, dark, tokens, terminal };
}

function entryContains(entry: MenuEntry, id: ThemeId): boolean {
  return entry.kind === 'theme'
    ? entry.option.id === id
    : entry.family.options.some((o) => o.id === id);
}

function toneLabel(dark: boolean): string {
  return dark ? 'Dark' : 'Light';
}

/** 主题色块:span 带 data-theme,背景和中心点读该主题自己的变量。用户主题的 CSS 也按
 *  data-theme 限定作用范围,所以同样适用。 */
function Swatch({ id }: { id: ThemeId }): JSX.Element {
  return (
    <span className="theme-swatch" data-theme={id} aria-hidden="true">
      <span className="theme-swatch-dot" />
    </span>
  );
}

export function ThemePicker({
  value,
  onChange,
}: {
  value: ThemeId;
  onChange: (id: ThemeId) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const customThemes = useCustomThemes();
  const custom = useMemo(() => customFamily(customThemes), [customThemes]);
  const ENTRIES = useMemo(() => buildEntries(custom), [custom]);
  const [open, setOpen] = useState(false);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);

  const family = familyOf(value, ENTRIES);
  const currentIndex = Math.max(
    0,
    ENTRIES.findIndex((e) => entryContains(e, value)),
  );
  const current = useMemo(
    () => (family ? null : (SINGLE_THEMES.find((o) => o.id === value) ?? null)),
    [family, value],
  );
  const familyOption = family?.options.find((o) => o.id === value) ?? null;

  const openMenu = (): void => {
    setActive(currentIndex);
    setOpen(true);
  };

  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) fieldRef.current?.focus();
  };

  const choose = (entry: MenuEntry): void => {
    close(true);
    if (entry.kind === 'theme') {
      if (entry.option.id !== value) onChange(entry.option.id);
      return;
    }
    // 已经在这个系列里就保持当前变体,否则取系列第一款
    if (familyOf(value, ENTRIES) !== entry.family) {
      const first = entry.family.options[0];
      if (first) onChange(first.id);
    }
  };

  // 点菜单外面关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // 打开时把焦点给菜单,并让高亮项保持在可视区域内
  useEffect(() => {
    if (!open) return;
    menuRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const item = menuRef.current?.children[active] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onFieldKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu();
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLUListElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(ENTRIES.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(ENTRIES.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const entry = ENTRIES[active];
      if (entry) choose(entry);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const selectedCustom = customThemes.find((t) => t.id === value) ?? null;
  // 主题文件被删或改名后,设置里还是旧 id:字段上显示文件名,提示去菜单里重选
  const missingCustom = isCustomThemeId(value) && !selectedCustom;

  const runThemeCommand = async (channel: string, payload: unknown): Promise<unknown> => {
    setThemeError(null);
    try {
      return await window.api.invoke(channel, payload);
    } catch (err) {
      setThemeError(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const createFromCurrent = async (): Promise<void> => {
    const values = currentThemeValues(value, `My ${labelOf(value, ENTRIES)}`);
    const res = (await runThemeCommand(COMMAND_CHANNELS.THEME_CREATE_CUSTOM, values)) as {
      id: ThemeId;
    } | null;
    // 新文件和当前主题一模一样,直接切过去,用户改文件时立刻看到效果
    if (res) onChange(res.id);
  };

  const fieldLabel = missingCustom
    ? value.slice('custom:'.length)
    : family
      ? family.label
      : (current?.label ?? value);
  const fieldSupport = family
    ? (familyOption?.label ?? '')
    : current
      ? toneLabel(current.dark)
      : '';

  return (
    <div className="theme-picker" ref={rootRef}>
      <button
        ref={fieldRef}
        type="button"
        className={`theme-picker-field${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={tx('主题', 'Theme')}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onFieldKey}
      >
        <Swatch id={value} />
        <span className="theme-picker-field-label">{fieldLabel}</span>
        {fieldSupport && <span className="theme-picker-field-support">{fieldSupport}</span>}
        <ExpandMore size={20} className="theme-picker-arrow" />
      </button>

      {open && (
        <ul
          ref={menuRef}
          className="theme-menu"
          role="listbox"
          tabIndex={-1}
          aria-label={tx('主题', 'Theme')}
          aria-activedescendant={`theme-entry-${active}`}
          onKeyDown={onMenuKey}
        >
          {ENTRIES.map((entry, i) => {
            const selected = entryContains(entry, value);
            const swatchId =
              entry.kind === 'theme'
                ? entry.option.id
                : selected
                  ? value
                  : (entry.family.options[0]?.id ?? value);
            const label = entry.kind === 'theme' ? entry.option.label : entry.family.label;
            const support =
              entry.kind === 'theme'
                ? [toneLabel(entry.option.dark), entry.option.note].filter(Boolean).join(' · ')
                : `${entry.family.options.length} variants`;
            return (
              <li
                key={entry.kind === 'theme' ? entry.option.id : entry.family.key}
                id={`theme-entry-${i}`}
                role="option"
                aria-selected={selected}
                className={`theme-menu-item${i === active ? ' active' : ''}${selected ? ' selected' : ''}${i === SINGLE_THEMES.length ? ' first-family' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(entry)}
              >
                <Swatch id={swatchId} />
                <span className="theme-menu-label">{label}</span>
                <span className="theme-menu-support">{support}</span>
                <span className="theme-menu-check">{selected && <Check size={18} />}</span>
              </li>
            );
          })}
        </ul>
      )}

      {family && (
        <div className="theme-variants" role="radiogroup" aria-label={`${family.label} variants`}>
          {family.options.map((o) => {
            const selected = o.id === value;
            return (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`theme-chip${selected ? ' selected' : ''}`}
                onClick={() => {
                  if (!selected) onChange(o.id);
                }}
              >
                {selected ? <Check size={18} className="theme-chip-check" /> : <Swatch id={o.id} />}
                {o.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="theme-custom-actions">
        <button
          type="button"
          className="theme-custom-action"
          title={tx(
            '用当前主题的配色新建一个主题文件,并用默认编辑器打开。保存文件后立即生效',
            'Write a theme file with the current colours and open it in your editor. Saving applies it right away',
          )}
          onClick={() => void createFromCurrent()}
        >
          {tx('以当前主题新建', 'New theme from current')}
        </button>
        {selectedCustom && (
          <button
            type="button"
            className="theme-custom-action"
            onClick={() =>
              void runThemeCommand(COMMAND_CHANNELS.THEME_OPEN_FILE, { id: selectedCustom.id })
            }
          >
            {tx('编辑主题文件', 'Edit theme file')}
          </button>
        )}
        <button
          type="button"
          className="theme-custom-action"
          title={tx(
            '每个 .css 文件是一个主题;_template.css 是带注释的标准模板',
            'Each .css file is one theme; _template.css is the commented standard template',
          )}
          onClick={() => void runThemeCommand(COMMAND_CHANNELS.THEME_OPEN_FOLDER, undefined)}
        >
          {tx('打开主题文件夹', 'Open themes folder')}
        </button>
      </div>

      {missingCustom && (
        <p className="theme-custom-note">
          {tx(
            `找不到主题文件 ${fieldLabel}.css,暂用默认主题。`,
            `Theme file ${fieldLabel}.css is missing, so the default theme is showing.`,
          )}
        </p>
      )}
      {selectedCustom?.warnings.map((w) => (
        <p key={w} className="theme-custom-note">
          {selectedCustom.file}: {w}
        </p>
      ))}
      {themeError && <p className="theme-custom-note">{themeError}</p>}
    </div>
  );
}
