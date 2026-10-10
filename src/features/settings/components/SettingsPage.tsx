import type {PropsWithChildren, ReactNode} from 'react';

import {LumenText} from '../../../design-system/primitives/LumenText';
import {LumenUiIcon} from '../../../design-system/icons/LumenUiIcon';

export function SettingsPage({children}: PropsWithChildren) {
  return <div className="@container/settings grid min-w-0 w-full content-start gap-[24px] [overflow-wrap:anywhere]">{children}</div>;
}

export function SettingsCallout({children, tone = 'info'}: {children: ReactNode; tone?: 'info' | 'warning' | 'error'}) {
  return (
    <div className={['flex min-w-0 items-start gap-[12px] rounded-control border border-border-subtle p-[16px]', tone === 'error' ? 'bg-danger/10' : tone === 'warning' ? 'bg-warning/10' : 'bg-surface-inset'].join(' ')} role={tone === 'error' ? 'alert' : 'status'}>
      <LumenUiIcon name={tone === 'info' ? 'info' : 'error'} size="small" className={`mt-0.5 shrink-0 ${tone === 'error' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-text-tertiary'}`} />
      <LumenText className="min-w-0 leading-relaxed" tone="secondary" variant="meta">{children}</LumenText>
    </div>
  );
}
