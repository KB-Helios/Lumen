import {useCallback, useEffect, useState} from 'react';
import {WindowsAgentControls} from '../../windows-ai/WindowsAiControls';
import {ImprovementGatewayControls} from '../../improvement/ImprovementControls';
import {useImprovementStore} from '../../improvement/improvement.store';

import {McpIcon} from '../../../design-system/icons/lumen-icons';
import {LumenUiIcon} from '../../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../../design-system/primitives/LumenButton';
import {LumenText} from '../../../design-system/primitives/LumenText';
import {GatewayStatusPanel} from '../../gateway/GatewayStatusPanel';
import {ProviderRegistryList} from '../../gateway/ProviderRegistryList';
import {useGatewayStore} from '../../gateway/gateway.store';
import {ProviderRouteList} from '../../gateway/ProviderRouteList';
import {ToolPermissionList} from '../../gateway/ToolPermissionList';
import {ConfirmationDialog} from '../components/ConfirmationDialog';
import {SettingSection} from '../components/SettingSection';
import {SettingsCallout, SettingsPage} from '../components/SettingsPage';
import {StatusBadge} from '../components/StatusBadge';
import {LumenSelect, LumenTextField} from '../components/SettingsControls';
import {useSettingsStore} from '../settings.store';
import {isNativeRuntime, nativeAiService, type EnrichmentHealth, type GatewayHealth} from '../../../services/ai/native-ai-service';
import {
  providerRegistryService,
  type ProviderId,
  type ProviderRegistrySnapshot,
  type ProviderRouteUpdate,
} from '../../../services/ai/provider-registry-service';
import {
  mcpService,
  toolAccessSchema,
  toolIdSchema,
  type McpRegistrySnapshot,
} from '../../../services/ai/mcp-service';

export function AgentGatewayPage({nativeRuntime}: {nativeRuntime?: boolean} = {}) {
  const gatewayState = useGatewayStore((state) => state.gatewayState);
  const routes = useGatewayStore((state) => state.routes);
  const services = useGatewayStore((state) => state.mcpServices);
  const permissions = useGatewayStore((state) => state.permissions);
  const actionMessage = useGatewayStore((state) => state.actionMessage);
  const restart = useGatewayStore((state) => state.restart);
  const setRouteProvider = useGatewayStore((state) => state.setRouteProvider);
  const setPermission = useGatewayStore((state) => state.setPermission);
  const testProvider = useGatewayStore((state) => state.testProvider);
  const testMcp = useGatewayStore((state) => state.testMcp);
  const cloudConsent = useSettingsStore((state) => state.ai.cloudAnswerConsent);
  const improvementCloudConsent = useImprovementStore((state) => state.snapshot.settings.cloudConsent);
  const runtimeMode = useSettingsStore((state) => state.ai.runtimeMode);
  const setCloudAnswerConsent = useSettingsStore((state) => state.setCloudAnswerConsent);
  const native = nativeRuntime ?? isNativeRuntime();
  const [health, setHealth] = useState<GatewayHealth>();
  const [enrichment, setEnrichment] = useState<EnrichmentHealth>();
  const [registry, setRegistry] = useState<ProviderRegistrySnapshot>();
  const [mcpRegistry, setMcpRegistry] = useState<McpRegistrySnapshot>();
  const [credential, setCredential] = useState('');
  const [credentialProvider, setCredentialProvider] = useState<ProviderId>('openai');
  const [nativeMessage, setNativeMessage] = useState('');
  const refresh = useCallback(async () => {
    if (!native) return;
    const [gateway, worker, providerRegistry, liveMcp] = await Promise.all([
      nativeAiService.gatewayHealth(),
      nativeAiService.enrichmentHealth(),
      providerRegistryService.list(),
      mcpService.list(),
    ]);
    setHealth(gateway);
    setEnrichment(worker);
    setRegistry(providerRegistry);
    setMcpRegistry(liveMcp);
  }, [native]);
  useEffect(() => {
    void refresh().catch((error: unknown) => setNativeMessage(String(error)));
  }, [refresh]);
  const changeCloudConsent = useCallback(async (granted: boolean) => {
    const saved = await setCloudAnswerConsent(granted);
    if (!saved) {
      setNativeMessage('Cloud consent was not changed because the device setting could not be saved.');
    } else if (native) {
      await refresh();
    }
  }, [native, refresh, setCloudAnswerConsent]);
  const grantCloudConsent = useCallback(() => {
    void changeCloudConsent(true);
  }, [changeCloudConsent]);
  const revokeCloudConsent = useCallback(async () => {
    if (runtimeMode === 'cloud') {
      const runtimeSaved = await useSettingsStore.getState().updateAi({runtimeMode: 'local'});
      if (!runtimeSaved) {
        setNativeMessage('Cloud consent was not changed because local mode could not be saved.');
        return;
      }
    }
    await changeCloudConsent(false);
  }, [changeCloudConsent, runtimeMode]);
  const restartGateway = async () => {
    if (!native) return restart();
    setNativeMessage('Restarting AgentGateway…');
    try {
      await nativeAiService.restartGateway();
      await refresh();
      setNativeMessage('AgentGateway restarted.');
    } catch (error) {
      setNativeMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const saveCredential = async () => {
    if (!credential.trim()) return;
    try {
      await nativeAiService.saveCredential(credentialProvider, credential);
      await nativeAiService.restartGateway();
      await refresh();
      setNativeMessage(`${registry?.providers.find((provider) => provider.id === credentialProvider)?.label ?? 'Provider'} credential saved in Windows Credential Manager.`);
    } catch (error) {
      setNativeMessage(`The provider credential could not be saved or activated: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCredential('');
    }
  };
  const deleteCredential = async () => {
    try {
      await nativeAiService.deleteCredential(credentialProvider);
      await refresh();
      setNativeMessage(`${registry?.providers.find((provider) => provider.id === credentialProvider)?.label ?? 'Provider'} credential removed.`);
    } catch (error) {
      setNativeMessage(`The provider credential may still be configured: ${error instanceof Error ? error.message : String(error)}`);
      await refresh().catch(() => undefined);
    }
  };
  const setNativeRoute = async (update: ProviderRouteUpdate) => {
    try {
      const result = await providerRegistryService.setRoute(update);
      setNativeMessage(result.message);
      await refresh();
    } catch (error) {
      setNativeMessage(error instanceof Error ? error.message : 'The provider route could not be changed.');
    }
  };
  const testNativeRoute = async (alias: string) => {
    try {
      setNativeMessage((await providerRegistryService.testRoute(alias)).message);
    } catch (error) {
      setNativeMessage(error instanceof Error ? error.message : 'The provider route could not be tested.');
    }
  };
  const setNativePermission = async (id: string, access: 'ask' | 'allow' | 'deny') => {
    const toolId = toolIdSchema.safeParse(id);
    const toolAccess = toolAccessSchema.safeParse(access);
    if (!toolId.success || !toolAccess.success) return;
    try {
      await mcpService.setPermission(toolId.data, toolAccess.data);
      setMcpRegistry(await mcpService.list());
      setNativeMessage('Tool permission applied.');
    } catch (error) {
      setNativeMessage(error instanceof Error ? error.message : 'The tool permission could not be changed.');
    }
  };

  return (
    <SettingsPage>
      <GatewayStatusPanel state={health?.state ?? gatewayState} onRestart={() => void restartGateway()} />
      <SettingsCallout>
        {health
          ? `AgentGateway ${health.version} · interactive 60 req/min and 100k tokens/hour · enrichment 10 req/min and 500k tokens/day.`
          : 'AgentGateway stays behind Rust IPC; the webview has no direct network route.'}
      </SettingsCallout>
      {nativeMessage || actionMessage ? <SettingsCallout>{nativeMessage || actionMessage}</SettingsCallout> : null}
      <SettingSection title="Virtual model routes" description="Stable aliases keep callers unchanged while providers change underneath.">
        {native ? registry ? (
          <ProviderRegistryList registry={registry} cloudConsent={cloudConsent} improvementCloudConsent={improvementCloudConsent} onSet={setNativeRoute} onTest={testNativeRoute} />
        ) : <div className="p-[16px]"><LumenText tone="tertiary" variant="meta">Loading provider registry…</LumenText></div>
          : <ProviderRouteList routes={routes} onChange={setRouteProvider} onTest={(id) => void testProvider(id)} />}
      </SettingSection>
      {native && registry ? (
        <SettingSection title="Provider credential" description="The value is written directly to Windows Credential Manager and never returned to React.">
          <div className="grid min-h-[64px] min-w-0 grid-cols-[minmax(0,1fr)] items-center gap-[12px] border-b border-border-subtle p-[16px] last:border-b-0 @min-[36rem]/settings:grid-cols-[minmax(0,.55fr)_minmax(0,1fr)_auto]">
            <LumenSelect<ProviderId>
              aria-label="Credential provider"
              options={registry.providers.filter((provider) => provider.cloud).map((provider) => ({id: provider.id, label: provider.label}))}
              value={credentialProvider}
              onChange={setCredentialProvider}
            />
            <LumenTextField aria-label="Provider API key" type="password" placeholder="API key" value={credential} onChange={setCredential} />
            <div className="flex min-w-0 flex-wrap items-center gap-[8px]">
              <LumenButton size="small" variant="primary" onPress={() => void saveCredential()}>Save</LumenButton>
              <LumenButton size="small" variant="quiet" onPress={() => void deleteCredential()}>Delete</LumenButton>
            </div>
          </div>
        </SettingSection>
      ) : null}
      <SettingSection title="Cloud consent" description="Cloud routes stay unavailable until this device records explicit consent.">
        <div className="grid min-h-[64px] min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-[12px] border-b border-border-subtle p-[16px] last:border-b-0 @min-[36rem]/settings:grid-cols-[auto_minmax(0,1fr)_auto]">
          <LumenUiIcon className="text-accent" name="success" size="medium" />
          <div className="grid min-w-0 gap-[4px]">
            <LumenText weight="medium">Provider requests</LumenText>
            <LumenText tone="tertiary" variant="meta">Search queries, filenames, and relevant indexed excerpts may leave this device after consent.</LumenText>
          </div>
          {cloudConsent ? (
            <div className="col-span-full flex min-w-0 flex-wrap items-center gap-[8px] @min-[36rem]/settings:col-auto">
              <StatusBadge tone="success">Cloud consent granted</StatusBadge>
              <LumenButton size="small" variant="quiet" onPress={() => void revokeCloudConsent()}>Revoke</LumenButton>
            </div>
          ) : (
            <ConfirmationDialog
              confirmLabel="Allow cloud requests"
              confirmVariant="primary"
              description="Cloud answers may send the current search query and relevant local index excerpts, including filenames, to the configured provider. Local mode remains on this PC."
              title="Allow cloud provider requests?"
              onConfirm={grantCloudConsent}
            >
              <LumenButton aria-label="Review cloud consent" className="col-span-full justify-self-start @min-[36rem]/settings:col-auto" size="small">Review consent</LumenButton>
            </ConfirmationDialog>
          )}
        </div>
      </SettingSection>
      {native && mcpRegistry ? (
        <>
          <SettingSection title="MCP services" description="Local services and tool counts reported by the native executor.">
            {mcpRegistry.services.map((service) => (
              <div key={service.id} className="grid min-h-[64px] min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-[12px] border-b border-border-subtle p-[16px] last:border-b-0 @min-[36rem]/settings:grid-cols-[auto_minmax(0,1fr)_auto]">
                <McpIcon className="text-accent" size={20} />
                <div className="grid min-w-0 gap-[4px]">
                  <LumenText weight="medium">{service.name}</LumenText>
                  <LumenText tone="tertiary" variant="meta">{service.tools.length} confined local tools</LumenText>
                </div>
                <div className="col-span-full @min-[36rem]/settings:col-auto"><StatusBadge tone={service.status === 'connected' ? 'success' : 'warning'}>{service.status === 'connected' ? 'Connected' : 'Unavailable'}</StatusBadge></div>
              </div>
            ))}
          </SettingSection>
          <SettingSection title="Tool permissions" description="Permissions are enforced by the native executor for every invocation.">
            <ToolPermissionList permissions={mcpRegistry.permissions} onChange={(id, access) => void setNativePermission(id, access)} />
          </SettingSection>
        </>
      ) : null}
      {native ? (
        <SettingSection title="Durable enrichment queue" description="Rivet Actors owns idempotent OCR and transcription job leases when its Windows engine is healthy.">
          <div className="grid min-h-[64px] min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-[12px] border-b border-border-subtle p-[16px] last:border-b-0 @min-[36rem]/settings:grid-cols-[auto_minmax(0,1fr)_auto]">
            <LumenUiIcon className="text-accent" name="connect" size="medium" />
            <div className="grid min-w-0 gap-[4px]">
              <LumenText weight="medium">Rivet worker</LumenText>
              <LumenText tone="tertiary" variant="meta">{enrichment?.detail ?? (enrichment?.paused ? 'Queue paused' : 'Loopback-only worker')}</LumenText>
            </div>
            <div className="col-span-full flex min-w-0 flex-wrap items-center gap-[8px] @min-[36rem]/settings:col-auto">
              <StatusBadge tone={enrichment?.state === 'ready' ? 'success' : 'warning'}>{enrichment?.state ?? 'Checking'}</StatusBadge>
              <LumenButton size="small" variant="quiet" onPress={() => void (enrichment?.paused ? nativeAiService.resumeEnrichment() : nativeAiService.pauseEnrichment()).then(refresh)}>{enrichment?.paused ? 'Resume' : 'Pause'}</LumenButton>
            </div>
          </div>
        </SettingSection>
      ) : null}
      {!native ? (
        <>
          <SettingSection title="MCP services" description="Development previews for service and tool-count states.">
            {services.map((service) => (
              <div key={service.id} className="grid min-h-[64px] min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-[12px] border-b border-border-subtle p-[16px] last:border-b-0 @min-[36rem]/settings:grid-cols-[auto_minmax(0,1fr)_auto]">
                <McpIcon className="text-accent" size={20} />
                <div className="grid min-w-0 gap-[4px]">
                  <LumenText weight="medium">{service.name}</LumenText>
                  <LumenText tone="tertiary" variant="meta">
                    {service.status === 'connected' ? `${service.toolCount} preview tools` : service.status === 'testing' ? 'Testing preview…' : 'Service unavailable'}
                  </LumenText>
                </div>
                <LumenButton aria-label={`Test ${service.name}`} className="col-span-full justify-self-start @min-[36rem]/settings:col-auto" size="small" variant="quiet" onPress={() => void testMcp(service.id)}>Test</LumenButton>
              </div>
            ))}
          </SettingSection>
          <SettingSection title="Tool permissions" description="Development preview of local tool policies.">
            <ToolPermissionList permissions={permissions} onChange={setPermission} />
          </SettingSection>
        </>
      ) : null}
      <WindowsAgentControls />
      <ImprovementGatewayControls />
    </SettingsPage>
  );
}
