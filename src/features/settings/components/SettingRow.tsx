import type {ReactNode} from 'react';

import {LumenText} from '../../../design-system/primitives/LumenText';

export interface SettingRowProps {
  children: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  label: ReactNode;
  status?: ReactNode;
}

export function SettingRow({children, description, error, label, status}: SettingRowProps) {
  return (
    <div className="grid min-h-[62px] min-w-0 grid-cols-[minmax(0,1fr)] items-center gap-[12px] border-b border-border-subtle p-[16px] last:border-b-0 @min-[32rem]/settings:grid-cols-[minmax(0,1fr)_minmax(0,.85fr)] @min-[32rem]/settings:gap-[24px]">
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <LumenText weight="medium">{label}</LumenText>
          {status}
        </div>
        {description ? <LumenText tone="tertiary" variant="meta">{description}</LumenText> : null}
        {error ? <LumenText className="text-danger" role="alert" variant="meta">{error}</LumenText> : null}
      </div>
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-[8px] @min-[32rem]/settings:justify-end">{children}</div>
    </div>
  );
}
