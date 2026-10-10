import {useRef, useState} from 'react';

import {createWindowService} from '../../../platform/window/tauri-window-service';
import type {WindowService} from '../../../platform/window/window-service';
import {
  createRuntimeSettingsService,
  type RuntimeSettingsService,
} from '../../../services/settings/runtime-settings-service';
import {SettingRow} from '../components/SettingRow';
import {SettingSection} from '../components/SettingSection';
import {LumenSelect, LumenSwitch} from '../components/SettingsControls';
import {SettingsCallout, SettingsPage} from '../components/SettingsPage';
import {ShortcutRecorder} from '../components/ShortcutRecorder';
import {useSettingsStore} from '../settings.store';

const defaultWindowService = createWindowService();
const defaultRuntimeService = createRuntimeSettingsService();

export function GeneralPage({
  runtimeService = defaultRuntimeService,
  windowService = defaultWindowService,
}: {
  runtimeService?: RuntimeSettingsService;
  windowService?: WindowService;
}) {
  const general = useSettingsStore((state) => state.general);
  const updateGeneral = useSettingsStore((state) => state.updateGeneral);
  const [shortcutError, setShortcutError] = useState('');
  const [runtimeError, setRuntimeError] = useState('');
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);

  const updateShortcut = async (shortcut: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    const previousShortcut = general.shortcut;
    setShortcutError('');
    try {
      await windowService.setShortcut(shortcut);
      const saving = updateGeneral({shortcut});
      const applied = useSettingsStore.getState().general;
      if (!await saving) {
        if (applied === useSettingsStore.getState().general) {
          await windowService.setShortcut(previousShortcut);
          await updateGeneral({shortcut: previousShortcut});
        }
        throw new Error('The shortcut was registered but could not be saved.');
      }
    } catch {
      setShortcutError('Windows could not register that shortcut. Your previous shortcut remains active.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const applyRuntimeSetting = async (
    patch: Partial<typeof general>,
    apply: () => Promise<void>,
    rollback: () => Promise<void>,
    previous: Partial<typeof general>,
  ) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setRuntimeError('');
    try {
      await apply();
      const saving = updateGeneral(patch);
      const applied = useSettingsStore.getState().general;
      if (!await saving) {
        if (applied === useSettingsStore.getState().general) {
          await rollback();
          await updateGeneral(previous);
        }
        throw new Error('The setting was applied but could not be saved.');
      }
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : 'Windows rejected the setting.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <SettingsPage>
      {runtimeError ? <SettingsCallout tone="error">{runtimeError}</SettingsCallout> : null}
      <SettingSection title="Startup" description="Choose when Lumen is ready without adding visual noise.">
        <SettingRow label="Launch at startup" description="Start Lumen quietly when you sign in to Windows.">
          <LumenSwitch
            isDisabled={busy}
            aria-label="Launch at startup"
            isSelected={general.launchAtStartup}
            onChange={(launchAtStartup) => void applyRuntimeSetting(
              {launchAtStartup},
              () => runtimeService.setLaunchAtStartup(launchAtStartup),
              () => runtimeService.setLaunchAtStartup(general.launchAtStartup),
              {launchAtStartup: general.launchAtStartup},
            )}
          />
        </SettingRow>
      </SettingSection>
      <SettingSection title="Launcher" description="Keyboard and window behavior shared by every search.">
        <SettingRow
          label="Global shortcut"
          description="Press the chord once to summon Lumen on the active monitor."
          error={shortcutError}
        >
          <ShortcutRecorder isDisabled={busy} value={general.shortcut} onChange={updateShortcut} onInvalid={setShortcutError} />
        </SettingRow>
        <SettingRow label="Open on" description="Follow your pointer and active application, or stay on the primary display.">
          <LumenSelect
            isDisabled={busy}
            aria-label="Monitor behavior"
            options={[
              {id: 'active', label: 'Active monitor'},
              {id: 'primary', label: 'Primary monitor'},
            ]}
            value={general.monitorBehavior}
            onChange={(monitorBehavior) => void applyRuntimeSetting(
              {monitorBehavior},
              () => runtimeService.setMonitorBehavior(monitorBehavior),
              () => runtimeService.setMonitorBehavior(general.monitorBehavior),
              {monitorBehavior: general.monitorBehavior},
            )}
          />
        </SettingRow>
        <SettingRow label="Search history" description="Keep recent queries locally for quick recall.">
          <LumenSwitch
            isDisabled={busy}
            aria-label="Search history"
            isSelected={general.historyEnabled}
            onChange={(historyEnabled) => void applyRuntimeSetting(
              {historyEnabled},
              () => runtimeService.setHistoryEnabled(historyEnabled),
              () => runtimeService.setHistoryEnabled(general.historyEnabled),
              {historyEnabled: general.historyEnabled},
            )}
          />
        </SettingRow>
        <SettingRow label="When the launcher closes" description="Hiding keeps the warm interface ready for the next shortcut.">
          <LumenSelect
            isDisabled={busy}
            aria-label="Launcher close behavior"
            options={[
              {id: 'hide', label: 'Hide and stay ready'},
              {id: 'quit', label: 'Quit Lumen'},
            ]}
            value={general.closeBehavior}
            onChange={(closeBehavior) => void applyRuntimeSetting(
              {closeBehavior},
              () => runtimeService.setCloseBehavior(closeBehavior),
              () => runtimeService.setCloseBehavior(general.closeBehavior),
              {closeBehavior: general.closeBehavior},
            )}
          />
        </SettingRow>
      </SettingSection>
    </SettingsPage>
  );
}
