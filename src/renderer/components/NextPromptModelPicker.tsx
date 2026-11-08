/**
 * @file src/renderer/components/NextPromptModelPicker.tsx
 * @purpose The model choice for next prompt suggestions: a list read from the API address,
 *   with a few recommended OpenRouter models and their reasons on top, so the user picks a
 *   model instead of pasting its id. "Other" still allows typing any id.
 *
 * @关键设计:
 * - The list comes from GET /models of the address in settings, fetched by the main
 *   process (the Host for a remote view), so it always matches where guesses go.
 * - Choosing the default model saves '', so a later change of default reaches the user.
 * - Recommended entries are OpenRouter ids, so they appear only with the default address.
 *
 * @对应文档章节:无独立章节;设置 → AI 助手 → 下一步提示建议
 *
 * @不要在这里做的事:
 * - 不要在 renderer 里直接 fetch 模型列表,CSP 不放行外部地址,而且远程视图要问 Host
 */
import { useEffect, useMemo, useState } from 'react';
import {
  NEXT_PROMPT_DEFAULT_MODEL,
  RECOMMENDED_NEXT_PROMPT_MODELS,
  formatModelPrice,
  type NextPromptModelOption,
} from '@shared/next-prompt';
import { COMMAND_CHANNELS, type ListNextPromptModelsResponse } from '@shared/protocol';
import { useTranslation } from './LanguageProvider';

const OTHER = '__other__';
/** Wait for the user to stop typing an address before asking it for models. */
const REFETCH_DELAY_MS = 600;

export function NextPromptModelPicker({
  model,
  baseURL,
  keySaved,
  onChange,
}: {
  model: string;
  baseURL: string;
  /** Refetch on connect or disconnect, since some providers list models only to members. */
  keySaved: boolean;
  onChange: (model: string) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const [models, setModels] = useState<NextPromptModelOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const usesOpenRouter = !baseURL.trim();

  // Refetch when the address or the account changes: both decide which models answer.
  useEffect(() => {
    let stale = false;
    const timer = window.setTimeout(() => {
      window.api
        .invoke<undefined, ListNextPromptModelsResponse>(
          COMMAND_CHANNELS.AI_LIST_NEXT_PROMPT_MODELS,
          undefined,
        )
        .then((res) => {
          if (stale) return;
          setModels(res.models);
          setLoadError(null);
        })
        .catch((err: unknown) => {
          if (stale) return;
          setModels(null);
          setLoadError(err instanceof Error ? err.message : String(err));
        });
    }, REFETCH_DELAY_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [baseURL, keySaved]);

  const recommended = usesOpenRouter ? RECOMMENDED_NEXT_PROMPT_MODELS : [];
  const byId = useMemo(() => new Map((models ?? []).map((m) => [m.id, m])), [models]);
  const others = (models ?? []).filter((m) => !recommended.some((r) => r.id === m.id));

  const current = model.trim() || (usesOpenRouter ? NEXT_PROMPT_DEFAULT_MODEL : '');
  const listed = recommended.some((r) => r.id === current) || byId.has(current);
  const unlisted = current !== '' && !listed;
  const loaded = models !== null || loadError !== null;
  // An id typed by hand, or one the provider does not list, keeps its text box. So does a
  // custom address whose list cannot be read, since then there is nothing to choose from.
  const showInput =
    typing || (unlisted && loaded) || (loadError !== null && recommended.length === 0);
  const selectValue = showInput ? OTHER : current;

  const withPrice = (label: string, id: string): string => {
    const m = byId.get(id);
    const price = m ? formatModelPrice(m) : '';
    return price ? `${label} · ${price}` : label;
  };

  return (
    <div className="next-prompt-model">
      <select
        className="settings-input"
        value={selectValue}
        onChange={(e) => {
          const id = e.target.value;
          if (id === OTHER) {
            setTyping(true);
            return;
          }
          setTyping(false);
          onChange(usesOpenRouter && id === NEXT_PROMPT_DEFAULT_MODEL ? '' : id);
        }}
      >
        {selectValue === '' && <option value="">{tx('请选择模型', 'Choose a model')}</option>}
        {/* While the list loads, a saved id not yet known still shows as itself. */}
        {unlisted && !showInput && <option value={current}>{current}</option>}
        {recommended.length > 0 && (
          <optgroup label={tx('推荐', 'Recommended')}>
            {recommended.map((r) => (
              <option key={r.id} value={r.id}>
                {withPrice(tx(r.zh, r.en), r.id)}
              </option>
            ))}
          </optgroup>
        )}
        {others.length > 0 && (
          <optgroup
            label={tx(
              `全部 ${others.length} 个,便宜的在前(每百万 token 输入 / 输出价)`,
              `All ${others.length}, cheapest first (input / output per million tokens)`,
            )}
          >
            {others.map((m) => (
              <option key={m.id} value={m.id}>
                {withPrice(m.name, m.id)}
              </option>
            ))}
          </optgroup>
        )}
        <option value={OTHER}>{tx('其他,手动填写模型名…', 'Other, type a model id…')}</option>
      </select>
      {showInput && (
        <input
          className="settings-input"
          type="text"
          spellCheck={false}
          autoFocus={typing}
          placeholder={usesOpenRouter ? NEXT_PROMPT_DEFAULT_MODEL : 'model id'}
          value={model}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {loadError && (
        <div className="settings-row-hint">
          {tx(`无法读取模型列表:${loadError}`, `Cannot read the model list: ${loadError}`)}
        </div>
      )}
      {models === null && !loadError && (
        <div className="settings-row-hint">{tx('正在读取模型列表…', 'Reading the model list…')}</div>
      )}
    </div>
  );
}
