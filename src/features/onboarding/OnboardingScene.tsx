import type {ReactNode} from 'react';

import {LumenText} from '../../design-system/primitives/LumenText';

export interface OnboardingSceneProps {
  description: string;
  icon: ReactNode;
  support: string;
  title: string;
  children?: ReactNode;
}

export function OnboardingScene({
  children,
  description,
  icon,
  support,
  title,
}: OnboardingSceneProps) {
  return (
    <div className="mx-auto grid min-w-0 w-full max-w-[680px] justify-items-center gap-[24px] px-[24px] text-center [overflow-wrap:anywhere]">
      <div aria-hidden="true" className="grid size-[88px] place-items-center rounded-surface border border-border-strong bg-surface-inset text-text-secondary">{icon}</div>
      <div className="grid min-w-0 w-full max-w-[576px] gap-[16px]">
        <LumenText as="h1" variant="title" weight="semibold">{title}</LumenText>
        <LumenText variant="bodyLarge">{description}</LumenText>
        <LumenText tone="secondary">{support}</LumenText>
      </div>
      {children}
    </div>
  );
}
