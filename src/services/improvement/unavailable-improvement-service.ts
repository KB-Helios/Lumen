import type {ImprovementService} from './improvement-service';
import {emptyImprovementSnapshot, preferenceSchema, type ImprovementHealth, type Preference} from './improvement.types';
export class UnavailableImprovementService implements ImprovementService {
  readonly simulated = false;
  readonly available = false;
  async health(): Promise<ImprovementHealth> {return {state: 'unavailable', version: '0.9.8', detail: 'Improvement requires the native Windows runtime.', prepared: false, modelReady: false};}
  async snapshot() {return emptyImprovementSnapshot();}
  async candidateBase(): Promise<never> {return this.unavailable();}
  async workflows() {return [];}
  private unavailable(): never {throw new Error('Improvement requires the native Windows runtime.');}
  async setSettings() {this.unavailable();}
  async prepare() {this.unavailable();}
  async analyze() {this.unavailable();}
  async cancel() {this.unavailable();}
  async approve() {this.unavailable();}
  async reject() {this.unavailable();}
  async rollback() {this.unavailable();}
  async clear() {this.unavailable();}
  async savePreference(preference: Preference) {preferenceSchema.parse(preference); this.unavailable();}
  async authorizeWorkflow(): Promise<never> {return this.unavailable();}
  async endWorkflow() {this.unavailable();}
}
