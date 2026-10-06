import {LazyStore} from '@tauri-apps/plugin-store';
import {create} from 'zustand';
import {subscribeWithSelector} from 'zustand/middleware';

import {
  defaultSettings,
  parseSettings,
  settingsSchema,
  type AiSettings,
  type ComputerUseSettings,
  type ActivitySettings,
  type GeneralSettings,
  type IndexedRoot,
  type LumenSettings,
  type PresentationSettings,
  type PrivacySettings,
  type SearchSettings,
  type SettingsPageId,
} from './settings.schema';

export type SettingsPersistenceStatus = 'idle' | 'loading' | 'ready' | 'saving' | 'saved' | 'error';

interface SettingsMeta {
  hydrated: boolean;
  persistenceStatus: SettingsPersistenceStatus;
  persistenceError: string | null;
}

interface SettingsActions {
  hydrate(): Promise<void>;
  reset(): void;
  setActivePage(page: SettingsPageId): void;
  updateGeneral(patch: Partial<GeneralSettings>): Promise<boolean>;
  updatePresentation(patch: Partial<PresentationSettings>): Promise<boolean>;
  setRoots(roots: IndexedRoot[]): Promise<boolean>;
  setRootsAndAi(roots: IndexedRoot[], patch: Partial<AiSettings>): Promise<boolean>;
  updateSearch(patch: Partial<SearchSettings>): Promise<boolean>;
  updateAi(patch: Partial<AiSettings>): Promise<boolean>;
  setCloudAnswerConsent(granted: boolean): Promise<boolean>;
  updateComputerUse(patch: Partial<ComputerUseSettings>): Promise<boolean>;
  setComputerUseConsent(granted: boolean, consent?: 'cloudConsent' | 'desktopControlConsent' | 'desktopCloudConsent'): Promise<boolean>;
  updateActivity(patch: Partial<ActivitySettings>): Promise<boolean>;
  updatePrivacy(patch: Partial<PrivacySettings>): Promise<boolean>;
}

export type SettingsState = LumenSettings & SettingsMeta & SettingsActions;

const browserStorageKey = 'lumen-management-settings';
const nativeStore = new LazyStore('lumen.settings.json', {autoSave: false});

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function readSettings() {
  try {
    if (isTauriRuntime()) {
      return parseSettings(await nativeStore.get<unknown>('management'));
    }
    const raw = window.localStorage.getItem(browserStorageKey);
    return raw ? parseSettings(JSON.parse(raw)) : defaultSettings;
  } catch {
    return defaultSettings;
  }
}

async function writeSettings(settings: LumenSettings) {
  if (isTauriRuntime()) {
    await nativeStore.set('management', settings);
    await nativeStore.save();
    return;
  }
  window.localStorage.setItem(browserStorageKey, JSON.stringify(settings));
}

/** Internal persistence seam kept injectable for ordering and failure regression tests. */
export const settingsPersistence = {
  read: readSettings,
  write: writeSettings,
};

function stateSettings(state: SettingsState): LumenSettings {
  return settingsSchema.parse({
    activePage: state.activePage,
    general: state.general,
    presentation: state.presentation,
    roots: state.roots,
    search: state.search,
    ai: state.ai,
    computerUse: state.computerUse,
    activity: state.activity,
    privacy: state.privacy,
  });
}

const initialMeta: SettingsMeta = {
  hydrated: false,
  persistenceStatus: 'idle',
  persistenceError: null,
};

export const useSettingsStore = create<SettingsState>()(
  subscribeWithSelector((set, get) => {
    let writeRevision = 0;
    let writeQueue = Promise.resolve();
    const computerUseConsentRevisions = {cloudConsent: 0, desktopControlConsent: 0, desktopCloudConsent: 0};

    async function persist(
      settings: () => LumenSettings = () => stateSettings(get()),
      afterWrite?: () => void,
    ) {
      const revision = ++writeRevision;
      set({persistenceStatus: 'saving', persistenceError: null});
      const write = writeQueue.then(async () => {
        await settingsPersistence.write(settings());
        afterWrite?.();
      });
      writeQueue = write.catch(() => undefined);
      try {
        await write;
        if (revision === writeRevision) {
          set({persistenceStatus: 'saved'});
        }
        return true;
      } catch (error) {
        if (revision === writeRevision) {
          set({
            persistenceStatus: 'error',
            persistenceError: error instanceof Error ? error.message : 'Settings could not be saved.',
          });
        }
        return false;
      }
    }

    return {
      ...defaultSettings,
      ...initialMeta,
      hydrate: async () => {
        if (get().hydrated) {
          return;
        }
        set({persistenceStatus: 'loading'});
        const settings = await settingsPersistence.read();
        set({...settings, hydrated: true, persistenceStatus: 'ready'});
      },
      reset: () => {
        writeRevision += 1;
        computerUseConsentRevisions.cloudConsent += 1;
        computerUseConsentRevisions.desktopControlConsent += 1;
        computerUseConsentRevisions.desktopCloudConsent += 1;
        set({...defaultSettings, ...initialMeta});
      },
      setActivePage: (activePage) => {
        set({activePage});
        void persist();
      },
      updateGeneral: (patch) => {
        set((state) => ({general: {...state.general, ...patch}}));
        return persist();
      },
      updatePresentation: (patch) => {
        set((state) => ({presentation: {...state.presentation, ...patch}}));
        return persist();
      },
      setRoots: (roots) => {
        set({roots});
        return persist();
      },
      setRootsAndAi: (roots, patch) => {
        set((state) => ({roots, ai: {...state.ai, ...patch}}));
        return persist();
      },
      updateSearch: (patch) => {
        set((state) => ({search: {...state.search, ...patch}}));
        return persist();
      },
      updateAi: (patch) => {
        set((state) => ({ai: {...state.ai, ...patch}}));
        return persist();
      },
      setCloudAnswerConsent: (granted) => persist(
        () => {
          const settings = stateSettings(get());
          return settingsSchema.parse({
            ...settings,
            ai: {...settings.ai, cloudAnswerConsent: granted},
          });
        },
        () => set((state) => ({ai: {...state.ai, cloudAnswerConsent: granted}})),
      ),
      updateComputerUse: (patch) => {
        const configuration = {...patch};
        delete configuration.cloudConsent;
        delete configuration.desktopControlConsent;
        delete configuration.desktopCloudConsent;
        set((state) => ({computerUse: {...state.computerUse, ...configuration}}));
        return persist();
      },
      setComputerUseConsent: (granted, consent = 'cloudConsent') => {
        const revision = ++computerUseConsentRevisions[consent];
        // Withdrawal closes UI admission immediately, even while the disk is busy.
        if (!granted) set((state) => ({computerUse: {...state.computerUse, [consent]: false}}));
        return persist(
          () => {
            const settings = stateSettings(get());
            return settingsSchema.parse({
              ...settings,
              computerUse: {...settings.computerUse, [consent]: revision === computerUseConsentRevisions[consent] ? granted : settings.computerUse[consent]},
            });
          },
          () => {
            if (revision === computerUseConsentRevisions[consent]) set((state) => ({computerUse: {...state.computerUse, [consent]: granted}}));
          },
        );
      },
      updateActivity: (patch) => {
        set((state) => ({activity: {...state.activity, ...patch}}));
        return persist();
      },
      updatePrivacy: (patch) => {
        set((state) => ({privacy: {...state.privacy, ...patch}}));
        return persist();
      },
    };
  }),
);
