import {beforeEach, describe, expect, it, vi} from 'vitest';
import {defaultSettings, parseSettings} from './settings.schema';
import {settingsPersistence, useSettingsStore} from './settings.store';

describe('Computer Use persisted permissions', () => {
  beforeEach(() => {window.localStorage.clear(); useSettingsStore.getState().reset();});
  it('preserves browser consent and saved model while migrating both desktop grants off', () => {
    const settings = parseSettings({...defaultSettings, computerUse: {
      model: 'gemini-3.5-flash', initialUrl: 'https://example.com', cloudConsent: true,
    }});
    expect(settings.computerUse).toMatchObject({
      model: 'gemini-3.5-flash', cloudConsent: true, provider: 'gemini', executionMode: 'fast',
      desktopControlConsent: false, desktopCloudConsent: false, openaiModel: 'gpt-6.1-sol',
    });
  });
  it('retains an unsupported saved model so its unavailable state can be explained', () => {
    const settings = parseSettings({...defaultSettings, computerUse: {
      model: 'saved-unsupported-model', initialUrl: 'https://example.com', cloudConsent: true,
    }});
    expect(settings.computerUse.model).toBe('saved-unsupported-model');
    expect(settings.computerUse.cloudConsent).toBe(true);
  });
  it.each(['desktopControlConsent', 'desktopCloudConsent'] as const)(
    'publishes %s only after its persisted grant succeeds', async (consent) => {
      let finish: (() => void) | undefined;
      vi.spyOn(settingsPersistence, 'write').mockImplementation(() => new Promise<void>((resolve) => {finish = resolve;}));
      const saving = useSettingsStore.getState().setComputerUseConsent(true, consent);
      await Promise.resolve();
      try {expect(useSettingsStore.getState().computerUse[consent]).toBe(false);} finally {finish!();}
      await expect(saving).resolves.toBe(true);
      expect(useSettingsStore.getState().computerUse[consent]).toBe(true);
    },
  );
  it('cannot grant permissions through the ordinary optimistic settings update', async () => {
    vi.spyOn(settingsPersistence, 'write').mockRejectedValue(new Error('device write failed'));
    await useSettingsStore.getState().updateComputerUse({desktopControlConsent: true, desktopCloudConsent: true});
    expect(useSettingsStore.getState().computerUse.desktopControlConsent).toBe(false);
    expect(useSettingsStore.getState().computerUse.desktopCloudConsent).toBe(false);
  });
  it('withdraws a grant immediately while its device write is pending and stays withdrawn on failure', async () => {
    useSettingsStore.setState((state) => ({computerUse: {...state.computerUse, desktopControlConsent: true}}));
    let rejectWrite: ((error: Error) => void) | undefined;
    vi.spyOn(settingsPersistence, 'write').mockImplementation(() => new Promise<void>((_resolve, reject) => {rejectWrite = reject;}));
    const saving = useSettingsStore.getState().setComputerUseConsent(false, 'desktopControlConsent');
    await Promise.resolve();
    try {expect(useSettingsStore.getState().computerUse.desktopControlConsent).toBe(false);} finally {rejectWrite!(new Error('device write failed')); await saving;}
    expect(useSettingsStore.getState().computerUse.desktopControlConsent).toBe(false);
  });
  it('never publishes an older pending grant after the user has withdrawn it', async () => {
    let finishGrant: (() => void) | undefined;
    vi.spyOn(settingsPersistence, 'write').mockImplementationOnce(() => new Promise<void>((resolve) => {finishGrant = resolve;})).mockResolvedValue(undefined);
    let publishedGrant = false;
    const unsubscribe = useSettingsStore.subscribe((state) => {publishedGrant ||= state.computerUse.desktopCloudConsent;});
    const grant = useSettingsStore.getState().setComputerUseConsent(true, 'desktopCloudConsent');
    await Promise.resolve();
    const revoke = useSettingsStore.getState().setComputerUseConsent(false, 'desktopCloudConsent');
    finishGrant!();
    await Promise.all([grant, revoke]);
    unsubscribe();
    expect(publishedGrant).toBe(false);
  });
});
