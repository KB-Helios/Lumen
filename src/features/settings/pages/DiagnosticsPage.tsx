import {useState} from 'react';
import {WindowsAiDiagnostics} from '../../windows-ai/WindowsAiControls';

import {LumenUiIcon} from '../../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../../design-system/primitives/LumenButton';
import {
  createLocalDataService,
  type LocalDataService,
  type NativeDiagnostics,
} from '../../../services/settings/local-data-service';
import {useDiagnosticsStore} from '../../diagnostics/diagnostics.store';
import {DiagnosticItem} from '../../diagnostics/DiagnosticItem';
import {SettingSection} from '../components/SettingSection';
import {SettingsCallout, SettingsPage} from '../components/SettingsPage';

const defaultLocalDataService = createLocalDataService();

function stateLabel(value: string) {
  return value.replace(/([A-Z])/g, ' $1').replace('-', ' ').replace(/^./, (character) => character.toUpperCase());
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function DiagnosticsPage({
  localDataService = defaultLocalDataService,
}: {
  localDataService?: LocalDataService;
}) {
  const snapshot = useDiagnosticsStore((state) => state.snapshot);
  const lastExport = useDiagnosticsStore((state) => state.lastExport);
  const refresh = useDiagnosticsStore((state) => state.refresh);
  const sampleRefreshRate = useDiagnosticsStore((state) => state.sampleRefreshRate);
  const prepareExport = useDiagnosticsStore((state) => state.prepareExport);
  const [native, setNative] = useState<NativeDiagnostics>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refreshAll = async () => {
    refresh();
    setBusy(true);
    setMessage('');
    try {
      setNative(await localDataService.getNativeDiagnostics());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Native diagnostics are unavailable.');
    } finally {
      setBusy(false);
    }
  };

  const exportAll = async () => {
    setBusy(true);
    setMessage('');
    try {
      const current = native ?? await localDataService.getNativeDiagnostics();
      setNative(current);
      const payload = prepareExport(current);
      const result = await localDataService.exportDiagnostics(payload.contents);
      setMessage(result.saved
        ? `Saved ${result.fileName ?? payload.filename}.`
        : 'Diagnostic export cancelled.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Diagnostics could not be exported.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage>
      <SettingsCallout>
        Values are sampled on demand. Lumen does not run a per-frame diagnostics render loop.
      </SettingsCallout>
      <SettingSection title="Runtime">
        <DiagnosticItem label="Application">Lumen {snapshot.appVersion}</DiagnosticItem>
        <DiagnosticItem label="WebView2">{snapshot.webViewVersion}</DiagnosticItem>
        <DiagnosticItem label="Tauri">{snapshot.tauriVersion}</DiagnosticItem>
        <DiagnosticItem label="Monitor">{snapshot.monitor}</DiagnosticItem>
        <DiagnosticItem label="DPI scale">{Math.round(snapshot.dpiScale * 100)}%</DiagnosticItem>
        <DiagnosticItem label="Refresh estimate">{snapshot.refreshRateHz} Hz</DiagnosticItem>
      </SettingSection>
      <SettingSection title="Rendering and activity">
        <DiagnosticItem label="Active animations">{snapshot.activeAnimations}</DiagnosticItem>
        <DiagnosticItem label="React commit">{snapshot.reactCommitMs.toFixed(2)} ms</DiagnosticItem>
        <DiagnosticItem label="Activity">{snapshot.activity}</DiagnosticItem>
        <DiagnosticItem label="AgentGateway">{snapshot.gateway}</DiagnosticItem>
        <DiagnosticItem label="Provider routes">{snapshot.providerRoutes.join('; ') || 'No routes'}</DiagnosticItem>
        <DiagnosticItem label="Logs">{snapshot.logs[snapshot.logs.length - 1] ?? 'No warnings recorded'}</DiagnosticItem>
      </SettingSection>
      <SettingSection title="Native services">
        <DiagnosticItem label="Index">{native ? `${stateLabel(native.index.phase)} · schema ${native.index.schemaVersion} · ${countLabel(native.index.indexedFiles, 'file')} · ${countLabel(native.index.indexedChunks, 'chunk')}` : 'Not sampled'}</DiagnosticItem>
        <DiagnosticItem label="SQLite vector">{native ? (native.vector.available ? `Ready · ${native.vector.version ?? 'version unavailable'}` : `Unavailable${native.vector.lastError ? ` · ${native.vector.lastError}` : ''}`) : 'Not sampled'}</DiagnosticItem>
        <DiagnosticItem label="Activity policy">{native ? `${stateLabel(native.activity.mode)} · ${stateLabel(native.activity.backgroundPolicy)}` : 'Not sampled'}</DiagnosticItem>
        <DiagnosticItem label="AgentGateway native">{native ? `${stateLabel(native.gateway.state)} · ${native.gateway.version}` : 'Not sampled'}</DiagnosticItem>
        <DiagnosticItem label="MCP">{native ? `${countLabel(native.mcp.services, 'service')} · ${countLabel(native.mcp.tools, 'tool')}` : 'Not sampled'}</DiagnosticItem>
        <DiagnosticItem label="Local runtime">{native ? `${stateLabel(native.runtime.state)} · Lemonade ${native.runtime.lemonadeVersion ?? native.runtime.requiredLemonadeVersion}` : 'Not sampled'}</DiagnosticItem>
        <DiagnosticItem label="Provisioning">{native ? `${stateLabel(native.provisioning.state)} · ${native.provisioning.progress}%` : 'Not sampled'}</DiagnosticItem>
        <DiagnosticItem label="Native routes">{native ? `${countLabel(native.providers.routes, 'route')} · ${native.providers.localRoutes} local` : 'Not sampled'}</DiagnosticItem>
        <DiagnosticItem label="Global shortcut">{native ? (native.shortcut.registered ? native.shortcut.accelerator ?? 'Registered' : `Unavailable · ${native.shortcut.errorCode ?? 'unknown'}`) : 'Not sampled'}</DiagnosticItem>
      </SettingSection>
      <SettingSection title="Performance samples">
        <DiagnosticItem label="Browser long tasks (50 ms+)">{snapshot.browserLongTasks.length}</DiagnosticItem>
        <DiagnosticItem label="Interaction samples">{snapshot.timings.length}</DiagnosticItem>
        <DiagnosticItem label="Native aggregation">{native ? `${native.timings[0]?.durationMs ?? 0} ms · ${native.logs.length} bounded states` : 'Not sampled'}</DiagnosticItem>
      </SettingSection>
      <div className="flex flex-wrap gap-2">
        <LumenButton aria-label="Refresh diagnostics" isDisabled={busy} size="small" onPress={() => void refreshAll()}><LumenUiIcon name="refresh" size="small" /> Refresh</LumenButton>
        <LumenButton aria-label="Measure refresh rate" isDisabled={busy} size="small" onPress={() => void sampleRefreshRate()}>Measure refresh rate</LumenButton>
        <LumenButton aria-label="Export diagnostics" isDisabled={busy} size="small" variant="quiet" onPress={() => void exportAll()}><LumenUiIcon name="download" size="small" /> Export</LumenButton>
      </div>
      {message ? <SettingsCallout>{message}</SettingsCallout> : lastExport ? <SettingsCallout>{lastExport.filename} is prepared for review.</SettingsCallout> : null}
      <WindowsAiDiagnostics />
    </SettingsPage>
  );
}
