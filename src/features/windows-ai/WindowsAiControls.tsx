import {useEffect, useRef, useState} from 'react';
import {LumenButton} from '../../design-system/primitives/LumenButton';
import {LumenText} from '../../design-system/primitives/LumenText';
import {windowsAiService} from '../../services/windows-ai';
import {canUseWindowsAiFeature, defaultWindowsAiPreferences, type WindowsAiFeature, type WindowsAiPreferences} from '../../services/windows-ai/windows-ai.types';
import {ConfirmationDialog} from '../settings/components/ConfirmationDialog';
import {SettingRow} from '../settings/components/SettingRow';
import {SettingSection} from '../settings/components/SettingSection';
import {LumenSelect, LumenSwitch, LumenTextField} from '../settings/components/SettingsControls';
import {SettingsCallout} from '../settings/components/SettingsPage';
import {StatusBadge} from '../settings/components/StatusBadge';
import {useWindowsAiStore} from './windows-ai.store';

const availabilityLabels: Record<WindowsAiFeature['availability'], string> = {ready: 'Ready', downloadable: 'Download available', preparing: 'Preparing', unavailable: 'Unavailable', accessRequired: 'Access required', identityRequired: 'Package identity required', runtimeRequired: 'Runtime required', unsupported: 'Unsupported', disabled: 'Off', failed: 'Failed'};
const availabilityDetails: Record<WindowsAiFeature['availability'], string> = {ready: 'Available in this host. Enable its permission to use it.', downloadable: 'Prepare the supported model after allowing downloads in Privacy.', preparing: 'The host is preparing this capability.', unavailable: 'The required service or local model is unavailable.', accessRequired: 'Microsoft access setup is required for this preview model.', identityRequired: 'Install the optional signed Lumen identity package to use this feature.', runtimeRequired: 'Install the required Windows runtime or update Windows, then refresh.', unsupported: 'This device or host cannot run this API.', disabled: 'Enable the corresponding permission or review Windows policy.', failed: 'The capability check failed. Refresh after completing setup.'};
function useControls() {
  const state = useWindowsAiStore();
  return {...state, preferences: state.snapshot?.preferences ?? defaultWindowsAiPreferences, disabled: state.busy || !state.snapshot};
}
function Preference({label, description, field}: {label: string; description: string; field: keyof Pick<WindowsAiPreferences, 'windowsEnabled' | 'edgeEnabled' | 'textToolsEnabled' | 'modelDownloadsAllowed' | 'dictationEnabled' | 'ocrEnabled' | 'imageDescriptionsEnabled' | 'keepWarm' | 'appContentEnabled' | 'agentsEnabled'>}) {
  const {preferences, disabled, update} = useControls();
  return <SettingRow label={label} description={description}><LumenSwitch aria-label={label} isDisabled={disabled} isSelected={preferences[field]} onChange={(enabled) => void update({[field]: enabled})} /></SettingRow>;
}
export function WindowsAiNotice() {
  const message = useWindowsAiStore((state) => state.message);
  return message ? <SettingsCallout><span role="status">{message}</span></SettingsCallout> : null;
}
function FeatureRow({feature}: {feature: WindowsAiFeature}) {
  const {preferences, busy, run, refresh} = useControls();
  const [progress, setProgress] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const prepare = () => void run(async () => {
    abort.current = new AbortController();
    setProgress('Starting preparation…');
    try {
      await windowsAiService.prepare(feature.id, `prepare-${crypto.randomUUID()}`, (event) => {
        if (event.type === 'progress') setProgress(`${event.phase}${event.progress === null ? '' : ` ${Math.round(event.progress * 100)}%`}`);
      }, abort.current.signal);
      await refresh();
    } finally { abort.current = null; setProgress(''); }
  });
  return <SettingRow label={feature.label} description={feature.detail ?? availabilityDetails[feature.availability]} status={<StatusBadge tone={feature.availability === 'ready' && feature.enabled ? 'success' : feature.availability === 'failed' ? 'error' : 'warning'}>{availabilityLabels[feature.availability]}</StatusBadge>}>
    {progress ? <div className="grid gap-1"><LumenText variant="meta" role="status">{progress}</LumenText><LumenButton size="small" variant="quiet" onPress={() => abort.current?.abort()}>Cancel</LumenButton></div> : feature.availability === 'downloadable' ? <ConfirmationDialog title={`Prepare ${feature.label}?`} description="Windows or the current Edge host may download a local model. Preparation can use network, storage, and power. No model is downloaded by checking availability." confirmLabel="Prepare model" confirmVariant="primary" onConfirm={prepare}><LumenButton aria-label={`Prepare ${feature.label}`} isDisabled={busy || !feature.enabled || !preferences.modelDownloadsAllowed} size="small">Prepare</LumenButton></ConfirmationDialog> : null}
  </SettingRow>;
}

export function WindowsLocalAiControls() {
  const {snapshot, preferences, disabled, busy, refresh, run} = useControls();
  const [token, setToken] = useState('');
  const [testResult, setTestResult] = useState('');
  const [testing, setTesting] = useState(false);
  const testAbort = useRef<AbortController | null>(null);
  useEffect(() => () => testAbort.current?.abort(), []);
  const features = snapshot?.features.filter((feature) => ['languageModel', 'aion', 'summarize', 'rewrite', 'ocr', 'imageDescription', 'edgePrompt', 'edgeSummarize', 'edgeWrite', 'edgeRewrite', 'edgeTranslation', 'edgeLanguageDetection', 'edgeSpeech'].includes(feature.id)) ?? [];
  const test = () => void run(async () => {
    const engine = preferences.localEngine === 'auto' ? 'windows' : preferences.localEngine;
    if (engine === 'runtime') throw new Error('Choose Windows, Aion, or Edge to test an integration.');
    testAbort.current = new AbortController();
    setTesting(true);
    setTestResult('');
    try {
      const result = await windowsAiService.text({requestId: `test-${crypto.randomUUID()}`, engine, task: 'answer', text: 'Say hello in one sentence.'}, undefined, testAbort.current.signal);
      setTestResult(result.text.slice(0, 600));
    } finally { testAbort.current = null; setTesting(false); }
  });
  const ready = canUseWindowsAiFeature(features.find((item) => item.id === (preferences.localEngine === 'aion' ? 'aion' : preferences.localEngine === 'edge' ? 'edgePrompt' : 'languageModel')));
  return <>
    <WindowsAiNotice />
    <SettingSection title="Windows and Edge AI" description="Preview availability is checked for this device and the current web host. Local file search works independently.">
      <Preference label="Windows AI" description="Allow supported Windows APIs to run on explicit requests." field="windowsEnabled" />
      <Preference label="Edge on-device APIs" description="Use APIs exposed by this web host. An installed Edge browser does not establish WebView2 support." field="edgeEnabled" />
      <SettingRow label="Local answer engine" description="Automatic uses a ready Windows model, then the existing local runtime. A selected unavailable engine reports its reason."><LumenSelect aria-label="Local answer engine" isDisabled={disabled} value={preferences.localEngine} options={[{id: 'auto', label: 'Automatic'}, {id: 'runtime', label: 'Local runtime'}, {id: 'windows', label: 'Windows AI'}, {id: 'aion', label: 'Aion preview'}, {id: 'edge', label: 'Edge host'}]} onChange={(localEngine) => void useWindowsAiStore.getState().update({localEngine})} /></SettingRow>
      <Preference label="Keep Windows model warm" description="Retain supported native sessions after requests. Turning this off releases idle sessions." field="keepWarm" />
      {features.map((feature) => <FeatureRow key={feature.id} feature={feature} />)}
      <div className="flex flex-wrap gap-3 p-5"><LumenButton aria-label="Refresh Windows AI availability" size="small" isDisabled={busy} onPress={() => void run(refresh)}>Refresh availability</LumenButton>{testing ? <LumenButton size="small" variant="quiet" onPress={() => testAbort.current?.abort()}>Cancel test</LumenButton> : <LumenButton aria-label="Test selected AI engine" size="small" variant="quiet" isDisabled={disabled || !ready || preferences.localEngine === 'runtime'} onPress={test}>Test engine</LumenButton>}</div>
      {testResult ? <div className="p-5 pt-0"><LumenText role="status">{testResult}</LumenText></div> : null}
    </SettingSection>
    <SettingSection title="Preview setup" description="Phi Silica may require a Microsoft Limited Access Feature token. Aion native preview requires ARM64 Snapdragon hardware and its separately installed framework.">
      <SettingRow label="Windows language model access" description={snapshot?.accessTokenConfigured ? 'A token is saved in the native credential store.' : 'No access token configured.'}><div className="grid gap-2"><LumenTextField aria-label="Windows AI access token" type="password" value={token} onChange={setToken} /><div className="flex gap-2"><LumenButton isDisabled={disabled || !token.trim()} size="small" onPress={() => void run(async () => { try { useWindowsAiStore.setState({snapshot: await windowsAiService.setAccessToken(token.trim())}); } finally { setToken(''); } }, 'Access token saved.')}>Save token</LumenButton><LumenButton size="small" variant="quiet" isDisabled={disabled || !snapshot?.accessTokenConfigured} onPress={() => void run(async () => { useWindowsAiStore.setState({snapshot: await windowsAiService.setAccessToken('')}); }, 'Access token removed.')}>Remove token</LumenButton></div></div></SettingRow>
      <div className="flex flex-wrap gap-3 p-5 text-sm text-accent"><a className="underline focus-visible:ring-2 focus-visible:ring-focus" href="https://learn.microsoft.com/en-us/windows/ai/apis/" target="_blank" rel="noreferrer">Windows API requirements</a><a className="underline focus-visible:ring-2 focus-visible:ring-focus" href="https://github.com/microsoft/Aion-Instruct-Preview-Sample/releases/tag/v1.0.0.0" target="_blank" rel="noreferrer">Aion framework setup</a></div>
    </SettingSection>
  </>;
}

export function WindowsPrivacyControls() {
  const {preferences, disabled, update} = useControls();
  return <>
    <WindowsAiNotice />
    <SettingSection title="On-device AI permissions" description="These permissions are independent of cloud provider consent. File tools run only when you request them for a confined preview.">
      <Preference label="Allow local model downloads" description="Allow Prepare actions to download models. Enabling this permission does not start a download." field="modelDownloadsAllowed" />
      <Preference label="Local text tools" description="Allow summaries, rewrites, writing, translation, and language detection for text you select." field="textToolsEnabled" />
      <Preference label="Local image OCR" description="Allow Windows OCR on the selected image within indexed roots." field="ocrEnabled" />
      <Preference label="Local image descriptions" description="Allow Windows image descriptions on a selected image." field="imageDescriptionsEnabled" />
      <Preference label="Local microphone dictation" description="Allow a user-started local speech session. The host asks for microphone permission. No cloud speech fallback is used." field="dictationEnabled" />
      <SettingRow label="Translation source"><LumenSelect aria-label="Translation source" isDisabled={disabled} value={preferences.sourceLanguage} options={[{id: 'en', label: 'English'}, {id: 'sv', label: 'Swedish'}, {id: 'de', label: 'German'}, {id: 'fr', label: 'French'}, {id: 'es', label: 'Spanish'}]} onChange={(sourceLanguage) => void update({sourceLanguage})} /></SettingRow>
      <SettingRow label="Translation target"><LumenSelect aria-label="Translation target" isDisabled={disabled} value={preferences.targetLanguage} options={[{id: 'en', label: 'English'}, {id: 'sv', label: 'Swedish'}, {id: 'de', label: 'German'}, {id: 'fr', label: 'French'}, {id: 'es', label: 'Spanish'}]} onChange={(targetLanguage) => void update({targetLanguage})} /></SettingRow>
      <SettingRow label="Dictation language"><LumenSelect aria-label="Dictation language" isDisabled={disabled} value={preferences.speechLanguage} options={[{id: 'en-US', label: 'English (US)'}, {id: 'sv-SE', label: 'Swedish'}, {id: 'de-DE', label: 'German'}, {id: 'fr-FR', label: 'French'}, {id: 'es-ES', label: 'Spanish'}]} onChange={(speechLanguage) => void update({speechLanguage})} /></SettingRow>
    </SettingSection>
  </>;
}

export function WindowsAppContentControls() {
  const {snapshot, disabled, run, refresh} = useControls();
  const feature = snapshot?.features.find((item) => item.id === 'appContentSearch');
  const action = (operation: () => Promise<{ok: boolean; message: string}>) => void run(async () => { const result = await operation(); if (!result.ok) throw new Error(result.message); await refresh(); useWindowsAiStore.setState({message: result.message}); });
  return <>
    <WindowsAiNotice />
    <SettingSection title="Lumen app content" description="Search the shipped public help and action catalogue. Personal file contents are kept in Lumen's confined SQLite index.">
      <Preference label="Search Lumen app content" description="Include public help in All results and show the App content scope. Keyword search remains available without Windows semantic indexing." field="appContentEnabled" />
      {feature ? <FeatureRow feature={feature} /> : null}
      <SettingRow label="Public content index" description={`${snapshot?.appIndex.items ?? 0} public items; ${snapshot?.appIndex.state ?? 'checking'}.`}><div className="flex gap-2"><LumenButton size="small" isDisabled={disabled || !canUseWindowsAiFeature(feature)} onPress={() => action(() => windowsAiService.rebuildContent())}>Rebuild help index</LumenButton><ConfirmationDialog title="Delete the public help index?" description="Delete only Lumen's Windows public-content index. Your selected folders and file index are unaffected." confirmLabel="Delete help index" onConfirm={() => action(() => windowsAiService.deleteContent())}><LumenButton size="small" variant="danger" isDisabled={disabled || !snapshot?.host.packageIdentity}>Delete help index</LumenButton></ConfirmationDialog></div></SettingRow>
    </SettingSection>
  </>;
}

export function WindowsAgentControls() {
  const {snapshot, preferences, disabled, run, refresh} = useControls();
  const registration = snapshot?.features.find((item) => item.id === 'agentRegistration');
  const discovery = snapshot?.features.find((item) => item.id === 'agentDiscovery');
  return <>
    <WindowsAiNotice />
    <SettingSection title="Windows agent launchers" description="Discover installed agent actions. Invoking an agent sends your explicit prompt to that application, which applies its own data policy.">
      <Preference label="Windows agents" description="Allow explicit discovery and invocation of installed Windows agent launchers." field="agentsEnabled" />
      {discovery ? <FeatureRow feature={discovery} /> : null}
      {registration ? <FeatureRow feature={registration} /> : null}
      <SettingRow label="Register Lumen browser agent" description="Requires the optional signed package identity. Incoming prompts open as drafts; browser execution still requires consent and your Run action."><LumenSwitch aria-label="Register Lumen browser agent" isDisabled={disabled || !snapshot?.host.packageIdentity} isSelected={preferences.registerLumenAgent} onChange={(enabled) => void run(async () => { useWindowsAiStore.setState({snapshot: await windowsAiService.setRegistration(enabled)}); })} /></SettingRow>
      <div className="grid gap-3 p-5"><LumenButton aria-label="Discover Windows agents" isDisabled={disabled || !preferences.agentsEnabled || !canUseWindowsAiFeature(discovery)} size="small" onPress={() => void run(async () => { const agents = await windowsAiService.discoverAgents(); await refresh(); const current = useWindowsAiStore.getState().snapshot; if (current) useWindowsAiStore.setState({snapshot: {...current, agents}}); }, 'Windows agent catalogue refreshed.')}>Refresh installed agents</LumenButton>
        {(snapshot?.agents ?? []).map((agent) => <div key={agent.id} className="grid gap-1 rounded-control border border-border-subtle p-3"><LumenText weight="medium">{agent.displayName}</LumenText><LumenText tone="secondary" variant="meta">{agent.description}</LumenText></div>)}
        <LumenText tone="tertiary" variant="caption">Use the optional signed Lumen identity package to enable registration. <a className="underline focus-visible:ring-2 focus-visible:ring-focus" href="https://learn.microsoft.com/en-us/windows/ai/agent-launchers/" target="_blank" rel="noreferrer">Windows agent requirements</a></LumenText>
      </div>
    </SettingSection>
  </>;
}

export function WindowsAiDiagnostics() {
  const {snapshot, disabled, run, refresh} = useControls();
  return <SettingSection title="Windows AI diagnostics" description="Readiness checks do not start inference, downloads, indexing, or microphone capture."><SettingRow label="Host" description={`${snapshot?.host.osBuild ?? 'Checking'} · ${snapshot?.host.architecture ?? 'unknown'}`}><StatusBadge tone={snapshot?.host.packageIdentity ? 'success' : 'warning'}>{snapshot?.host.packageIdentity ? 'Package identity active' : 'No package identity'}</StatusBadge></SettingRow><SettingRow label="Runtime" description={snapshot?.host.runtimeVersion ?? 'Not reported'}><LumenText variant="meta">{snapshot?.host.npuProviders.join(', ') || 'No ready NPU provider reported'}</LumenText></SettingRow>{snapshot?.features.map((feature) => <FeatureRow key={feature.id} feature={feature} />)}<div className="p-5"><LumenButton aria-label="Refresh integration diagnostics" isDisabled={disabled} size="small" onPress={() => void run(refresh)}>Refresh integrations</LumenButton></div><WindowsAiNotice /></SettingSection>;
}
