import {z} from 'zod';

import type {DictationListener, DictationSession, WindowsAiEventListener} from '../windows-ai/windows-ai-service';
import {
  windowsAiEventSchema, windowsAiFeatureIdSchema, windowsAiFeatureSchema,
  windowsAiPreferencesSchema, windowsAiRequestIdSchema,
  windowsAiTextRequestSchema, windowsAiTextResultSchema,
} from '../windows-ai/windows-ai.types';
import type {WindowsAiEvent, WindowsAiFeature, WindowsAiFeatureId, WindowsAiPreferences, WindowsAiTextRequest, WindowsAiTextResult, WindowsAiTextTask} from '../windows-ai/windows-ai.types';

const features = {
  edgePrompt: {api: 'LanguageModel', label: 'Edge prompt', method: 'prompt'},
  edgeSummarize: {api: 'Summarizer', label: 'Edge summarize', method: 'summarize'},
  edgeWrite: {api: 'Writer', label: 'Edge write', method: 'write'},
  edgeRewrite: {api: 'Rewriter', label: 'Edge rewrite', method: 'rewrite'},
  edgeLanguageDetection: {api: 'LanguageDetector', label: 'Edge language detection', method: 'detect'},
  edgeTranslation: {api: 'Translator', label: 'Edge translation', method: 'translate'},
  edgeSpeech: {api: 'SpeechRecognition', label: 'Edge local dictation', method: null},
} as const;
type EdgeFeatureId = keyof typeof features;
type EdgeTextFeatureId = Exclude<EdgeFeatureId, 'edgeSpeech'>;
const taskFeatures: Record<WindowsAiTextTask, EdgeTextFeatureId> = {
  answer: 'edgePrompt', summarize: 'edgeSummarize', write: 'edgeWrite',
  rewrite: 'edgeRewrite', detectLanguage: 'edgeLanguageDetection', translate: 'edgeTranslation',
};
const availabilitySchema = z.enum(['available', 'downloadable', 'downloading', 'unavailable']);
const detectionSchema = z.array(windowsAiTextResultSchema.pick({detectedLanguage: true, confidence: true}).required()).min(1).max(256);
const inputByteLimit = 65_536;
const outputLimit = 262_144;
const probeTimeoutMs = 5_000;
const textTimeoutMs = 120_000;
const prepareTimeoutMs = 600_000;
const dictationTimeoutMs = 120_000;

/** The executing realm, injectable for tests. Browser APIs stay inside this service. */
export interface EdgeAiHost {
  isSecureContext: boolean;
  userActivation?: {isActive: boolean};
  LanguageModel?: unknown;
  Summarizer?: unknown;
  Writer?: unknown;
  Rewriter?: unknown;
  LanguageDetector?: unknown;
  Translator?: unknown;
  SpeechRecognition?: unknown;
  lifecycle?: EventTarget;
  visibility?: EventTarget & {readonly hidden: boolean};
  /** Current Edge APIs emit deltas. Set only for an explicitly known compatibility host. */
  streamSemantics?: Partial<Record<EdgeTextFeatureId, 'delta' | 'cumulative'>>;
}

type Options = Record<string, unknown>;
type Session = Options & {destroy(): void};
interface ModelApi {
  availability(options: Options): Promise<unknown>;
  create(options: Options): Promise<unknown>;
}
interface SpeechInstance {
  processLocally: boolean;
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface SpeechApi {
  new(): SpeechInstance;
  prototype: object;
  available(options: Options): Promise<unknown>;
  install(options: Options): Promise<unknown>;
}
interface Operation {
  requestId: string;
  featureId: EdgeFeatureId;
  preparing: boolean;
  controller: AbortController;
  resources: Set<() => void>;
}

export class EdgeAiError extends Error {
  constructor(readonly code: string, message: string) {super(message); this.name = 'EdgeAiError';}
}

function object(value: unknown): value is Options {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function executingHost(): EdgeAiHost {
  const scope = globalThis as unknown as Options;
  return {
    get isSecureContext() {return scope.isSecureContext === true;},
    get userActivation() {return typeof navigator !== 'undefined' ? navigator.userActivation : undefined;},
    get LanguageModel() {return scope.LanguageModel;},
    get Summarizer() {return scope.Summarizer;},
    get Writer() {return scope.Writer;},
    get Rewriter() {return scope.Rewriter;},
    get LanguageDetector() {return scope.LanguageDetector;},
    get Translator() {return scope.Translator;},
    get SpeechRecognition() {return scope.SpeechRecognition;},
    lifecycle: typeof window === 'undefined' ? undefined : window,
    visibility: typeof document === 'undefined' ? undefined : document,
  };
}

function preferences(value: WindowsAiPreferences): WindowsAiPreferences {
  const parsed = windowsAiPreferencesSchema.safeParse(value);
  if (!parsed.success) throw new EdgeAiError('edge_invalid_preferences', 'Edge AI preferences are invalid.');
  return parsed.data;
}

function enabled(id: EdgeFeatureId, prefs: WindowsAiPreferences): boolean {
  return prefs.edgeEnabled && (id === 'edgeSpeech' ? prefs.dictationEnabled : id === 'edgePrompt' || prefs.textToolsEnabled);
}

function assertEnabled(id: EdgeFeatureId, prefs: WindowsAiPreferences): void {
  if (!enabled(id, prefs)) throw new EdgeAiError('edge_disabled', 'Enable this Edge AI feature in Privacy before using it.');
}

function options(id: EdgeFeatureId, prefs: WindowsAiPreferences, request?: WindowsAiTextRequest): Options {
  const sourceLanguage = request?.sourceLanguage ?? prefs.sourceLanguage;
  const targetLanguage = request?.targetLanguage ?? (id === 'edgeTranslation' ? prefs.targetLanguage : sourceLanguage);
  if (id === 'edgeSpeech') return {langs: [prefs.speechLanguage], processLocally: true};
  if (id === 'edgeTranslation') return {sourceLanguage, targetLanguage};
  if (id === 'edgeLanguageDetection') return {expectedInputLanguages: [sourceLanguage]};
  if (id === 'edgePrompt') return {expectedInputs: [{type: 'text', languages: [sourceLanguage]}], expectedOutputs: [{type: 'text', languages: [targetLanguage]}]};
  return {expectedInputLanguages: [sourceLanguage], outputLanguage: targetLanguage, format: 'plain-text'};
}

function abortError(): DOMException {return new DOMException('Edge AI operation cancelled.', 'AbortError');}

function failure(error: unknown): EdgeAiError {
  if (error instanceof EdgeAiError) return error;
  if (object(error) && error.name === 'QuotaExceededError') return new EdgeAiError('edge_input_limit', 'The selected Edge model context is too small for this text. Shorten the input.');
  if (object(error) && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) return new EdgeAiError('edge_permission_denied', 'The browser denied this local AI operation. Check its permissions and try again.');
  return new EdgeAiError('edge_operation_failed', 'The Edge AI operation failed. Refresh its availability and try again.');
}

function emit(listener: WindowsAiEventListener | undefined, event: WindowsAiEvent): void {
  listener?.(windowsAiEventSchema.parse(event));
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined);
    throw signal.reason ?? abortError();
  }
  let onAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? abortError());
    signal.addEventListener('abort', onAbort, {once: true});
  });
  try {return await Promise.race([pending, cancelled]);}
  finally {signal.removeEventListener('abort', onAbort);}
}

async function boundedProbe(pending: Promise<unknown>, signal?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new EdgeAiError('edge_probe_timeout', 'The browser did not finish its availability check.')), probeTimeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? abortError());
  signal?.addEventListener('abort', onAbort, {once: true});
  if (signal?.aborted) onAbort();
  try {
    const parsed = availabilitySchema.safeParse(await abortable(pending, controller.signal));
    if (!parsed.success) throw new EdgeAiError('edge_api_contract', 'The browser returned an unknown availability state.');
    return parsed.data;
  } finally {clearTimeout(timer); signal?.removeEventListener('abort', onAbort);}
}

export class EdgeAiService {
  private readonly operations = new Map<string, Operation>();
  private dictation: {stop(): void; controller: AbortController} | null = null;
  private disposed = false;

  constructor(private readonly host: EdgeAiHost = executingHost()) {}

  async status(value: WindowsAiPreferences): Promise<WindowsAiFeature[]> {
    const prefs = preferences(value);
    this.revoke(prefs);
    return Promise.all((Object.keys(features) as EdgeFeatureId[]).map(async (id) => {
      const feature: WindowsAiFeature = {id, host: 'edge', label: features[id].label, availability: 'disabled', reasonCode: 'edge_disabled', detail: null, enabled: enabled(id, prefs), model: null};
      if (!feature.enabled) return windowsAiFeatureSchema.parse(feature);
      try {
        const availability = await this.availability(id, options(id, prefs));
        const states = {available: 'ready', downloadable: 'downloadable', downloading: 'preparing', unavailable: 'unavailable'} as const;
        feature.availability = states[availability];
        feature.reasonCode = `edge_${availability}`;
        feature.detail = availability === 'unavailable' ? 'This executing browser host cannot run the requested local model or language.' : availability === 'downloadable' ? 'Use Prepare with model-download consent to download this local model or language pack.' : null;
      } catch (error) {
        const reason = failure(error);
        feature.availability = ['edge_insecure_context', 'edge_api_missing', 'edge_local_speech_missing'].includes(reason.code) ? 'unsupported' : 'failed';
        feature.reasonCode = reason.code;
        feature.detail = reason.message;
      }
      return windowsAiFeatureSchema.parse(feature);
    }));
  }

  async prepare(featureId: WindowsAiFeatureId, requestId: string, value: WindowsAiPreferences, listener?: WindowsAiEventListener, signal?: AbortSignal): Promise<void> {
    const parsedId = windowsAiFeatureIdSchema.safeParse(featureId);
    if (!parsedId.success || !Object.prototype.hasOwnProperty.call(features, parsedId.data) || !windowsAiRequestIdSchema.safeParse(requestId).success) throw new EdgeAiError('edge_invalid_request', 'The Edge AI preparation request is invalid.');
    const id = parsedId.data as EdgeFeatureId;
    const prefs = preferences(value);
    assertEnabled(id, prefs);
    if (!prefs.modelDownloadsAllowed) throw new EdgeAiError('edge_download_consent', 'Record model-download consent in Privacy before preparing this model.');
    this.assertUserAction();
    await this.run(id, requestId, true, listener, signal, async (operation) => {
      const opts = options(id, prefs);
      const state = await this.availability(id, opts, operation.controller.signal);
      if (state === 'available') return;
      if (state === 'unavailable') throw new EdgeAiError('edge_not_ready', 'The requested Edge model or language is unavailable on this host.');
      this.assertUserAction();
      emit(listener, {type: 'progress', requestId, phase: id === 'edgeSpeech' ? 'Installing local speech language pack' : 'Preparing Edge local model', progress: null});
      if (id === 'edgeSpeech') {
        // This API exposes neither a download monitor nor cancellation. Never invent progress.
        const installed = await abortable(this.speechApi().install(opts), operation.controller.signal);
        if (installed !== true) throw new EdgeAiError('edge_install_failed', 'The browser could not install the requested local speech language pack.');
      } else {
        await this.createSession(id, opts, operation, listener, true);
      }
      if (await this.availability(id, opts, operation.controller.signal) !== 'available') throw new EdgeAiError('edge_not_ready', 'The requested Edge model is not ready after preparation. Refresh and try again.');
    });
  }

  async text(value: WindowsAiTextRequest, prefValue: WindowsAiPreferences, listener?: WindowsAiEventListener, signal?: AbortSignal): Promise<WindowsAiTextResult> {
    const parsed = windowsAiTextRequestSchema.safeParse(value);
    if (!parsed.success || parsed.data.engine !== 'edge' || new TextEncoder().encode(parsed.data.text).byteLength > inputByteLimit) throw new EdgeAiError('edge_invalid_request', 'The Edge text request is invalid or exceeds the 64 KiB input limit.');
    const request = parsed.data;
    const prefs = preferences(prefValue);
    const id = taskFeatures[request.task];
    assertEnabled(id, prefs);
    this.assertUserAction();
    return this.run(id, request.requestId, false, listener, signal, async (operation) => {
      const opts = options(id, prefs, request);
      if (await this.availability(id, opts, operation.controller.signal) !== 'available') throw new EdgeAiError('edge_not_ready', 'Prepare the requested Edge model or language first. Text operations never download models.');
      this.assertUserAction();
      const session = await this.createSession(id, opts, operation, listener, false);
      await this.checkInputQuota(session, request.text, operation.controller.signal);
      if (id === 'edgeLanguageDetection') {
        const detect = session.detect;
        if (typeof detect !== 'function') throw new EdgeAiError('edge_api_contract', 'The browser does not expose the expected local language-detection operation.');
        const raw = await abortable(Promise.resolve(detect.call(session, request.text, {signal: operation.controller.signal})), operation.controller.signal);
        const detected = detectionSchema.safeParse(raw);
        if (!detected.success) throw new EdgeAiError('edge_api_contract', 'The browser returned invalid language-detection results.');
        const best = [...detected.data].sort((a, b) => b.confidence - a.confidence)[0];
        return windowsAiTextResultSchema.parse({text: best.detectedLanguage, engine: 'edge', model: null, citations: [], ...best});
      }
      const text = await this.generate(session, id, request, operation, listener);
      return windowsAiTextResultSchema.parse({text, engine: 'edge', model: null, citations: []});
    });
  }

  async startDictation(value: WindowsAiPreferences, listener: DictationListener): Promise<DictationSession> {
    const prefs = preferences(value);
    assertEnabled('edgeSpeech', prefs);
    this.assertUserAction();
    if (this.dictation) throw new EdgeAiError('edge_busy', 'Stop the current dictation session first.');
    const api = this.speechApi();
    const controller = new AbortController();
    const startup = {controller, stop: () => controller.abort(abortError())};
    this.dictation = startup;
    const detachLifecycle = this.watchLifecycle(startup.stop);
    try {
      if (await this.availability('edgeSpeech', options('edgeSpeech', prefs), controller.signal) !== 'available') throw new EdgeAiError('edge_not_ready', 'Prepare the requested local speech language pack before dictating.');
      this.assertUserAction();
      if (controller.signal.aborted) throw controller.signal.reason;
      const recognition = new api();
      let ended = false;
      const timer = setTimeout(() => finish(true), dictationTimeoutMs);
      const finish = (stopCapture: boolean) => {
        if (ended) return;
        ended = true;
        recognition.onresult = null;
        recognition.onend = null;
        recognition.onerror = null;
        clearTimeout(timer);
        detachLifecycle();
        controller.signal.removeEventListener('abort', stop);
        if (this.dictation?.controller === controller) this.dictation = null;
        if (stopCapture) {
          try {recognition.abort();}
          catch {try {recognition.stop();} catch {/* Already stopped by the browser. */}}
        }
        listener.onEnd();
      };
      const stop = () => finish(true);
      this.dictation = {controller, stop};
      controller.signal.addEventListener('abort', stop, {once: true});
      recognition.lang = prefs.speechLanguage;
      recognition.processLocally = true;
      recognition.continuous = true;
      recognition.interimResults = true;
      if (recognition.processLocally !== true) {stop(); throw new EdgeAiError('edge_local_speech_missing', 'The browser cannot guarantee local-only speech recognition.');}
      recognition.onend = () => finish(false);
      recognition.onerror = () => {
        try {listener.onError('Local dictation failed. Check browser microphone permission and local language-pack availability.');}
        finally {stop();}
      };
      recognition.onresult = (event) => {
        if (ended) return;
        try {
          if (!object(event) || !object(event.results)) throw new Error();
          const results = event.results;
          const count = z.number().int().min(0).max(1024).parse(results.length);
          let text = '';
          let final = count > 0;
          for (let index = 0; index < count; index++) {
            const result = results[index];
            if (!object(result) || !object(result[0])) throw new Error();
            const transcript = z.string().max(4000).parse(result[0].transcript);
            final = z.boolean().parse(result.isFinal) && final;
            text += `${text && transcript ? ' ' : ''}${transcript}`;
            if (text.length > 4000) throw new Error();
          }
          if (text) listener.onText(text, final);
        } catch {
          try {listener.onError('Local dictation returned invalid text or exceeded the 4,000-character draft limit.');}
          finally {stop();}
        }
      };
      try {recognition.start();}
      catch (error) {stop(); throw failure(error);}
      return {stop};
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const reason = controller.signal.reason;
      detachLifecycle();
      if (this.dictation?.controller === controller) {this.dictation.stop(); this.dictation = null;}
      throw cancelled ? reason : failure(error);
    }
  }

  cancel(requestId: string): void {
    if (!windowsAiRequestIdSchema.safeParse(requestId).success) return;
    this.operations.get(requestId)?.controller.abort(abortError());
  }

  /** Call when the owning app surface is disposed; DictationSession.stop handles navigation. */
  dispose(): void {
    this.disposed = true;
    for (const operation of this.operations.values()) operation.controller.abort(abortError());
    this.dictation?.controller.abort(abortError());
    this.dictation?.stop();
  }

  private assertUserAction(): void {
    if (this.disposed) throw new EdgeAiError('edge_disposed', 'The Edge AI service has been disposed.');
    if (this.host.userActivation?.isActive !== true) throw new EdgeAiError('edge_user_activation', 'Start this operation from its visible action control.');
  }

  private modelApi(id: EdgeTextFeatureId): ModelApi {
    this.assertSecure();
    const api = this.host[features[id].api];
    if (!object(api) || typeof api.availability !== 'function' || typeof api.create !== 'function') throw new EdgeAiError('edge_api_missing', 'This executing browser host does not expose this Edge on-device API.');
    return api as unknown as ModelApi;
  }

  private speechApi(): SpeechApi {
    this.assertSecure();
    const api = this.host.SpeechRecognition;
    if (typeof api !== 'function' || !object(api) || !object(api.prototype) || !('processLocally' in api.prototype) || typeof api.available !== 'function' || typeof api.install !== 'function') throw new EdgeAiError('edge_local_speech_missing', 'This executing browser host does not expose verified local-only speech recognition and language-pack APIs.');
    return api as unknown as SpeechApi;
  }

  private assertSecure(): void {
    if (this.disposed) throw new EdgeAiError('edge_disposed', 'The Edge AI service has been disposed.');
    if (this.host.isSecureContext !== true) throw new EdgeAiError('edge_insecure_context', 'Edge on-device APIs require a secure context in the executing browser host.');
  }

  private async availability(id: EdgeFeatureId, opts: Options, signal?: AbortSignal) {
    return boundedProbe(id === 'edgeSpeech' ? this.speechApi().available(opts) : this.modelApi(id).availability(opts), signal);
  }

  private revoke(prefs: WindowsAiPreferences): void {
    for (const operation of this.operations.values()) if (!enabled(operation.featureId, prefs) || (operation.preparing && !prefs.modelDownloadsAllowed)) operation.controller.abort(abortError());
    if (!enabled('edgeSpeech', prefs)) this.dictation?.controller.abort(abortError());
  }

  private watchLifecycle(stop: () => void): () => void {
    const hidden = () => {if (this.host.visibility?.hidden) stop();};
    this.host.lifecycle?.addEventListener('pagehide', stop);
    this.host.visibility?.addEventListener('visibilitychange', hidden);
    return () => {this.host.lifecycle?.removeEventListener('pagehide', stop); this.host.visibility?.removeEventListener('visibilitychange', hidden);};
  }

  private async run<T>(id: EdgeFeatureId, requestId: string, preparing: boolean, listener: WindowsAiEventListener | undefined, external: AbortSignal | undefined, work: (operation: Operation) => Promise<T>): Promise<T> {
    if (this.operations.size) throw new EdgeAiError('edge_busy', 'Stop the current Edge model operation before starting another.');
    const operation: Operation = {requestId, featureId: id, preparing, controller: new AbortController(), resources: new Set()};
    const {controller, resources} = operation;
    const cleanup = () => {for (const release of resources) release(); resources.clear();};
    const onAbort = () => controller.abort(external?.reason ?? abortError());
    external?.addEventListener('abort', onAbort, {once: true});
    if (external?.aborted) onAbort();
    controller.signal.addEventListener('abort', cleanup, {once: true});
    const detachLifecycle = this.watchLifecycle(() => controller.abort(abortError()));
    const timer = setTimeout(() => controller.abort(new EdgeAiError('edge_timeout', 'The Edge AI operation reached its time limit.')), preparing ? prepareTimeoutMs : textTimeoutMs);
    this.operations.set(requestId, operation);
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const result = await work(operation);
      if (controller.signal.aborted) throw controller.signal.reason;
      emit(listener, {type: 'completed', requestId});
      return result;
    } catch (error) {
      if (controller.signal.aborted && !(controller.signal.reason instanceof EdgeAiError)) {emit(listener, {type: 'cancelled', requestId}); throw abortError();}
      const reason = failure(controller.signal.aborted ? controller.signal.reason : error);
      emit(listener, {type: 'failed', requestId, code: reason.code, message: reason.message});
      throw reason;
    } finally {
      clearTimeout(timer);
      detachLifecycle();
      external?.removeEventListener('abort', onAbort);
      cleanup();
      controller.abort(abortError());
      this.operations.delete(requestId);
    }
  }

  private resource(operation: Operation, release: () => void): void {
    if (operation.controller.signal.aborted) release();
    else operation.resources.add(release);
  }

  private async createSession(id: EdgeTextFeatureId, opts: Options, operation: Operation, listener: WindowsAiEventListener | undefined, preparing: boolean): Promise<Session> {
    const monitor = (target: EventTarget) => {
      const progress = (event: Event) => {
        if (operation.controller.signal.aborted) return;
        const raw = event as Event & {loaded?: unknown; total?: unknown};
        const loaded = z.number().finite().nonnegative().safeParse(raw.loaded);
        const total = z.number().finite().positive().safeParse(raw.total);
        if (!loaded.success || !total.success || loaded.data > total.data) return;
        if (!preparing) {
          // Ready sessions also emit 0/1 during initialization. An intermediate fraction
          // is an observed download; creation has no atomic no-download option.
          if (loaded.data > 0 && loaded.data < total.data) operation.controller.abort(new EdgeAiError('edge_unexpected_download', 'The model began downloading after its readiness check. Use Prepare before trying again.'));
          return;
        }
        emit(listener, {type: 'progress', requestId: operation.requestId, phase: 'Downloading Edge local model', progress: loaded.data / total.data});
      };
      target.addEventListener('downloadprogress', progress);
      this.resource(operation, () => target.removeEventListener('downloadprogress', progress));
    };
    const pending = this.modelApi(id).create({...opts, signal: operation.controller.signal, monitor}).then((raw) => {
      if (!object(raw) || typeof raw.destroy !== 'function') throw new EdgeAiError('edge_api_contract', 'The browser returned a model session without the required cleanup API.');
      const session = raw as Session;
      let destroyed = false;
      this.resource(operation, () => {if (!destroyed) {destroyed = true; try {session.destroy();} catch {/* Aborting the creation signal also releases this session. */}}});
      return session;
    });
    return abortable(pending, operation.controller.signal);
  }

  private async checkInputQuota(session: Session, text: string, signal: AbortSignal): Promise<void> {
    const context = typeof session.measureContextUsage === 'function' && typeof session.contextWindow === 'number';
    const measure = context ? session.measureContextUsage : session.measureInputUsage;
    const quota = context ? (session.contextWindow as number) - (typeof session.contextUsage === 'number' ? session.contextUsage : 0) : session.inputQuota;
    if (typeof measure !== 'function' || typeof quota !== 'number' || quota === Infinity) return;
    if (!Number.isFinite(quota) || quota < 0) throw new EdgeAiError('edge_api_contract', 'The browser returned an invalid model context quota.');
    const measured = await abortable(Promise.resolve(measure.call(session, text, {signal})), signal);
    if (typeof measured !== 'number' || !Number.isFinite(measured) || measured < 0) throw new EdgeAiError('edge_api_contract', 'The browser returned invalid model input usage.');
    if (measured > quota) throw new EdgeAiError('edge_input_limit', 'The selected Edge model context is too small for this text. Shorten the input.');
  }

  private async generate(session: Session, id: Exclude<EdgeTextFeatureId, 'edgeLanguageDetection'>, request: WindowsAiTextRequest, operation: Operation, listener?: WindowsAiEventListener): Promise<string> {
    const methodName = features[id].method;
    const streaming = session[`${methodName}Streaming`];
    const method = session[methodName];
    if (typeof streaming !== 'function') {
      if (typeof method !== 'function') throw new EdgeAiError('edge_api_contract', 'The browser does not expose the expected local text operation.');
      const result = await abortable(Promise.resolve(method.call(session, request.text, {signal: operation.controller.signal})), operation.controller.signal);
      if (typeof result !== 'string') throw new EdgeAiError('edge_api_contract', 'The browser returned invalid local text.');
      this.checkOutput(result);
      this.emitText(listener, request.requestId, result);
      return result;
    }
    const stream: unknown = streaming.call(session, request.text, {signal: operation.controller.signal});
    if (!object(stream) || typeof stream.getReader !== 'function') throw new EdgeAiError('edge_api_contract', 'The browser returned an invalid local text stream.');
    const reader = (stream as unknown as ReadableStream<unknown>).getReader();
    let done = false;
    let released = false;
    this.resource(operation, () => {
      if (released) return;
      released = true;
      if (!done) void reader.cancel().catch(() => undefined);
      try {reader.releaseLock();} catch {/* Cancellation resolves a pending read before releasing its lock. */}
    });
    let text = '';
    let chunks = 0;
    while (true) {
      const next = await abortable(reader.read(), operation.controller.signal);
      if (next.done) {done = true; break;}
      if (++chunks > 16_384) throw new EdgeAiError('edge_output_limit', 'The Edge AI response exceeded its stream limit.');
      if (typeof next.value !== 'string') throw new EdgeAiError('edge_api_contract', 'The browser returned an invalid text-stream chunk.');
      const cumulative = this.host.streamSemantics?.[id] === 'cumulative';
      if (cumulative && !next.value.startsWith(text)) throw new EdgeAiError('edge_api_contract', 'The cumulative browser stream rewrote previously emitted text.');
      const delta = cumulative ? next.value.slice(text.length) : next.value;
      const nextText = cumulative ? next.value : text + delta;
      this.checkOutput(nextText);
      text = nextText;
      this.emitText(listener, request.requestId, delta);
    }
    return text;
  }

  private checkOutput(text: string): void {
    if (text.length > outputLimit || new TextEncoder().encode(text).byteLength > outputLimit) throw new EdgeAiError('edge_output_limit', 'The Edge AI response exceeded the 256 KiB output limit.');
  }

  private emitText(listener: WindowsAiEventListener | undefined, requestId: string, text: string): void {
    for (let offset = 0; offset < text.length; offset += 65_536) emit(listener, {type: 'delta', requestId, text: text.slice(offset, offset + 65_536)});
  }
}
