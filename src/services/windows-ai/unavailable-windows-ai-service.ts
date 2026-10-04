import type {WindowsAiService} from './windows-ai-service';
import {searchPublicCatalogue} from './catalogue';
import {defaultWindowsAiPreferences, windowsAiFeatureIds, windowsAiPreferencesSchema, windowsAiPreferencePatchSchema, type WindowsAiPreferences, type WindowsAiSnapshot} from './windows-ai.types';

const labels: Record<string, string> = {languageModel: 'Windows language model', aion: 'Aion Instruct preview', summarize: 'Windows summarizer', rewrite: 'Windows rewriter', ocr: 'Windows OCR', imageDescription: 'Image descriptions', appContentSearch: 'App Content Search', agentDiscovery: 'Windows agent discovery', agentInvocation: 'Windows agent invocation', agentRegistration: 'Lumen agent registration'};
export function unsupportedWindowsAiSnapshot(preferences = defaultWindowsAiPreferences): WindowsAiSnapshot {
  return {version: 1, host: {osBuild: 'Browser host', architecture: 'unknown', packageIdentity: false, runtimeVersion: null, npuProviders: []}, preferences, features: windowsAiFeatureIds.filter((id) => !id.startsWith('edge')).map((id) => ({id, host: 'windows', label: labels[id], availability: 'unsupported', reasonCode: 'nativeHostRequired', detail: 'Open the Windows desktop app to use this capability.', enabled: false, model: null})), agents: [], appIndex: {state: 'unavailable', items: 0}, accessTokenConfigured: false};
}

/** Browser host: preferences persist, but Windows readiness is never simulated. */
export class UnavailableWindowsAiService implements WindowsAiService {
  private preferences = {...defaultWindowsAiPreferences};
  private readonly listeners = new Set<(snapshot: WindowsAiSnapshot) => void>();
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage) {
    try { this.preferences = windowsAiPreferencesSchema.parse(JSON.parse(storage?.getItem('lumen.windows-ai.preferences') ?? '{}')); } catch { /* Invalid saved data fails closed. */ }
  }
  async status() { return unsupportedWindowsAiSnapshot(this.preferences); }
  async updatePreferences(patch: Partial<WindowsAiPreferences>) {
    const next = windowsAiPreferencesSchema.parse({...this.preferences, ...windowsAiPreferencePatchSchema.parse(patch)});
    if (next.registerLumenAgent) throw new Error('Package identity is required to register Lumen.');
    this.storage?.setItem('lumen.windows-ai.preferences', JSON.stringify(next));
    this.preferences = next;
    const snapshot = await this.status();
    this.listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  }
  async prepare(): Promise<WindowsAiSnapshot> { throw new Error('Windows AI requires the desktop app and a supported runtime.'); }
  async text(): Promise<never> { throw new Error('This Windows model is unavailable in the browser host.'); }
  async image(): Promise<never> { throw new Error('Windows image tools require the desktop app.'); }
  async searchContent(query: string, signal?: AbortSignal) { signal?.throwIfAborted(); return this.preferences.appContentEnabled ? searchPublicCatalogue(query) : []; }
  async rebuildContent() { return {ok: false, code: 'nativeHostRequired', message: 'Windows semantic indexing requires the desktop app. Public help is available through keyword search.'}; }
  async deleteContent() { return {ok: false, code: 'nativeHostRequired', message: 'This browser host has no Windows content index.'}; }
  async discoverAgents() { return []; }
  async invokeAgent(): Promise<never> { throw new Error('Windows agents require the desktop app.'); }
  async setRegistration(enabled: boolean) { return this.updatePreferences({registerLumenAgent: enabled}); }
  async setAccessToken(): Promise<never> { throw new Error('Access tokens can only be saved by the desktop app.'); }
  async cancel() { /* No Windows operations exist in a browser host. */ }
  async consumeActivation() { return null; }
  subscribeActivation() { return () => undefined; }
  subscribe(listener: (snapshot: WindowsAiSnapshot) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async startDictation(): Promise<never> { throw new Error('Local dictation is unavailable in this host.'); }
}
