/**
 * @file ColonCommandsSettings.tsx
 * @purpose The list editor for the `name:` commands extension (ADR-019) in Settings →
 *          Extensions: shows each saved `name:` → command pair, removes one with ×, adds one
 *          from two inputs.
 *
 * @关键设计:
 * - Every change goes straight to settings (no save button); the parent passes `onChange`.
 * - An empty command field means `/name`, the common case, so most entries need one field.
 * - The form checks the entry with the same rule main uses (colonCommandProblem) and shows
 *   the reason under the inputs instead of sending a list main would reject.
 *
 * @不要在这里做的事:
 * - Do not edit entries in place; remove and add again. It keeps the form to one rule.
 */
import { useState, type FormEvent } from 'react';
import { COLON_COMMANDS_MAX, colonCommandProblem, type ColonCommand } from '@shared/colon-commands';
import { Icon } from './icons';
import { useTranslation } from './LanguageProvider';

export function ColonCommandsSettings({
  commands,
  onChange,
}: {
  commands: ColonCommand[];
  onChange: (next: ColonCommand[]) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const full = commands.length >= COLON_COMMANDS_MAX;

  const handleAdd = (e: FormEvent): void => {
    e.preventDefault();
    const entry = { name: name.trim(), command: command.trim() || `/${name.trim()}` };
    const why = colonCommandProblem(entry, commands);
    if (why) {
      setProblem(why);
      return;
    }
    onChange([...commands, entry]);
    setName('');
    setCommand('');
    setProblem(null);
  };

  return (
    <div className="colon-commands">
      {commands.length > 0 && (
        <ul className="colon-commands-list">
          {commands.map((c) => (
            <li key={c.name.toLowerCase()} className="colon-commands-item">
              <code className="colon-commands-name">{c.name}:</code>
              <span className="colon-commands-arrow" aria-hidden="true">
                →
              </span>
              <code className="colon-commands-command">{c.command}</code>
              <button
                type="button"
                className="colon-commands-remove"
                title={tx(`删除 ${c.name}:`, `Remove ${c.name}:`)}
                aria-label={tx(`删除 ${c.name}:`, `Remove ${c.name}:`)}
                onClick={() => onChange(commands.filter((o) => o !== c))}
              >
                <Icon name="close" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="colon-commands-form" onSubmit={handleAdd}>
        <input
          className="settings-input"
          value={name}
          disabled={full}
          placeholder={tx('名称,如 plan', 'Name, e.g. plan')}
          aria-label={tx('名称', 'Name')}
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value);
            setProblem(null);
          }}
        />
        <input
          className="settings-input"
          value={command}
          disabled={full}
          placeholder={
            name.trim() ? `/${name.trim()}` : tx('命令,留空即 /名称', 'Command, empty means /name')
          }
          aria-label={tx('命令', 'Command')}
          spellCheck={false}
          onChange={(e) => {
            setCommand(e.target.value);
            setProblem(null);
          }}
        />
        <button type="submit" className="settings-button" disabled={full || !name.trim()}>
          <Icon name="plus" size={16} />
          {tx('添加', 'Add')}
        </button>
      </form>
      {problem && <p className="colon-commands-problem">{problem}</p>}
      {full && (
        <p className="colon-commands-hint">
          {tx(`最多 ${COLON_COMMANDS_MAX} 项`, `Up to ${COLON_COMMANDS_MAX} items`)}
        </p>
      )}
    </div>
  );
}
