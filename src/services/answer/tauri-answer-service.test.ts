import {beforeEach, describe, expect, it, vi} from 'vitest';

import type {AnswerEvent, AnswerRequest} from './answer.types';
import {TauriAnswerService} from './tauri-answer-service';

const native = vi.hoisted(() => ({invoke: vi.fn(), send: undefined as ((event: unknown) => void) | undefined}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: native.invoke,
  Channel: class {
    constructor(handler?: (event: unknown) => void) { native.send = handler; }
    set onmessage(handler: (event: unknown) => void) { native.send = handler; }
  },
}));

const request: AnswerRequest = {requestId: 123, query: 'hello', mode: 'auto', cloudConsent: false};
const completed = {type: 'completed', provider: 'local', model: 'fixture', route: 'local'} as const;
const collect = async (events: AsyncIterable<AnswerEvent>) => {
  const result: AnswerEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
};
const flush = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); };

beforeEach(() => { native.invoke.mockReset(); native.send = undefined; });

describe('native answer admission', () => {
  it('does not invoke native work for an already aborted signal', async () => {
    native.invoke.mockResolvedValue(undefined);
    const abort = new AbortController();
    abort.abort();
    expect(await collect(new TauriAnswerService().stream(request, abort.signal))).toEqual([]);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it('returns on completion while the command is still open and ignores late payloads', async () => {
    native.invoke.mockImplementation(() => new Promise(() => {}));
    const events = collect(new TauriAnswerService().stream(request, new AbortController().signal));
    native.send?.({type: 'delta', text: 'Hello 🌍'});
    native.send?.(completed);
    native.send?.({type: 'delta', text: 'late'});
    expect(await events).toEqual([{type: 'delta', text: 'Hello 🌍'}, completed]);
  });

  it('fails closed if the command ends without a terminal event', async () => {
    native.invoke.mockResolvedValue(undefined);
    await expect(collect(new TauriAnswerService().stream(request, new AbortController().signal))).rejects.toThrow(/complete|ended/i);
  });

  it('normalizes rejected invocation without exposing secrets', async () => {
    native.invoke.mockRejectedValue(new Error('secret-key https://private.example body'));
    await expect(collect(new TauriAnswerService().stream(request, new AbortController().signal))).rejects.toThrow(/answer/i);
    try { await collect(new TauriAnswerService().stream(request, new AbortController().signal)); }
    catch (error) { expect(String(error)).not.toMatch(/secret-key|private.example|body/); }
  });

  it.each([
    ['null', null],
    ['unknown type', {type: 'unknown'}],
    ['non-string token', {type: 'delta', text: 42}],
    ['oversized token', {type: 'delta', text: 'x'.repeat(65_537)}],
    ['negative usage', {type: 'usage', usage: {inputTokens: -1, outputTokens: 1}}],
    ['infinite usage', {type: 'usage', usage: {inputTokens: Infinity, outputTokens: 1}}],
    ['negative page', {type: 'citation', citation: {fileId: 'f', label: 'F', page: -1}}],
    ['invalid timestamp', {type: 'citation', citation: {fileId: 'f', label: 'F', timestampSeconds: NaN}}],
    ['oversized attribution', {type: 'completed', provider: 'local', model: 'x'.repeat(513), route: 'local'}],
    ['unknown field', {type: 'delta', text: 'secret', extra: 'unvalidated'}],
  ])('rejects invalid native payload: %s', async (_label, payload) => {
    native.invoke.mockResolvedValue(undefined);
    const events = collect(new TauriAnswerService().stream(request, new AbortController().signal));
    native.send?.(payload);
    await expect(events).rejects.toThrow(/invalid|protocol/i);
    expect(native.invoke).toHaveBeenCalledWith('cancel_answer', {requestId: 123});
  });

  it('normalizes native failure text', async () => {
    native.invoke.mockResolvedValue(undefined);
    const events = collect(new TauriAnswerService().stream(request, new AbortController().signal));
    native.send?.({type: 'failed', message: 'secret-key https://private.example'});
    const result = await events;
    expect(result[0]?.type).toBe('failed');
    expect(JSON.stringify(result)).not.toMatch(/secret-key|private.example/);
  });

  it.each([
    ['rate_limited', 'rate limited'],
    ['provider_unavailable', 'unavailable'],
    ['provider_unauthorized', 'authenticate'],
    ['invalid_response', 'invalid response'],
    ['incomplete_response', 'complete'],
    ['response_too_large', 'size limit'],
    ['header_timeout', 'respond in time'],
    ['stream_timeout', 'stopped responding'],
    ['request_timeout', 'time limit'],
    ['local_runtime_unavailable', 'Local AI'],
    ['context_unavailable', 'sources'],
    ['cloud_consent_required', 'consent'],
    ['cloud_credential_required', 'credential'],
    ['route_unavailable', 'route'],
    ['invalid_request', 'invalid'],
  ])('preserves actionable safe guidance for %s', async (code, guidance) => {
    native.invoke.mockResolvedValue(undefined);
    const events = collect(new TauriAnswerService().stream(request, new AbortController().signal));
    native.send?.({type: 'failed', code, message: 'secret provider body'});
    const result = await events;
    expect(result[0]).toMatchObject({type: 'failed', code});
    expect(JSON.stringify(result)).toContain(guidance);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('measures bounded admission and drainage of a 1000-token native burst', async () => {
    native.invoke.mockImplementation(() => new Promise(() => {}));
    const events = collect(new TauriAnswerService().stream(request, new AbortController().signal));
    const start = performance.now();
    for (let index = 0; index < 1000; index += 1) native.send?.({type: 'delta', text: 'x'});
    native.send?.(completed);
    const result = await events;
    const updateMs = performance.now() - start;
    expect(result.filter((event) => event.type === 'delta').map((event) => event.text).join('')).toBe('x'.repeat(1000));
    console.info('answer-native-admission-burst', JSON.stringify({tokens: 1000, updateMs}));
  });

  it('bounds a burst of queued channel events and cancels work', async () => {
    native.invoke.mockResolvedValue(undefined);
    const events = collect(new TauriAnswerService().stream(request, new AbortController().signal));
    for (let index = 0; index < 4097; index += 1) native.send?.({type: 'delta', text: 'x'});
    await expect(events).rejects.toThrow(/limit|too|buffer/i);
    expect(native.invoke).toHaveBeenCalledWith('cancel_answer', {requestId: 123});
  });

  it('caps accumulated output even when the consumer drains each event', async () => {
    native.invoke.mockImplementation(() => new Promise(() => {}));
    const iterator = new TauriAnswerService().stream(request, new AbortController().signal)[Symbol.asyncIterator]();
    for (let index = 0; index < 16; index += 1) {
      const next = iterator.next();
      native.send?.({type: 'delta', text: 'x'.repeat(65_536)});
      expect((await next).value).toMatchObject({type: 'delta'});
    }
    const next = iterator.next();
    native.send?.({type: 'delta', text: 'x'});
    await expect(next).rejects.toThrow(/limit|too|buffer/i);
  });

  it('bounds accumulated source metadata while the consumer keeps draining', async () => {
    native.invoke.mockImplementation(() => new Promise(() => {}));
    const iterator = new TauriAnswerService().stream(request, new AbortController().signal)[Symbol.asyncIterator]();
    let rejected = false;
    for (let index = 0; index < 4096; index += 1) {
      const next = iterator.next();
      native.send?.({type: 'citation', citation: {fileId: `f-${index}`, label: 'x'.repeat(1024)}});
      try { await next; } catch (error) { expect(String(error)).toMatch(/limit|too|buffer/i); rejected = true; break; }
    }
    expect(rejected).toBe(true);
    await iterator.return?.();
  });

  it.each(['constructor', 'unknown-provider-code'])('uses generic safe guidance for unknown code %s', async (code) => {
    native.invoke.mockResolvedValue(undefined);
    const events = collect(new TauriAnswerService().stream(request, new AbortController().signal));
    native.send?.({type: 'failed', code, message: 'secret upstream body'});
    const result = await events;
    expect(result[0]).toMatchObject({type: 'failed', code: 'answer-failed'});
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('aborts waiting work and consumes cancellation rejection', async () => {
    native.invoke.mockImplementation((command) => command === 'cancel_answer'
      ? Promise.reject(new Error('cancel secret')) : new Promise(() => {}));
    const abort = new AbortController();
    const events = collect(new TauriAnswerService().stream(request, abort.signal));
    abort.abort();
    expect(await events).toEqual([]);
    await flush();
    expect(native.invoke).toHaveBeenCalledWith('cancel_answer', {requestId: 123});
  });

  it('cancels when the consumer closes early and drops subsequent events', async () => {
    native.invoke.mockImplementation((command) => command === 'cancel_answer'
      ? Promise.resolve() : new Promise(() => {}));
    const iterator = new TauriAnswerService().stream(request, new AbortController().signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    native.send?.({type: 'delta', text: 'partial'});
    expect(await first).toEqual({done: false, value: {type: 'delta', text: 'partial'}});
    await iterator.return?.();
    native.send?.({type: 'delta', text: 'late'});
    expect(native.invoke).toHaveBeenCalledWith('cancel_answer', {requestId: 123});
  });
});
