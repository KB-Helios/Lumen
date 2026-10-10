import {create} from 'zustand';

type SettingsDomain = 'general' | 'activity';

interface NativeOperationsState {
  general: symbol | null;
  activity: symbol | null;
  claim(domain: SettingsDomain): symbol | null;
  owns(domain: SettingsDomain, owner: symbol): boolean;
  release(domain: SettingsDomain, owner: symbol): void;
}

// Native work outlives a settings tab. Keep its ownership until apply, save,
// and any rollback have all settled, including executable picker admission.
export const useNativeOperationsStore = create<NativeOperationsState>((set, get) => ({
  general: null,
  activity: null,
  claim: (domain) => {
    if (get()[domain] !== null) return null;
    const owner = Symbol(domain);
    set({[domain]: owner});
    return owner;
  },
  owns: (domain, owner) => get()[domain] === owner,
  release: (domain, owner) => {
    if (get()[domain] === owner) set({[domain]: null});
  },
}));
