import type {EdgeAiService} from '../edge-ai/edge-ai-service';
import type {DictationListener, WindowsAiEventListener, WindowsAiService} from './windows-ai-service';
import {defaultWindowsAiPreferences, windowsAiPreferencePatchSchema, windowsAiSnapshotSchema, type WindowsAiFeatureId, type WindowsAiPreferences, type WindowsAiSnapshot, type WindowsAiTextRequest} from './windows-ai.types';

/** Windows and web capabilities are probed in their actual hosts. */
export class ComposedWindowsAiService implements WindowsAiService {
  private snapshot: WindowsAiSnapshot | null = null;
  private revision = 0;
  private policyRevision = 0;
  private preferences: WindowsAiPreferences | null = null;
  private readonly pendingRevocations = new Map<number, Partial<WindowsAiPreferences>>();
  constructor(private readonly native: WindowsAiService, private readonly edge: EdgeAiService) {}
  private effectivePreferences(preferences: WindowsAiPreferences) {
    return Object.assign({...preferences}, ...this.pendingRevocations.values()) as WindowsAiPreferences;
  }
  private currentPreferences() {
    const preferences = this.preferences ?? (this.pendingRevocations.size ? defaultWindowsAiPreferences : null);
    return preferences ? this.effectivePreferences(preferences) : null;
  }
  private async combine(snapshot: WindowsAiSnapshot, policyRevision = this.policyRevision) {
    const revision = ++this.revision;
    if (policyRevision === this.policyRevision) this.preferences = snapshot.preferences;
    const preferences = this.effectivePreferences(this.preferences ?? snapshot.preferences);
    const features = await this.edge.status(preferences);
    const combined = windowsAiSnapshotSchema.parse({...snapshot, preferences, features: [...snapshot.features.filter((feature) => feature.host === 'windows'), ...features]});
    if (revision === this.revision) this.snapshot = combined;
    return this.snapshot ?? combined;
  }
  private async combineNative(pending: Promise<WindowsAiSnapshot>) {
    const policyRevision = this.policyRevision;
    return this.combine(await pending, policyRevision);
  }
  async status() { return this.combineNative(this.native.status()); }
  async updatePreferences(patch: Partial<WindowsAiPreferences>) {
    const validated = windowsAiPreferencePatchSchema.parse(patch);
    const policyRevision = ++this.policyRevision;
    const revoked: Partial<WindowsAiPreferences> = {};
    for (const key of ['edgeEnabled', 'dictationEnabled', 'textToolsEnabled', 'modelDownloadsAllowed'] as const) {
      if (validated[key] === false) revoked[key] = false;
    }
    this.pendingRevocations.set(policyRevision, revoked);
    ++this.revision;
    this.edge.revoke(this.effectivePreferences(this.preferences ?? defaultWindowsAiPreferences));
    try {
      const snapshot = await this.native.updatePreferences(validated);
      this.pendingRevocations.delete(policyRevision);
      return await this.combine(snapshot, policyRevision);
    } finally {
      this.pendingRevocations.delete(policyRevision);
    }
  }
  async prepare(featureId: WindowsAiFeatureId, requestId: string, listener?: WindowsAiEventListener, signal?: AbortSignal) {
    if (featureId.startsWith('edge')) {
      const preferences = this.currentPreferences() ?? (await this.status()).preferences;
      await this.edge.prepare(featureId, requestId, preferences, listener, signal);
      return this.status();
    }
    return this.combineNative(this.native.prepare(featureId, requestId, listener, signal));
  }
  async text(request: WindowsAiTextRequest, listener?: WindowsAiEventListener, signal?: AbortSignal) {
    if (request.engine !== 'edge') return this.native.text(request, listener, signal);
    return this.edge.text(request, this.currentPreferences() ?? (await this.status()).preferences, listener, signal);
  }
  image: WindowsAiService['image'] = (...args) => this.native.image(...args);
  searchContent: WindowsAiService['searchContent'] = (...args) => this.native.searchContent(...args);
  rebuildContent: WindowsAiService['rebuildContent'] = (...args) => this.native.rebuildContent(...args);
  deleteContent: WindowsAiService['deleteContent'] = (...args) => this.native.deleteContent(...args);
  discoverAgents: WindowsAiService['discoverAgents'] = (...args) => this.native.discoverAgents(...args);
  invokeAgent: WindowsAiService['invokeAgent'] = (...args) => this.native.invokeAgent(...args);
  async setRegistration(enabled: boolean) { return this.combineNative(this.native.setRegistration(enabled)); }
  async setAccessToken(token: string) { return this.combineNative(this.native.setAccessToken(token)); }
  async cancel(requestId: string) { this.edge.cancel(requestId); await this.native.cancel(requestId); }
  consumeActivation: WindowsAiService['consumeActivation'] = () => this.native.consumeActivation();
  subscribeActivation: WindowsAiService['subscribeActivation'] = (listener) => this.native.subscribeActivation(listener);
  subscribe(listener: (snapshot: WindowsAiSnapshot) => void) {
    let active = true;
    const unsubscribe = this.native.subscribe((snapshot) => { void this.combine(snapshot).then((combined) => { if (active) listener(combined); }).catch(() => undefined); });
    return () => { active = false; unsubscribe(); };
  }
  async startDictation(listener: DictationListener) { return this.edge.startDictation(this.currentPreferences() ?? (await this.status()).preferences, listener); }
}
