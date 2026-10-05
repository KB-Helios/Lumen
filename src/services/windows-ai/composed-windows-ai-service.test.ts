import {describe, expect, it, vi} from 'vitest';
import {EdgeAiService} from '../edge-ai/edge-ai-service';
import {ComposedWindowsAiService} from './composed-windows-ai-service';
import {UnavailableWindowsAiService} from './unavailable-windows-ai-service';
import type {WindowsAiFeature, WindowsAiSnapshot} from './windows-ai.types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return {promise, resolve, reject};
}

function enabledNative() {
  return new UnavailableWindowsAiService({
    getItem: () => '{"edgeEnabled":true,"dictationEnabled":true,"textToolsEnabled":true,"modelDownloadsAllowed":true}',
    setItem: () => undefined,
  });
}

class LocalSpeech {
  static async available() { return 'available'; }
  static async install() { return true; }
  static current: LocalSpeech;
  stopped = false;
  processLocally = false;
  constructor() { LocalSpeech.current = this; }
  start() { /* The fake browser owns capture until abort. */ }
  abort() { this.stopped = true; }
  stop() { this.stopped = true; }
}
Object.defineProperty(LocalSpeech.prototype, 'processLocally', {value: false, writable: true});

describe('combined host readiness', () => {
  it.each([{edgeEnabled: false}, {dictationEnabled: false}])('stops microphone capture before a native revocation response for %j', async (patch) => {
    const native = enabledNative();
    const pending = deferred<WindowsAiSnapshot>();
    const edge = new EdgeAiService({isSecureContext: true, userActivation: {isActive: true}, SpeechRecognition: LocalSpeech});
    const service = new ComposedWindowsAiService(native, edge);
    await service.status();
    const session = await service.startDictation({onText: vi.fn(), onEnd: vi.fn(), onError: vi.fn()});
    const original = await native.status();
    vi.spyOn(native, 'updatePreferences').mockReturnValue(pending.promise);
    const updating = service.updatePreferences(patch);
    try {
      expect(LocalSpeech.current.stopped).toBe(true);
      await expect(service.startDictation({onText: vi.fn(), onEnd: vi.fn(), onError: vi.fn()})).rejects.toMatchObject({code: 'edge_disabled'});
    } finally {
      pending.resolve({...original, preferences: {...original.preferences, ...patch}});
      await updating;
      session.stop();
      edge.dispose();
    }
  });

  it('destroys active text output before a stalled native text-tool revocation finishes', async () => {
    const native = enabledNative();
    const pending = deferred<WindowsAiSnapshot>();
    let destroyed = false;
    let creationSignal: AbortSignal | undefined;
    const edge = new EdgeAiService({isSecureContext: true, userActivation: {isActive: true}, Summarizer: {
      availability: async () => 'available',
      create: async ({signal}: {signal: AbortSignal}) => {
        creationSignal = signal;
        return {destroy: () => {destroyed = true;}, summarizeStreaming: () => new ReadableStream()};
      },
    }});
    const service = new ComposedWindowsAiService(native, edge);
    await service.status();
    const text = service.text({requestId: 'active-summary', engine: 'edge', task: 'summarize', text: 'Public text'}).catch((error: unknown) => error);
    await vi.waitFor(() => expect(creationSignal).toBeDefined());
    const original = await native.status();
    vi.spyOn(native, 'updatePreferences').mockReturnValue(pending.promise);
    const updating = service.updatePreferences({textToolsEnabled: false});
    try {
      expect(creationSignal?.aborted).toBe(true);
      expect(destroyed).toBe(true);
      expect(await text).toMatchObject({name: 'AbortError'});
      await expect(service.text({requestId: 'new-summary', engine: 'edge', task: 'summarize', text: 'Public text'})).rejects.toMatchObject({code: 'edge_disabled'});
    } finally {
      pending.resolve({...original, preferences: {...original.preferences, textToolsEnabled: false}});
      await updating;
      edge.dispose();
    }
  });

  it('cancels model preparation before a stalled native download revocation finishes', async () => {
    const native = enabledNative();
    const pending = deferred<WindowsAiSnapshot>();
    const creation = deferred<{destroy(): void}>();
    let creationSignal: AbortSignal | undefined;
    const edge = new EdgeAiService({isSecureContext: true, userActivation: {isActive: true}, LanguageModel: {
      availability: async () => 'downloadable',
      create: ({signal}: {signal: AbortSignal}) => { creationSignal = signal; return creation.promise; },
    }});
    const service = new ComposedWindowsAiService(native, edge);
    await service.status();
    const preparing = service.prepare('edgePrompt', 'active-download').catch((error: unknown) => error);
    await vi.waitFor(() => expect(creationSignal).toBeDefined());
    const original = await native.status();
    vi.spyOn(native, 'updatePreferences').mockReturnValue(pending.promise);
    const updating = service.updatePreferences({modelDownloadsAllowed: false});
    try {
      expect(creationSignal?.aborted).toBe(true);
      expect(await preparing).toMatchObject({name: 'AbortError'});
      await expect(service.prepare('edgePrompt', 'new-download')).rejects.toMatchObject({code: 'edge_download_consent'});
    } finally {
      creation.resolve({destroy: () => undefined});
      pending.resolve({...original, preferences: {...original.preferences, modelDownloadsAllowed: false}});
      await updating;
      edge.dispose();
    }
  });

  it('does not restore consent from a native status response started before revocation', async () => {
    const native = enabledNative();
    const service = new ComposedWindowsAiService(native, new EdgeAiService());
    const original = await service.status();
    const pending = deferred<WindowsAiSnapshot>();
    vi.spyOn(native, 'status').mockReturnValueOnce(pending.promise);
    const old = service.status();
    await service.updatePreferences({dictationEnabled: false});
    pending.resolve(original);
    expect((await old).preferences.dictationEnabled).toBe(false);
  });

  it('retains confirmed permissions when a revocation write fails', async () => {
    const native = enabledNative();
    const service = new ComposedWindowsAiService(native, new EdgeAiService());
    await service.status();
    vi.spyOn(native, 'updatePreferences').mockRejectedValue(new Error('Cannot persist preferences'));
    await expect(service.updatePreferences({dictationEnabled: false})).rejects.toThrow('Cannot persist preferences');
    expect((await service.status()).preferences.dictationEnabled).toBe(true);
  });

  it('cannot restore revoked consent when an older probe resolves late', async () => {
    const native = new UnavailableWindowsAiService({getItem: () => '{"edgeEnabled":true,"dictationEnabled":true}', setItem: () => undefined});
    const edge = new EdgeAiService();
    let resolveOld!: (features: WindowsAiFeature[]) => void;
    vi.spyOn(edge, 'status').mockImplementationOnce(() => new Promise((resolve) => {resolveOld = resolve;})).mockResolvedValue([]);
    const dictate = vi.spyOn(edge, 'startDictation').mockResolvedValue({stop: vi.fn()});
    const service = new ComposedWindowsAiService(native, edge);
    const old = service.status();
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    await service.updatePreferences({dictationEnabled: false});
    resolveOld([]);
    expect((await old).preferences.dictationEnabled).toBe(false);
    await service.startDictation({onText: vi.fn(), onEnd: vi.fn(), onError: vi.fn()});
    expect(dictate).toHaveBeenCalledWith(expect.objectContaining({dictationEnabled: false}), expect.anything());
  });
});
