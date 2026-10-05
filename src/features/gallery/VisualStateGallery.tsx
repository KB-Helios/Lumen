import {useCallback, useEffect, useLayoutEffect, useMemo, useState} from 'react';

import {LumenSurface} from '../../design-system/primitives/LumenSurface';
import {LumenText} from '../../design-system/primitives/LumenText';
import {BrowserWindowService} from '../../platform/window/browser-window-service';
import type {WindowService} from '../../platform/window/window-service';
import {ActivityStatus} from '../activity/ActivityStatus';
import {AnswerPanel} from '../answer/AnswerPanel';
import type {AnswerState} from '../answer/useAnswerController';
import {ComputerUsePanel} from '../computer-use/ComputerUsePanel';
import type {ComputerUseController, ComputerUseState} from '../computer-use/useComputerUseController';
import {GatewayStatusPanel} from '../gateway/GatewayStatusPanel';
import {CollapsedLauncher} from '../launcher/CollapsedLauncher';
import {ExpandedWorkspace} from '../launcher/ExpandedWorkspace';
import {useLauncherStore} from '../launcher/launcher.store';
import {useQueryStore} from '../launcher/query.store';
import {OnboardingFlow} from '../onboarding/OnboardingFlow';
import {useOnboardingStore} from '../onboarding/onboarding.store';
import type {RootSelectionService} from '../onboarding/root-selection-service';
import {SettingsShell} from '../settings/SettingsShell';
import {LocalAiPage} from '../settings/pages/LocalAiPage';
import {SearchPage} from '../settings/pages/SearchPage';
import {useSettingsStore} from '../settings/settings.store';
import {useWindowsAiStore} from '../windows-ai/windows-ai.store';
import {WindowsLocalAiControls} from '../windows-ai/WindowsAiControls';
import {unsupportedWindowsAiSnapshot} from '../../services/windows-ai/unavailable-windows-ai-service';
import {GallerySearchService, galleryResults} from './fixtures';
import {ScenarioControls} from './ScenarioControls';
import {galleryScenarios, getGalleryScenario} from './scenarios';
import type {GalleryAnswerState, GalleryLauncherState, GalleryScenario, GalleryScenarioId} from './gallery.types';

const galleryWindowService = new BrowserWindowService();
const standaloneGalleryWindowService = new BrowserWindowService();

const galleryRootService: RootSelectionService = {async chooseRoot() { return null; }};
const textScales = [100, 125, 150, 175, 200] as const;
const themes = ['dark', 'light', 'opaque', 'high-contrast', 'reduced-motion'] as const;

function navigate(parameters: URLSearchParams) {
  window.location.search = parameters.toString();
}

function galleryAnswer(state: GalleryAnswerState | undefined, constrained = false): AnswerState | null {
  if (!state) return null;
  if (state === 'waiting') return {phase: 'waiting', text: '', citations: []};
  if (state === 'streaming') return {
    phase: 'streaming',
    text: constrained
      ? 'The local report is being summarized as the answer arrives. The constrained work area keeps the composer and footer visible while the answer remains available through its own scroll region. Local files stay visible alongside the streamed response, and the preview yields before either primary region is clipped.'
      : 'The local report is being summarized as the answer arrives.',
    citations: [],
  };
  if (state === 'failed') return {phase: 'error', text: '', citations: [], error: 'The answer route is unavailable.'};
  return {
    phase: 'completed',
    text: 'The quarterly report highlights stable local search, explicit AI submission, and preserved privacy boundaries.',
    citations: [{fileId: 'quarterly-report', label: 'Quarterly report', page: 1}],
    provider: 'Local runtime',
    model: 'on-device',
    route: 'local',
  };
}

const approvalState: ComputerUseState = {
  phase: 'approval',
  health: {state: 'ready', mode: 'python', browser: 'Microsoft Edge', credentialConfigured: true},
  task: 'Review the release notes in the isolated browser session.',
  taskId: 1,
  model: 'gemini-3.6-flash',
  browser: 'Microsoft Edge',
  currentUrl: 'https://example.test/release-notes',
  reasoning: 'The next action could change a remote setting.',
  approval: {id: 'gallery-approval', explanation: 'Apply the requested change in the isolated Edge session.'},
  activity: [{id: 1, label: 'Waiting for your approval', tone: 'accent'}],
};

function GalleryLauncher({state}: {state: GalleryLauncherState}) {
  const results = useMemo(() => galleryResults(state.resultSet), [state.resultSet]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const service = useMemo(
    () => new GallerySearchService(results, state.preview ?? 'complete'),
    [results, state.preview],
  );

  useLayoutEffect(() => {
    const query = useQueryStore.getState();
    query.reset();
    if (state.composing) {
      query.startComposition();
    }
    query.setDraft(state.query);
    useLauncherStore.getState().show(state.mode);
    const index = state.selectedIndex ?? (results.length > 0 ? 0 : -1);
    setSelectedId(index >= 0 ? results[index]?.id ?? null : null);
  }, [results, state]);

  const noRootError = state.noRoot
    ? {code: 'unavailable' as const, message: 'Choose an indexed root to search local filenames.', recoverable: true}
    : null;
  const lifecycle = state.noRoot ? 'error' : results.length > 0 ? 'ready' : 'empty';
  const expanded = state.mode === 'expanded';
  const [answer, setAnswer] = useState(() => galleryAnswer(state.answer, state.constrained));

  return (
    <div className={`min-h-0 min-w-0 ${state.constrained ? 'h-[340px] w-[min(100%,520px)]' : expanded ? 'h-[min(100%,540px)] w-[min(100%,800px)]' : 'h-[66px] w-[min(100%,800px)]'}`}>
      <CollapsedLauncher
        focusOnMount={state.focusOnMount ?? true}
        statusLabel={state.noRoot ? 'No root' : results.length > 0 ? `${results.length} results` : 'Ready'}
        windowService={galleryWindowService}
        expandedContent={expanded ? (
          <ExpandedWorkspace
            activeFilters={[]}
            announcement={noRootError?.message ?? `${results.length} deterministic results`}
            answerPanel={answer ? <AnswerPanel answer={answer} mode="local" onModeChange={() => undefined} onOpenCitation={() => undefined} onRetry={() => undefined} onStop={() => setAnswer((current) => current ? {...current, phase: 'cancelled'} : current)} /> : undefined}
            error={noRootError}
            lifecycle={lifecycle}
            openingId={null}
            results={results}
            selectedId={selectedId}
            service={service}
            onClearFilters={() => undefined}
            onDetails={() => undefined}
            onOpen={() => undefined}
            onOpenContainingFolder={() => undefined}
            onPin={() => undefined}
            onRemoveFilter={() => undefined}
            onSelectionChange={setSelectedId}
          />
        ) : null}
      />
    </div>
  );
}

function GalleryComputerUse() {
  const [state, setState] = useState<ComputerUseState>(approvalState);
  const controller = useMemo<ComputerUseController>(() => ({
    ...state,
    async refreshHealth() {},
    async start() {},
    async approve() {
      setState((current) => ({
        ...current,
        phase: 'running',
        approval: undefined,
        reasoning: 'Approval recorded. The deterministic gallery session can continue.',
        activity: [...current.activity, {id: 2, label: 'Approved once in the deterministic gallery session', tone: 'success'}],
      }));
    },
    async deny() {
      setState((current) => ({
        ...current,
        phase: 'cancelled',
        approval: undefined,
        reasoning: 'The deterministic gallery session stopped without performing the action.',
        activity: [...current.activity, {id: 2, label: 'Denied and stopped in the deterministic gallery session', tone: 'neutral'}],
      }));
    },
    stop() {
      setState((current) => ({...current, phase: 'cancelled', approval: undefined}));
    },
  }), [state]);

  return (
    <div className="h-[min(100%,540px)] w-[min(100%,800px)] min-h-0 min-w-0">
      <ComputerUsePanel cloudConsent controller={controller} draftTask={controller.task ?? ''} onOpenSettings={() => undefined} onStart={() => undefined} />
    </div>
  );
}

function GalleryPanel({scenario, children}: {scenario: GalleryScenario; children: React.ReactNode}) {
  return (
    <LumenSurface aria-label={scenario.label} className="grid w-[min(100%,760px)] max-h-[min(100%,620px)] content-start gap-5 overflow-y-auto rounded-surface p-6" material="mica">
      <div className="grid gap-1.5">
        <LumenText as="h1" variant="title">{scenario.label}</LumenText>
        <LumenText tone="secondary">{scenario.description}</LumenText>
      </div>
      {children}
    </LumenSurface>
  );
}

function GallerySettingsShell({page}: {page: 'general' | 'agent-gateway'}) {
  useLayoutEffect(() => {
    useSettingsStore.setState({activePage: page, hydrated: true, persistenceStatus: 'ready'});
  }, [page]);
  return <div className="h-[min(100%,600px)] w-[min(100%,880px)] min-h-0 min-w-0"><SettingsShell onClose={() => undefined} /></div>;
}

function GalleryOnboarding({step}: {step: number}) {
  useLayoutEffect(() => {
    useOnboardingStore.setState({
      completed: false,
      currentIndex: step,
      hydrated: true,
      root: '',
      shortcut: 'Alt + Space',
      started: step > 0,
    });
  }, [step]);
  return (
    <div className="h-[min(100%,600px)] w-[min(100%,880px)] min-h-0 min-w-0">
      <OnboardingFlow rootService={galleryRootService} windowService={galleryWindowService} />
    </div>
  );
}

function ScenarioSurface({scenario}: {scenario: GalleryScenario}) {
  const surface = scenario.surface;
  switch (surface.kind) {
    case 'launcher': return <GalleryLauncher key={scenario.id} state={surface.state} />;
    case 'activity': return <GalleryPanel scenario={scenario}><ActivityStatus mode={surface.mode} /></GalleryPanel>;
    case 'local-ai': return <GalleryPanel scenario={scenario}><LocalAiPage model={{hardware: surface.hardware, state: surface.model, progress: surface.progress}} /></GalleryPanel>;
    case 'gateway': return <GalleryPanel scenario={scenario}><GatewayStatusPanel state={surface.state} onRestart={() => undefined} /></GalleryPanel>;
    case 'settings-page': return <GalleryPanel scenario={scenario}><SearchPage /></GalleryPanel>;
    case 'settings-shell': return <GallerySettingsShell page={surface.page === 'agent-gateway' ? 'agent-gateway' : 'general'} />;
    case 'onboarding': return <GalleryOnboarding step={surface.step} />;
    case 'computer-use': return <GalleryComputerUse />;
    case 'windows-ai': return <GalleryPanel scenario={scenario}><GalleryWindowsAi state={surface.state} /></GalleryPanel>;
  }
}

function GalleryWindowsAi({state}: {state: 'ready' | 'unavailable' | 'preparing' | 'failed'}) {
  useLayoutEffect(() => {
    const snapshot = unsupportedWindowsAiSnapshot();
    snapshot.preferences = {...snapshot.preferences, windowsEnabled: true, textToolsEnabled: true};
    snapshot.host = {...snapshot.host, osBuild: 'Development fixture', runtimeVersion: 'Preview fixture'};
    snapshot.features = snapshot.features.map((feature) => ({...feature, enabled: true, availability: feature.id === 'languageModel' ? state : 'unavailable', reasonCode: 'galleryFixture', detail: feature.id === 'languageModel' ? state === 'preparing' ? 'Preparing model · 42% (fixture)' : state === 'failed' ? 'The preview model could not be prepared (fixture).' : state === 'ready' ? 'Available on this fixture device.' : 'Preview runtime is missing (fixture).' : 'Not available in this fixture.'}));
    useWindowsAiStore.setState({snapshot, hydrated: true, busy: true, message: ''});
    return () => useWindowsAiStore.setState({snapshot: null, hydrated: false, busy: false, message: ''});
  }, [state]);
  return <WindowsLocalAiControls />;
}

export interface VisualStateGalleryProps {
  windowService?: WindowService;
}

export function VisualStateGallery({
  windowService = standaloneGalleryWindowService,
}: VisualStateGalleryProps = {}) {
  const parameters = useMemo(() => new URLSearchParams(window.location.search), []);
  const scenario = getGalleryScenario(parameters.get('scenario'));
  const matrix = parameters.get('matrix') === '1';
  const capture = parameters.get('capture') === '1';
  const parsedScale = Number(parameters.get('scale') ?? '100');
  const scale = textScales.includes(parsedScale as (typeof textScales)[number]) ? parsedScale : 100;

  useEffect(() => {
    useLauncherStore.getState().show('gallery');
    void windowService.show('gallery').catch(() => undefined);
  }, [windowService]);

  useEffect(() => {
    const original = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = `${16 * scale / 100}px`;
    return () => { document.documentElement.style.fontSize = original; };
  }, [scale]);

  const setParameter = useCallback((name: string, value: string | null) => {
    const next = new URLSearchParams(window.location.search);
    if (value === null) next.delete(name);
    else next.set(name, value);
    next.set('gallery', '1');
    navigate(next);
  }, []);

  const navigateScenario = useCallback((direction: -1 | 1) => {
    const index = galleryScenarios.findIndex((item) => item.id === scenario.id);
    const next = galleryScenarios[(index + direction + galleryScenarios.length) % galleryScenarios.length];
    if (next) setParameter('scenario', next.id);
  }, [scenario.id, setParameter]);

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, select, textarea')) return;
      if (event.key === '[') navigateScenario(-1);
      else if (event.key === ']') navigateScenario(1);
      else if (event.key.toLowerCase() === 'm') setParameter('matrix', matrix ? null : '1');
      else if (event.key.toLowerCase() === 'd') {
        const index = textScales.indexOf(scale as (typeof textScales)[number]);
        setParameter('scale', String(textScales[(index + 1) % textScales.length]));
      } else if (event.key.toLowerCase() === 't') {
        const current = parameters.get('theme') as (typeof themes)[number] | null;
        const index = current ? themes.indexOf(current) : -1;
        setParameter('theme', themes[(index + 1) % themes.length]);
      }
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, [matrix, navigateScenario, parameters, scale, setParameter]);

  return (
    <section
      aria-label="Lumen visual state gallery"
      data-gallery-scenario={scenario.id}
      className={capture ? 'grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-transparent' : 'grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-canvas'}
    >
      {!capture ? (
        <ScenarioControls
          matrix={matrix}
          scale={scale}
          scenarioId={scenario.id}
          onMatrix={() => setParameter('matrix', matrix ? null : '1')}
          onNavigate={navigateScenario}
          onScenario={(id: GalleryScenarioId) => setParameter('scenario', id)}
        />
      ) : null}
      <div className={`grid min-h-0 min-w-0 gap-4 overflow-hidden p-4 ${matrix ? 'grid-cols-[300px_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)]'}`}>
        {matrix ? (
          <nav aria-label="Scenario matrix" className="grid min-h-0 min-w-0 content-start gap-1.5 overflow-y-auto rounded-surface border border-border-subtle bg-surface-raised p-3">
            {galleryScenarios.map((item) => (
              <button
                key={item.id}
                aria-current={item.id === scenario.id ? 'true' : undefined}
                className={`grid min-h-9 w-full gap-0.5 rounded-control border px-2.5 py-2 text-left font-sans ${item.id === scenario.id ? 'border-border-strong bg-surface-inset text-text-primary' : 'border-transparent bg-transparent text-text-secondary'}`}
                onClick={() => setParameter('scenario', item.id)}
              >
                <LumenText weight="medium">{item.label}</LumenText>
                <LumenText tone="tertiary" variant="caption">{item.category}</LumenText>
              </button>
            ))}
          </nav>
        ) : null}
        <div className="grid min-h-0 min-w-0 place-items-center overflow-hidden"><ScenarioSurface scenario={scenario} /></div>
      </div>
    </section>
  );
}
