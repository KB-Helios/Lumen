import {describe, expect, it, vi} from 'vitest';
import {WindowsAiAnswerService} from './windows-ai-answer-service';
import {UnavailableWindowsAiService, unsupportedWindowsAiSnapshot} from '../windows-ai/unavailable-windows-ai-service';
import {defaultWindowsAiPreferences} from '../windows-ai/windows-ai.types';
import type {AnswerService} from './answer-service';
import type {AnswerEvent} from './answer.types';
import type {WindowsAiService, WindowsAiEventListener} from '../windows-ai/windows-ai-service';
import type {WindowsAiTextResult} from '../windows-ai/windows-ai.types';

async function collect(events: AsyncIterable<AnswerEvent>) { const result: AnswerEvent[] = []; for await (const event of events) result.push(event); return result; }

const fallback: AnswerService = {stream: vi.fn(async function* () { yield {type: 'completed', provider: 'runtime', model: 'local', route: 'local'} as const; })};
describe('answer engine routing', () => {
  it('keeps automatic local runtime answers when Windows AI is unavailable', async () => {
    const service = new WindowsAiAnswerService(fallback, new UnavailableWindowsAiService(), () => unsupportedWindowsAiSnapshot());
    const result = await collect(service.stream({requestId: 1, query: 'hello', mode: 'local', cloudConsent: false}, new AbortController().signal));
    expect(result[result.length - 1]).toMatchObject({provider: 'runtime'});
  });
  it('does not silently route an unavailable explicitly selected preview engine to cloud', async () => {
    const snapshot = unsupportedWindowsAiSnapshot({...defaultWindowsAiPreferences, localEngine: 'aion'});
    const service = new WindowsAiAnswerService(fallback, new UnavailableWindowsAiService(), () => snapshot);
    const result = await collect(service.stream({requestId: 1, query: 'hello', mode: 'auto', cloudConsent: true}, new AbortController().signal));
    expect(result).toEqual([expect.objectContaining({type: 'failed'})]);
  });
});

function localHarness() {
  const snapshot = unsupportedWindowsAiSnapshot({...defaultWindowsAiPreferences, localEngine: 'windows'});
  snapshot.features[0] = {...snapshot.features[0]!, enabled: true, availability: 'ready'};
  const windows: WindowsAiService = new UnavailableWindowsAiService();
  let listener: WindowsAiEventListener | undefined;
  let requestId = '';
  let resolve: ((result: WindowsAiTextResult) => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((done) => { markStarted = done; });
  const text = vi.fn<WindowsAiService['text']>((request, callback) => {
    requestId = request.requestId;
    listener = callback;
    markStarted?.();
    return new Promise((done) => { resolve = done; });
  });
  windows.text = text;
  windows.cancel = vi.fn().mockRejectedValue(new Error('cancel secret'));
  const service = new WindowsAiAnswerService(fallback, windows, () => snapshot);
  return {service, text, windows, started, resolve: (result: WindowsAiTextResult) => resolve?.(result),
    delta: (text: string) => listener?.({type: 'delta', requestId, text}),
    failed: () => listener?.({type: 'failed', requestId, code: 'provider', message: 'secret failure'}),
    cancelled: () => listener?.({type: 'cancelled', requestId}),
  };
}
const localRequest = {requestId: 10, query: 'hello', mode: 'local', cloudConsent: false} as const;

describe('Windows answer lifecycle', () => {
  it('does not start or emit for an already aborted request', async () => {
    const harness = localHarness();
    const abort = new AbortController();
    abort.abort();
    expect(await collect(harness.service.stream(localRequest, abort.signal))).toEqual([]);
    expect(harness.text).not.toHaveBeenCalled();
  });

  it('does not start native work when aborted after started', async () => {
    const harness = localHarness();
    const abort = new AbortController();
    const iterator = harness.service.stream(localRequest, abort.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({type: 'started'});
    abort.abort();
    expect((await iterator.next()).done).toBe(true);
    expect(harness.text).not.toHaveBeenCalled();
  });

  it('reconciles final tokens and citations without duplicate streamed text', async () => {
    const harness = localHarness();
    const events = collect(harness.service.stream(localRequest, new AbortController().signal));
    await harness.started;
    harness.delta('Hello ');
    harness.resolve({text: 'Hello 🌍', engine: 'windows', model: 'local', citations: [{fileId: 'f', label: 'File'}]});
    const result = await events;
    expect(result.filter((event) => event.type === 'delta').map((event) => event.text).join('')).toBe('Hello 🌍');
    expect(result).toContainEqual({type: 'citation', citation: {fileId: 'f', label: 'File'}});
    expect(result[result.length - 1]).toMatchObject({type: 'completed'});
  });

  it.each(['failed', 'cancelled'] as const)('terminates on a native %s event without waiting for the result', async (kind) => {
    const harness = localHarness();
    const events = collect(harness.service.stream(localRequest, new AbortController().signal));
    await harness.started;
    harness[kind]();
    const result = await events;
    expect(result[result.length - 1]).toMatchObject({type: kind});
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(harness.windows.cancel).toHaveBeenCalledOnce();
  });

  it('bounds queued local tokens and cancels the native request', async () => {
    const harness = localHarness();
    const iterator = harness.service.stream(localRequest, new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();
    const first = iterator.next();
    for (let index = 0; index < 4097; index += 1) harness.delta('x');
    const result = await first;
    expect(result.value).toMatchObject({type: 'failed'});
    expect((await iterator.next()).done).toBe(true);
    expect(harness.windows.cancel).toHaveBeenCalledOnce();
  });

  it('rejects inconsistent final output with a safe terminal error', async () => {
    const harness = localHarness();
    const events = collect(harness.service.stream(localRequest, new AbortController().signal));
    await harness.started;
    harness.delta('obsolete');
    harness.resolve({text: 'different', engine: 'windows', model: null, citations: []});
    const result = await events;
    expect(result[result.length - 1]).toMatchObject({type: 'failed'});
    expect(JSON.stringify(result)).not.toContain('different');
  });

  it('completes when the native result has an empty optional model label', async () => {
    const harness = localHarness();
    const events = collect(harness.service.stream(localRequest, new AbortController().signal));
    await harness.started;
    harness.resolve({text: 'answer', engine: 'windows', model: '', citations: []});
    const result = await events;
    expect(result[result.length - 1]).toMatchObject({type: 'completed', model: 'Local model'});
  });

  it('aborts while waiting for tokens and ignores a later native result', async () => {
    const harness = localHarness();
    const abort = new AbortController();
    const events = collect(harness.service.stream(localRequest, abort.signal));
    await harness.started;
    abort.abort();
    const result = await events;
    harness.delta('late');
    harness.resolve({text: 'late', engine: 'windows', model: null, citations: []});
    await Promise.resolve();
    expect(result).toEqual([expect.objectContaining({type: 'started'})]);
    expect(harness.windows.cancel).toHaveBeenCalledOnce();
  });

  it('cancels on consumer close and ignores late callbacks', async () => {
    const harness = localHarness();
    const iterator = harness.service.stream(localRequest, new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();
    const first = iterator.next();
    harness.delta('partial');
    expect((await first).value).toEqual({type: 'delta', text: 'partial'});
    await iterator.return?.();
    harness.delta('late');
    harness.resolve({text: 'partiallate', engine: 'windows', model: null, citations: []});
    await Promise.resolve();
    expect(harness.windows.cancel).toHaveBeenCalledOnce();
  });
});
