import {act, renderHook} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {MemoryAnswerService} from '../../services/answer/memory-answer-service';
import type {AnswerEvent, RuntimeMode} from '../../services/answer/answer.types';
import type {AnswerService} from '../../services/answer/answer-service';
import {useAnswerController} from './useAnswerController';

describe('useAnswerController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts every settled non-empty query after 350 ms', async () => {
    const service = new MemoryAnswerService();
    const {result} = renderHook(
      ({query}) => useAnswerController(service, {mode: 'auto', query}),
      {initialProps: {query: 'quarterly report'}},
    );

    await act(() => vi.advanceTimersByTimeAsync(349));
    expect(service.requests).toHaveLength(0);

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(service.requests).toHaveLength(1);
    expect(service.requests[0]?.request).toMatchObject({
      mode: 'auto',
      cloudConsent: false,
      query: 'quarterly report',
    });
    expect(result.current.phase).toBe('waiting');
  });

  it('restarts and forwards consent changes to the answer service', async () => {
    const service = new MemoryAnswerService();
    const {rerender} = renderHook(
      ({cloudConsent}) => useAnswerController(service, {
        cloudConsent,
        mode: 'cloud',
        query: 'private report',
      }),
      {initialProps: {cloudConsent: false}},
    );

    await act(() => vi.advanceTimersByTimeAsync(350));
    rerender({cloudConsent: true});
    await act(() => vi.advanceTimersByTimeAsync(350));

    expect(service.requests.map((item) => item.request.cloudConsent)).toEqual([false, true]);
  });

  it('cancels the old stream and restarts the same query when mode changes', async () => {
    const service = new MemoryAnswerService();
    const {rerender} = renderHook(
      ({mode}) => useAnswerController(service, {mode, query: 'explain this'}),
      {initialProps: {mode: 'cloud' as RuntimeMode}},
    );

    await act(() => vi.advanceTimersByTimeAsync(350));
    const firstSignal = service.requests[0]?.signal;
    rerender({mode: 'local'});

    expect(firstSignal?.aborted).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(350));
    expect(service.requests.map((item) => item.request.mode)).toEqual(['cloud', 'local']);
  });

  it('cancels the old stream and retries the same explicit submission revision', async () => {
    const service = new MemoryAnswerService();
    const {rerender} = renderHook(
      ({restartKey}) => useAnswerController(service, {
        delayMs: 0,
        mode: 'auto',
        query: 'release notes',
        restartKey,
      }),
      {initialProps: {restartKey: 1}},
    );

    await act(() => vi.advanceTimersByTimeAsync(0));
    const firstSignal = service.requests[0]?.signal;
    rerender({restartKey: 2});
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(firstSignal?.aborted).toBe(true);
    expect(service.requests.map((item) => item.request.query)).toEqual([
      'release notes',
      'release notes',
    ]);
  });

  it('keeps citations and usage from the current stream only', async () => {
    const service = new MemoryAnswerService();
    const {result, rerender} = renderHook(
      ({query}) => useAnswerController(service, {mode: 'auto', query}),
      {initialProps: {query: 'first'}},
    );

    await act(() => vi.advanceTimersByTimeAsync(350));
    rerender({query: 'second'});
    await act(() => vi.advanceTimersByTimeAsync(350));

    await act(() => service.emit('first', {type: 'delta', text: 'stale'}));
    await act(() => service.emit('second', {
      type: 'citation',
      citation: {fileId: 'report', label: 'Report.pdf', page: 4},
    }));
    await act(() => service.emit('second', {type: 'delta', text: 'Current answer'}));
    await act(() => service.emit('second', {
      type: 'usage',
      usage: {inputTokens: 120, outputTokens: 20, remainingTokens: 860},
    }));
    await act(() => service.emit('second', {
      type: 'completed',
      model: 'gpt-5.4-mini',
      provider: 'openai',
      route: 'lumen.answer.cloud',
    }));

    expect(result.current.text).toBe('Current answer');
    expect(result.current.citations).toEqual([
      {fileId: 'report', label: 'Report.pdf', page: 4},
    ]);
    expect(result.current.usage?.remainingTokens).toBe(860);
    expect(result.current.phase).toBe('completed');
  });

  it('stops immediately and can retry the same query', async () => {
    const service = new MemoryAnswerService();
    const {result} = renderHook(() =>
      useAnswerController(service, {mode: 'auto', query: 'retry me'}),
    );

    await act(() => vi.advanceTimersByTimeAsync(350));
    const firstSignal = service.requests[0]?.signal;
    act(() => result.current.stop());

    expect(firstSignal?.aborted).toBe(true);
    expect(result.current.phase).toBe('cancelled');

    act(() => result.current.retry());
    await act(() => vi.advanceTimersByTimeAsync(350));
    expect(service.requests).toHaveLength(2);
  });

  it('replaces the failed attempt while retaining source citations', async () => {
    const service = new MemoryAnswerService();
    const {result} = renderHook(() => useAnswerController(service, {mode: 'auto', query: 'fallback', delayMs: 0}));
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => service.emit('fallback', {type: 'citation', citation: {fileId: 'report', label: 'Report'}}));
    await act(() => service.emit('fallback', {type: 'started', provider: 'cloud', model: 'obsolete', route: 'cloud'}));
    await act(() => service.emit('fallback', {type: 'delta', text: 'obsolete'}));
    await act(() => service.emit('fallback', {type: 'usage', usage: {inputTokens: 10, outputTokens: 1}}));
    await act(() => service.emit('fallback', {type: 'started', provider: 'local', route: 'local'}));
    expect(result.current).toMatchObject({phase: 'waiting', text: '', provider: 'local', route: 'local'});
    expect(result.current.model).toBeUndefined();
    expect(result.current.usage).toBeUndefined();
    await act(() => service.emit('fallback', {type: 'delta', text: 'success'}));
    expect(result.current.phase).toBe('streaming');
    await act(() => service.emit('fallback', {type: 'completed', provider: 'local', model: 'local model', route: 'local'}));
    expect(result.current.text).toBe('success');
    expect(result.current.citations).toEqual([{fileId: 'report', label: 'Report'}]);
    expect(result.current.usage).toBeUndefined();
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('keeps %s stable despite later events and Stop', async (terminal) => {
    const events: AnswerEvent[] = [
      {type: 'delta', text: 'answer'},
      terminal === 'completed' ? {type: terminal, provider: 'local', model: 'local', route: 'local'}
        : terminal === 'failed' ? {type: terminal, message: 'Safe failure'} : {type: terminal},
      {type: 'delta', text: 'late'},
      {type: 'started', provider: 'late'},
      {type: 'completed', provider: 'late', model: 'late', route: 'late'},
    ];
    const service: AnswerService = {async *stream() { yield* events; }};
    const {result} = renderHook(() => useAnswerController(service, {mode: 'auto', query: 'terminal', delayMs: 0}));
    await act(() => vi.advanceTimersByTimeAsync(0));
    act(() => result.current.stop());
    expect(result.current.phase).toBe(terminal === 'failed' ? 'error' : terminal);
    expect(result.current.text).toBe('answer');
    expect(result.current.provider).not.toBe('late');
  });

  it('fails safely when the stream ends without a terminal event', async () => {
    const service: AnswerService = {async *stream() { yield {type: 'delta', text: 'partial'}; }};
    const {result} = renderHook(() => useAnswerController(service, {mode: 'auto', query: 'end', delayMs: 0}));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.phase).toBe('error');
    expect(result.current.text).toBe('partial');
  });

  it('does not expose raw service exceptions', async () => {
    const service: AnswerService = {stream() { throw new Error('secret-key https://private.example'); }};
    const {result} = renderHook(() => useAnswerController(service, {mode: 'auto', query: 'error', delayMs: 0}));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.phase).toBe('error');
    expect(result.current.error).not.toContain('secret-key');
    expect(result.current.error).not.toContain('https:');
  });

  it('uses distinct native request IDs across controller instances', async () => {
    const service = new MemoryAnswerService();
    renderHook(() => useAnswerController(service, {mode: 'auto', query: 'one', delayMs: 0}));
    renderHook(() => useAnswerController(service, {mode: 'auto', query: 'two', delayMs: 0}));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(new Set(service.requests.map(({request}) => request.requestId)).size).toBe(2);
  });

  it('stops before debounce without starting work', async () => {
    const service = new MemoryAnswerService();
    const {result} = renderHook(() => useAnswerController(service, {mode: 'auto', query: 'stop'}));
    act(() => result.current.stop());
    await act(() => vi.advanceTimersByTimeAsync(350));
    expect(result.current.phase).toBe('cancelled');
    expect(service.requests).toHaveLength(0);
  });

  it('aborts work on unmount and ignores late events after a rapid replacement', async () => {
    let release: ((event: AnswerEvent) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    const service: AnswerService = {async *stream(request, signal) {
      if (request.query === 'old') {
        oldSignal = signal;
        yield await new Promise<AnswerEvent>((resolve) => { release = resolve; });
      } else yield {type: 'completed', provider: 'new', model: 'new', route: 'local'};
    }};
    const {result, rerender, unmount} = renderHook(({query}) => useAnswerController(service, {mode: 'auto', query, delayMs: 0}), {initialProps: {query: 'old'}});
    await act(() => vi.advanceTimersByTimeAsync(0));
    rerender({query: 'middle'});
    rerender({query: 'new'});
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(async () => { release?.({type: 'delta', text: 'stale'}); });
    expect(oldSignal?.aborted).toBe(true);
    expect(result.current).toMatchObject({text: '', provider: 'new', phase: 'completed'});
    unmount();
  });

  it('aborts the active request on unmount before tokens arrive', async () => {
    const service = new MemoryAnswerService();
    const {unmount} = renderHook(() => useAnswerController(service, {query: 'unmount', mode: 'local', delayMs: 0}));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const signal = service.requests[0]?.signal;
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
