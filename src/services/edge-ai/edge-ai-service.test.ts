import {afterEach, describe, expect, it, vi} from 'vitest';

import {defaultWindowsAiPreferences} from '../windows-ai/windows-ai.types';
import type {WindowsAiEvent, WindowsAiPreferences, WindowsAiTextRequest} from '../windows-ai/windows-ai.types';
import {EdgeAiService} from './edge-ai-service';

const enabled: WindowsAiPreferences = {
  ...defaultWindowsAiPreferences,
  edgeEnabled: true,
  textToolsEnabled: true,
  dictationEnabled: true,
};
const request: WindowsAiTextRequest = {requestId: 'edge-test', engine: 'edge', task: 'answer', text: 'Hello'};
const services: EdgeAiService[] = [];

function host(extra: Record<string, unknown> = {}) {
  return {isSecureContext: true, userActivation: {isActive: true}, ...extra};
}

function createService(extra: Record<string, unknown> = {}) {
  const service = new EdgeAiService(host(extra));
  services.push(service);
  return service;
}

function model(chunks: unknown[] = ['Hello', ' world']) {
  let created = 0;
  let destroyed = 0;
  let input: string | undefined;
  const availabilityOptions: unknown[] = [];
  const creationOptions: Record<string, unknown>[] = [];
  const session = {
    destroy() {destroyed++;},
    promptStreaming(text: string) {
      input = text;
      return new ReadableStream({start(controller) {for (const chunk of chunks) controller.enqueue(chunk); controller.close();}});
    },
  };
  const api = {
    async availability(options?: unknown) {availabilityOptions.push(options); return 'available';},
    async create(options: Record<string, unknown>) {created++; creationOptions.push(options); return session;},
  };
  return {api, session, availabilityOptions, creationOptions, get created() {return created;}, get destroyed() {return destroyed;}, get input() {return input;}};
}

class LocalRecognition {
  static instances: LocalRecognition[] = [];
  static availability = 'available';
  static availableOptions: unknown[] = [];
  static installations = 0;
  static async available(options: unknown) {this.availableOptions.push(options); return this.availability;}
  static async install() {this.installations++; this.availability = 'available'; return true;}
  lang = '';
  continuous = false;
  interimResults = false;
  started = 0;
  stopped = 0;
  onresult: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor() {LocalRecognition.instances.push(this);}
  get processLocally() {return this.local;}
  set processLocally(value: boolean) {this.local = value;}
  private local = false;
  start() {this.started++;}
  stop() {this.stopped++;}
  abort() {this.stopped++;}
}

afterEach(() => {
  for (const service of services) service.dispose();
  services.length = 0;
  LocalRecognition.instances.length = 0;
  LocalRecognition.availableOptions.length = 0;
  LocalRecognition.installations = 0;
  LocalRecognition.availability = 'available';
  vi.useRealTimers();
});

describe('EdgeAiService capability and consent boundary', () => {
  it('reports each missing current-host API without creating any sessions', async () => {
    const features = await createService().status(enabled);
    expect(features.map(({id}) => id)).toEqual(['edgePrompt', 'edgeSummarize', 'edgeWrite', 'edgeRewrite', 'edgeLanguageDetection', 'edgeTranslation', 'edgeSpeech']);
    expect(features.every((feature) => feature.availability === 'unsupported' && feature.model === null)).toBe(true);
  });

  it('rejects an insecure host even when APIs are present', async () => {
    const fake = model();
    const features = await createService({isSecureContext: false, LanguageModel: fake.api}).status(enabled);
    expect(features[0]).toMatchObject({availability: 'unsupported', reasonCode: 'edge_insecure_context'});
    expect(fake.created).toBe(0);
    expect(fake.availabilityOptions).toEqual([]);
  });

  it('keeps passive status side-effect free and applies enablement gates', async () => {
    const fake = model();
    const service = createService({LanguageModel: fake.api});
    expect((await service.status({...enabled, edgeEnabled: false}))[0]).toMatchObject({availability: 'disabled', enabled: false});
    expect((await service.status({...enabled, textToolsEnabled: false})).find((feature) => feature.id === 'edgeRewrite')).toMatchObject({availability: 'disabled', enabled: false});
    expect((await service.status(enabled))[0]).toMatchObject({availability: 'ready', enabled: true, model: null});
    expect(fake.created).toBe(0);
  });

  it('fails closed on unknown availability instead of declaring a model ready', async () => {
    const fake = model();
    fake.api.availability = async () => 'probably-ready';
    expect((await createService({LanguageModel: fake.api}).status(enabled))[0]).toMatchObject({availability: 'failed', reasonCode: 'edge_api_contract'});
    expect(fake.created).toBe(0);
  });

  it.each(['downloadable', 'downloading', 'unavailable'])('never creates a session for a text request while availability is %s', async (availability) => {
    const fake = model();
    fake.api.availability = async () => availability;
    await expect(createService({LanguageModel: fake.api}).text(request, {...enabled, modelDownloadsAllowed: true})).rejects.toMatchObject({code: 'edge_not_ready'});
    expect(fake.created).toBe(0);
  });

  it.each([{edgeEnabled: false}, {textToolsEnabled: false}])('enforces text-tool consent before a session can be created', async (patch) => {
    const fake = model();
    await expect(createService({Writer: fake.api}).text({...request, task: 'write'}, {...enabled, ...patch})).rejects.toMatchObject({code: 'edge_disabled'});
    expect(fake.created).toBe(0);
  });

  it.each([{text: 'x'.repeat(65_537)}, {text: '界'.repeat(22_000)}, {requestId: 'bad request'}, {engine: 'windows'}, {sourceLanguage: '../en'}])('rejects invalid or oversized requests before touching browser APIs', async (patch) => {
    const fake = model();
    await expect(createService({LanguageModel: fake.api}).text({...request, ...patch} as WindowsAiTextRequest, enabled)).rejects.toMatchObject({code: 'edge_invalid_request'});
    expect(fake.created).toBe(0);
    expect(fake.availabilityOptions).toEqual([]);
  });

  it('requires recorded download consent and current user activation for preparation', async () => {
    const fake = model();
    fake.api.availability = async () => 'downloadable';
    await expect(createService({LanguageModel: fake.api}).prepare('edgePrompt', 'prepare-1', enabled)).rejects.toMatchObject({code: 'edge_download_consent'});
    await expect(createService({LanguageModel: fake.api, userActivation: {isActive: false}}).prepare('edgePrompt', 'prepare-2', {...enabled, modelDownloadsAllowed: true})).rejects.toMatchObject({code: 'edge_user_activation'});
    expect(fake.created).toBe(0);
  });

  it('reports actual download progress and releases the prepared session', async () => {
    const fake = model();
    let availability = 'downloadable';
    fake.api.availability = async () => availability;
    fake.api.create = async (options) => {
      fake.creationOptions.push(options);
      const monitor = new EventTarget();
      (options.monitor as (monitor: EventTarget) => void)(monitor);
      monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), {loaded: 25, total: 100}));
      monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), {loaded: 100, total: 100}));
      availability = 'available';
      return fake.session;
    };
    const events: WindowsAiEvent[] = [];
    await createService({LanguageModel: fake.api}).prepare('edgePrompt', 'prepare-1', {...enabled, modelDownloadsAllowed: true}, (event) => events.push(event));
    expect(events.filter((event) => event.type === 'progress').filter((event) => event.progress !== null).map((event) => event.progress)).toEqual([0.25, 1]);
    expect(events[events.length - 1]).toEqual({type: 'completed', requestId: 'prepare-1'});
    expect(fake.destroyed).toBe(1);
  });

  it('does not convert creation success into readiness when the fresh probe is still downloading', async () => {
    const fake = model();
    fake.api.availability = async () => 'downloadable';
    await expect(createService({LanguageModel: fake.api}).prepare('edgePrompt', 'prepare-1', {...enabled, modelDownloadsAllowed: true})).rejects.toMatchObject({code: 'edge_not_ready'});
    expect(fake.destroyed).toBe(1);
  });

  it('checks the exact translation pair instead of reusing settings readiness', async () => {
    const fake = model();
    fake.api.availability = async (options) => {
      fake.availabilityOptions.push(options);
      const pair = options as {sourceLanguage: string; targetLanguage: string};
      return pair.sourceLanguage === 'en' && pair.targetLanguage === 'sv' ? 'available' : 'unavailable';
    };
    const service = createService({Translator: fake.api});
    expect((await service.status(enabled)).find((feature) => feature.id === 'edgeTranslation')?.availability).toBe('ready');
    await expect(service.text({...request, task: 'translate', sourceLanguage: 'sv', targetLanguage: 'ja'}, enabled)).rejects.toMatchObject({code: 'edge_not_ready'});
    expect(fake.availabilityOptions).toContainEqual({sourceLanguage: 'sv', targetLanguage: 'ja'});
    expect(fake.created).toBe(0);
  });
});

describe('EdgeAiService bounded sessions and streams', () => {
  it('aborts an unexpected model download during text session creation', async () => {
    const fake = model();
    fake.api.create = async (options) => {
      const monitor = new EventTarget();
      (options.monitor as (monitor: EventTarget) => void)(monitor);
      monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), {loaded: 0.25, total: 1}));
      return fake.session;
    };
    await expect(createService({LanguageModel: fake.api}).text(request, {...enabled, modelDownloadsAllowed: true})).rejects.toMatchObject({code: 'edge_unexpected_download'});
    expect(fake.input).toBeUndefined();
    expect(fake.destroyed).toBe(1);
  });

  it('accepts the standard initialization-only zero and one progress events for a ready model', async () => {
    const fake = model();
    fake.api.create = async (options) => {
      const monitor = new EventTarget();
      (options.monitor as (monitor: EventTarget) => void)(monitor);
      monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), {loaded: 0, total: 1}));
      monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), {loaded: 1, total: 1}));
      return fake.session;
    };
    expect((await createService({LanguageModel: fake.api}).text(request, enabled)).text).toBe('Hello world');
    expect(fake.destroyed).toBe(1);
  });

  it.each([
    {task: 'summarize', apiName: 'Summarizer', methodName: 'summarizeStreaming'},
    {task: 'write', apiName: 'Writer', methodName: 'writeStreaming'},
    {task: 'rewrite', apiName: 'Rewriter', methodName: 'rewriteStreaming'},
    {task: 'translate', apiName: 'Translator', methodName: 'translateStreaming'},
  ] as const)('dispatches $task to its exposed task-specific API', async ({task, apiName, methodName}) => {
    const fake = model();
    const api = {...fake.api, create: async () => ({...fake.session, [methodName]: (text: string) => new ReadableStream({start(controller) {controller.enqueue(`${task}: ${text}`); controller.close();}})})};
    const result = await createService({[apiName]: api}).text({...request, task}, enabled);
    expect(result.text).toBe(`${task}: Hello`);
    expect(result.citations).toEqual([]);
    expect(fake.destroyed).toBe(1);
  });

  it('validates language detection and selects the highest-confidence result', async () => {
    const fake = model();
    const api = {...fake.api, create: async () => ({...fake.session, detect: async () => [{detectedLanguage: 'en', confidence: 0.2}, {detectedLanguage: 'sv', confidence: 0.8}]})};
    const result = await createService({LanguageDetector: api}).text({...request, task: 'detectLanguage'}, enabled);
    expect(result).toEqual({text: 'sv', detectedLanguage: 'sv', confidence: 0.8, engine: 'edge', model: null, citations: []});
    expect(fake.availabilityOptions[0]).toEqual({expectedInputLanguages: ['en']});
    expect(fake.destroyed).toBe(1);
  });

  it('rejects malformed language-detector confidence without returning a result', async () => {
    const fake = model();
    const api = {...fake.api, create: async () => ({...fake.session, detect: async () => [{detectedLanguage: 'sv', confidence: 20}]})};
    await expect(createService({LanguageDetector: api}).text({...request, task: 'detectLanguage'}, enabled)).rejects.toMatchObject({code: 'edge_api_contract'});
    expect(fake.destroyed).toBe(1);
  });

  it('ends a stalled stream at the operation deadline', async () => {
    vi.useFakeTimers();
    const fake = model();
    fake.session.promptStreaming = () => new ReadableStream();
    const pending = createService({LanguageModel: fake.api}).text(request, enabled).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fake.created).toBe(1));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await pending).toMatchObject({code: 'edge_timeout'});
    expect(fake.destroyed).toBe(1);
  });

  it('preserves repeated delta tokens and emits only appendable deltas', async () => {
    const fake = model(['ha', 'ha', '!']);
    const events: WindowsAiEvent[] = [];
    const result = await createService({LanguageModel: fake.api}).text(request, enabled, (event) => events.push(event));
    expect(result).toEqual({text: 'haha!', engine: 'edge', model: null, citations: []});
    expect(events.filter((event) => event.type === 'delta').map((event) => event.text)).toEqual(['ha', 'ha', '!']);
    expect(fake.destroyed).toBe(1);
  });

  it('normalizes explicitly cumulative host chunks without duplicating prior output', async () => {
    const fake = model(['Hello', 'Hello', 'Hello world']);
    const events: WindowsAiEvent[] = [];
    const result = await createService({LanguageModel: fake.api, streamSemantics: {edgePrompt: 'cumulative'}}).text(request, enabled, (event) => events.push(event));
    expect(result.text).toBe('Hello world');
    expect(events.filter((event) => event.type === 'delta').map((event) => event.text)).toEqual(['Hello', ' world']);
  });

  it('rejects a cumulative stream that rewrites already emitted text', async () => {
    const fake = model(['Hello', 'Goodbye']);
    await expect(createService({LanguageModel: fake.api, streamSemantics: {edgePrompt: 'cumulative'}}).text(request, enabled)).rejects.toMatchObject({code: 'edge_api_contract'});
    expect(fake.destroyed).toBe(1);
  });

  it('uses language-specific options for availability and session creation', async () => {
    const fake = model();
    await createService({LanguageModel: fake.api}).text({...request, sourceLanguage: 'sv', targetLanguage: 'en'}, enabled);
    expect(fake.availabilityOptions[0]).toEqual({expectedInputs: [{type: 'text', languages: ['sv']}], expectedOutputs: [{type: 'text', languages: ['en']}]});
    expect(fake.creationOptions[0]).toMatchObject(fake.availabilityOptions[0] as object);
  });

  it('rejects input beyond the session context quota before generating', async () => {
    const fake = model();
    const api = {...fake.api, create: async () => ({...fake.session, contextWindow: 10, contextUsage: 1, measureContextUsage: async () => 12})};
    await expect(createService({LanguageModel: api}).text(request, enabled)).rejects.toMatchObject({code: 'edge_input_limit'});
    expect(fake.input).toBeUndefined();
    expect(fake.destroyed).toBe(1);
  });

  it('bounds provider output and destroys the session on malformed or oversized chunks', async () => {
    for (const chunks of [[{text: 'unsafe'}], ['x'.repeat(262_145)]]) {
      const fake = model(chunks);
      await expect(createService({LanguageModel: fake.api}).text(request, enabled)).rejects.toMatchObject({code: expect.stringMatching(/^edge_(api_contract|output_limit)$/)});
      expect(fake.destroyed).toBe(1);
    }
  });

  it('aborts a pending stream, cancels its reader, and suppresses late output', async () => {
    const fake = model();
    let cancelled = false;
    fake.session.promptStreaming = () => new ReadableStream({cancel() {cancelled = true;}});
    const events: WindowsAiEvent[] = [];
    const controller = new AbortController();
    const pending = createService({LanguageModel: fake.api}).text(request, enabled, (event) => events.push(event), controller.signal);
    const failure = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(fake.created).toBe(1));
    controller.abort();
    expect(await failure).toMatchObject({name: 'AbortError'});
    expect(cancelled).toBe(true);
    expect(fake.destroyed).toBe(1);
    expect(events).toEqual([{type: 'cancelled', requestId: request.requestId}]);
  });

  it('destroys a session that resolves after cancellation during creation', async () => {
    const fake = model();
    let finish: ((session: typeof fake.session) => void) | undefined;
    const api = {...fake.api, create: () => new Promise<typeof fake.session>((resolve) => {finish = resolve;})};
    const service = createService({LanguageModel: api});
    const pending = service.text(request, enabled);
    const failure = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    service.cancel(request.requestId);
    expect(await failure).toMatchObject({name: 'AbortError'});
    finish!(fake.session);
    await vi.waitFor(() => expect(fake.destroyed).toBe(1));
  });

  it('returns a sanitized provider error without disclosing submitted text', async () => {
    const fake = model();
    fake.session.promptStreaming = () => {throw new Error('Provider echoed a private prompt');};
    const events: WindowsAiEvent[] = [];
    await expect(createService({LanguageModel: fake.api}).text(request, enabled, (event) => events.push(event))).rejects.toMatchObject({code: 'edge_operation_failed'});
    expect(JSON.stringify(events)).not.toContain('private prompt');
    expect(fake.destroyed).toBe(1);
  });

  it('revokes a pending operation when refreshed authoritative preferences disable its feature', async () => {
    const fake = model();
    fake.session.promptStreaming = () => new ReadableStream();
    const service = createService({LanguageModel: fake.api});
    const pending = service.text(request, enabled);
    const failure = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(fake.created).toBe(1));
    await service.status({...enabled, edgeEnabled: false});
    expect(await failure).toMatchObject({name: 'AbortError'});
    expect(fake.destroyed).toBe(1);
  });
});

describe('EdgeAiService local dictation', () => {
  it('stops an otherwise healthy capture at its finite time limit', async () => {
    vi.useFakeTimers();
    let ended = 0;
    await createService({SpeechRecognition: LocalRecognition}).startDictation(enabled, {onText() {}, onEnd() {ended++;}, onError() {}});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(LocalRecognition.instances[0].stopped).toBe(1);
    expect(ended).toBe(1);
  });

  it('rejects transcript overflow and releases the microphone', async () => {
    const errors: string[] = [];
    await createService({SpeechRecognition: LocalRecognition}).startDictation(enabled, {onText() {throw new Error('Overflow must not be delivered');}, onEnd() {}, onError(message) {errors.push(message);}});
    const recognition = LocalRecognition.instances[0];
    const result = Object.assign([{transcript: 'x'.repeat(4001), confidence: 0.9}], {isFinal: true});
    recognition.onresult!({resultIndex: 0, results: [result]});
    expect(errors).toHaveLength(1);
    expect(recognition.stopped).toBe(1);
    expect(recognition.onresult).toBeNull();
  });

  it('stops on visibility loss and rejects a late transcript', async () => {
    const visibility = Object.assign(new EventTarget(), {hidden: false});
    const texts: string[] = [];
    await createService({SpeechRecognition: LocalRecognition, visibility}).startDictation(enabled, {onText(text) {texts.push(text);}, onEnd() {}, onError() {}});
    const recognition = LocalRecognition.instances[0];
    const lateResult = recognition.onresult!;
    visibility.hidden = true;
    visibility.dispatchEvent(new Event('visibilitychange'));
    lateResult({resultIndex: 0, results: [Object.assign([{transcript: 'late', confidence: 0.9}], {isFinal: true})]});
    expect(texts).toEqual([]);
    expect(recognition.stopped).toBe(1);
  });

  it('rejects cloud-only recognition even if a prefixed API is exposed', async () => {
    class CloudRecognition {start() {throw new Error('Cloud capture must never start');}}
    const service = createService({SpeechRecognition: CloudRecognition, webkitSpeechRecognition: CloudRecognition});
    expect((await service.status(enabled)).find((feature) => feature.id === 'edgeSpeech')).toMatchObject({availability: 'unsupported', reasonCode: 'edge_local_speech_missing'});
    await expect(service.startDictation(enabled, {onText() {}, onEnd() {}, onError() {}})).rejects.toMatchObject({code: 'edge_local_speech_missing'});
  });

  it('checks requested-language local availability without installing or capturing', async () => {
    LocalRecognition.availability = 'downloadable';
    const service = createService({SpeechRecognition: LocalRecognition});
    expect((await service.status({...enabled, speechLanguage: 'sv-SE'})).find((feature) => feature.id === 'edgeSpeech')?.availability).toBe('downloadable');
    expect(LocalRecognition.availableOptions).toContainEqual({langs: ['sv-SE'], processLocally: true});
    await expect(service.startDictation(enabled, {onText() {}, onEnd() {}, onError() {}})).rejects.toMatchObject({code: 'edge_not_ready'});
    expect(LocalRecognition.instances).toEqual([]);
    expect(LocalRecognition.installations).toBe(0);
  });

  it('requires a microphone opt-in independently of language tools and downloads', async () => {
    const service = createService({SpeechRecognition: LocalRecognition});
    await expect(service.startDictation({...enabled, dictationEnabled: false, modelDownloadsAllowed: true}, {onText() {}, onEnd() {}, onError() {}})).rejects.toMatchObject({code: 'edge_disabled'});
    expect(LocalRecognition.instances).toEqual([]);
  });

  it('allows local-language installation only through explicit prepare without starting the microphone', async () => {
    LocalRecognition.availability = 'downloadable';
    await createService({SpeechRecognition: LocalRecognition}).prepare('edgeSpeech', 'speech-pack', {...enabled, modelDownloadsAllowed: true});
    expect(LocalRecognition.installations).toBe(1);
    expect(LocalRecognition.instances).toEqual([]);
    expect(LocalRecognition.availableOptions).toContainEqual({langs: ['en-US'], processLocally: true});
  });

  it('delivers bounded draft transcripts locally and disposes capture on navigation', async () => {
    const lifecycle = new EventTarget();
    const texts: Array<{text: string; final: boolean}> = [];
    let ended = 0;
    const service = createService({SpeechRecognition: LocalRecognition, lifecycle});
    const session = await service.startDictation(enabled, {onText(text, final) {texts.push({text, final});}, onEnd() {ended++;}, onError() {}});
    const recognition = LocalRecognition.instances[0];
    expect(recognition).toMatchObject({processLocally: true, lang: 'en-US', continuous: true, interimResults: true, started: 1});
    const result = Object.assign([{transcript: 'hello', confidence: 0.9}], {isFinal: false});
    recognition.onresult!({resultIndex: 0, results: [result]});
    expect(texts).toEqual([{text: 'hello', final: false}]);
    lifecycle.dispatchEvent(new Event('pagehide'));
    expect(recognition.stopped).toBe(1);
    expect(ended).toBe(1);
    expect(recognition.onresult).toBeNull();
    session.stop();
    expect(ended).toBe(1);
  });

  it('stops capture and clears handlers when recognition reports an error', async () => {
    const errors: string[] = [];
    const service = createService({SpeechRecognition: LocalRecognition});
    await service.startDictation(enabled, {onText() {}, onEnd() {}, onError(error) {errors.push(error);}});
    const recognition = LocalRecognition.instances[0];
    recognition.onerror!({error: 'network', message: 'private transcript'});
    expect(recognition.stopped).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain('private transcript');
    expect(recognition.onresult).toBeNull();
  });
});
