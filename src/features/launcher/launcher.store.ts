import {create} from 'zustand';
import {subscribeWithSelector} from 'zustand/middleware';

import type {WindowMode} from '../../platform/window/window-service';

export type LauncherFocusRegion = 'search' | 'scope' | 'results' | 'preview';
export type LauncherIntent = 'search' | 'computer';

interface LauncherData {
  mode: WindowMode;
  visible: boolean;
  focusRegion: LauncherFocusRegion;
  intent: LauncherIntent;
  externalAgentId: string;
  agentActivationId: string | null;
  agentActivationPending: boolean;
}

interface LauncherActions {
  show(mode: WindowMode): void;
  hide(): void;
  setMode(mode: WindowMode): void;
  setFocusRegion(region: LauncherFocusRegion): void;
  setIntent(intent: LauncherIntent): void;
  setExternalAgentId(id: string): void;
  finishAgentActivation(id: string): void;
  reset(): void;
}

export type LauncherStore = LauncherData & LauncherActions;

const initialLauncherData: LauncherData = {
  mode: 'collapsed',
  visible: true,
  focusRegion: 'search',
  intent: 'search',
  externalAgentId: '',
  agentActivationId: null,
  agentActivationPending: false,
};

export const useLauncherStore = create<LauncherStore>()(
  subscribeWithSelector((set, get) => ({
    ...initialLauncherData,
    show: (mode) => set({mode, visible: true}),
    hide: () => set({visible: false}),
    setMode: (mode) => set({mode}),
    setFocusRegion: (focusRegion) => set({focusRegion}),
    setIntent: (intent) => set({intent, focusRegion: 'search'}),
    setExternalAgentId: (externalAgentId) => set({externalAgentId}),
    finishAgentActivation: (id) => {
      if (get().agentActivationId === id) set({agentActivationId: null});
    },
    reset: () => set(initialLauncherData),
  })),
);

export const selectLauncherMode = (state: LauncherStore) => state.mode;
export const selectLauncherVisible = (state: LauncherStore) => state.visible;
export const selectLauncherFocusRegion = (state: LauncherStore) => state.focusRegion;

