import {useEffect, useState} from 'react';
import {WindowsPrivacyControls} from '../../windows-ai/WindowsAiControls';
import {ImprovementPrivacyControls} from '../../improvement/ImprovementControls';

import {LumenUiIcon} from '../../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../../design-system/primitives/LumenButton';
import {LumenText} from '../../../design-system/primitives/LumenText';
import {useAppearanceStore} from '../../../state/appearance.store';
import {
  createLocalDataService,
  type LocalDataService,
} from '../../../services/settings/local-data-service';
import {useDiagnosticsStore} from '../../diagnostics/diagnostics.store';
import {ConfirmationDialog} from '../components/ConfirmationDialog';
import {SettingRow} from '../components/SettingRow';
import {SettingSection} from '../components/SettingSection';
import {LumenSwitch} from '../components/SettingsControls';
import {SettingsCallout, SettingsPage} from '../components/SettingsPage';
import {StatusBadge} from '../components/StatusBadge';
import {useSettingsStore} from '../settings.store';

function rootSummary(paths: string[]) {
  if (paths.length === 0) return 'No local roots selected';
  const names = paths.map((path) => {
    const segments = path.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? 'Local folder';
  });
  return names.length <= 2 ? names.join(', ') : `${names.length} local folders`;
}

const defaultLocalDataService = createLocalDataService();

export function PrivacyPage({
  localDataService = defaultLocalDataService,
}: {
  localDataService?: LocalDataService;
}) {
  const privacy = useSettingsStore((state) => state.privacy);
  const roots = useSettingsStore((state) => state.roots);
  const updatePrivacy = useSettingsStore((state) => state.updatePrivacy);
  const setPreview = useAppearanceStore((state) => state.setPreview);
  const prepareExport = useDiagnosticsStore((state) => state.prepareExport);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void localDataService.getHistoryStatus()
      .then(({entryCount}) => updatePrivacy({historyEntries: entryCount}))
      .catch(() => undefined);
  }, [localDataService, updatePrivacy]);

  const togglePreviews = async (previewsEnabled: boolean) => {
    const previous = privacy.previewsEnabled;
    setMessage('');
    try {
      await localDataService.setPreviewsEnabled(previewsEnabled);
      const appearanceResult = await setPreview(previewsEnabled ? 'automatic' : 'never');
      if (!appearanceResult.ok || !await updatePrivacy({previewsEnabled})) {
        await localDataService.setPreviewsEnabled(previous);
        await updatePrivacy({previewsEnabled: previous});
        await setPreview(previous ? 'automatic' : 'never');
        throw new Error('The preview setting could not be saved.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The preview setting could not be applied.');
    }
  };

  const clearHistory = async () => {
    setBusy(true);
    setMessage('');
    try {
      const result = await localDataService.clearSearchHistory();
      await updatePrivacy({historyEntries: result.entryCount});
      setMessage('Local search history cleared.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Search history could not be cleared.');
    } finally {
      setBusy(false);
    }
  };

  const deleteIndex = async () => {
    setBusy(true);
    setMessage('');
    try {
      const result = await localDataService.deleteIndexData();
      setMessage(`Deleted generated data for ${result.deletedFiles} files and ${result.deletedChunks} chunks. Source files were not changed.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The local index could not be deleted.');
    } finally {
      setBusy(false);
    }
  };

  const prepareSanitizedExport = async () => {
    setBusy(true);
    setMessage('');
    try {
      const native = await localDataService.getNativeDiagnostics();
      const payload = prepareExport(native);
      const result = await localDataService.exportDiagnostics(payload.contents);
      setMessage(result.saved
        ? `Saved ${result.fileName ?? payload.filename}.`
        : 'Diagnostic export cancelled.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Diagnostics could not be prepared.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage>
      <SettingsCallout>
        <LumenUiIcon name="privacy" size="small" /> Lumen search data stays on this PC. Cloud provider consent is separate and off by default.
      </SettingsCallout>
      {message ? <SettingsCallout>{message}</SettingsCallout> : null}
      <SettingSection title="Local data">
        <SettingRow label="Local-only search" description="Filenames, content index, previews, and history remain on this PC." status={<StatusBadge tone="success">On device</StatusBadge>}>
          <LumenUiIcon name="privacy" size="medium" />
        </SettingRow>
        <SettingRow label="Indexed root summary" description="Only folders you explicitly chose can be traversed.">
          <LumenText tone="secondary" variant="meta">{rootSummary(roots.map((root) => root.path))}</LumenText>
        </SettingRow>
        <SettingRow label="Search history" description={`${privacy.historyEntries} local ${privacy.historyEntries === 1 ? 'entry' : 'entries'}.`}>
          <ConfirmationDialog
            confirmLabel={`Clear ${privacy.historyEntries} history entries`}
            description="This removes local recent-query history. Indexed files are not affected."
            title="Clear search history?"
            onConfirm={() => void clearHistory()}
          >
            <LumenButton aria-label="Clear search history" isDisabled={busy || privacy.historyEntries === 0} size="small" variant="quiet">
              <LumenUiIcon name="delete" size="small" /> Clear
            </LumenButton>
          </ConfirmationDialog>
        </SettingRow>
        <SettingRow label="Local index" description="Delete generated index data without changing selected folders or source files.">
          <ConfirmationDialog
            confirmLabel="Delete local index data"
            description="This removes generated file, content, and vector records. Selected roots and source files remain unchanged."
            title="Delete the local index?"
            onConfirm={() => void deleteIndex()}
          >
            <LumenButton isDisabled={busy} size="small" variant="danger"><LumenUiIcon name="storage" size="small" /> Delete index</LumenButton>
          </ConfirmationDialog>
        </SettingRow>
      </SettingSection>
      <SettingSection title="Previews">
        <SettingRow label="File previews" description="Disable all text, image, and metadata preview requests.">
          <LumenSwitch aria-label="File previews" isDisabled={busy} isSelected={privacy.previewsEnabled} onChange={(enabled) => void togglePreviews(enabled)} />
        </SettingRow>
      </SettingSection>
      <SettingSection title="Diagnostic export">
        <SettingRow label="Sanitized support snapshot" description="Exports versions, states, and timing samples. Local paths, prompts, and secret fields are redacted.">
          <ConfirmationDialog
            confirmLabel="Prepare sanitized export"
            confirmVariant="primary"
            description="Review the generated JSON before sharing it. Lumen removes local paths and known secret-bearing fields."
            title="Prepare diagnostic export?"
            onConfirm={() => void prepareSanitizedExport()}
          >
            <LumenButton isDisabled={busy} size="small"><LumenUiIcon name="download" size="small" /> Export</LumenButton>
          </ConfirmationDialog>
        </SettingRow>
      </SettingSection>
      <WindowsPrivacyControls />
      <ImprovementPrivacyControls />
    </SettingsPage>
  );
}
