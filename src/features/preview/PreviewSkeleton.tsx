import {motion} from 'motion/react';

export function PreviewSkeleton({reducedMotion = false}: {reducedMotion?: boolean}) {
  return (
    <div aria-label="Loading preview" className="relative grid min-h-70 content-start gap-3 overflow-hidden bg-canvas high-contrast:bg-[Canvas] p-4" role="status" data-preview-surface="opaque">
      <div className="mb-1 h-36 w-full rounded-control border border-[color:var(--einui-command-divider)] bg-[var(--einui-command-row)]" />
      <div className="h-[18px] w-[56%] rounded-pill bg-[var(--einui-command-row)]" />
      <div className="h-3 w-[78%] rounded-pill bg-[var(--einui-command-row)]" />
      <div className="h-3 w-full rounded-pill bg-[var(--einui-command-row)]" />
      <div className="h-3 w-[42%] rounded-pill bg-[var(--einui-command-row)]" />
      {reducedMotion ? null : <motion.span aria-hidden="true" animate={{transform: ['translateX(-110%)', 'translateX(310%)']}} className="pointer-events-none absolute inset-y-0 left-0 w-[35%] bg-[linear-gradient(100deg,transparent_0%,var(--einui-command-row-selected)_50%,transparent_100%)]" transition={{duration: 1.4, ease: 'easeInOut', repeat: Infinity}} />}
    </div>
  );
}
