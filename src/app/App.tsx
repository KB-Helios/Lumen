import {lazy, Suspense, useCallback, useEffect, useState} from 'react';
import type {CSSProperties} from 'react';

import {LumenMark} from '../design-system/icons/LumenMark';
import {LumenSurface} from '../design-system/primitives/LumenSurface';
import {LumenText} from '../design-system/primitives/LumenText';
import type {AppearancePreferences} from '../design-system/theme';
import {SearchExperience} from '../features/launcher/SearchExperience';
import {useActivityStore} from '../features/activity/activity.store';
import {useLauncherStore} from '../features/launcher/launcher.store';
import {useQueryStore} from '../features/launcher/query.store';
import {
  requestWindowShow,
  useNativeLauncherLifecycle,
} from '../features/launcher/useLauncherPresentation';
import {useOnboardingStore} from '../features/onboarding/onboarding.store';
import {createIndexedRoot} from '../features/settings/indexed-root';
import {useSettingsStore} from '../features/settings/settings.store';
import {createWindowService} from '../platform/window/tauri-window-service';
import {windowGeometry} from '../platform/window/window-service';
import type {WindowMode, WindowService} from '../platform/window/window-service';
import {TauriAnswerService} from '../services/answer/tauri-answer-service';
import {WindowsAiAnswerService} from '../services/answer/windows-ai-answer-service';
import {CatalogueSearchService} from '../services/search/catalogue-search-service';
import {windowsAiService} from '../services/windows-ai';
import {getWindowsAiPreferences, useWindowsAiStore} from '../features/windows-ai/windows-ai.store';
import {UnavailableAnswerService} from '../services/answer/unavailable-answer-service';
import {TauriComputerUseService} from '../services/computer-use/tauri-computer-use-service';
import {UnavailableComputerUseService} from '../services/computer-use/unavailable-computer-use-service';
import {DevelopmentComputerUseService} from '../services/computer-use/development-computer-use-service';
import {isNativeRuntime, nativeAiService} from '../services/ai/native-ai-service';
import {
  createActivityService,
  type ActivityService,
  toActivityMode,
} from '../services/activity/activity-service';
import {DevelopmentFileSearchService} from '../services/search/development-file-search-service';
import {DevelopmentSearchService} from '../services/search/development-search-service';
import {AppProviders} from './AppProviders';

declare global {
  interface WindowEventMap {
    'lumen:diagnostics-show-launcher': CustomEvent<void>;
  }
}

const foundationAppearances: AppearancePreferences[] = [
  {mode: 'dark', transparency: 'native', effects: 'full', motion: 'full'},
  {mode: 'light', transparency: 'native', effects: 'full', motion: 'full'},
  {mode: 'dark', transparency: 'disabled', effects: 'reduced', motion: 'reduced'},
];

function createDefaultSearchService() {
  const useDevelopmentService = import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get('service') === 'memory';
  if (useDevelopmentService) {
    return new DevelopmentSearchService();
  }
  return new DevelopmentFileSearchService({
    getRoots: () => {
      const settingsRoots = useSettingsStore
        .getState()
        .roots
        .filter((root) => !root.paused)
        .map((root) => root.path);
      if (settingsRoots.length > 0) {
        return settingsRoots;
      }
      const onboardingRoot = useOnboardingStore.getState().root;
      return onboardingRoot ? [onboardingRoot] : [];
    },
    getRootConfigurations: () => {
      const settings = useSettingsStore.getState();
      const configuredRoots = settings.roots
        .filter((root) => !root.paused)
        .map((root) => ({
          id: root.id,
          path: root.path,
          cloudEnrichment: settings.ai.cloudEnrichedRootIds.includes(root.id),
          exclusions: root.exclusions,
          includeHidden: root.includeHidden,
          maxFileSizeMb: root.maxFileSizeMb,
        }));
      if (configuredRoots.length > 0) {
        return configuredRoots;
      }
      const onboardingRoot = useOnboardingStore.getState().root;
      return onboardingRoot ? [{
        id: `onboarding:${onboardingRoot}`,
        path: onboardingRoot,
        cloudEnrichment: false,
        exclusions: [],
        includeHidden: false,
        maxFileSizeMb: 256,
      }] : [];
    },
    getSearchPreferences: () => {
      const {
        filenamePriority,
        recency,
        rerankingEnabled,
        semanticEnabled,
        showPinned,
      } = useSettingsStore.getState().search;
      return {filenamePriority, recency, rerankingEnabled, semanticEnabled, showPinned};
    },
  });
}

const defaultFileSearchService = createDefaultSearchService();
const defaultActivityService = createActivityService();
const runtimeAnswerService = isNativeRuntime()
  ? new TauriAnswerService()
  : new UnavailableAnswerService();
const developmentComputerUse = import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get('computerUse') === 'memory';
const defaultComputerUseService = developmentComputerUse
  ? new DevelopmentComputerUseService()
  : isNativeRuntime()
    ? new TauriComputerUseService()
    : new UnavailableComputerUseService();
const appWindowService = createWindowService();
const defaultSearchService = new CatalogueSearchService(defaultFileSearchService, windowsAiService, getWindowsAiPreferences, async (page) => {
  useSettingsStore.getState().setActivePage(page);
  await requestWindowShow(appWindowService, 'settings');
});
const defaultAnswerService = new WindowsAiAnswerService(runtimeAnswerService, windowsAiService, () => useWindowsAiStore.getState().snapshot);
const OnboardingFlow = lazy(async () => {
  const module = await import('../features/onboarding/OnboardingFlow');
  return {default: module.OnboardingFlow};
});
const SettingsShell = lazy(async () => {
  const module = await import('../features/settings/SettingsShell');
  return {default: module.SettingsShell};
});
const DiagnosticsOverlay = lazy(async () => {
  const module = await import('../features/diagnostics/DiagnosticsOverlay');
  return {default: module.DiagnosticsOverlay};
});
const VisualStateGallery = import.meta.env.DEV ? lazy(async () => {
  const module = await import('../features/gallery/VisualStateGallery');
  return {default: module.VisualStateGallery};
}) : null;

function isFoundationPreview() {
  return import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get('mode') === 'foundation';
}

function isGalleryPreview() {
  return import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get('gallery') === '1';
}

function galleryAppearance() {
  const parameters = new URLSearchParams(window.location.search);
  const scenario = parameters.get('scenario');
  const theme = parameters.get('theme') ?? (
    scenario === 'theme-light' ? 'light'
      : scenario === 'theme-opaque' ? 'opaque'
        : scenario === 'theme-high-contrast' ? 'high-contrast'
          : scenario === 'theme-reduced-motion' ? 'reduced-motion'
            : 'dark'
  );
  const appearance: AppearancePreferences = {
    mode: theme === 'light' ? 'light' : 'dark',
    transparency: theme === 'opaque' ? 'disabled' : 'native',
    effects: theme === 'opaque' ? 'reduced' : 'full',
    motion: theme === 'reduced-motion' ? 'reduced' : 'full',
  };
  return {appearance, forceHighContrast: theme === 'high-contrast'};
}

function getOnboardingMode() {
  if (!import.meta.env.DEV) {
    return 'persisted' as const;
  }
  const params = new URLSearchParams(window.location.search);
  if (params.get('onboarding') === '1') {
    return 'forced' as const;
  }
  if (params.get('onboarded') === '1' || params.get('service') === 'memory') {
    return 'bypassed' as const;
  }
  return 'persisted' as const;
}

export interface AppProps {
  activityService?: ActivityService;
  windowService?: WindowService;
}

export function App({
  activityService = defaultActivityService,
  windowService = appWindowService,
}: AppProps = {}) {
  const foundationPreview = isFoundationPreview();
  const galleryPreview = isGalleryPreview();
  const galleryPresentation = galleryPreview ? galleryAppearance() : null;
  const onboardingMode = getOnboardingMode();
  const onboardingCompleted = useOnboardingStore((state) => state.completed);
  const onboardingHydrated = useOnboardingStore((state) => state.hydrated);
  const hydrateOnboarding = useOnboardingStore((state) => state.hydrate);
  const hydrateSettings = useSettingsStore((state) => state.hydrate);
  const settingsHydrated = useSettingsStore((state) => state.hydrated);
  const runtimeMode = useSettingsStore((state) => state.ai.runtimeMode);
  const keepLocalWarm = useSettingsStore((state) => state.ai.keepLocalWarm);
  const [foundationAppearance, setFoundationAppearance] = useState(0);
  const launcherMode = useLauncherStore((state) => state.mode);

  useNativeLauncherLifecycle(windowService, galleryPreview ? 'gallery' : null);

  useEffect(() => {
    if (!foundationPreview) {
      return;
    }

    const cycleFoundationAppearance = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        setFoundationAppearance((current) =>
          (current + 1) % foundationAppearances.length,
        );
      }
    };

    window.addEventListener('keydown', cycleFoundationAppearance);
    return () => window.removeEventListener('keydown', cycleFoundationAppearance);
  }, [foundationPreview]);

  useEffect(() => {
    if (!foundationPreview && !galleryPreview && onboardingMode === 'persisted') {
      void hydrateOnboarding();
    }
  }, [foundationPreview, galleryPreview, hydrateOnboarding, onboardingMode]);

  useEffect(() => {
    if (!foundationPreview && !galleryPreview) {
      void hydrateSettings();
    }
  }, [foundationPreview, galleryPreview, hydrateSettings]);

  useEffect(() => {
    if (foundationPreview || galleryPreview) return;
    void useWindowsAiStore.getState().refresh();
    return windowsAiService.subscribe((snapshot) => useWindowsAiStore.setState({snapshot, hydrated: true}));
  }, [foundationPreview, galleryPreview]);

  useEffect(() => {
    if (foundationPreview || galleryPreview || !settingsHydrated) return;
    let active = true;
    let requested = true;
    const consume = async () => {
      const launcher = useLauncherStore.getState();
      if (!active || !requested || launcher.agentActivationPending || launcher.agentActivationId) return;
      requested = false;
      useLauncherStore.setState({agentActivationPending: true});
      try {
        const activation = await windowsAiService.consumeActivation();
        if (!activation) return;
        useQueryStore.getState().clear();
        useQueryStore.getState().setDraft(activation.prompt);
        // Preserve a popped draft even if this subscription was disposed while
        // native IPC was pending. A later mount can present the held draft.
        useLauncherStore.setState({intent: 'computer', focusRegion: 'search', externalAgentId: '', agentActivationId: activation.activationId});
        if (active) await requestWindowShow(windowService, 'expanded');
      } catch { /* Malformed or unavailable activations cannot execute a task. */ }
      finally { useLauncherStore.setState({agentActivationPending: false}); }
    };
    const request = () => { requested = true; void consume(); };
    const unsubscribe = windowsAiService.subscribeActivation(request);
    const unsubscribeQuery = useQueryStore.subscribe((state) => {
      const id = useLauncherStore.getState().agentActivationId;
      if (id && !state.draft.trim()) useLauncherStore.getState().finishAgentActivation(id);
    });
    const unsubscribeLauncher = useLauncherStore.subscribe((state, previous) => {
      if (previous.agentActivationId && !state.agentActivationId) requested = true;
      if (state.agentActivationId && state.intent !== 'computer') {
        state.finishAgentActivation(state.agentActivationId);
        return;
      }
      if (requested && !state.agentActivationPending && !state.agentActivationId) void consume();
    });
    if (useLauncherStore.getState().agentActivationId) void requestWindowShow(windowService, 'expanded');
    void consume();
    return () => { active = false; unsubscribe(); unsubscribeQuery(); unsubscribeLauncher(); };
  }, [foundationPreview, galleryPreview, settingsHydrated, windowService]);

  useEffect(() => {
    if (!developmentComputerUse || !settingsHydrated) return;
    useSettingsStore.setState((state) => ({
      computerUse: {...state.computerUse, cloudConsent: true},
    }));
  }, [settingsHydrated]);

  useEffect(() => {
    if (isNativeRuntime()) {
      void nativeAiService.setLocalRuntimeMode(runtimeMode, keepLocalWarm);
    }
  }, [keepLocalWarm, runtimeMode]);

  useEffect(() => {
    let active = true;
    const refreshActivity = async () => {
      try {
        const snapshot = await activityService.status();
        if (!active) return;
        const mode = toActivityMode(snapshot.mode);
        useActivityStore.setState({
          active: mode !== 'indexing',
          mode,
          detectedApplication: null,
          message: '',
        });
      } catch {
        // Search remains available when activity classification is unavailable.
      }
    };
    void refreshActivity();
    const timer = window.setInterval(() => void refreshActivity(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activityService]);

  const completeOnboarding = useCallback(async () => {
    const root = useOnboardingStore.getState().root;
    if (!root) {
      return false;
    }
    const settings = useSettingsStore.getState();
    if (!settings.roots.some((item) => item.path.toLocaleLowerCase() === root.toLocaleLowerCase())) {
      if (!await settings.setRoots([...settings.roots, createIndexedRoot(root)])) {
        return false;
      }
    }
    if (isNativeRuntime()) {
      const current = useSettingsStore.getState();
      await nativeAiService.synchronizeRoots(current.roots.filter((item) => !item.paused).map((item) => ({
        path: item.path,
        cloudEnrichment: current.ai.cloudEnrichedRootIds.includes(item.id),
        exclusions: item.exclusions,
        includeHidden: item.includeHidden,
        maxFileSizeMb: item.maxFileSizeMb,
      })));
    }
    return true;
  }, []);

  const showOnboarding = !foundationPreview && !galleryPreview && (
    (onboardingMode === 'forced' && !onboardingCompleted) ||
    (onboardingMode === 'persisted' && onboardingHydrated && !onboardingCompleted)
  );
  const onboardingPending = !foundationPreview && !galleryPreview &&
    onboardingMode === 'persisted' &&
    !onboardingHydrated;
  const browserWindowMode: WindowMode = galleryPreview
    ? 'gallery'
    : showOnboarding
      ? 'onboarding'
      : foundationPreview
        ? 'collapsed'
        : launcherMode;
  const browserWindowStyle: CSSProperties | undefined = import.meta.env.DEV && !isNativeRuntime()
    ? {
        height: `min(100%, ${windowGeometry[browserWindowMode].height}px)`,
        left: '50%',
        position: 'absolute',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        width: `min(100%, ${windowGeometry[browserWindowMode].width}px)`,
      }
    : undefined;

  const closeSettings = useCallback(() => {
    const targetMode = useQueryStore.getState().committed ? 'expanded' : 'collapsed';
    void requestWindowShow(windowService, targetMode);
  }, [windowService]);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    const showDiagnosticsLauncher = () => {
      const targetMode = useQueryStore.getState().committed ? 'expanded' : 'collapsed';
      void requestWindowShow(windowService, targetMode);
    };
    window.addEventListener('lumen:diagnostics-show-launcher', showDiagnosticsLauncher);
    return () => window.removeEventListener('lumen:diagnostics-show-launcher', showDiagnosticsLauncher);
  }, [windowService]);

  return (
    <AppProviders
      appearance={galleryPresentation?.appearance ?? (
        foundationPreview ? foundationAppearances[foundationAppearance] : undefined
      )}
      forceHighContrast={galleryPresentation?.forceHighContrast}
    >
      <main
        className="grid h-full min-h-0 min-w-0 w-full grid-rows-[minmax(0,1fr)] items-stretch overflow-x-clip bg-transparent p-1.5"
        data-browser-window-mode={browserWindowStyle ? browserWindowMode : undefined}
        style={browserWindowStyle}
      >
        {galleryPreview && VisualStateGallery ? (
          <Suspense fallback={null}><VisualStateGallery windowService={windowService} /></Suspense>
        ) : foundationPreview ? (
          <LumenSurface
            aria-label="Lumen launcher"
            className="h-full w-full rounded-pill"
            material="mica"
          >
            <div className="flex min-h-[52px] min-w-0 items-center gap-3 px-3" data-tauri-drag-region>
              <span aria-hidden="true" className="grid size-[38px] shrink-0 place-items-center rounded-control border border-border-subtle bg-accent/10 text-accent shadow-control">
                <LumenMark
                  className="drop-shadow-[0_0_10px_currentColor]"
                  size="large"
                />
              </span>
              <span aria-hidden="true" className="h-[26px] w-px shrink-0 bg-border-subtle" />
              <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
                <LumenText
                  className="truncate"
                  tone="secondary"
                  variant="bodyLarge"
                >
                  Search apps, files, and settings
                </LumenText>
                <LumenText tone="tertiary" variant="caption">
                  Local
                </LumenText>
              </div>
              <span aria-label="Local search ready" className="inline-flex shrink-0 items-center gap-1.5 text-text-tertiary">
                <span aria-hidden="true" className="size-1.5 rounded-pill bg-success shadow-[0_0_9px_var(--lumen-success)]" />
                <LumenText tone="tertiary" variant="caption">
                  Ready
                </LumenText>
              </span>
              <kbd aria-label="Alt plus Space" className="inline-flex shrink-0 items-center rounded-control border border-border-subtle bg-surface-inset px-2.5 py-1 font-sans text-xs leading-tight text-text-secondary shadow-control">
                Alt&nbsp;&nbsp;Space
              </kbd>
            </div>
          </LumenSurface>
        ) : showOnboarding ? (
          <Suspense fallback={null}>
            <OnboardingFlow windowService={windowService} onComplete={completeOnboarding} />
          </Suspense>
        ) : launcherMode === 'settings' ? (
          <Suspense fallback={null}>
            <SettingsShell onClose={closeSettings} />
          </Suspense>
        ) : onboardingPending ? null : (
          <SearchExperience
            answerService={defaultAnswerService}
            computerUseService={defaultComputerUseService}
            service={defaultSearchService}
            windowService={windowService}
          />
        )}
      </main>
      {import.meta.env.DEV ? (
        <Suspense fallback={null}><DiagnosticsOverlay /></Suspense>
      ) : null}
    </AppProviders>
  );
}
