import {lazy, Suspense, useEffect} from 'react';
import {AppProviders} from '../app/AppProviders';
import {SearchExperience} from '../features/launcher/SearchExperience';
import {useQueryStore} from '../features/launcher/query.store';
import {requestWindowShow, useNativeLauncherLifecycle} from '../features/launcher/useLauncherPresentation';
import {WorkflowServicesContext} from '../features/improvement/workflow-context';
import {SemanticSearchContext} from '../features/launcher/semantic-search-context';
import {unavailableSemanticSearchService} from '../services/search/semantic-search-service';
import {createWindowService} from '../platform/window/tauri-window-service';
import type {WindowService} from '../platform/window/window-service';
import {UnavailableAnswerService} from '../services/answer/unavailable-answer-service';
import {WindowsAiAnswerService} from '../services/answer/windows-ai-answer-service';
import {UnavailableComputerUseService} from '../services/computer-use/unavailable-computer-use-service';
import {DevelopmentSearchService} from '../services/search/development-search-service';
import {CatalogueSearchService} from '../services/search/catalogue-search-service';
import {UnavailableWindowsAiService} from '../services/windows-ai/unavailable-windows-ai-service';
import {defaultWindowsAiPreferences} from '../services/windows-ai/windows-ai.types';

declare global {
  interface Window { __LUMEN_NATIVE_PERFORMANCE__?: boolean }
}

const nativeWindow = createWindowService();
const unavailableWindows = new UnavailableWindowsAiService();
const runtimeAnswer = new UnavailableAnswerService();
const answer = new WindowsAiAnswerService(runtimeAnswer, unavailableWindows, () => null);
const computerUse = new UnavailableComputerUseService();
const search = new CatalogueSearchService(new DevelopmentSearchService(), unavailableWindows, () => defaultWindowsAiPreferences, () => {
  throw new Error('Settings navigation is unavailable in the native performance fixture.');
});
const workflow = {search, answer: runtimeAnswer, draft: async () => { throw new Error('Workflows are unavailable in this fixture.'); }};
const DiagnosticsOverlay = lazy(async () => ({default: (await import('../features/diagnostics/DiagnosticsOverlay')).DiagnosticsOverlay}));
const appearance = {mode: 'dark', transparency: 'native', effects: 'full', motion: 'full'} as const;

/** Developer-only UI workload. Ordinary App and its native startup effects never mount. */
export function NativePerformanceFixture({windowService = nativeWindow}: {windowService?: WindowService}) {
  if (!import.meta.env.DEV || window.__LUMEN_NATIVE_PERFORMANCE__ !== true) throw new Error('Native performance fixture bootstrap required');
  useNativeLauncherLifecycle(windowService);
  useEffect(() => {
    const show = () => { void requestWindowShow(windowService, useQueryStore.getState().committed ? 'expanded' : 'collapsed'); };
    show();
    window.addEventListener('lumen:diagnostics-show-launcher', show);
    return () => window.removeEventListener('lumen:diagnostics-show-launcher', show);
  }, [windowService]);
  return <WorkflowServicesContext.Provider value={workflow}>
    <SemanticSearchContext.Provider value={unavailableSemanticSearchService}>
    <AppProviders appearance={appearance}>
      <main className="grid h-full min-h-0 min-w-0 w-full grid-rows-[minmax(0,1fr)] items-stretch overflow-x-clip bg-transparent p-1.5">
        <SearchExperience service={search} answerService={answer} computerUseService={computerUse} windowService={windowService} />
      </main>
      <Suspense fallback={null}><DiagnosticsOverlay /></Suspense>
    </AppProviders>
    </SemanticSearchContext.Provider>
  </WorkflowServicesContext.Provider>;
}
