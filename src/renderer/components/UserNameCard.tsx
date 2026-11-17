/**
 * @file src/renderer/components/UserNameCard.tsx
 * @purpose The one-time card that asks what Ceteris should call the user (ADR-052).
 *
 * @关键设计:
 * - A small card in the bottom right corner, the size of a toast. It is NOT modal: no
 *   backdrop, the rest of the window keeps working, and Enter / Escape only act while the
 *   name field has focus, so a terminal key press is never taken.
 * - Shown while settings.behavior.userNameAsked is false, only after the extension setup card
 *   is done (extensions.setupSeen) and not in the settings view, so only one first start card
 *   is on screen at a time (order: MainAgentCard, ExtensionSetupCard, this card).
 * - Save stores the cleaned name (sanitizeUserName) and userNameAsked = true; Skip stores only
 *   userNameAsked = true. Either way it never comes back; the name stays editable in
 *   Settings, Appearance.
 * - The field starts with the OS account name of this machine, first letter capitalised, when
 *   main can read it; otherwise it starts empty.
 *
 * @对应文档章节:软件定义书.md ADR-052;ipc-protocol.md cmd:system:get-os-user-name
 *
 * @不要在这里做的事:
 * - Do not pass the name to agents or terminals; it is only for app to user notices.
 * - Do not show it while another first start card is open.
 */
import { useEffect, useRef, useState } from 'react';
import { COMMAND_CHANNELS } from '@shared/protocol';
import { USER_NAME_MAX_LENGTH, sanitizeUserName, suggestUserName } from '@shared/user-name';
import { useAppState } from '../store';
import { useTranslation } from './LanguageProvider';
import { useToast } from './Toast';

export function UserNameCard(): JSX.Element | null {
  const { tx } = useTranslation();
  const state = useAppState();
  const toast = useToast();
  const asked = state.settings.behavior?.userNameAsked;
  const setupSeen = state.settings.extensions?.setupSeen === true;
  const show = asked === false && setupSeen && !state.inSettingsView;
  const [name, setName] = useState('');
  const [suggested, setSuggested] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!show || suggested) return;
    setSuggested(true);
    window.api
      .invoke<unknown, { userName: string }>(COMMAND_CHANNELS.SYSTEM_GET_OS_USER_NAME, {})
      .then((res) => setName((cur) => cur || suggestUserName(res.userName)))
      .catch((err) => console.warn('[UserNameCard] no OS user name suggestion', err));
  }, [show, suggested]);

  useEffect(() => {
    if (show) inputRef.current?.focus();
  }, [show]);

  if (!show) return null;

  const answer = async (save: boolean): Promise<void> => {
    setBusy(true);
    try {
      await window.api.invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, {
        partial: {
          behavior: save
            ? { userName: sanitizeUserName(name), userNameAsked: true }
            : { userNameAsked: true },
        },
      });
    } catch (err) {
      toast.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="toast user-name-card" role="dialog" aria-label={tx('称呼', 'Your name')}>
      <div className="user-name-card-title">
        {tx('你好!我该怎么称呼你?', 'Hi! What should I call you?')}
      </div>
      <input
        ref={inputRef}
        className="user-name-card-input"
        type="text"
        value={name}
        maxLength={USER_NAME_MAX_LENGTH}
        spellCheck={false}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void answer(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            void answer(false);
          }
        }}
      />
      <div className="user-name-card-actions">
        <button
          type="button"
          className="toast-action"
          disabled={busy}
          onClick={() => void answer(false)}
        >
          {tx('跳过', 'Skip')}
        </button>
        <button
          type="button"
          className="toast-action user-name-card-save"
          disabled={busy}
          onClick={() => void answer(true)}
        >
          {tx('保存', 'Save')}
        </button>
      </div>
    </div>
  );
}
