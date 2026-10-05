import {useCallback, useEffect, useState} from 'react';

import {LumenUiIcon} from '../../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../../design-system/primitives/LumenButton';
import {LumenText} from '../../../design-system/primitives/LumenText';
import {isNativeRuntime, nativeAiService} from '../../../services/ai/native-ai-service';
import {TauriComputerUseService} from '../../../services/computer-use/tauri-computer-use-service';
import {
  computerUseModels,
  type ComputerUseHealth,
  type ComputerUseModel,
} from '../../../services/computer-use/computer-use.types';
import {ConfirmationDialog} from '../components/ConfirmationDialog';
import {SettingRow} from '../components/SettingRow';
import {SettingSection} from '../components/SettingSection';
import {LumenSelect, LumenTextField} from '../components/SettingsControls';
import {SettingsCallout, SettingsPage} from '../components/SettingsPage';
import {StatusBadge} from '../components/StatusBadge';
import {useSettingsStore} from '../settings.store';

const computerUseService = new TauriComputerUseService();

const modelOptions = computerUseModels.map((model) => ({id: model, label: model}));

function validWebUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname.length > 0
      && url.username.length === 0
      && url.password.length === 0;
  } catch {
    return false;
  }
}

export function ComputerUsePage() {
  const settings = useSettingsStore((state) => state.computerUse);
  const updateComputerUse = useSettingsStore((state) => state.updateComputerUse);
  const setComputerUseConsent = useSettingsStore((state) => state.setComputerUseConsent);
  const native = isNativeRuntime();
  const [health, setHealth] = useState<ComputerUseHealth>();
  const [credential, setCredential] = useState('');
  const [initialUrl, setInitialUrl] = useState(settings.initialUrl);
  const [message, setMessage] = useState('');
  const refresh = useCallback(async () => {
    if (!native) return;
    setHealth(await computerUseService.health());
  }, [native]);

  useEffect(() => {
    void refresh().catch((error: unknown) => setMessage(String(error)));
  }, [refresh]);

  useEffect(() => {
    setInitialUrl(settings.initialUrl);
  }, [settings.initialUrl]);

  const saveCredential = async () => {
    if (!credential.trim()) return;
    try {
      await nativeAiService.saveCredential('gemini', credential);
      await refresh();
      setMessage('Gemini API key saved in Windows Credential Manager.');
    } catch (error) {
      setMessage(`The Gemini credential could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCredential('');
    }
  };
  const deleteCredential = async () => {
    try {
      await nativeAiService.deleteCredential('gemini');
      await refresh();
      setMessage('Gemini API key removed.');
    } catch (error) {
      setMessage(`The Gemini credential may still be configured: ${error instanceof Error ? error.message : String(error)}`);
      await refresh().catch(() => undefined);
    }
  };
  const saveInitialUrl = async () => {
    if (!validWebUrl(initialUrl)) {
      setMessage('The start page must be an absolute HTTP or HTTPS URL.');
      return;
    }
    await updateComputerUse({initialUrl});
    setMessage('Computer Use start page saved.');
  };
  const grantConsent = () => void setComputerUseConsent(true);
  const revokeConsent = () => void setComputerUseConsent(false);

  return (
    <SettingsPage>
      <SettingsCallout>
        Computer Use runs a separate Microsoft Edge session. The Gemini key stays in Windows Credential Manager; tasks and browser screenshots leave this device only after explicit consent.
      </SettingsCallout>
      {message ? <SettingsCallout>{message}</SettingsCallout> : null}
      <SettingSection title="Runtime" description="Lumen supervises a fixed, browser-only sidecar and stops it with the app.">
        <SettingRow
          label="Computer Use worker"
          description={health?.detail ?? `${health?.browser ?? 'Microsoft Edge'} · ${health?.mode ?? 'checking'} runtime`}
          status={<StatusBadge tone={health?.state === 'ready' ? 'success' : 'warning'}>{health?.state ?? 'Checking'}</StatusBadge>}
        >
          <LumenButton size="small" variant="quiet" onPress={() => void refresh()}>
            <LumenUiIcon name="computer" size="small" /> Check
          </LumenButton>
        </SettingRow>
        <SettingRow label="Gemini model" description="Only models exposed by the pinned Computer Use Preview adapter are selectable.">
          <LumenSelect
            aria-label="Computer Use model"
            options={modelOptions}
            value={settings.model}
            onChange={(model: ComputerUseModel) => void updateComputerUse({model})}
          />
        </SettingRow>
        <SettingRow label="Start page" description="Every task starts in a fresh Edge context at this HTTP or HTTPS address.">
          <div className="grid min-w-0 w-[300px] max-w-full grid-cols-[minmax(0,1fr)] gap-[8px] @min-[36rem]/settings:grid-cols-[minmax(0,1fr)_auto]">
            <LumenTextField aria-label="Computer Use start page" value={initialUrl} onChange={setInitialUrl} />
            <LumenButton className="justify-self-start" size="small" variant="quiet" onPress={() => void saveInitialUrl()}>Save</LumenButton>
          </div>
        </SettingRow>
      </SettingSection>
      {native ? (
        <SettingSection title="Gemini credential" description="The secret is written directly to Windows Credential Manager and never returned to React.">
          <div className="grid min-h-[64px] min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-[12px] p-[16px] @min-[36rem]/settings:grid-cols-[auto_minmax(0,1fr)_auto]">
            <LumenUiIcon className="text-accent" name="key" size="medium" />
            <div className="grid min-w-0 gap-[4px]">
              <LumenText weight="medium">Gemini API key</LumenText>
              <LumenText tone="tertiary" variant="meta">
                {health?.credentialConfigured ? 'A key is configured for this Windows account.' : 'No Gemini key is configured.'}
              </LumenText>
              <LumenTextField aria-label="Gemini API key" type="password" placeholder="Enter API key" value={credential} onChange={setCredential} />
            </div>
            <div className="col-span-full flex min-w-0 flex-wrap items-center gap-[8px] @min-[36rem]/settings:col-auto">
              <LumenButton size="small" variant="primary" onPress={() => void saveCredential()}>Save</LumenButton>
              <LumenButton size="small" variant="quiet" onPress={() => void deleteCredential()}>Delete</LumenButton>
            </div>
          </div>
        </SettingSection>
      ) : null}
      <SettingSection title="Cloud consent" description="Consent is device-local and can be revoked at any time.">
        <div className="grid min-h-[64px] min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-[12px] p-[16px] @min-[36rem]/settings:grid-cols-[auto_minmax(0,1fr)_auto]">
          <LumenUiIcon className="text-accent" name="success" size="medium" />
          <div className="grid min-w-0 gap-[4px]">
            <LumenText weight="medium">Browser task requests</LumenText>
            <LumenText tone="tertiary" variant="meta">The task, page URL, and screenshots are sent to Gemini. Passwords and payment details may be visible if you navigate to them.</LumenText>
          </div>
          {settings.cloudConsent ? (
            <div className="col-span-full flex min-w-0 flex-wrap items-center gap-[8px] @min-[36rem]/settings:col-auto">
              <StatusBadge tone="success">Consent granted</StatusBadge>
              <LumenButton size="small" variant="quiet" onPress={revokeConsent}>Revoke</LumenButton>
            </div>
          ) : (
            <ConfirmationDialog
              confirmLabel="Allow Computer Use"
              confirmVariant="primary"
              description="Gemini will receive your browser task, visited page URLs, and screenshots from a fresh Microsoft Edge session. Model-requested sensitive actions still require separate approval."
              title="Allow Gemini Computer Use?"
              onConfirm={grantConsent}
            >
              <LumenButton aria-label="Review Computer Use consent" className="col-span-full justify-self-start @min-[36rem]/settings:col-auto" size="small">Review consent</LumenButton>
            </ConfirmationDialog>
          )}
        </div>
      </SettingSection>
    </SettingsPage>
  );
}
