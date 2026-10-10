import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, expect, it, vi} from 'vitest';
import {AppProviders} from '../../../app/AppProviders';
import {nativeAiService} from '../../../services/ai/native-ai-service';
import {createActivityService} from '../../../services/activity/activity-service';
import type {SearchStatus} from '../../../services/search/search.types';
import {settingsPersistence, useSettingsStore} from '../settings.store';
import {ActivityPage} from './ActivityPage';
import {GeneralPage} from './GeneralPage';
import {IndexedRootsPage} from './IndexedRootsPage';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {resolve = finish;});
  return {promise, resolve};
}

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  useSettingsStore.getState().reset();
  localStorage.clear();
});

it.each(['direct', 'subscription'] as const)('ignores pre-admission %s Ready after a newer index generation', async (source) => {
  const user = userEvent.setup();
  Reflect.defineProperty(window, '__TAURI_INTERNALS__', {configurable: true, value: {}});
  const old = {phase: 'ready' as const, generation: 1, pendingItems: 0, indexedItems: 1, queuedEnrichment: 0, skippedItems: 0, message: 'Old index ready.'};
  const newer = {...old, phase: 'indexing' as const, generation: 2, message: 'Generation two is indexing.'};
  const initial = deferred<typeof old>();
  vi.spyOn(nativeAiService, 'indexStatus').mockImplementation(() => source === 'direct' ? initial.promise : Promise.resolve(old));
  vi.spyOn(nativeAiService, 'synchronizeRoots').mockResolvedValue(newer);
  let publish!: (status: SearchStatus) => void;
  const statusService = {subscribeToStatus: (listener: typeof publish) => {publish = listener; return () => undefined;}};
  useSettingsStore.setState({roots: [{id: 'projects', path: 'C:\\Projects', paused: false, exclusions: [], includeHidden: false, maxFileSizeMb: 256, status: 'ready'}]});
  render(<AppProviders><IndexedRootsPage statusService={statusService} /></AppProviders>);
  await user.click(screen.getByRole('button', {name: 'Rebuild index'}));
  expect(screen.getByText('Indexing')).toBeVisible();
  await act(async () => {
    if (source === 'direct') initial.resolve(old);
    else publish({...old, updatedAt: new Date().toISOString()});
  });
  expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  expect(screen.getByText(newer.message)).toBeVisible();
  act(() => publish({...newer, phase: 'ready', updatedAt: new Date().toISOString()}));
  expect(screen.getByText('Ready')).toBeVisible();
});

function nativePage(domain: 'General' | 'Activity', pending: Promise<void>, stage: 'apply' | 'save' | 'rollback') {
  let calls = 0;
  const apply = vi.fn(async () => {
    calls += 1;
    if (calls === (stage === 'apply' ? 1 : 2)) await pending;
  });
  if (domain === 'General') {
    const runtimeService = {setLaunchAtStartup: apply, setMonitorBehavior: vi.fn(async () => undefined), setCloseBehavior: vi.fn(async () => undefined), setHistoryEnabled: vi.fn(async () => undefined)};
    return {page: <GeneralPage runtimeService={runtimeService} />, apply, label: 'Launch at startup'};
  }
  const service = createActivityService();
  vi.spyOn(service, 'setPolicy').mockImplementation(async () => {await apply(); return service.status();});
  return {page: <ActivityPage activityService={service} nativeRuntime />, apply, label: 'Detect games automatically'};
}

it.each([
  ['General', 'apply'], ['General', 'save'], ['General', 'rollback'],
  ['Activity', 'apply'], ['Activity', 'save'], ['Activity', 'rollback'],
] as const)('holds %s ownership across remount during native %s', async (domain, stage) => {
  const user = userEvent.setup();
  const pending = deferred<void>();
  if (stage === 'rollback') vi.spyOn(settingsPersistence, 'write').mockRejectedValueOnce(new Error('Device save failed')).mockResolvedValue();
  if (stage === 'save') vi.spyOn(settingsPersistence, 'write').mockReturnValueOnce(pending.promise);
  const {page, apply, label} = nativePage(domain, pending.promise, stage);
  const original = render(<AppProviders>{page}</AppProviders>);
  await user.click(screen.getByRole('switch', {name: label}));
  await waitFor(() => expect(apply).toHaveBeenCalledTimes(stage === 'rollback' ? 2 : 1));
  original.unmount();
  render(<AppProviders>{page}</AppProviders>);
  try {
    expect(screen.getByRole('switch', {name: label})).toBeDisabled();
    await user.click(screen.getByRole('switch', {name: label}));
    expect(apply).toHaveBeenCalledTimes(stage === 'rollback' ? 2 : 1);
  } finally {
    await act(async () => pending.resolve());
  }
  await waitFor(() => expect(screen.getByRole('switch', {name: label})).toBeEnabled());
  expect(domain === 'General' ? useSettingsStore.getState().general.launchAtStartup : !useSettingsStore.getState().activity.detectGames).toBe(stage !== 'rollback');
});

it.each(['General', 'Activity'] as const)('retains newer %s choices when awaited native rollback completes', async (domain) => {
  const user = userEvent.setup();
  const pending = deferred<void>();
  vi.spyOn(settingsPersistence, 'write').mockRejectedValueOnce(new Error('Device save failed')).mockResolvedValue();
  const {page, apply, label} = nativePage(domain, pending.promise, 'rollback');
  render(<AppProviders>{page}</AppProviders>);
  await user.click(screen.getByRole('switch', {name: label}));
  await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
  act(() => useSettingsStore.setState((state) => domain === 'General'
    ? {general: {...state.general, monitorBehavior: 'primary'}}
    : {activity: {...state.activity, pauseOnBattery: false}}));
  await act(async () => pending.resolve());
  expect(domain === 'General' ? useSettingsStore.getState().general.launchAtStartup : !useSettingsStore.getState().activity.detectGames).toBe(true);
  expect(domain === 'General' ? useSettingsStore.getState().general.monitorBehavior : useSettingsStore.getState().activity.pauseOnBattery).toBe(domain === 'General' ? 'primary' : false);
});

it('holds Activity picker ownership across remount until native policy and persistence finish', async () => {
  const user = userEvent.setup();
  const selected = deferred<Awaited<ReturnType<ReturnType<typeof createActivityService>['chooseExecutable']>>>();
  const applying = deferred<void>();
  const service = createActivityService();
  vi.spyOn(service, 'chooseExecutable').mockReturnValue(selected.promise);
  vi.spyOn(service, 'setPolicy').mockImplementation(async () => {await applying.promise; return service.status();});
  const page = <ActivityPage activityService={service} nativeRuntime />;
  const original = render(<AppProviders>{page}</AppProviders>);
  await user.click(screen.getByRole('button', {name: 'Choose application executable'}));
  original.unmount();
  render(<AppProviders>{page}</AppProviders>);
  try {
    expect(screen.getByRole('switch', {name: 'Detect games automatically'})).toBeDisabled();
    await act(async () => selected.resolve({fileName: 'Example.exe', identityHash: 'a'.repeat(64)}));
    expect(screen.getByRole('switch', {name: 'Detect games automatically'})).toBeDisabled();
  } finally {
    await act(async () => {selected.resolve({fileName: 'Example.exe', identityHash: 'a'.repeat(64)}); applying.resolve();});
  }
  await waitFor(() => expect(screen.getByRole('switch', {name: 'Detect games automatically'})).toBeEnabled());
  expect(useSettingsStore.getState().activity.overrides[0]?.application).toBe('Example.exe');
});
