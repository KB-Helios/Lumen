import type {ReactNode} from 'react';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export interface StatusBadgeProps {
  children: ReactNode;
  tone?: StatusTone;
}

export function StatusBadge({children, tone = 'neutral'}: StatusBadgeProps) {
  return (
    <span className={['inline-flex min-h-[22px] min-w-0 max-w-full items-center gap-[6px] rounded-pill border border-border-subtle bg-surface-inset px-[10px] py-[3px] font-sans text-xs font-medium', tone === 'info' ? 'bg-accent/10 text-accent' : tone === 'success' ? 'bg-success/10 text-success' : tone === 'warning' ? 'bg-warning/10 text-warning' : tone === 'error' ? 'bg-danger/10 text-danger' : 'text-text-secondary'].join(' ')}>
      <span aria-hidden="true" className="size-[6px] shrink-0 rounded-pill bg-current" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </span>
  );
}
