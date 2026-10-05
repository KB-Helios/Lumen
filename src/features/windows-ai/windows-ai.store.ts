import {create} from 'zustand';
import {windowsAiService} from '../../services/windows-ai';
import type {WindowsAiService} from '../../services/windows-ai/windows-ai-service';
import {defaultWindowsAiPreferences, type WindowsAiPreferences, type WindowsAiSnapshot} from '../../services/windows-ai/windows-ai.types';

interface WindowsAiState {
  snapshot: WindowsAiSnapshot | null;
  hydrated: boolean;
  busy: boolean;
  message: string;
  refresh(): Promise<void>;
  update(patch: Partial<WindowsAiPreferences>): Promise<void>;
  run<T>(action: () => Promise<T>, success?: string): Promise<T | undefined>;
}
export function createWindowsAiStore(service: WindowsAiService) {
  return create<WindowsAiState>((set, get) => ({
    snapshot: null, hydrated: false, busy: false, message: '',
    refresh: async () => {
      try { set({snapshot: await service.status(), hydrated: true}); }
      catch { set({hydrated: true, message: 'Windows AI availability could not be checked. Refresh to try again.'}); }
    },
    update: async (patch) => { await get().run(async () => { set({snapshot: await service.updatePreferences(patch)}); }); },
    run: async (action, success = '') => {
      if (get().busy) return undefined;
      set({busy: true, message: ''});
      try { const result = await action(); if (success) set({message: success}); return result; }
      catch (error) { set({message: error instanceof Error ? error.message : 'The Windows AI operation could not be completed.'}); return undefined; }
      finally { set({busy: false}); }
    },
  }));
}
export const useWindowsAiStore = createWindowsAiStore(windowsAiService);
export const getWindowsAiPreferences = () => useWindowsAiStore.getState().snapshot?.preferences ?? defaultWindowsAiPreferences;
