import {afterEach, describe, expect, it, vi} from 'vitest';

import {useDiagnosticsStore} from './diagnostics.store';

afterEach(() => {
  useDiagnosticsStore.getState().reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fakeFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frames.push(callback);
    return 1;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  return frames;
}

describe('on-demand refresh measurement', () => {
  it('does not report an assumed 60 Hz cadence before measurement', () => {
    expect(useDiagnosticsStore.getState().snapshot.refreshRateHz).toBeNull();
  });

  it.each([120, 240, 500])('measures %i Hz without a frame cap or per-frame state writes', async (rate) => {
    const frames = fakeFrames();
    const updates = vi.fn();
    const unsubscribe = useDiagnosticsStore.subscribe(updates);
    const measurement = useDiagnosticsStore.getState().sampleRefreshRate();
    let count = 0;
    // The first callback is a partial interval and must seed, not sample.
    while (frames.length && count < 61) {
      frames.shift()!(100 + count * 1000 / rate);
      count += 1;
    }
    expect(updates).not.toHaveBeenCalled();
    expect(await measurement).toBe(rate);
    expect(count).toBe(61);
    expect(updates).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('bounds sampling when the browser stops delivering frames', async () => {
    vi.useFakeTimers();
    fakeFrames();
    const measurement = useDiagnosticsStore.getState().sampleRefreshRate();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await measurement).toBeNull();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });
});
