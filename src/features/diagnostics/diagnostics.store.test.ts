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
    return frames.length;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  return frames;
}

describe('on-demand refresh measurement', () => {
  it('does not assume 60 Hz before measurement', () => {
    expect(useDiagnosticsStore.getState().snapshot.refreshRateHz).toBeNull();
  });

  it.each([20, 120, 240, 500])('seeds the first callback and measures %i Hz without clamping', async (rate) => {
    const frames = fakeFrames();
    const updates = vi.fn();
    const unsubscribe = useDiagnosticsStore.subscribe(updates);
    const measurement = useDiagnosticsStore.getState().sampleRefreshRate();
    for (let index = 0; index < 60 && frames.length; index += 1) frames.shift()!(100 + index * 1000 / rate);
    expect(frames).toHaveLength(1);
    expect(updates).not.toHaveBeenCalled();
    frames.shift()!(100 + 60 * 1000 / rate);
    expect(await measurement).toBe(rate);
    expect(updates).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('requires 60 positive complete intervals', async () => {
    vi.useFakeTimers();
    const frames = fakeFrames();
    const measurement = useDiagnosticsStore.getState().sampleRefreshRate();
    for (let index = 0; index < 100 && frames.length; index += 1) frames.shift()!(100);
    expect(frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await measurement).toBeNull();
    expect(useDiagnosticsStore.getState().snapshot.refreshRateHz).toBeNull();
  });

  it('times out at 3000 ms and cancels the pending callback', async () => {
    vi.useFakeTimers();
    fakeFrames();
    const measurement = useDiagnosticsStore.getState().sampleRefreshRate();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await measurement).toBeNull();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it('stops when hidden without writing a partial estimate', async () => {
    const frames = fakeFrames();
    const measurement = useDiagnosticsStore.getState().sampleRefreshRate();
    frames.shift()!(100);
    frames.shift()!(110);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await measurement).toBeNull();
    const requested = frames.length;
    frames.shift()?.(120);
    expect(frames.length).toBeLessThan(requested);
    expect(useDiagnosticsStore.getState().snapshot.refreshRateHz).toBeNull();
  });

  it('cancels sampling on reset without accepting a late callback', async () => {
    const frames = fakeFrames();
    const measurement = useDiagnosticsStore.getState().sampleRefreshRate();
    useDiagnosticsStore.getState().reset();
    frames.shift()?.(100);
    expect(await measurement).toBeNull();
    expect(frames).toHaveLength(0);
  });
});
