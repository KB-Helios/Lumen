import type {WindowsAiService} from '../windows-ai/windows-ai-service';
import {canUseWindowsAiFeature, type WindowsAiSnapshot} from '../windows-ai/windows-ai.types';
import type {AnswerService} from './answer-service';
import type {AnswerEvent, AnswerRequest} from './answer.types';

export class WindowsAiAnswerService implements AnswerService {
  constructor(private readonly runtime: AnswerService, private readonly windows: WindowsAiService, private readonly snapshot: () => WindowsAiSnapshot | null) {}
  async *stream(request: AnswerRequest, signal: AbortSignal): AsyncIterable<AnswerEvent> {
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
    let wake: (() => void) | undefined;
    let streamed = '';
    const notify = () => { wake?.(); wake = undefined; };
    yield {type: 'started', provider: engine, model: feature?.model ?? undefined, route: 'local'};
    const operation = this.windows.text({requestId, engine, task: 'answer', text: request.query}, (event) => {
      if (event.type === 'delta' && !signal.aborted) { streamed += event.text; queue.push({type: 'delta', text: event.text}); notify(); }
    }, signal).then((result) => {
      if (signal.aborted) return;
      if (!result.text.startsWith(streamed)) throw new Error('The local model returned an inconsistent response.');
      const remaining = result.text.slice(streamed.length);
      if (remaining) queue.push({type: 'delta', text: remaining});
      result.citations.forEach((citation) => queue.push({type: 'citation', citation}));
      queue.push({type: 'completed', provider: result.engine, model: result.model ?? 'Local model', route: 'local'});
    }).catch(() => {
      if (!signal.aborted) queue.push({type: 'failed', code: 'windows-ai-failed', message: 'The local model could not answer. Check its availability in Local AI settings.'});
    }).finally(() => { done = true; notify(); });
    signal.addEventListener('abort', notify, {once: true});
    try {
      while (!done || queue.length) {
        if (signal.aborted) return;
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
      await operation;
    } finally { signal.removeEventListener('abort', notify); if (!done) void this.windows.cancel(requestId).catch(() => undefined); }
  }
}
