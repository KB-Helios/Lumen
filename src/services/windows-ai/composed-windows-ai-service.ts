import type {EdgeAiService} from '../edge-ai/edge-ai-service';
import type {DictationListener, WindowsAiEventListener, WindowsAiService} from './windows-ai-service';
import {windowsAiSnapshotSchema, type WindowsAiFeatureId, type WindowsAiPreferences, type WindowsAiSnapshot, type WindowsAiTextRequest} from './windows-ai.types';

/** Windows and web capabilities are probed in their actual hosts. */
export class ComposedWindowsAiService implements WindowsAiService {
  private snapshot: WindowsAiSnapshot | null = null;
  private revision = 0;
  private preferences: WindowsAiPreferences | null = null;
  constructor(private readonly native: WindowsAiService, private readonly edge: EdgeAiService) {}
  private async combine(snapshot: WindowsAiSnapshot) {
    const revision = ++this.revision;
    this.preferences = snapshot.preferences;
    const features = await this.edge.status(snapshot.preferences);
    const combined = windowsAiSnapshotSchema.parse({...snapshot, features: [...snapshot.features.filter((feature) => feature.host === 'windows'), ...features]});
    if (revision === this.revision) this.snapshot = combined;
    return this.snapshot ?? combined;
  }
  async status() { return this.combine(await this.native.status()); }
  async updatePreferences(patch: Partial<WindowsAiPreferences>) { return this.combine(await this.native.updatePreferences(patch)); }
  async prepare(featureId: WindowsAiFeatureId, requestId: string, listener?: WindowsAiEventListener, signal?: AbortSignal) {
    if (featureId.startsWith('edge')) {
      const preferences = this.preferences ?? (await this.status()).preferences;
      await this.edge.prepare(featureId, requestId, preferences, listener, signal);
      return this.status();
    }
    return this.combine(await this.native.prepare(featureId, requestId, listener, signal));
  }
  async text(request: WindowsAiTextRequest, listener?: WindowsAiEventListener, signal?: AbortSignal) {
    if (request.engine !== 'edge') return this.native.text(request, listener, signal);
    return this.edge.text(request, this.preferences ?? (await this.status()).preferences, listener, signal);
  }
  image: WindowsAiService['image'] = (...args) => this.native.image(...args);
  searchContent: WindowsAiService['searchContent'] = (...args) => this.native.searchContent(...args);
  rebuildContent: WindowsAiService['rebuildContent'] = (...args) => this.native.rebuildContent(...args);
  deleteContent: WindowsAiService['deleteContent'] = (...args) => this.native.deleteContent(...args);
  discoverAgents: WindowsAiService['discoverAgents'] = (...args) => this.native.discoverAgents(...args);
  invokeAgent: WindowsAiService['invokeAgent'] = (...args) => this.native.invokeAgent(...args);
  async setRegistration(enabled: boolean) { return this.combine(await this.native.setRegistration(enabled)); }
  async setAccessToken(token: string) { return this.combine(await this.native.setAccessToken(token)); }
  async cancel(requestId: string) { this.edge.cancel(requestId); await this.native.cancel(requestId); }
  consumeActivation: WindowsAiService['consumeActivation'] = () => this.native.consumeActivation();
  subscribeActivation: WindowsAiService['subscribeActivation'] = (listener) => this.native.subscribeActivation(listener);
  subscribe(listener: (snapshot: WindowsAiSnapshot) => void) {
    let active = true;
    const unsubscribe = this.native.subscribe((snapshot) => { void this.combine(snapshot).then((combined) => { if (active) listener(combined); }).catch(() => undefined); });
    return () => { active = false; unsubscribe(); };
  }
  async startDictation(listener: DictationListener) { return this.edge.startDictation(this.preferences ?? (await this.status()).preferences, listener); }
}
