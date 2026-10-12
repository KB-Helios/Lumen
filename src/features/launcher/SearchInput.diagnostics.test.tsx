import {fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';

import {readDiagnosticMetrics, resetDiagnosticMetrics} from '../diagnostics/diagnostics.metrics';
import {SearchInput} from './SearchInput';
import {useQueryStore} from './query.store';

afterEach(() => {
  useQueryStore.getState().reset();
  resetDiagnosticMetrics();
  vi.unstubAllGlobals();
});

it('records handler time separately from the next actual callback without changing the input', () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const now = vi.spyOn(performance, 'now').mockReturnValue(10);
  render(<SearchInput onEscapeEmpty={() => undefined} />);
  fireEvent.input(screen.getByRole('searchbox'), {target: {value: 'report'}});
  expect(readDiagnosticMetrics().timings.map(({name}) => name)).toEqual(['input-response']);
  now.mockReturnValue(26);
  frames.shift()!(24);
  expect(readDiagnosticMetrics().timings).toEqual([
    expect.objectContaining({name: 'input-response', durationMs: 0}),
    expect.objectContaining({name: 'input-next-frame', durationMs: 16}),
  ]);
  expect(screen.getByRole('searchbox')).toHaveValue('report');
});
