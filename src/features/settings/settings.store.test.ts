import {afterEach, expect, it, vi} from 'vitest';
import {settingsPersistence, useSettingsStore} from './settings.store';
import {waitFor} from '@testing-library/react';

afterEach(() => useSettingsStore.getState().reset());

it('keeps the committed root removal in memory if native admission and disk rollback both fail', async () => {
  useSettingsStore.setState((state) => ({
    roots: [{id: 'projects', path: 'C:\\Projects', paused: false, exclusions: [], includeHidden: false, maxFileSizeMb: 256, status: 'ready'}],
    ai: {...state.ai, cloudEnrichedRootIds: ['projects']},
  }));
  let persisted: Parameters<typeof settingsPersistence.write>[0] | undefined;
  vi.spyOn(settingsPersistence, 'write')
    .mockImplementationOnce(async (settings) => {persisted = settings;})
    .mockRejectedValueOnce(new Error('Disk unavailable'));
  const removed = await useSettingsStore.getState().removeRoot('projects', async () => {throw new Error('Admission denied');});
  expect(removed).toBe(false);
  expect(useSettingsStore.getState().roots).toEqual(persisted?.roots);
  expect(useSettingsStore.getState().ai.cloudEnrichedRootIds).toEqual(persisted?.ai.cloudEnrichedRootIds);
  expect(useSettingsStore.getState().persistenceError).toContain('could not be restored');
});

it('retains a newer root queued while native removal and disk rollback fail', async () => {
  const original = {id: 'projects', path: 'C:\\Projects', paused: false, exclusions: [], includeHidden: false, maxFileSizeMb: 256, status: 'ready' as const};
  const added = {...original, id: 'added', path: 'C:\\Added'};
  useSettingsStore.setState({roots: [original]});
  let persisted: Parameters<typeof settingsPersistence.write>[0] | undefined;
  vi.spyOn(settingsPersistence, 'write')
    .mockImplementationOnce(async (settings) => {persisted = settings;})
    .mockRejectedValueOnce(new Error('Disk unavailable'))
    .mockImplementation(async (settings) => {persisted = settings;});
  let fail!: (error: Error) => void;
  const removal = useSettingsStore.getState().removeRoot('projects', () => new Promise((_, reject) => {fail = reject;}));
  await waitFor(() => expect(fail).toBeDefined());
  const addition = useSettingsStore.getState().setRoots([original, added]);
  fail(new Error('Admission denied'));
  expect(await removal).toBe(false);
  expect(await addition).toBe(true);
  expect(useSettingsStore.getState().roots).toEqual([added]);
  expect(persisted?.roots).toEqual([added]);
});
