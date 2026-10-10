import {Profiler, type PropsWithChildren} from 'react';
import {act, renderHook} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';

import {MemoryAnswerService} from '../../services/answer/memory-answer-service';
import {useAnswerController} from './useAnswerController';

afterEach(() => vi.useRealTimers());

it('preserves a 1000-token burst and measures controller commits', async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  const service = new MemoryAnswerService();
  let commits = 0;
  let renderMs = 0;
  const wrapper = ({children}: PropsWithChildren) => <Profiler id="answer" onRender={(_id, _phase, duration) => {
    commits += 1;
    renderMs += duration;
  }}>{children}</Profiler>;
  const {result} = renderHook(() => useAnswerController(service, {query: 'burst', mode: 'local', delayMs: 0}), {wrapper});
  await act(() => vi.advanceTimersByTimeAsync(0));
  commits = 0;
  renderMs = 0;
  const start = performance.now();
  await act(async () => {
    for (let index = 0; index < 1000; index += 1) await service.emit('burst', {type: 'delta', text: 'x'});
    await service.emit('burst', {type: 'completed', provider: 'local', model: 'fixture', route: 'local'});
  });
  const updateMs = performance.now() - start;
  expect(result.current.text).toBe('x'.repeat(1000));
  expect(result.current.phase).toBe('completed');
  console.info('answer-controller-burst', JSON.stringify({tokens: 1000, commits, renderMs, updateMs}));
});
