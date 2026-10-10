import {afterEach, expect, it, vi} from 'vitest';

import {sampleFrameCadence} from './diagnostics.refresh.mjs';

afterEach(() => vi.unstubAllGlobals());

it('retains raw interval order independently of sorted cadence estimates', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const sample = sampleFrameCadence({sampleCount: 3});
  for (const timestamp of [100, 103, 104, 106]) frames.shift()!(timestamp);
  expect(await sample).toEqual({intervals: [3, 1, 2], medianMs: 2, p95Ms: 3});
});

it('does not start background sampling while hidden', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const request = vi.fn();
  vi.stubGlobal('requestAnimationFrame', request);
  expect(await sampleFrameCadence()).toEqual({intervals: [], medianMs: null, p95Ms: null});
  expect(request).not.toHaveBeenCalled();
});
