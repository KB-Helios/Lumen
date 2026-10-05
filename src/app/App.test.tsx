import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {defaultAppearance} from '../design-system/theme';
import {useActivityStore} from '../features/activity/activity.store';
import {useLauncherStore} from '../features/launcher/launcher.store';
import {useQueryStore} from '../features/launcher/query.store';
import {useOnboardingStore} from '../features/onboarding/onboarding.store';
import {useSettingsStore} from '../features/settings/settings.store';
import {useWindowsAiStore} from '../features/windows-ai/windows-ai.store';
import {BrowserWindowService} from '../platform/window/browser-window-service';
import type {ActivityService} from '../services/activity/activity-service';
import {windowsAiService} from '../services/windows-ai';
import {unsupportedWindowsAiSnapshot} from '../services/windows-ai/unavailable-windows-ai-service';
import {defaultWindowsAiPreferences, type WindowsAgentActivation} from '../services/windows-ai/windows-ai.types';
import {App} from './App';

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
    await user.click(screen.getByRole('searchbox', {name: 'Describe a browser task'}));
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
    await user.click(screen.getByRole('searchbox', {name: 'Describe a browser task'}));
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
