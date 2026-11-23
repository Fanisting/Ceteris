/**
 * @file src/renderer/components/PushVoiceSettings.tsx
 * @purpose Settings → Notifications, the AI voice part (ADR-057): turn AI-written done
 *   notifications on, pick one of five voices, see two example notifications of the picked
 *   voice, choose what the model sees, and send a real sample.
 *
 * @关键设计:
 * - Clicking a voice card selects it and shows its examples right below the cards, in the
 *   app language, with the user's name filled in. The examples are real outputs from the
 *   2026-11-22 test (src/shared/push-voice.ts), so they show what the voice really writes.
 * - Two context levels as two radio buttons (names only / also the answer's end), because
 *   the second sends screen text to OpenRouter and the user should see that choice plainly.
 * - Without a connected OpenRouter key the switch still works, and a hint says where to
 *   connect; until then every notification uses the plain text.
 *
 * @对应文档章节:软件定义书.md ADR-057
 *
 * @不要在这里做的事:
 * - No model calls here; "Send a sample" goes through cmd:notify:test with { voice: true }.
 * - Do not save settings directly; the parent passes update (SettingsView's updateSettings).
 */
import { useState } from 'react';
import type { DeepPartial } from '@shared/types-helpers';
import type { Settings } from '@shared/types';
import {
  COMMAND_CHANNELS,
  type NotifyTestPayload,
  type NotifyTestResponse,
} from '@shared/protocol';
import {
  PUSH_VOICE_DEFAULT_MODEL,
  PUSH_VOICES,
  voiceExamples,
  type PushVoiceId,
} from '@shared/push-voice';
import { useAppState } from '../store';
import { useTranslation } from './LanguageProvider';
import { SettingRow } from './SettingsView';

const DEFAULT_AI: Settings['notifications']['ai'] = {
  enabled: false,
  voice: 'mascot',
  model: '',
  includeAnswer: true,
};

export function PushVoiceSettings({
  update,
  setError,
}: {
  update: (partial: DeepPartial<Settings>) => void;
  setError: (msg: string | null) => void;
}): JSX.Element {
  const state = useAppState();
  const { tx, locale } = useTranslation();
  const zh = locale === 'zh-CN';
  const ai = state.settings.notifications?.ai ?? DEFAULT_AI;
  const keySaved = state.settings.ai?.nextPrompt?.keySaved === true;
  const userName = state.settings.behavior?.userName ?? '';
  const [model, setModel] = useState(ai.model);
  const [sample, setSample] = useState<
    { state: 'sending' } | { state: 'done'; result: NotifyTestResponse } | null
  >(null);

  const setAi = (partial: Partial<Settings['notifications']['ai']>): void =>
    update({ notifications: { ai: partial } });

  const pickVoice = (id: PushVoiceId): void => {
    setSample(null);
    if (id !== ai.voice) setAi({ voice: id });
  };

  const sendSample = (): void => {
    setSample({ state: 'sending' });
    window.api
      .invoke<NotifyTestPayload, NotifyTestResponse>(COMMAND_CHANNELS.NOTIFY_TEST, { voice: true })
      .then((result) => setSample({ state: 'done', result }))
      .catch((err: unknown) => {
        setSample(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const examples = voiceExamples(ai.voice, zh, userName);

  return (
    <>
      <SettingRow
        label={tx('让 AI 用可爱的语气写通知', 'Cute notifications written by AI')}
        hint={tx(
          '回答完的通知由 AI 写:说清做成了什么、还差你哪一步,用下面选的语气。用你在 设置 → AI 助手 连接的 OpenRouter;每条约 0.00005 美元,1 秒左右。AI 没及时回复时照常发普通通知。',
          'An AI writes each done notification: what got done and the one step left for you, in the voice below. Uses the OpenRouter account connected in Settings → AI, about $0.00005 and 1 second per notification. If the AI does not answer in time, the plain notification goes out.',
        )}
      >
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={ai.enabled}
            onChange={(e) => setAi({ enabled: e.target.checked })}
          />
          <span>{tx('启用', 'Enable')}</span>
        </label>
        {ai.enabled && !keySaved && (
          <span className="settings-row-hint">
            {tx(
              '还没连接 OpenRouter:在 设置 → AI 助手 点"连接 OpenRouter"。连好之前发的是普通通知。',
              'OpenRouter is not connected yet: click "Connect OpenRouter" in Settings → AI. Until then you get plain notifications.',
            )}
          </span>
        )}
      </SettingRow>

      {ai.enabled && (
        <>
          <div className="push-voice">
            <div className="settings-row-label">{tx('语气', 'Voice')}</div>
            <div className="push-voice-cards" role="radiogroup" aria-label={tx('语气', 'Voice')}>
              {PUSH_VOICES.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="radio"
                  aria-checked={ai.voice === v.id}
                  className={`push-voice-card${ai.voice === v.id ? ' is-picked' : ''}`}
                  onClick={() => pickVoice(v.id)}
                >
                  <span className="push-voice-letter">{v.letter}</span>
                  <span className="push-voice-name">{zh ? v.name.zh : v.name.en}</span>
                  <span className="push-voice-blurb">{zh ? v.blurb.zh : v.blurb.en}</span>
                </button>
              ))}
            </div>
            <div className="settings-row-hint">
              {tx('这个语气写出来的样子 (真实输出):', 'What this voice writes (real outputs):')}
            </div>
            <div className="push-voice-examples" aria-live="polite">
              {examples.map((e, i) => (
                <div key={`${ai.voice}-${i}`} className="push-voice-toast">
                  <div className="push-voice-toast-app">
                    <span className="push-voice-toast-icon" aria-hidden="true" />
                    Ceteris
                    <span className={`push-voice-toast-kind${i === 1 ? ' is-waiting' : ''}`}>
                      {i === 0 ? tx('回答完', 'done') : tx('等你决定', 'needs you')}
                    </span>
                  </div>
                  <div className="push-voice-toast-title">{e.title}</div>
                  <div className="push-voice-toast-body">{e.body}</div>
                </div>
              ))}
            </div>
            <div className="push-voice-actions">
              <button
                type="button"
                className="settings-button"
                onClick={sendSample}
                disabled={sample?.state === 'sending'}
              >
                {sample?.state === 'sending'
                  ? tx('AI 正在写…', 'Writing…')
                  : tx('用这个语气发一条真的试试', 'Send a real one in this voice')}
              </button>
              {sample?.state === 'done' && (
                <span className="settings-row-hint">
                  {!sample.result.shown
                    ? tx(
                        '这台电脑没有可用的通知服务。',
                        'This computer has no notification service Ceteris can use.',
                      )
                    : sample.result.written
                      ? tx(
                          '已发送,看右下角 (macOS 右上角)。内容是 AI 按一轮假想的"修好登录测试"写的。',
                          'Sent; look at the corner of the screen. The AI wrote it for a made up "login tests fixed" turn.',
                        )
                      : tx(
                          `AI 没写出来,发了普通测试通知。原因:${sample.result.error ?? ''}`,
                          `The AI wrote nothing, so the plain test went out. Reason: ${sample.result.error ?? ''}`,
                        )}
                </span>
              )}
            </div>
          </div>

          <SettingRow
            label={tx('AI 能看到什么', 'What the AI sees')}
            hint={tx(
              '只发名字时,通知只能说"哪个标签好了"。带上回答末尾,通知才说得出"42 个测试全过"或"卡在第 3 步等你选"。内容只发给 OpenRouter。',
              'With names only, a notification can only say which tab is ready. With the end of the answer it can say "42 tests pass" or "stopped at step 3, needs your pick". Sent to OpenRouter only.',
            )}
          >
            <div className="settings-radio-group">
              <label className="settings-radio">
                <input
                  type="radio"
                  name="push-voice-context"
                  checked={!ai.includeAnswer}
                  onChange={() => setAi({ includeAnswer: false })}
                />
                {tx(
                  '只发名字 (agent、标签名、文件夹、用时、你的称呼)',
                  'Names only (agent, tab name, folder, minutes, your name)',
                )}
              </label>
              <label className="settings-radio">
                <input
                  type="radio"
                  name="push-voice-context"
                  checked={ai.includeAnswer}
                  onChange={() => setAi({ includeAnswer: true })}
                />
                {tx('再加上回答的最后 600 个字', 'Also the last 600 characters of the answer')}
              </label>
            </div>
          </SettingRow>

          <SettingRow
            label={tx('模型', 'Model')}
            hint={tx(
              `OpenRouter 上的模型 id。留空用 ${PUSH_VOICE_DEFAULT_MODEL} (测试里又快又便宜,也最老实)。`,
              `An OpenRouter model id. Empty uses ${PUSH_VOICE_DEFAULT_MODEL} (fast, cheap and honest in our test).`,
            )}
          >
            <input
              className="settings-input"
              type="text"
              value={model}
              placeholder={PUSH_VOICE_DEFAULT_MODEL}
              maxLength={200}
              spellCheck={false}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => {
                const next = model.trim();
                if (next !== ai.model) setAi({ model: next });
              }}
            />
          </SettingRow>
        </>
      )}
    </>
  );
}
