/**
 * @file src/renderer/components/use-named-notice.ts
 * @purpose Hook for notices that address the user by name (ADR-052).
 *
 * @关键设计:
 * - Works like tx(zh, en) and adds settings.behavior.userName to the end of the chosen text
 *   (withUserName in shared/user-name.ts). Without a name the text is exactly what tx gives.
 * - Only for app to user notices (toasts that tell the user something happened or is waiting).
 *   Labels, buttons and error messages keep using tx so they stay neutral.
 *
 * @对应文档章节:软件定义书.md ADR-052
 *
 * @不要在这里做的事:
 * - Do not use it for text sent to an agent or a terminal.
 */
import { useCallback } from 'react';
import { withUserName } from '@shared/user-name';
import { useAppState } from '../store';
import { useTranslation } from './LanguageProvider';

/** Returns txNamed(zh, en): tx plus the user name at the end when one is set. */
export function useNamedNotice(): (zh: string, en: string) => string {
  const { locale, tx } = useTranslation();
  const name = useAppState().settings.behavior?.userName ?? '';
  return useCallback(
    (zh: string, en: string) => withUserName(tx(zh, en), name, locale === 'zh-CN'),
    // locale is a dependency on purpose: tx reads the current locale.
    [locale, tx, name],
  );
}
