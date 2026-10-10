import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {AppProviders} from '../../app/AppProviders';
import type {NativeDiagnostics} from '../../services/settings/local-data-service';
import {useSettingsStore} from '../settings/settings.store';
import {DiagnosticsPage} from '../settings/pages/DiagnosticsPage';
import {PrivacyPage} from '../settings/pages/PrivacyPage';
import {DiagnosticsOverlay} from './DiagnosticsOverlay';
import {createDiagnosticsExport, sanitizeDiagnostics} from './diagnostics.types';
import {useDiagnosticsStore} from './diagnostics.store';

function renderPage(children: React.ReactNode) {
  return render(<AppProviders appearance={{mode: 'dark', transparency: 'disabled', effects: 'reduced', motion: 'reduced'}}>{children}</AppProviders>);
}

const nativeDiagnostics: NativeDiagnostics = {
  appVersion: '0.1.0',
  index: {phase: 'ready', schemaVersion: 3, indexedFiles: 7, indexedChunks: 11, historyEntries: 3, historyEnabled: true},
  vector: {available: true, version: '1.0.0', backend: 'sqlite-vector', lastError: null},
  activity: {mode: 'indexing', backgroundPolicy: 'normal', fullscreen: false, onBattery: false},
  gateway: {state: 'ready', version: '0.8.0', cloudCredentialConfigured: false},
  mcp: {services: 1, tools: 3, allowed: 2, ask: 1, denied: 0},
  runtime: {state: 'ready', profile: 'generic-local', lemonadeVersion: '11.5.2', requiredLemonadeVersion: '11.5.2', answerModel: 'qwen', embeddingModel: 'nomic'},
  provisioning: {state: 'ready', version: '11.5.2', installedVersion: '11.5.2', progress: 100},
  providers: {routes: 7, localRoutes: 2, cloudRoutes: 5},
  shortcut: {registered: true, accelerator: 'Alt + Space', errorCode: null},
  timings: [{name: 'native-diagnostics', durationMs: 1}],
  logs: [{component: 'index', state: 'ready'}],
};

afterEach(() => {
  useDiagnosticsStore.getState().reset();
  useSettingsStore.getState().reset();
});

describe('diagnostics privacy', () => {
  it('cancels an in-progress refresh measurement when the Diagnostics page unmounts', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const view = renderPage(<DiagnosticsPage />);
    const measurement = useDiagnosticsStore.getState().sampleRefreshRate();
    view.unmount();
    expect(await measurement).toBeNull();
    for (const callback of frames.splice(0)) callback(100);
    expect(frames).toHaveLength(0);
    vi.unstubAllGlobals();
  });
  it('redacts paths and provider secrets from diagnostic exports', () => {
    const result = sanitizeDiagnostics({
      root: 'C:\\Users\\Kevin\\Secret',
      apiKey: 'token',
      message: 'Failed at C:\\Users\\Kevin\\Secret\\note.txt',
      embeddedUnc: 'failed at \\\\vault\\share\\note.txt',
      forwardUnc: 'failed at //vault/share/note.txt',
      providerError: 'quota response from upstream',
      version: '1.0.0',
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('Kevin');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('quota');
    expect(serialized).not.toContain('vault');
    expect(serialized).toContain('[local-path]');
    expect(serialized).toContain('[redacted]');
  });

  it('creates a stable export payload without local root paths', () => {
    const payload = createDiagnosticsExport({
      appVersion: '0.1.0',
      roots: ['C:\\Private'],
      providerToken: 'secret-value',
    });

    expect(payload.filename).toMatch(/^lumen-diagnostics-/);
    expect(payload.contents).not.toContain('Private');
    expect(payload.contents).not.toContain('secret-value');
  });

  it('opens the development overlay from the keyboard without a render loop', async () => {
    const user = userEvent.setup();
    renderPage(<DiagnosticsOverlay />);

    await user.keyboard('{Control>}{Shift>}d{/Shift}{/Control}');

    expect(screen.getByRole('complementary', {name: 'Performance diagnostics'})).toBeVisible();
    expect(screen.getByText('Refresh estimate')).toBeVisible();
    expect(screen.getByRole('button', {name: 'Refresh diagnostics'})).toBeVisible();
  });

  it('lets the development-only overlay be dismissed without changing diagnostics state', async () => {
    const user = userEvent.setup();
    useDiagnosticsStore.getState().setOverlay(true);
    renderPage(<DiagnosticsOverlay />);

    await user.click(screen.getByRole('button', {name: 'Close diagnostics'}));

    expect(screen.queryByRole('complementary', {name: 'Performance diagnostics'})).not.toBeInTheDocument();
    expect(useDiagnosticsStore.getState().overlayOpen).toBe(false);
  });

  it('shows complete runtime fields on the Diagnostics page', () => {
    renderPage(<DiagnosticsPage />);

    for (const field of ['Application', 'WebView2', 'Tauri', 'Monitor', 'DPI scale', 'Refresh estimate', 'Active animations', 'React commit', 'Activity', 'AgentGateway', 'Provider routes', 'Logs']) {
      expect(screen.getByText(field)).toBeVisible();
    }
  });

  it('clears durable local history without presenting unimplemented analysis controls', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({privacy: {...useSettingsStore.getState().privacy, historyEntries: 12}});
    const localDataService = {
      setPreviewsEnabled: vi.fn(async () => undefined),
      getHistoryStatus: vi.fn(async () => ({entryCount: 12, enabled: true})),
      clearSearchHistory: vi.fn(async () => ({entryCount: 0})),
      deleteIndexData: vi.fn(async () => ({deletedFiles: 0, deletedChunks: 0})),
      getNativeDiagnostics: vi.fn(async () => nativeDiagnostics),
      exportDiagnostics: vi.fn(async () => ({saved: false})),
    };
    renderPage(<PrivacyPage localDataService={localDataService} />);

    await user.click(screen.getByRole('button', {name: 'Clear search history'}));
    await user.click(screen.getByRole('button', {name: 'Clear 12 history entries'}));

    await waitFor(() => expect(localDataService.clearSearchHistory).toHaveBeenCalledOnce());
    expect(useSettingsStore.getState().privacy.historyEntries).toBe(0);
    expect(screen.queryByRole('switch', {name: 'OCR analysis'})).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', {name: 'Image understanding'})).not.toBeInTheDocument();
  });

  it('refreshes one typed native diagnostics snapshot on demand', async () => {
    const user = userEvent.setup();
    const localDataService = {
      setPreviewsEnabled: vi.fn(async () => undefined),
      getHistoryStatus: vi.fn(async () => ({entryCount: 0, enabled: true})),
      clearSearchHistory: vi.fn(async () => ({entryCount: 0})),
      deleteIndexData: vi.fn(async () => ({deletedFiles: 0, deletedChunks: 0})),
      getNativeDiagnostics: vi.fn(async () => nativeDiagnostics),
      exportDiagnostics: vi.fn(async () => ({saved: true, fileName: 'lumen-diagnostics.json'})),
    };
    renderPage(<DiagnosticsPage localDataService={localDataService} />);

    await user.click(screen.getByRole('button', {name: 'Refresh diagnostics'}));

    await waitFor(() => expect(localDataService.getNativeDiagnostics).toHaveBeenCalledOnce());
    expect(screen.getByText('Ready · schema 3 · 7 files · 11 chunks')).toBeVisible();
    expect(screen.getByText('Ready · 1.0.0')).toBeVisible();
    expect(screen.getByText('1 service · 3 tools')).toBeVisible();
  });

  it('applies preview privacy before persisting and deletes only generated index data', async () => {
    const user = userEvent.setup();
    const localDataService = {
      setPreviewsEnabled: vi.fn(async () => undefined),
      getHistoryStatus: vi.fn(async () => ({entryCount: 0, enabled: true})),
      clearSearchHistory: vi.fn(async () => ({entryCount: 0})),
      deleteIndexData: vi.fn(async () => ({deletedFiles: 4, deletedChunks: 9})),
      getNativeDiagnostics: vi.fn(async () => nativeDiagnostics),
      exportDiagnostics: vi.fn(async () => ({saved: false})),
    };
    renderPage(<PrivacyPage localDataService={localDataService} />);

    await user.click(screen.getByRole('switch', {name: 'File previews'}));
    await waitFor(() => expect(localDataService.setPreviewsEnabled).toHaveBeenCalledWith(false));
    expect(useSettingsStore.getState().privacy.previewsEnabled).toBe(false);

    await user.click(screen.getByRole('button', {name: /Delete index/}));
    await user.click(screen.getByRole('button', {name: 'Delete local index data'}));

    await waitFor(() => expect(localDataService.deleteIndexData).toHaveBeenCalledOnce());
    expect(screen.getByText(/4 files and 9 chunks/)).toBeVisible();
  });

  it('exports the sanitized snapshot through the native save operation', async () => {
    const user = userEvent.setup();
    const localDataService = {
      setPreviewsEnabled: vi.fn(async () => undefined),
      getHistoryStatus: vi.fn(async () => ({entryCount: 0, enabled: true})),
      clearSearchHistory: vi.fn(async () => ({entryCount: 0})),
      deleteIndexData: vi.fn(async () => ({deletedFiles: 0, deletedChunks: 0})),
      getNativeDiagnostics: vi.fn(async () => nativeDiagnostics),
      exportDiagnostics: vi.fn(async (contents: string) => {
        expect(contents).not.toContain('C:\\');
        return {saved: true, fileName: 'lumen-diagnostics.json'};
      }),
    };
    renderPage(<PrivacyPage localDataService={localDataService} />);

    await user.click(screen.getByRole('button', {name: 'Export'}));
    await user.click(screen.getByRole('button', {name: 'Prepare sanitized export'}));

    await waitFor(() => expect(localDataService.exportDiagnostics).toHaveBeenCalledOnce());
    expect(screen.getByText('Saved lumen-diagnostics.json.')).toBeVisible();
  });
});
