import {isNativeRuntime} from '../ai/native-ai-service';
import {DevelopmentImprovementService} from './development-improvement-service';
import {TauriImprovementService} from './tauri-improvement-service';
import {UnavailableImprovementService} from './unavailable-improvement-service';
import type {ImprovementService} from './improvement-service';
export function createImprovementService(): ImprovementService {
  if (isNativeRuntime()) return new TauriImprovementService();
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('service') === 'memory') return new DevelopmentImprovementService();
  return new UnavailableImprovementService();
}
export const improvementService = createImprovementService();
