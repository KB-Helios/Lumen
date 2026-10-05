import {create} from 'zustand';
import {subscribeWithSelector} from 'zustand/middleware';

import {useActivityStore} from '../activity/activity.store';
import {activityPresentations} from '../activity/activity.types';
import {useGatewayStore} from '../gateway/gateway.store';
import {createDiagnosticsExport, type DiagnosticsExport, type DiagnosticsSnapshot} from './diagnostics.types';
import {readDiagnosticMetrics, resetDiagnosticMetrics} from './diagnostics.metrics';

function webViewVersion() {
  const edge = typeof navigator === 'undefined' ? null : navigator.userAgent.match(/Edg\/([\d.]+)/);
  return edge?.[1] ?? 'WebView2 runtime';
}

function currentMonitor() {
  if (typeof screen === 'undefined') return 'Unknown monitor';
  return `${screen.width} × ${screen.height}`;
}

function activeAnimationCount() {
  return typeof document !== 'undefined' && typeof document.getAnimations === 'function'
    ? document.getAnimations().length
    : 0;
}

function buildSnapshot(refreshRateHz: number | null = null): DiagnosticsSnapshot {
  const activity = useActivityStore.getState();
  const gateway = useGatewayStore.getState();
  return {
    appVersion: '0.1.0',
    webViewVersion: webViewVersion(),
    tauriVersion: 'Tauri 2 frontend contract',
    monitor: currentMonitor(),
    dpiScale: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
    refreshRateHz,
    activeAnimations: activeAnimationCount(),
    ...readDiagnosticMetrics(),
    activity: activityPresentations[activity.mode].label,
    gateway: gateway.gatewayState,
    providerRoutes: gateway.routes.map((route) => `${route.alias} → ${route.providerId} (${route.status})`),
  };
}

interface DiagnosticsState {
  overlayOpen: boolean;
  snapshot: DiagnosticsSnapshot;
  lastExport: DiagnosticsExport | null;
  refresh(): void;
  sampleRefreshRate(): Promise<number | null>;
  prepareExport(native?: unknown): DiagnosticsExport;
  setOverlay(open: boolean): void;
  toggleOverlay(): void;
  reset(): void;
}

const initialSnapshot = buildSnapshot();

export const useDiagnosticsStore = create<DiagnosticsState>()(
  subscribeWithSelector((set, get) => ({
    overlayOpen: false,
    snapshot: initialSnapshot,
    lastExport: null,
    refresh: () => set({snapshot: buildSnapshot(get().snapshot.refreshRateHz)}),
    sampleRefreshRate: async () => {
      if (typeof requestAnimationFrame !== 'function' || document.visibilityState === 'hidden') {
        return get().snapshot.refreshRateHz;
      }
      const samples: number[] = [];
      let previous: number | undefined;
      await new Promise<void>((resolve) => {
        let frame = 0;
        const finish = () => {
          cancelAnimationFrame(frame);
          window.clearTimeout(timeout);
          document.removeEventListener('visibilitychange', finish);
          resolve();
        };
        const timeout = window.setTimeout(finish, 2000);
        document.addEventListener('visibilitychange', finish, {once: true});
        const sample = (now: number) => {
          if (previous !== undefined && now > previous) samples.push(now - previous);
          previous = now;
          if (samples.length >= 60) finish();
          else frame = requestAnimationFrame(sample);
        };
        frame = requestAnimationFrame(sample);
      });
      if (samples.length < 60) return get().snapshot.refreshRateHz;
      samples.sort((a, b) => a - b);
      const median = samples[Math.floor(samples.length / 2)];
      const refreshRateHz = Math.round(1000 / median);
      set({snapshot: buildSnapshot(refreshRateHz)});
      return refreshRateHz;
    },
    prepareExport: (native) => {
      const payload = createDiagnosticsExport(native === undefined
        ? get().snapshot
        : {frontend: get().snapshot, native});
      set({lastExport: payload});
      return payload;
    },
    setOverlay: (overlayOpen) => {
      if (overlayOpen) set({snapshot: buildSnapshot(get().snapshot.refreshRateHz)});
      set({overlayOpen});
    },
    toggleOverlay: () => get().setOverlay(!get().overlayOpen),
    reset: () => {
      resetDiagnosticMetrics();
      set({overlayOpen: false, snapshot: buildSnapshot(), lastExport: null});
    },
  })),
);
