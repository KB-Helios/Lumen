import type {CSSProperties, PropsWithChildren, ProfilerOnRenderCallback} from 'react';
import {Profiler, useEffect, useMemo, useRef, useSyncExternalStore} from 'react';
import {UNSAFE_PortalProvider} from 'react-aria';
import {LumenMotionProvider} from '../design-system/MotionProvider';
import type {AppearancePreferences} from '../design-system/theme';
import {
  captureReactCommit,
  readDiagnosticMetrics,
  resetDiagnosticMetrics,
  startDiagnosticsObserver,
} from '../features/diagnostics/diagnostics.metrics';
import {useAppearanceStore} from '../state/appearance.store';
import {useSettingsStore} from '../features/settings/settings.store';

function subscribeToMedia(query: string, onChange: () => void) {
  if (typeof window.matchMedia !== 'function') {
    return () => undefined;
  }

  const media = window.matchMedia(query);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function readMedia(query: string) {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

export function useMediaPreference(query: string) {
  return useSyncExternalStore(
    (onChange) => subscribeToMedia(query, onChange),
    () => readMedia(query),
    () => false,
  );
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

export function useDocumentVisible() {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState !== 'hidden', () => false);
}

interface AppProvidersProps extends PropsWithChildren {
  appearance?: AppearancePreferences;
  forceHighContrast?: boolean;
}

const recordCommit: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  captureReactCommit(actualDuration);
};

export function AppProviders({
  children,
  appearance,
  forceHighContrast = false,
}: AppProvidersProps) {
  const storedMode = useAppearanceStore((state) => state.mode);
  const storedTransparency = useAppearanceStore((state) => state.transparency);
  const storedEffects = useAppearanceStore((state) => state.effects);
  const storedMotion = useAppearanceStore((state) => state.motion);
  const storedDensity = useAppearanceStore((state) => state.density);
  const glassIntensity = useSettingsStore((state) => state.hydrated ? state.presentation.glassIntensity : undefined);
  const hydrateAppearance = useAppearanceStore((state) => state.hydrate);
  const storedAppearance = useMemo<AppearancePreferences>(
    () => ({
      mode: storedMode,
      transparency: storedTransparency,
      effects: storedEffects,
      motion: storedMotion,
    }),
    [storedEffects, storedMode, storedMotion, storedTransparency],
  );
  const resolvedAppearance = appearance ?? storedAppearance;
  const systemDark = useMediaPreference('(prefers-color-scheme: dark)');
  const systemReducedMotion = useMediaPreference('(prefers-reduced-motion: reduce)');
  const forcedColors = useMediaPreference('(forced-colors: active)');
  const prefersMoreContrast = useMediaPreference('(prefers-contrast: more)');
  const highContrast = forceHighContrast || forcedColors || prefersMoreContrast;
  const resolvedMode = resolvedAppearance.mode === 'system'
    ? systemDark
      ? 'dark'
      : 'light'
    : resolvedAppearance.mode;
  const reducedMotion = resolvedAppearance.motion === 'reduced' ||
    (resolvedAppearance.motion === 'system' && systemReducedMotion);
  const portalContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (appearance === undefined) {
      void hydrateAppearance();
    }
  }, [appearance, hydrateAppearance]);

  useEffect(() => startDiagnosticsObserver(), []);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    const diagnosticsWindow = window as typeof window & {
      __LUMEN_DIAGNOSTICS__?: {
        read: typeof readDiagnosticMetrics;
        reset: typeof resetDiagnosticMetrics;
      };
    };
    diagnosticsWindow.__LUMEN_DIAGNOSTICS__ = {
      read: readDiagnosticMetrics,
      reset: resetDiagnosticMetrics,
    };
    return () => {
      delete diagnosticsWindow.__LUMEN_DIAGNOSTICS__;
    };
  }, []);

  return (
    <LumenMotionProvider reducedMotion={reducedMotion}>
      <div
        ref={portalContainerRef}
        className="h-full w-full bg-transparent font-sans text-text-primary"
        role="application"
        aria-label="Lumen"
        data-theme={resolvedAppearance.mode}
        data-resolved-theme={resolvedMode}
        data-transparency={resolvedAppearance.transparency}
        data-contrast={highContrast ? 'high' : 'standard'}
        data-effects={resolvedAppearance.effects}
        data-density={storedDensity}
        data-motion={resolvedAppearance.motion}
        data-reduced-motion={reducedMotion}
        style={glassIntensity === undefined ? undefined : {'--lumen-glass-strength': glassIntensity / 72} as CSSProperties}
      >
        <UNSAFE_PortalProvider getContainer={() => portalContainerRef.current ?? document.body}>
          <Profiler id="Lumen" onRender={recordCommit}>{children}</Profiler>
        </UNSAFE_PortalProvider>
      </div>
    </LumenMotionProvider>
  );
}
