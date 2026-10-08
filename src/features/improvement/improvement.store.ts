import {useEffect} from 'react';
import {create} from 'zustand';
import {improvementService} from '../../services/improvement';
import type {ImprovementService} from '../../services/improvement/improvement-service';
import {emptyImprovementSnapshot, type ImprovementHealth, type ImprovementSnapshot} from '../../services/improvement/improvement.types';

interface ImprovementState {
  snapshot: ImprovementSnapshot;
  health: ImprovementHealth | null;
  busy: boolean;
  analyzing: boolean;
  message: string;
  refresh(service?: ImprovementService): Promise<void>;
  action(service: ImprovementService, operation: () => Promise<void>): Promise<void>;
  analyze(service: ImprovementService): Promise<void>;
  cancel(service: ImprovementService): Promise<void>;
  clear(service: ImprovementService): Promise<boolean>;
  reset(): void;
}
let refreshSequence = 0;
let analysisSequence = 0;
const initial = () => ({snapshot: emptyImprovementSnapshot(), health: null, busy: false, analyzing: false, message: ''});
export const useImprovementStore = create<ImprovementState>((set, get) => ({
  ...initial(),
  async refresh(service = improvementService) {
    const sequence = ++refreshSequence;
    const [snapshot, health] = await Promise.all([service.snapshot(), service.health()]);
    if (sequence === refreshSequence) set({snapshot, health});
  },
  async action(service, operation) {
    if (get().busy) return;
    set({busy: true, message: ''});
    try {await operation(); await get().refresh(service);}
    catch (error) {set({message: error instanceof Error ? error.message : 'Improvement action failed.'}); await get().refresh(service).catch(() => undefined);}
    finally {set({busy: false});}
  },
  async analyze(service) {
    if (get().busy || get().analyzing) return;
    const sequence = ++analysisSequence;
    set({analyzing: true, message: ''});
    try {
      await service.analyze((event) => {
        if (sequence !== analysisSequence) return;
        const terminal = ['completed', 'cancelled', 'failed'].includes(event.type);
        set({message: event.message ?? event.phase, analyzing: !terminal});
        if (terminal) void get().refresh(service).catch(() => undefined);
      });
      if (sequence === analysisSequence) await get().refresh(service);
    } catch (error) {if (sequence === analysisSequence) {++analysisSequence; set({analyzing: false, message: error instanceof Error ? error.message : 'Improvement analysis failed.'}); await get().refresh(service).catch(() => undefined);}}
  },
  async cancel(service) {
    await get().action(service, async () => {++analysisSequence; await service.cancel(); set({analyzing: false, message: 'Improvement analysis cancelled.'});});
  },
  async clear(service) {
    let cleared = false;
    await get().action(service, async () => {++analysisSequence; await service.clear(); set({analyzing: false}); cleared = true;});
    return cleared;
  },
  reset() {++analysisSequence; ++refreshSequence; set(initial());},
}));
export function useImprovement(service: ImprovementService = improvementService) {
  const state = useImprovementStore();
  useEffect(() => {
    let active = true;
    void useImprovementStore.getState().refresh(service).catch(() => {if (active) useImprovementStore.setState({message: 'Improvement status unavailable.'});});
    const timer = window.setInterval(() => {void useImprovementStore.getState().refresh(service).catch(() => undefined);}, 5000);
    return () => {active = false; window.clearInterval(timer);};
  }, [service]);
  return state;
}
