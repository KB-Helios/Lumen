import type {WindowsAiService} from '../windows-ai/windows-ai-service';
import {canUseWindowsAiFeature, windowsAiTextResultSchema, type WindowsAiSnapshot} from '../windows-ai/windows-ai.types';
import type {AnswerService} from './answer-service';
import {answerEventSchema, isTerminalAnswerEvent, maxAnswerEvents, maxAnswerQueuedEvents, maxAnswerTextBytes, type AnswerEvent, type AnswerRequest} from './answer.types';

export class WindowsAiAnswerService implements AnswerService {
  constructor(private readonly runtime: AnswerService, private readonly windows: WindowsAiService, private readonly snapshot: () => WindowsAiSnapshot | null) {}
  /** Selects the configured local engine or runtime route, bounds event delivery, and cancels unfinished local work on disposal. */
  async *stream(request: AnswerRequest, signal: AbortSignal): AsyncIterable<AnswerEvent> {
    if (signal.aborted) return;
    const snapshot = this.snapshot();
    const selected = snapshot?.preferences.localEngine ?? 'auto';
    const featureId = selected === 'aion' ? 'aion' : selected === 'edge' ? 'edgePrompt' : 'languageModel';
    const feature = snapshot?.features.find((item) => item.id === featureId);
    if (request.mode === 'cloud' || selected === 'runtime' || (selected === 'auto' && !canUseWindowsAiFeature(feature))) {
      yield* this.runtime.stream(request, signal);
      return;
    }
    if (!canUseWindowsAiFeature(feature)) { yield {type: 'failed', code: 'engine-unavailable', message: feature?.detail ?? 'The selected local engine is unavailable. Check Local AI settings.'}; return; }
    const engine = selected === 'auto' ? 'windows' : selected;
    const requestId = `answer-${request.requestId}-${crypto.randomUUID()}`;
    const queue: AnswerEvent[] = [];
    let done = false;
    let disposed = false;
    let terminal = false;
    let cancelled = false;
    let wake: (() => void) | undefined;
    let streamed = '';
    let queuedBytes = 0;
    let outputBytes = 0;
    let eventCount = 0;
    const encoder = new TextEncoder();
    const notify = () => { wake?.(); wake = undefined; };
    /** Cancels this Windows AI session at most once and wakes the consumer. */
    const cancel = () => {
      if (!cancelled) {
        cancelled = true;
        void this.windows.cancel(requestId).catch(() => undefined);
      }
      notify();
    };
    /** Replaces pending output with a fixed terminal failure and cancels the local session. */
    const fail = () => {
      if (disposed || terminal || signal.aborted) return;
      terminal = true;
      queue.length = 0;
      queuedBytes = 0;
      queue.push({type: 'failed', code: 'windows-ai-failed', message: 'The local model could not answer. Check its availability in Local AI settings.'});
      cancel();
    };
    /** Validates and bounds one queued event, ignoring callbacks after termination or disposal. */
    const push = (event: AnswerEvent) => {
      if (disposed || terminal || signal.aborted) return;
      const parsed = answerEventSchema.safeParse(event);
      if (!parsed.success) { fail(); return; }
      const size = encoder.encode(JSON.stringify(parsed.data)).byteLength;
      if (event.type === 'delta') outputBytes += encoder.encode(event.text).byteLength;
      eventCount += 1;
      if (queue.length >= maxAnswerQueuedEvents || queuedBytes + size > maxAnswerTextBytes
        || outputBytes > maxAnswerTextBytes || eventCount > maxAnswerEvents) { fail(); return; }
      queuedBytes += size;
      queue.push(parsed.data);
      terminal = isTerminalAnswerEvent(parsed.data);
      notify();
    };
    yield {type: 'started', provider: engine, model: feature?.model ?? undefined, route: 'local'};
    if (signal.aborted) return;
    const operation = this.windows.text({requestId, engine, task: 'answer', text: request.query}, (event) => {
      if (disposed || terminal || signal.aborted || event.requestId !== requestId) return;
      if (event.type === 'delta') {
        push({type: 'delta', text: event.text});
        if (!terminal) streamed += event.text;
      } else if (event.type === 'failed') fail();
      else if (event.type === 'cancelled') push({type: 'cancelled'});
    }, signal).then((result) => {
      if (disposed || terminal || signal.aborted) return;
      const parsed = windowsAiTextResultSchema.safeParse(result);
      if (!parsed.success || !parsed.data.text.startsWith(streamed)) { fail(); return; }
      const final = parsed.data;
      const remaining = final.text.slice(streamed.length);
      for (let offset = 0; offset < remaining.length; offset += 65536) push({type: 'delta', text: remaining.slice(offset, offset + 65536)});
      final.citations.forEach((citation) => push({type: 'citation', citation}));
      push({type: 'completed', provider: final.engine, model: final.model || 'Local model', route: 'local'});
    }).catch(() => {
      fail();
    }).finally(() => { done = true; notify(); });
    signal.addEventListener('abort', cancel, {once: true});
    try {
      while (!done || queue.length) {
        if (signal.aborted) return;
        if (queue.length) {
          const event = queue.shift()!;
          queuedBytes -= encoder.encode(JSON.stringify(event)).byteLength;
          yield event;
          if (isTerminalAnswerEvent(event)) return;
        }
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
      await operation;
    } finally {
      disposed = true;
      queue.length = 0;
      signal.removeEventListener('abort', cancel);
      if (!done) cancel();
    }
  }
}
