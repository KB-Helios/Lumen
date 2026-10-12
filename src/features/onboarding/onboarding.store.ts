import {LazyStore} from '@tauri-apps/plugin-store';
import {create} from 'zustand';
import {subscribeWithSelector} from 'zustand/middleware';

export const onboardingSteps = [
  'welcome',
  'root',
  'shortcut',
  'choices',
] as const;

export type OnboardingStep = (typeof onboardingSteps)[number];

interface PersistedOnboarding {
  completed: boolean;
  root: string;
  shortcut: string;
}

interface OnboardingData extends PersistedOnboarding {
  currentIndex: number;
  hydrated: boolean;
  started: boolean;
}

interface OnboardingActions {
  back(): void;
  begin(): void;
  complete(): Promise<boolean>;
  hydrate(): Promise<void>;
  next(): void;
  reset(): void;
  setRoot(root: string): boolean;
  setShortcut(shortcut: string): void;
}

export type OnboardingState = OnboardingData & OnboardingActions;

const storageKey = 'lumen-onboarding';
const nativeStore = new LazyStore('lumen.settings.json', {autoSave: false});

const initialData: OnboardingData = {
  completed: false,
  currentIndex: 0,
  hydrated: false,
  root: '',
  shortcut: 'Alt + Space',
  started: false,
};

export function isValidRoot(root: string) {
  const value = root.trim();
  return value.length >= 3 && (/^[a-z]:\\/i.test(value) || /^\\\\[^\\]+\\/.test(value));
}

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function parsePersisted(value: unknown): PersistedOnboarding | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Partial<PersistedOnboarding>;
  if (
    typeof candidate.completed !== 'boolean' ||
    typeof candidate.root !== 'string' ||
    typeof candidate.shortcut !== 'string'
  ) {
    return null;
  }
  return {
    completed: candidate.completed && isValidRoot(candidate.root),
    root: isValidRoot(candidate.root) ? candidate.root : '',
    shortcut: candidate.shortcut || 'Alt + Space',
  };
}

async function readPersisted() {
  try {
    if (isTauriRuntime()) {
      return parsePersisted(await nativeStore.get<unknown>('onboarding'));
    }
    const raw = window.localStorage.getItem(storageKey);
    return raw ? parsePersisted(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

async function persist(value: PersistedOnboarding) {
  if (!isTauriRuntime()) {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
    return;
  }
  await nativeStore.set('onboarding', value);
  await nativeStore.save();
}

export const useOnboardingStore = create<OnboardingState>()(
  subscribeWithSelector((set, get) => ({
    ...initialData,
    back: () => set((state) => ({currentIndex: Math.max(0, state.currentIndex - 1)})),
    begin: () => set({started: true, currentIndex: 1}),
    complete: async () => {
      const state = get();
      if (!isValidRoot(state.root)) {
        return false;
      }
      const value = {completed: true, root: state.root, shortcut: state.shortcut};
      await persist(value);
      set({...value, hydrated: true});
      return true;
    },
    hydrate: async () => {
      if (get().hydrated) {
        return;
      }
      const persisted = await readPersisted();
      set(persisted ? {...persisted, hydrated: true} : {hydrated: true});
    },
    next: () => set((state) => ({
      currentIndex: state.currentIndex === 1 && !isValidRoot(state.root)
        ? state.currentIndex
        : Math.min(onboardingSteps.length - 1, state.currentIndex + 1),
    })),
    reset: () => set(initialData),
    setRoot: (root) => {
      if (!isValidRoot(root)) {
        return false;
      }
      set({root: root.trim()});
      return true;
    },
    setShortcut: (shortcut) => set({shortcut}),
  })),
);
