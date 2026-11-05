/**
 * @file src/shared/link-theme.ts
 * @purpose Link 远程窗口的主题规则:主题跟随用户面前的这台机器,其余设置仍以 Host 为准。
 *   这样同一台机器上的本地窗口和远程窗口颜色一致,切换时一起变,也不会改动 Host。
 *
 * @关键设计:
 * - 只有 appearance.theme 走本机。字体、模板等仍来自 Host,见 link-protocol.ts。
 * - 这里只放纯函数,转发和事件注入的时机在 ipc.ts。renderer 不知道这条规则,
 *   它拿到的设置已经是覆盖过的结果。
 *
 * @对应文档章节: docs/远程访问指南.md
 */
import { COMMAND_CHANNELS } from './protocol';
import type { DeepPartial } from './types-helpers';
import type { Settings, ThemeId } from './types';

/** 返回值带完整 settings 的转发命令,结果要覆盖主题。 */
const SETTINGS_CARRYING_CHANNELS: ReadonlySet<string> = new Set([
  COMMAND_CHANNELS.SETTINGS_GET,
  COMMAND_CHANNELS.APP_GET_SNAPSHOT,
]);

export function withLocalTheme(settings: Settings, theme: ThemeId): Settings {
  return { ...settings, appearance: { ...settings.appearance, theme } };
}

/**
 * 覆盖一条转发命令返回值里的主题。
 *
 * @param channel 命令 channel
 * @param result Host 的返回值
 * @param theme 本机主题
 * @returns 不带 settings 的 channel 原样返回
 */
export function applyLocalThemeToResult(
  channel: string,
  result: unknown,
  theme: ThemeId,
): unknown {
  if (!SETTINGS_CARRYING_CHANNELS.has(channel)) return result;
  const settings = (result as { settings?: Settings } | null)?.settings;
  if (!settings) return result;
  return { ...(result as object), settings: withLocalTheme(settings, theme) };
}

export interface ThemeUpdateSplit {
  /** 要写到本机的主题,patch 里没有时为 undefined */
  theme: ThemeId | undefined;
  /** 要转发给 Host 的其余部分,为空时是 null,此时不需要转发 */
  rest: DeepPartial<Settings> | null;
}

/** 把远程窗口的设置更新拆成本机主题和转发给 Host 的部分。不修改入参。 */
export function splitThemeUpdate(partial: DeepPartial<Settings>): ThemeUpdateSplit {
  const theme = partial.appearance?.theme;
  if (theme === undefined) return { theme: undefined, rest: partial };

  const appearance = { ...partial.appearance };
  delete appearance.theme;
  const rest: DeepPartial<Settings> = { ...partial, appearance };
  if (Object.keys(appearance).length === 0) delete rest.appearance;
  return { theme, rest: Object.keys(rest).length > 0 ? rest : null };
}
