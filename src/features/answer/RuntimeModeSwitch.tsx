import {useId} from 'react';

import type {RuntimeMode} from '../../services/answer/answer.types';

const modes: readonly {id: RuntimeMode; label: string}[] = [
  {id: 'auto', label: 'Auto'}, {id: 'local', label: 'Local'}, {id: 'cloud', label: 'Cloud'},
];

export interface RuntimeModeSwitchProps {
  mode: RuntimeMode;
  onChange(mode: RuntimeMode): void;
}

export function RuntimeModeSwitch({mode, onChange}: RuntimeModeSwitchProps) {
  const name = useId();
  return (
    <fieldset aria-label="Answer runtime" className="inline-flex min-w-0 gap-[2px] rounded-pill border border-[color:var(--einui-command-divider)] bg-[var(--einui-command-row)] p-[2px]">
      <legend className="sr-only">Answer runtime</legend>
      {modes.map((option) => (
        <label key={option.id} className={`inline-flex min-h-[32px] min-w-[32px] cursor-default items-center justify-center rounded-pill px-[8px] font-sans text-[0.6875rem] font-medium text-[color:var(--einui-command-muted-text)] outline-none transition-colors duration-[var(--lumen-duration-hover)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--lumen-focus)] ${mode === option.id ? 'bg-[var(--einui-command-row-selected)] text-[color:var(--einui-command-text)] shadow-control' : ''}`}>
          <input checked={mode === option.id} className="sr-only" name={name} type="radio" value={option.id} onChange={() => onChange(option.id)} />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
