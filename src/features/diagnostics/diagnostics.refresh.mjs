// Standalone browser function shared with the Edge evidence runners.
export async function sampleFrameCadence({sampleCount = 60, signal} = {}) {
  const intervals = [];
  if (typeof globalThis.requestAnimationFrame !== 'function' || globalThis.document.visibilityState === 'hidden' || signal?.aborted) {
    return {intervals, medianMs: null, p95Ms: null};
  }
  let previous;
  await new Promise((resolve) => {
    let frame = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      globalThis.cancelAnimationFrame(frame);
      globalThis.clearTimeout(timeout);
      globalThis.document.removeEventListener('visibilitychange', visibilityChanged);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const visibilityChanged = () => {
      if (globalThis.document.visibilityState === 'hidden') finish();
    };
    const timeout = globalThis.setTimeout(finish, 3000);
    globalThis.document.addEventListener('visibilitychange', visibilityChanged);
    signal?.addEventListener('abort', finish, {once: true});
    const sample = (now) => {
      if (finished) return;
      if (previous !== undefined && Number.isFinite(now) && now > previous) intervals.push(now - previous);
      previous = Number.isFinite(now) ? now : undefined;
      if (intervals.length >= sampleCount) finish();
      else frame = globalThis.requestAnimationFrame(sample);
    };
    frame = globalThis.requestAnimationFrame(sample);
  });
  const sorted = [...intervals].sort((left, right) => left - right);
  return {
    intervals,
    medianMs: intervals.length === sampleCount ? sorted[Math.floor(sorted.length / 2)] : null,
    p95Ms: intervals.length === sampleCount ? sorted[Math.floor(sorted.length * 0.95)] : null,
  };
}
