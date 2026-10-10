import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {defaultAppearance} from '../design-system/theme';
import {useActivityStore} from '../features/activity/activity.store';
import {useLauncherStore} from '../features/launcher/launcher.store';
import {useQueryStore} from '../features/launcher/query.store';
import {useOnboardingStore} from '../features/onboarding/onboarding.store';
import {settingsPersistence, useSettingsStore} from '../features/settings/settings.store';
import {defaultSettings, type LumenSettings} from '../features/settings/settings.schema';
import {useWindowsAiStore} from '../features/windows-ai/windows-ai.store';
import {BrowserWindowService} from '../platform/window/browser-window-service';
import type {ActivityService} from '../services/activity/activity-service';
import {windowsAiService} from '../services/windows-ai';
import {unsupportedWindowsAiSnapshot} from '../services/windows-ai/unavailable-windows-ai-service';
import {defaultWindowsAiPreferences, type WindowsAgentActivation} from '../services/windows-ai/windows-ai.types';
import {App} from './App';
// Load the lazy settings fixture before measuring asynchronous application ownership.
import '../features/settings/SettingsShell';
import {createIndexedRoot} from '../features/settings/indexed-root';
import {DevelopmentFileSearchService} from '../services/search/development-file-search-service';
import * as nativeAiModule from '../services/ai/native-ai-service';

const nativeCalls = vi.hoisted(() => [] as {command: string; args?: Record<string, unknown>}[]);
const nativeState = vi.hoisted(() => ({generation: 1}));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/api/core')>(),
  invoke: async (command: string, args?: Record<string, unknown>) => {
    nativeCalls.push({command, args});
    if (command === 'synchronize_index_roots' || command === 'get_index_status') return {phase: 'ready', generation: nativeState.generation, pendingItems: 0, indexedItems: 0, queuedEnrichment: 0, skippedItems: 0, message: 'Ready'};
    if (command === 'search_hybrid') return {items: [], semantic: {phase: 'disabled', reason: null}};
    if (command === 'search_filenames') return {
      items: [{path: 'C:\\Projects\\Readme.md', relativePath: 'Readme.md', name: 'Readme.md',
        kind: 'document', extension: 'md', sizeBytes: 128, modifiedMs: null, score: 1, ranges: []}],
      total: 1, truncated: false, elapsedMs: 1, warnings: [],
    };
    return undefined;
  },
}));

class ReactivatableWindowService extends BrowserWindowService {
  reactivateCollapsed() {
    this.publishNativeState({mode: 'collapsed', source: 'shortcut', visible: true});
  }
}

afterEach(() => {
  useLauncherStore.getState().reset();
  useQueryStore.getState().reset();
  useOnboardingStore.getState().reset();
  useSettingsStore.getState().reset();
  useActivityStore.getState().reset();
  useWindowsAiStore.setState({snapshot: null, hydrated: false, busy: false, message: ''});
  window.history.replaceState({}, '', '/');
});

describe('App', () => {
  it('keeps the newer App application successful when the page later rejects the same runtime preferences', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/?service=memory');
    useSettingsStore.setState({hydrated: true, activePage: 'local-ai'});
    useLauncherStore.getState().show('settings');
    vi.spyOn(nativeAiModule, 'isNativeRuntime').mockReturnValue(true);
    const health = vi.spyOn(nativeAiModule.nativeAiService, 'localRuntimeHealth').mockResolvedValue({
      profile: 'generic-local', state: 'ready', accelerator: 'CPU',
      answerModel: 'fixture-answer', embeddingModel: 'fixture-embedding', transcriptionModel: 'fixture-transcription',
      baseUrl: 'http://127.0.0.1:13305/v1',
      lemonade: {installed: true, version: '11.5.2', requiredVersion: '11.5.2', state: 'ready'},
      flm: {installed: false, requiredVersion: '0.9.46', state: 'missing'},
      mistralRs: {installed: false, requiredVersion: '0.9.0', state: 'missing'},
    });
    let rejectPage!: (error: Error) => void;
    let warmApplications = 0;
    vi.spyOn(nativeAiModule.nativeAiService, 'setLocalRuntimeMode').mockImplementation((_, keepWarm) => {
      if (!keepWarm || ++warmApplications > 1) return Promise.resolve();
      return new Promise<void>((_, reject) => {rejectPage = reject;});
    });
    render(<App windowService={new BrowserWindowService()} />);
    await waitFor(() => expect(health).toHaveBeenCalled());
    await screen.findByText(/The loopback provider is ready/);
    await user.click(screen.getByRole('switch', {name: 'Keep local model warm'}));
    await waitFor(() => expect(warmApplications).toBe(2));
    await act(async () => {rejectPage(new Error('obsolete same-preference busy fixture'));});

    expect(useSettingsStore.getState().localRuntimeError).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(useSettingsStore.getState().ai.keepLocalWarm).toBe(true);
  });

  it('handles rejected local runtime settings without retaining raw native error text', async () => {
    window.history.replaceState({}, '', '/?service=memory');
    useSettingsStore.setState({hydrated: true});
    vi.spyOn(nativeAiModule, 'isNativeRuntime').mockReturnValue(true);
    const applyMode = vi.spyOn(nativeAiModule.nativeAiService, 'setLocalRuntimeMode')
      .mockRejectedValue(new Error('busy fixture sk-private-key https://private.example subprocess output'));

    render(<App windowService={new BrowserWindowService()} />);

    await waitFor(() => expect(applyMode).toHaveBeenCalledWith('auto', false));
    await waitFor(() => expect(useSettingsStore.getState().localRuntimeError).toBe('apply-failed'));
    expect(JSON.stringify(useSettingsStore.getState())).not.toMatch(/sk-private-key|private\.example|subprocess output/);
  });

  it('ignores an obsolete runtime settings rejection after a newer preference succeeds', async () => {
    window.history.replaceState({}, '', '/?service=memory');
    useSettingsStore.setState({hydrated: true, localRuntimeError: null});
    vi.spyOn(nativeAiModule, 'isNativeRuntime').mockReturnValue(true);
    let rejectOld!: (error: Error) => void;
    const applyMode = vi.spyOn(nativeAiModule.nativeAiService, 'setLocalRuntimeMode')
      .mockImplementationOnce(() => new Promise<void>((_, reject) => {rejectOld = reject;}))
      .mockResolvedValue(undefined);
    render(<App windowService={new BrowserWindowService()} />);
    await waitFor(() => expect(rejectOld).toBeDefined());

    act(() => useSettingsStore.setState((state) => ({ai: {...state.ai, runtimeMode: 'local'}})));
    await waitFor(() => expect(applyMode).toHaveBeenCalledWith('local', false));
    await act(async () => {rejectOld(new Error('obsolete busy fixture'));});

    expect(useSettingsStore.getState().localRuntimeError).toBeNull();
  });

  it('handles a late runtime settings rejection after unmount without publishing an error', async () => {
    window.history.replaceState({}, '', '/?service=memory');
    useSettingsStore.setState({hydrated: true, localRuntimeError: null});
    vi.spyOn(nativeAiModule, 'isNativeRuntime').mockReturnValue(true);
    let rejectMode!: (error: Error) => void;
    vi.spyOn(nativeAiModule.nativeAiService, 'setLocalRuntimeMode')
      .mockImplementation(() => new Promise<void>((_, reject) => {rejectMode = reject;}));
    const {unmount} = render(<App windowService={new BrowserWindowService()} />);
    await waitFor(() => expect(rejectMode).toBeDefined());
    unmount();
    await act(async () => {rejectMode(new Error('late busy fixture'));});

    expect(useSettingsStore.getState().localRuntimeError).toBeNull();
  });

  it.each(['configured', 'empty', 'paused'] as const)('waits for real settings hydration before making a held query actionable with %s roots', async savedPolicy => {
    let finishHydration!: (settings: LumenSettings) => void;
    vi.spyOn(settingsPersistence, 'read').mockImplementation(() => new Promise(resolve => {finishHydration = resolve;}));
    useOnboardingStore.setState({hydrated: true, completed: true, root: 'C:\\OldOnboardingRoot'});
    useQueryStore.getState().setDraft('readme');
    useQueryStore.getState().commit();
    nativeState.generation++;
    nativeCalls.length = 0;
    const search = vi.spyOn(DevelopmentFileSearchService.prototype, 'search');
    render(<App windowService={new BrowserWindowService()} />);
    await waitFor(() => expect(finishHydration).toBeDefined());
    // A persisted query must not treat the store's initial empty roots as revocation.
    await act(async () => {await new Promise(resolve => setTimeout(resolve, 120));});
    expect(nativeCalls.filter(call => /synchronize_index_roots|search_hybrid|search_filenames|open_file|open_containing_folder/.test(call.command))).toEqual([]);
    const roots = savedPolicy === 'empty' ? [] : [{...createIndexedRoot('C:\\Projects'), paused: savedPolicy === 'paused'}];
    act(() => finishHydration({...defaultSettings, roots}));
    await waitFor(() => expect(nativeCalls.some(call => call.command === 'synchronize_index_roots')).toBe(true));
    expect(nativeCalls.find(call => call.command === 'synchronize_index_roots')?.args?.roots).toEqual(savedPolicy === 'configured'
      ? [{path: 'C:\\Projects', cloudEnrichment: false, exclusions: roots[0]!.exclusions, includeHidden: roots[0]!.includeHidden, maxFileSizeMb: roots[0]!.maxFileSizeMb}]
      : []);
    await waitFor(() => expect(screen.getByRole('searchbox', {name: 'Search files'})).toHaveValue('readme'));
    if (savedPolicy === 'configured') {
      await waitFor(() => expect(nativeCalls.some(call => call.command === 'search_hybrid')).toBe(true));
      // Exercise the actual default service's readiness callback independently
      // of the component gate, so another consumer cannot prune during hydration.
      const service = search.mock.contexts[search.mock.contexts.length - 1] as DevelopmentFileSearchService;
      act(() => useSettingsStore.setState({hydrated: false}));
      nativeCalls.length = 0;
      await expect(service.search({requestId: 99, query: 'readme', scope: 'all', filters: [], limit: 10})).rejects.toMatchObject({code: 'unavailable'});
      expect(nativeCalls.filter(call => /synchronize_index_roots|search_hybrid|search_filenames/.test(call.command))).toEqual([]);
    } else expect(nativeCalls.some(call => call.command === 'search_hybrid')).toBe(false);
  });
  it.each(['empty', 'paused'] as const)('keeps %s saved roots authoritative after onboarding in the default composition', async (rootState) => {
    const user = userEvent.setup();
    useOnboardingStore.setState({hydrated: true, completed: true, root: 'C:\\Projects'});
    useSettingsStore.setState({hydrated: true, roots: rootState === 'paused'
      ? [{...createIndexedRoot('C:\\Projects'), paused: true}] : []});
    const search = vi.spyOn(DevelopmentFileSearchService.prototype, 'search');
    render(<App windowService={new BrowserWindowService()} />);
    await user.type(await screen.findByRole('searchbox', {name: 'Search files'}), 'readme');
    await waitFor(() => expect(search).toHaveBeenCalled());
    const outcome = await search.mock.results[search.mock.results.length - 1]!.value;
    expect(outcome).toMatchObject({groups: [], total: 0});
  });

  function nativeActivations(queue: WindowsAgentActivation[], gate: Promise<void> = Promise.resolve()) {
    let signal: (() => void) | undefined;
    vi.spyOn(windowsAiService, 'consumeActivation').mockImplementation(async () => {
      await gate;
      return queue.shift() ?? null;
    });
    vi.spyOn(windowsAiService, 'subscribeActivation').mockImplementation((listener) => {
      signal = listener;
      return () => { signal = undefined; };
    });
    return {signal: () => signal?.(), ready: () => signal !== undefined};
  }

  it('leaves the second activation queued until the first draft is cleared', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/?service=memory');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queue: WindowsAgentActivation[] = [
      {activationId: 'first-draft', agentName: 'lumen.browser', prompt: 'First incoming browser task'},
      {activationId: 'second-draft', agentName: 'lumen.browser', prompt: 'Second incoming browser task'},
    ];
    const source = nativeActivations(queue, gate);
    render(<App windowService={new BrowserWindowService()} />);
    await waitFor(() => expect(source.ready()).toBe(true));
    act(() => { source.signal(); source.signal(); release(); });
    await waitFor(() => expect(useQueryStore.getState().draft).toBe('First incoming browser task'));
    expect(queue.map((item) => item.activationId)).toEqual(['second-draft']);

    await user.click(screen.getByRole('button', {name: 'Clear search'}));
    await waitFor(() => expect(useQueryStore.getState().draft).toBe('Second incoming browser task'));
    expect(queue).toEqual([]);
  });

  it('routes a warm Lumen activation to Lumen after an external recipient was selected', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/?service=memory');
    const snapshot = unsupportedWindowsAiSnapshot({...defaultWindowsAiPreferences, agentsEnabled: true});
    snapshot.agents = [{id: 'external-agent', name: 'external', displayName: 'External assistant', description: 'An installed external application', packageFamilyName: 'Example.External_123456', actionId: 'Run'}];
    snapshot.features = snapshot.features.map((feature) => feature.id === 'agentInvocation' ? {...feature, availability: 'ready', enabled: true} : feature);
    vi.spyOn(windowsAiService, 'status').mockResolvedValue(snapshot);
    const deliveries: {agent: string; task: string}[] = [];
    vi.spyOn(windowsAiService, 'invokeAgent').mockImplementation(async (agent, task) => {
      deliveries.push({agent, task});
      return {ok: true, message: 'Accepted'};
    });
    const queue: WindowsAgentActivation[] = [];
    const source = nativeActivations(queue);
    render(<App windowService={new BrowserWindowService()} />);
    await waitFor(() => expect(source.ready()).toBe(true));
    act(() => {
      useQueryStore.getState().setDraft('Previous browser task');
      useLauncherStore.getState().setIntent('computer');
      useLauncherStore.getState().show('expanded');
    });
    await user.click(await screen.findByRole('button', {name: /Agent application/}));
    await user.click(await screen.findByRole('option', {name: 'External assistant'}));

    queue.push({activationId: 'warm-lumen', agentName: 'lumen.browser', prompt: 'Incoming Lumen task'});
    act(() => source.signal());
    await waitFor(() => expect(useQueryStore.getState().draft).toBe('Incoming Lumen task'));
    await user.click(screen.getByRole('searchbox', {name: 'Describe a computer task'}));
    await user.keyboard('{Enter}');
    expect(deliveries).toEqual([]);
    expect(screen.getByRole('button', {name: /Agent application/})).toHaveTextContent('Lumen browser agent');
  });

  it('presents the next activation only after an explicit Run finishes', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/?service=memory');
    const queue: WindowsAgentActivation[] = [
      {activationId: 'review-one', agentName: 'lumen.browser', prompt: 'Reviewed incoming task'},
      {activationId: 'review-two', agentName: 'lumen.browser', prompt: 'Queued incoming task'},
    ];
    const source = nativeActivations(queue);
    render(<App windowService={new BrowserWindowService()} />);
    await waitFor(() => expect(useQueryStore.getState().draft).toBe('Reviewed incoming task'));
    await act(async () => source.signal());
    expect(useQueryStore.getState().draft).toBe('Reviewed incoming task');
    expect(queue.map((item) => item.activationId)).toEqual(['review-two']);
    await user.click(screen.getByRole('searchbox', {name: 'Describe a computer task'}));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(useQueryStore.getState().draft).toBe('Queued incoming task'));
  });

  it('renders the Lumen application landmark', () => {
    render(<App />);

    expect(screen.getByRole('application', {name: 'Lumen'})).toBeVisible();
  });

  it('preserves the framework-independent appearance contract on the application root', () => {
    render(<App />);

    const root = screen.getByRole('application', {name: 'Lumen'});
    expect(root).toHaveAttribute('data-theme', defaultAppearance.mode);
    expect(root).toHaveAttribute('data-resolved-theme', 'light');
    expect(root).toHaveAttribute('data-transparency', defaultAppearance.transparency);
    expect(root).toHaveAttribute('data-contrast', 'standard');
    expect(root).toHaveAttribute('data-effects', defaultAppearance.effects);
    expect(root).toHaveAttribute('data-motion', defaultAppearance.motion);
    expect(root).toHaveAttribute('data-reduced-motion', 'false');
  });

  it('re-shows the mounted launcher through the DEV diagnostics event with its current query mode', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/?service=memory');
    render(<App />);
    const search = await screen.findByRole('searchbox', {name: 'Search files'});
    await user.type(search, 'quarterly report');
    await waitFor(() => expect(useQueryStore.getState().committed).toBe('quarterly report'));

    act(() => useLauncherStore.getState().hide());
    expect(useLauncherStore.getState().visible).toBe(false);
    act(() => window.dispatchEvent(new CustomEvent('lumen:diagnostics-show-launcher')));

    expect(useLauncherStore.getState()).toMatchObject({mode: 'expanded', visible: true});
    expect(screen.getByRole('searchbox', {name: 'Search files'})).toBe(search);
    expect(search).toHaveValue('quarterly report');
    expect(search).toHaveFocus();
  });

  it('uses the typed unavailable answer service outside the native runtime', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/?service=memory');
    render(<App />);

    const search = await screen.findByRole('searchbox', {name: 'Search files'});
    await user.type(search, 'report');
    await user.keyboard('{Enter}');

    expect(await screen.findByTestId('answer-region')).toHaveTextContent(
      'The answer runtime is not ready. Local search is still available.',
    );
  });

  it('routes the DEV gallery through the app window lifecycle and retains gallery ownership', async () => {
    const windowService = new ReactivatableWindowService();
    window.history.replaceState({}, '', '/?gallery=1&scenario=collapsed-idle');

    render(<App windowService={windowService} />);

    expect(await screen.findByRole(
      'region',
      {name: 'Lumen visual state gallery'},
      {timeout: 5_000},
    )).toBeVisible();
    await waitFor(() => expect(windowService.snapshot()).toMatchObject({
      mode: 'gallery',
      visible: true,
      width: 1120,
      height: 760,
    }));
    expect(useLauncherStore.getState()).toMatchObject({mode: 'gallery', visible: true});

    act(() => windowService.reactivateCollapsed());

    await waitFor(() => expect(windowService.snapshot()).toMatchObject({
      mode: 'gallery',
      visible: true,
      width: 1120,
      height: 760,
    }));
    expect(useLauncherStore.getState()).toMatchObject({mode: 'gallery', visible: true});
  });

  it('reflects native activity without making exact search unavailable', async () => {
    window.history.replaceState({}, '', '/?service=memory');
    const activityService: ActivityService = {
      status: async () => ({
        mode: 'gaming',
        backgroundPolicy: 'paused',
        foregroundIdentity: 'a'.repeat(64),
        fullscreen: true,
        onBattery: false,
      }),
      setUserPause: async () => Promise.reject(new Error('unused')),
      setPolicy: async () => Promise.reject(new Error('unused')),
      chooseExecutable: async () => null,
    };

    render(<App activityService={activityService} />);

    expect(await screen.findByRole('searchbox', {name: 'Search files'})).toBeVisible();
    await waitFor(() => expect(useActivityStore.getState()).toMatchObject({
      active: true,
      mode: 'gaming',
    }));
  });
});
