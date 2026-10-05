import {useEffect, useLayoutEffect, useRef, useState} from 'react';

import {gsap} from 'gsap';
import {CustomEase} from 'gsap/CustomEase';
import type {AnimationItem} from 'lottie-web/build/player/lottie_svg';

import {useMediaPreference} from '../../app/AppProviders';
import activityAnimation from './activity-indicator.json';

gsap.registerPlugin(CustomEase);
const lumenStandardEase = CustomEase.create('lumen-standard', '0.2,0.8,0.2,1');

export interface ActivityIndicatorProps {
  active: boolean;
  reducedMotion: boolean;
  tone: 'success' | 'warning';
}

function ThreeDotMark({forcedColorsOnly = false}: {forcedColorsOnly?: boolean}) {
  return (
    <span
      className={forcedColorsOnly
        ? 'lumen-activity-forced-fallback hidden items-center gap-0.5'
        : 'inline-flex items-center gap-0.5 opacity-55'}
      data-static-activity="three"
    >
      <span className="size-1 rounded-full bg-current" data-static-activity="dot" />
      <span className="size-1 rounded-full bg-current" data-static-activity="dot" />
      <span className="size-1 rounded-full bg-current" data-static-activity="dot" />
    </span>
  );
}

export function ActivityIndicator({
  active,
  reducedMotion,
  tone,
}: ActivityIndicatorProps) {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const hostRef = useRef<HTMLSpanElement>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const forcedColors = useMediaPreference('(forced-colors: active)');
  const animationRunning = active && !reducedMotion && !loadFailed && !forcedColors;
  const color = active ? 'text-accent' : tone === 'warning' ? 'text-warning' : 'text-success';

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || reducedMotion || forcedColors) return;
    const context = gsap.context(() => {
      gsap.fromTo(
        wrapper,
        {autoAlpha: 0, y: 4, willChange: 'transform,opacity'},
        {
          autoAlpha: 1,
          clearProps: 'opacity,transform,visibility,willChange',
          duration: 0.14,
          ease: lumenStandardEase,
          force3D: true,
          y: 0,
        },
      );
    }, wrapper);
    return () => context.revert();
  }, [active, reducedMotion, forcedColors]);

  useEffect(() => {
    const host = hostRef.current;
    if (!animationRunning || !host) return;
    let cancelled = false;
    let instance: AnimationItem | undefined;
    void import('lottie-web/build/player/lottie_svg')
      .then(({default: lottie}) => {
        if (cancelled) return;
        try {
          instance = lottie.loadAnimation({
            animationData: activityAnimation,
            autoplay: true,
            container: host,
            loop: true,
            renderer: 'svg',
            rendererSettings: {
              hideOnTransparent: true,
              progressiveLoad: false,
            },
          });
          // Interpolate the 60 fps artwork at the display's rAF cadence.
          instance.setSubframe(true);
        } catch {
          instance?.destroy();
          instance = undefined;
          setLoadFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
      instance?.destroy();
    };
  }, [animationRunning]);

  return (
    <span
      ref={wrapperRef}
      aria-hidden="true"
      className={`inline-grid h-2 w-4 shrink-0 place-items-center ${color}`}
      data-activity-indicator
      data-activity-running={animationRunning || undefined}
      data-activity-state={active ? 'active' : 'idle'}
    >
      {animationRunning ? (
        <>
          <span ref={hostRef} className="lumen-activity-lottie block h-2 w-4" data-lottie-host />
          <ThreeDotMark forcedColorsOnly />
        </>
      ) : active ? (
        <ThreeDotMark />
      ) : (
        <span
          className={`size-1.5 rounded-full bg-current ${tone === 'success' ? 'shadow-[0_0_9px_currentColor]' : ''}`}
          data-static-activity="single"
        />
      )}
    </span>
  );
}
