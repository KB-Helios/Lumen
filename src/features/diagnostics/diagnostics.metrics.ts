import type {TimingSample} from './diagnostics.types';

const timingSamples: TimingSample[] = [];
const reactCommits: number[] = [];
const browserLongTasks: number[] = [];
const logs: string[] = [];
let longTaskResetAt = 0;

function trim<T>(items: T[], maximum = 160) {
  if (items.length > maximum) {
    items.splice(0, items.length - maximum);
  }
}

export function captureReactCommit(durationMs: number) {
  reactCommits.push(durationMs);
  trim(reactCommits);
}

export function captureTiming(name: TimingSample['name'], durationMs: number, frame?: TimingSample['frame']) {
  timingSamples.push({name, durationMs, timestamp: Date.now(), ...(frame ? {frame} : {})});
  trim(timingSamples);
}

export function captureLog(message: string) {
  logs.push(message);
  trim(logs);
}

// Historical name: the endpoint is the next actual rAF callback, before presentation.
export function measureAfterPaint(name: TimingSample['name'], startedAt: number) {
  let cancelled = false;
  const queuedAt = performance.now();
  const finish = (nominalAt?: number) => {
    if (cancelled) return;
    const end = performance.now();
    const duration = end - startedAt;
    captureTiming(name, duration, typeof nominalAt === 'number'
      ? {startedAt, queuedAt, nominalAt, callbackAt: end} : undefined);
  };
  if (typeof requestAnimationFrame === 'function') {
    const frame = requestAnimationFrame(finish);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  } else {
    queueMicrotask(finish);
    return () => {
      cancelled = true;
    };
  }
}

export function startDiagnosticsObserver() {
  if (typeof PerformanceObserver === 'undefined') {
    return () => undefined;
  }
  try {
    const observer = new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        if (entry.startTime >= longTaskResetAt && entry.duration >= 50) {
          browserLongTasks.push(entry.duration);
          trim(browserLongTasks);
        }
      }
    });
    observer.observe({entryTypes: ['longtask']});
    return () => observer.disconnect();
  } catch {
    return () => undefined;
  }
}

export function readDiagnosticMetrics() {
  return {
    timings: timingSamples.slice(),
    browserLongTasks: browserLongTasks.slice(),
    logs: logs.slice(),
    reactCommits: reactCommits.slice(),
    reactCommitMs: reactCommits[reactCommits.length - 1] ?? null,
  };
}

export function resetDiagnosticMetrics() {
  longTaskResetAt = typeof performance === 'undefined' ? 0 : performance.now();
  timingSamples.splice(0);
  reactCommits.splice(0);
  browserLongTasks.splice(0);
  logs.splice(0);
}
