import {beforeEach, describe, expect, it, vi} from 'vitest';

import {defaultSettings, parseSettings} from './settings.schema';
import {settingsPersistence, useSettingsStore} from './settings.store';

describe('AI runtime settings', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    window.localStorage.clear();
    useSettingsStore.getState().reset();
  });

  it('upgrades an older settings payload to Auto without losing existing settings', () => {
    const parsed = parseSettings({...defaultSettings, ai: undefined});

    expect(parsed.ai).toEqual({
      runtimeMode: 'auto',
      keepLocalWarm: false,
      cloudAnswerConsent: false,
      cloudEnrichedRootIds: [],
    });
    expect(parsed.general.shortcut).toBe(defaultSettings.general.shortcut);
  });

  it('persists the selected runtime mode per device', async () => {
    await useSettingsStore.getState().updateAi({runtimeMode: 'local'});

    const saved = JSON.parse(window.localStorage.getItem('lumen-management-settings') ?? '{}');
    expect(saved.ai.runtimeMode).toBe('local');
    expect(useSettingsStore.getState().ai.runtimeMode).toBe('local');
  });

  it('keeps runtime application errors transient while persisting the selected preferences', async () => {
    useSettingsStore.setState({localRuntimeError: 'apply-failed'});
    await useSettingsStore.getState().updateAi({runtimeMode: 'local'});

    const saved = JSON.parse(window.localStorage.getItem('lumen-management-settings') ?? '{}');
    expect(saved.ai.runtimeMode).toBe('local');
    expect(saved).not.toHaveProperty('localRuntimeError');
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().localRuntimeError).toBeNull();
  });

  it('fails closed when an existing AI settings payload predates cloud answer consent', () => {
    const parsed = parseSettings({
      ...defaultSettings,
      ai: {
        runtimeMode: 'cloud',
        keepLocalWarm: false,
        cloudEnrichedRootIds: [],
      },
    });

    expect(parsed.ai.cloudAnswerConsent).toBe(false);
  });

  it('persists explicit cloud answer consent per device', async () => {
    await useSettingsStore.getState().setCloudAnswerConsent(true);

    const saved = JSON.parse(window.localStorage.getItem('lumen-management-settings') ?? '{}');
    expect(saved.ai.cloudAnswerConsent).toBe(true);
  });

  it('does not expose cloud consent before the device write succeeds', async () => {
    let finishSave: (() => void) | undefined;
    vi.spyOn(settingsPersistence, 'write').mockImplementation(() => new Promise<void>((resolve) => {
      finishSave = resolve;
    }));

    const saving = useSettingsStore.getState().setCloudAnswerConsent(true);
    await Promise.resolve();
    expect(useSettingsStore.getState().ai.cloudAnswerConsent).toBe(false);

    finishSave?.();
    await expect(saving).resolves.toBe(true);
    expect(useSettingsStore.getState().ai.cloudAnswerConsent).toBe(true);
  });

  it('serializes full-settings writes so older snapshots cannot finish last', async () => {
    let finishFirstSave: (() => void) | undefined;
    const write = vi.spyOn(settingsPersistence, 'write')
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishFirstSave = resolve;
      }))
      .mockResolvedValue(undefined);

    const first = useSettingsStore.getState().updateAi({runtimeMode: 'local'});
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const second = useSettingsStore.getState().updateComputerUse({model: 'gemini-3.5-flash'});
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);

    finishFirstSave?.();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(write).toHaveBeenCalledTimes(2);
  });
});

