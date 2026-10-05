import type {PropsWithChildren, ReactNode} from 'react';

import {LumenText} from '../../../design-system/primitives/LumenText';

export interface SettingSectionProps extends PropsWithChildren {
  description?: ReactNode;
  title: string;
}

export function SettingSection({children, description, title}: SettingSectionProps) {
  const sectionId = `setting-section-${title.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <section aria-labelledby={sectionId} className="grid min-w-0 gap-[12px]" data-setting-section="true">
      <div className="grid min-w-0 gap-[4px]">
        <LumenText
          as="h2"
          id={sectionId}
          variant="bodyLarge"
          weight="semibold"
        >
          {title}
        </LumenText>
        {description ? <LumenText tone="tertiary" variant="meta">{description}</LumenText> : null}
      </div>
      <div className="min-w-0 rounded-surface border border-border-subtle bg-surface-raised">{children}</div>
    </section>
  );
}
