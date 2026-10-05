import {forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode} from 'react';

import {cn} from '../../lib/cn';

export type LumenMaterial = 'mica' | 'raised' | 'inset' | 'flat';

export interface LumenSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  material?: LumenMaterial;
}

const materialClasses: Record<LumenMaterial, string> = {
  mica: 'bg-surface-glass shadow-surface backdrop-blur-[24px] backdrop-saturate-[105%]',
  raised: 'bg-surface-raised shadow-control backdrop-blur-[16px]',
  inset: 'bg-surface-inset shadow-none',
  flat: 'bg-surface-glass shadow-none',
};

const noiseStyle = {
  '--lumen-surface-noise': 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 180 180\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'.92\' numOctaves=\'3\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\' opacity=\'.72\'/%3E%3C/svg%3E")',
} as CSSProperties;

export const LumenSurface = forwardRef<HTMLDivElement, LumenSurfaceProps>(
  function LumenSurface(
    {children, className, material = 'mica', ...props},
    ref,
  ) {
    return (
      <div
        {...props}
        ref={ref}
        className={cn(
          'relative isolate overflow-hidden border border-border-subtle text-text-primary high-contrast:shadow-none',
          materialClasses[material],
          className,
        )}
        data-material={material}
      >
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-30 rounded-[inherit] shadow-[inset_0_1px_0_var(--lumen-border-specular)]" />
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-20 bg-[radial-gradient(120%_90%_at_14%_-18%,rgba(255,255,255,0.025),transparent_54%)]" />
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[image:var(--lumen-surface-noise)] bg-repeat opacity-[0.018] mix-blend-soft-light [background-size:180px_180px]" style={noiseStyle} />
        {children}
      </div>
    );
  },
);

