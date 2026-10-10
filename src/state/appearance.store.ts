import {useStore} from 'zustand';
import {createStore, type StoreApi} from 'zustand/vanilla';

import {BrowserSettingsService} from '../services/settings/browser-settings-service';
import type {
  SettingsFailure,
  SettingsService,
  SettingsWriteResult,
} from '../services/settings/settings-service';
import {TauriSettingsService} from '../services/settings/tauri-settings-service';
import {
  appearanceSchema,
  defaultAppearanceSettings,
  type AppearanceSettings,
} from './appearance.schema';

export type AppearanceHydrationStatus = 'idle' | 'loading' | 'ready';
export type AppearancePersistenceStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface AppearanceActions {
  hydrate(): Promise<void>;
  setMode(value: AppearanceSettings['mode']): Promise<SettingsWriteResult>;
  setTransparency(value: AppearanceSettings['transparency']): Promise<SettingsWriteResult>;
  setDensity(value: AppearanceSettings['density']): Promise<SettingsWriteResult>;
  setPreview(value: AppearanceSettings['preview']): Promise<SettingsWriteResult>;
  setMotion(value: AppearanceSettings['motion']): Promise<SettingsWriteResult>;
  setEffects(value: AppearanceSettings['effects']): Promise<SettingsWriteResult>;
}

export interface AppearanceState extends AppearanceSettings, AppearanceActions {
  hydrationStatus: AppearanceHydrationStatus;
  persistenceStatus: AppearancePersistenceStatus;
  persistenceError: SettingsFailure | null;
}

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function createDefaultSettingsService(): SettingsService {
  return isTauriRuntime()
    ? new TauriSettingsService()
    : new BrowserSettingsService();
}

function selectSettings(state: AppearanceState): AppearanceSettings {
  return appearanceSchema.parse({
    mode: state.mode,
    transparency: state.transparency,
    density: state.density,
    preview: state.preview,
    motion: state.motion,
    effects: state.effects,
  });
}

export function createAppearanceStore(
  settingsService: SettingsService = createDefaultSettingsService(),
): StoreApi<AppearanceState> {
  let writeRevision = 0;
  let writeQueue = Promise.resolve();

  return createStore<AppearanceState>((set, get) => {
    async function persist(): Promise<SettingsWriteResult> {
      const revision = ++writeRevision;
      set({persistenceStatus: 'saving', persistenceError: null});
      const value = selectSettings(get());
      const write = writeQueue.then(() => settingsService.writeAppearance(value));
      writeQueue = write.then(() => undefined, () => undefined);
      let result: SettingsWriteResult;
      try {
        result = await write;
      } catch (error) {
        result = {ok: false, error: {code: 'settings-write-failed', operation: 'write', recoverable: true, message: error instanceof Error ? error.message : 'Appearance could not be saved.'}};
      }

      if (revision === writeRevision) {
        set(
          result.ok
            ? {persistenceStatus: 'saved', persistenceError: null}
            : {persistenceStatus: 'error', persistenceError: result.error},
        );
      }

      return result;
    }

    return {
      ...defaultAppearanceSettings,
      hydrationStatus: 'idle',
      persistenceStatus: 'idle',
      persistenceError: null,
      hydrate: async () => {
        if (get().hydrationStatus !== 'idle') {
          return;
        }

        set({hydrationStatus: 'loading'});
        const appearance = await settingsService.readAppearance();
        set({...appearance, hydrationStatus: 'ready'});
      },
      setMode: (mode) => {
        set({mode});
        return persist();
      },
      setTransparency: (transparency) => {
        set({transparency});
        return persist();
      },
      setDensity: (density) => {
        set({density});
        return persist();
      },
      setPreview: (preview) => {
        set({preview});
        return persist();
      },
      setMotion: (motion) => {
        set({motion});
        return persist();
      },
      setEffects: (effects) => {
        set({effects});
        return persist();
      },
    };
  });
}

export const appearanceStore = createAppearanceStore();

export function useAppearanceStore<T>(selector: (state: AppearanceState) => T): T {
  return useStore(appearanceStore, selector);
}

