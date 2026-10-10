import {useEffect, useRef} from 'react';
import {animate} from 'motion/mini';
import {useDocumentVisible, useMediaPreference} from '../../app/AppProviders';
import {useLauncherStore} from '../launcher/launcher.store';

export function PreviewSkeleton({reducedMotion = false}: {reducedMotion?: boolean}) {
  const shimmer = useRef<HTMLSpanElement>(null);
  const played = useRef(false);
  const visible = useLauncherStore((state) => state.visible);
  const documentVisible = useDocumentVisible();
  const forcedColors = useMediaPreference('(forced-colors: active)');
  const canAnimate = visible && documentVisible && !reducedMotion && !forcedColors;
  useEffect(() => {
    if (!canAnimate || !shimmer.current || played.current) return;
    played.current = true;
    const sweep = animate(shimmer.current, {transform: ['translateX(-110%)', 'translateX(310%)']}, {duration: 1.4, ease: 'easeInOut'});
    return () => sweep.stop();
  }, [canAnimate]);
  return (
    <div aria-label="Loading preview" className="relative grid min-h-70 content-start gap-3 overflow-hidden bg-canvas high-contrast:bg-[Canvas] p-4" role="status" data-preview-surface="opaque">
      <div className="mb-1 h-36 w-full rounded-control border border-[color:var(--einui-command-divider)] bg-[var(--einui-command-row)]" />
      <div className="h-[18px] w-[56%] rounded-pill bg-[var(--einui-command-row)]" />
      <div className="h-3 w-[78%] rounded-pill bg-[var(--einui-command-row)]" />
      <div className="h-3 w-full rounded-pill bg-[var(--einui-command-row)]" />
      <div className="h-3 w-[42%] rounded-pill bg-[var(--einui-command-row)]" />
      {canAnimate ? <span ref={shimmer} aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-[35%] bg-[linear-gradient(100deg,transparent_0%,var(--einui-command-row-selected)_50%,transparent_100%)]" style={{transform: 'translateX(-110%)'}} /> : null}
    </div>
  );
}
