import {describe, expect, it, vi} from 'vitest';

import {BrowserSettingsService} from '../services/settings/browser-settings-service';
import type {SettingsService} from '../services/settings/settings-service';
import {defaultAppearanceSettings} from './appearance.schema';
import {createAppearanceStore} from './appearance.store';

describe('appearance persistence', () => {
  it('serializes saves so an older pending choice cannot overwrite the newest choice', async () => {
    let finish!: () => void;
    const writes: string[] = [];
    const service: SettingsService = {
      readAppearance: async () => defaultAppearanceSettings,
      writeAppearance: async (value) => {
        if (value.mode === 'dark') await new Promise<void>((resolve) => {finish = resolve;});
        writes.push(value.mode);
        return {ok: true};
      },
    };
    const store = createAppearanceStore(service);
    const first = store.getState().setMode('dark');
    await Promise.resolve();
    const second = store.getState().setMode('light');
    await Promise.resolve();
    expect(writes).toEqual([]);
    finish();
    await Promise.all([first, second]);
    expect(writes).toEqual(['dark', 'light']);
    expect(store.getState().mode).toBe('light');
  });
  it('falls back safely when persisted appearance is invalid', async () => {
    const service = new BrowserSettingsService(
      new Map([['appearance', '{"mode":"neon"}']]),
    );

    expect(await service.readAppearance()).toEqual(defaultAppearanceSettings);
  });

  it('hydrates defaults for missing fields and persists a valid edit', async () => {
    const backingStore = new Map([
      ['appearance', '{"mode":"dark","density":"compact"}'],
    ]);
    const service = new BrowserSettingsService(backingStore);
    const store = createAppearanceStore(service);

    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({
      mode: 'dark',
      density: 'compact',
      preview: 'automatic',
      hydrationStatus: 'ready',
    });

    await store.getState().setTransparency('reduced');
    expect(JSON.parse(backingStore.get('appearance') ?? '{}')).toMatchObject({
      mode: 'dark',
      transparency: 'reduced',
    });
  });

  it('keeps an optimistic edit visible when a native write fails', async () => {
    const service: SettingsService = {
      readAppearance: vi.fn().mockResolvedValue(defaultAppearanceSettings),
      writeAppearance: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: 'settings-write-failed',
          message: 'The settings file is unavailable.',
          operation: 'write',
          recoverable: true,
        },
      }),
    };
    const store = createAppearanceStore(service);

    const write = store.getState().setMode('dark');
    expect(store.getState().mode).toBe('dark');
    await write;

    expect(store.getState()).toMatchObject({
      mode: 'dark',
      persistenceStatus: 'error',
      persistenceError: {code: 'settings-write-failed'},
    });
  });
});
