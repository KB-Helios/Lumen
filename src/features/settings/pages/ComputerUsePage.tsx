import {useCallback, useEffect, useState} from 'react';
import {LumenUiIcon} from '../../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../../design-system/primitives/LumenButton';
import {LumenText} from '../../../design-system/primitives/LumenText';
import {isNativeRuntime, nativeAiService} from '../../../services/ai/native-ai-service';
import {TauriComputerUseService} from '../../../services/computer-use/tauri-computer-use-service';
import {computerUseModels, computerUseWebUrlSchema, unavailableComputerUseHealth, type ComputerUseHealth} from '../../../services/computer-use/computer-use.types';
import {ConfirmationDialog} from '../components/ConfirmationDialog';
import {SettingRow} from '../components/SettingRow';
import {SettingSection} from '../components/SettingSection';
import {LumenSelect, LumenTextField} from '../components/SettingsControls';
import {SettingsCallout, SettingsPage} from '../components/SettingsPage';
import {StatusBadge} from '../components/StatusBadge';
import {useSettingsStore} from '../settings.store';

const computerUseService = new TauriComputerUseService();
type Consent = 'cloudConsent' | 'desktopControlConsent' | 'desktopCloudConsent';
const consentRows: Array<{consent: Consent; label: string; description: string; reviewLabel: string; confirmLabel: string; title: string}> = [
  {consent: 'cloudConsent', label: 'Browser task requests', description: 'Your task, page URLs, browser content and requested screenshots go to the selected provider from a fresh Edge context.', reviewLabel: 'Review Computer Use consent', confirmLabel: 'Allow Computer Use', title: 'Allow browser Computer Use?'},
  {consent: 'desktopControlConsent', label: 'Selected-window control', description: 'Allow native input only in an explicitly selected, revalidated Windows window. Foreground input requires a separate one-time approval in Fast mode.', reviewLabel: 'Review desktop control consent', confirmLabel: 'Allow selected-window control', title: 'Allow selected-window control?'},
  {consent: 'desktopCloudConsent', label: 'Desktop cloud observations', description: 'Your task, selected-window text, accessible controls and requested screenshots go to the selected provider. Sensitive information may be visible.', reviewLabel: 'Review desktop cloud consent', confirmLabel: 'Allow desktop observations', title: 'Allow desktop cloud observations?'},
];

export function ComputerUsePage() {
  const settings = useSettingsStore((state) => state.computerUse);
  const updateComputerUse = useSettingsStore((state) => state.updateComputerUse);
  const setComputerUseConsent = useSettingsStore((state) => state.setComputerUseConsent);
  const native = isNativeRuntime();
  const [health, setHealth] = useState<ComputerUseHealth>();
  const [credential, setCredential] = useState('');
  const [initialUrl, setInitialUrl] = useState(settings.initialUrl);
  const [message, setMessage] = useState('');
  const provider = settings.provider;
  const providerLabel = provider === 'openai' ? 'OpenAI' : 'Gemini';
  const model = provider === 'openai' ? settings.openaiModel : settings.model;
  const reviewedModels = health?.providers[provider].models ?? (provider === 'openai' ? ['gpt-6.1-sol'] : [...computerUseModels]);
  const unsupportedModel = !reviewedModels.includes(model);
  const modelOptions = [...reviewedModels, ...(unsupportedModel ? [model] : [])].map((id) => ({id, label: id === model && unsupportedModel ? `${id} · Unavailable` : id}));
  const refresh = useCallback(async () => {
    setHealth(native ? await computerUseService.health() : unavailableComputerUseHealth('Native Computer Use and desktop control are unavailable in this browser preview.'));
  }, [native]);
  useEffect(() => {void refresh().catch((error: unknown) => {setHealth(unavailableComputerUseHealth(String(error))); setMessage(String(error));});}, [refresh]);
  useEffect(() => {setInitialUrl(settings.initialUrl);}, [settings.initialUrl]);
  useEffect(() => {setCredential('');}, [provider]);

  const saveCredential = async () => {
    if (!credential.trim()) return;
    const selectedProvider = provider;
    try {
      await nativeAiService.saveCredential(selectedProvider, credential);
      await refresh();
      setMessage(`${providerLabel} API key saved in Windows Credential Manager.`);
    } catch (error) {setMessage(`The ${providerLabel} credential could not be saved: ${error instanceof Error ? error.message : String(error)}`);}
    finally {setCredential('');}
  };
  const deleteCredential = async () => {
    try {
      await nativeAiService.deleteCredential(provider);
      await refresh();
      setMessage(`${providerLabel} API key removed.`);
    } catch (error) {
      setMessage(`The ${providerLabel} credential may still be configured: ${error instanceof Error ? error.message : String(error)}`);
      await refresh().catch(() => undefined);
    }
  };
  const saveInitialUrl = async () => {
    if (!computerUseWebUrlSchema.safeParse(initialUrl).success) {setMessage('The start page must be an absolute HTTP or HTTPS URL.'); return;}
    setMessage(await updateComputerUse({initialUrl}) ? 'Computer Use start page saved.' : 'Computer Use start page could not be saved.');
  };
  const changeConsent = async (consent: Consent, granted: boolean) => {
    const saved = await setComputerUseConsent(granted, consent);
    if (!saved) setMessage(granted ? 'Consent could not be saved. Access has not been granted.' : 'Access was withdrawn locally, but the revocation could not be saved. Native warm-scope closure is not confirmed.');
    else if (!granted) setMessage('Consent revoked. Active tasks using this grant are stopped.');
  };
  return <SettingsPage>
    <SettingsCallout>Computer Use works in a fresh Edge context or a selected Windows window. Provider keys stay in Windows Credential Manager. Browser cloud, desktop control and desktop cloud observations each need separate consent.</SettingsCallout>
    {message ? <SettingsCallout>{message}</SettingsCallout> : null}
    <SettingSection title="Runtime" description="Native Lumen supervises a fixed executor. Ctrl + Alt + Esc closes native input admission; Alt + Space shows Lumen.">
      <SettingRow label="Computer Use worker" description={health?.detail ?? 'Checking native availability…'} status={<StatusBadge tone={health?.state === 'ready' ? 'success' : 'warning'}>{health?.state ?? 'Checking'}</StatusBadge>}>
        <LumenButton size="small" variant="quiet" onPress={() => void refresh().catch((error: unknown) => setMessage(String(error)))}><LumenUiIcon name="computer" size="small" /> Check</LumenButton>
      </SettingRow>
      <SettingRow label="Provider" description={health?.providers[provider].reason ?? 'Each provider keeps its own saved model selection.'}>
        <LumenSelect aria-label="Computer Use provider" options={[{id: 'gemini', label: 'Gemini'}, {id: 'openai', label: 'OpenAI'}]} value={provider} onChange={(value) => void updateComputerUse({provider: value})} />
      </SettingRow>
      <SettingRow label={`${providerLabel} model`} description={unsupportedModel ? `Saved model ${model} is unavailable for Computer Use. Choose a reviewed model.` : 'Only reviewed model IDs reported by native health can start a task.'}>
        <LumenSelect aria-label="Computer Use model" options={modelOptions} value={model} onChange={(value) => void updateComputerUse(provider === 'openai' ? {openaiModel: value} : {model: value})} />
      </SettingRow>
      <SettingRow label="Execution mode" description="Fast asks once before foreground input. Background refuses actions it cannot deliver without disturbing your work.">
        <LumenSelect aria-label="Computer Use execution mode" options={[{id: 'fast', label: 'Fast'}, {id: 'background', label: 'Background'}]} value={settings.executionMode} onChange={(executionMode) => void updateComputerUse({executionMode})} />
      </SettingRow>
      <SettingRow label="Browser route" description={health?.routes.browser.reason ?? 'Fresh Microsoft Edge context; headless by default.'} status={<StatusBadge tone={health?.routes.browser.available ? 'success' : 'warning'}>{health?.routes.browser.available ? 'Available' : 'Unavailable'}</StatusBadge>}>{null}</SettingRow>
      <SettingRow label="Desktop route" description={health?.routes.desktop.reason ?? 'Select a current native window in the workspace. Window identities are never saved.'} status={<StatusBadge tone={health?.routes.desktop.available ? 'success' : 'warning'}>{health?.routes.desktop.available ? 'Available' : 'Unavailable'}</StatusBadge>}>{null}</SettingRow>
      <SettingRow label="Start page" description="Each browser task starts in a fresh Edge context at this HTTP or HTTPS address.">
        <div className="grid min-w-0 w-[300px] max-w-full grid-cols-[minmax(0,1fr)] gap-[8px] @min-[36rem]/settings:grid-cols-[minmax(0,1fr)_auto]">
          <LumenTextField aria-label="Computer Use start page" value={initialUrl} onChange={setInitialUrl} />
          <LumenButton className="justify-self-start" size="small" variant="quiet" onPress={() => void saveInitialUrl()}>Save</LumenButton>
        </div>
      </SettingRow>
    </SettingSection>
    {native ? <SettingSection title={`${providerLabel} credential`} description="The secret is written directly to Windows Credential Manager and never returned to React.">
      <div className="grid min-h-[64px] min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-[12px] p-[16px] @min-[36rem]/settings:grid-cols-[auto_minmax(0,1fr)_auto]">
        <LumenUiIcon className="text-accent" name="key" size="medium" />
        <div className="grid min-w-0 gap-[4px]">
          <LumenText weight="medium">{providerLabel} API key</LumenText>
          <LumenText tone="tertiary" variant="meta">{health?.providers[provider].credentialConfigured ? 'A key is configured for this Windows account.' : `No ${providerLabel} key is configured.`}</LumenText>
          <LumenTextField aria-label={`${providerLabel} API key`} type="password" placeholder="Enter API key" value={credential} onChange={setCredential} />
        </div>
        <div className="col-span-full flex min-w-0 flex-wrap items-center gap-[8px] @min-[36rem]/settings:col-auto">
          <LumenButton aria-label={`Save ${providerLabel} key`} size="small" variant="primary" onPress={() => void saveCredential()}>Save</LumenButton>
          <LumenButton aria-label={`Delete ${providerLabel} key`} size="small" variant="quiet" onPress={() => void deleteCredential()}>Delete</LumenButton>
        </div>
      </div>
    </SettingSection> : null}
    <SettingSection title="Computer Use consent" description="Grants are saved on this device before they take effect. Revoking a grant stops active tasks and closes warm native permission scopes.">
      {consentRows.map((row) => <SettingRow key={row.consent} label={row.label} description={row.description}>
        {settings[row.consent] ? <>
          <StatusBadge tone="success">Consent granted</StatusBadge>
          <LumenButton aria-label={`Revoke ${row.label.toLowerCase()} consent`} size="small" variant="quiet" onPress={() => void changeConsent(row.consent, false)}>Revoke</LumenButton>
        </> : <ConfirmationDialog confirmLabel={row.confirmLabel} confirmVariant="primary" description={row.description} title={row.title} onConfirm={() => void changeConsent(row.consent, true)}>
          <LumenButton aria-label={row.reviewLabel} size="small">Review consent</LumenButton>
        </ConfirmationDialog>}
      </SettingRow>)}
    </SettingSection>
  </SettingsPage>;
}
