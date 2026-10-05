import {useCallback, useEffect, useState} from 'react';
import {WindowsLocalAiControls} from '../../windows-ai/WindowsAiControls';

import {ProgressBar} from 'react-aria-components';

import {LocalAiIcon, NpuIcon} from '../../../design-system/icons/lumen-icons';
import {LumenUiIcon} from '../../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../../design-system/primitives/LumenButton';
import {LumenText} from '../../../design-system/primitives/LumenText';
import {useGatewayStore} from '../../gateway/gateway.store';
import type {HardwareState, LocalAiViewModel, ModelState} from '../../gateway/gateway.types';
import {SettingRow} from '../components/SettingRow';
import {SettingSection} from '../components/SettingSection';
import {SettingsCallout, SettingsPage} from '../components/SettingsPage';
import {StatusBadge} from '../components/StatusBadge';
import {LumenSwitch} from '../components/SettingsControls';
import {useSettingsStore} from '../settings.store';
import {isNativeRuntime, nativeAiService, type LocalRuntimeHealth} from '../../../services/ai/native-ai-service';
import {
  provisioningService as defaultProvisioningService,
  type ProvisioningService,
  type ProvisioningStatus,
} from '../../../services/ai/provisioning-service';

const hardwareCopy: Record<HardwareState, {label: string; description: string; icon: React.ReactNode; tone: 'success' | 'info' | 'warning'}> = {
  npu: {label: 'Copilot+ NPU detected', description: 'Local inference can prefer the neural processor.', icon: <NpuIcon size={28} />, tone: 'success'},
  gpu: {label: 'GPU detected', description: 'A compatible graphics path is available for local inference.', icon: <LumenUiIcon name="hardware" size="large" />, tone: 'success'},
  cpu: {label: 'CPU fallback', description: 'Local inference can remain available at a lower throughput.', icon: <LumenUiIcon name="hardware" size="large" />, tone: 'info'},
  unavailable: {label: 'Provider unavailable', description: 'The local runtime is not installed or is not responding.', icon: <LumenUiIcon name="error" size="large" />, tone: 'warning'},
};

const modelCopy: Record<ModelState, {label: string; description: string; tone: 'success' | 'info' | 'warning' | 'error'}> = {
  missing: {label: 'Model missing', description: 'No local model is available.', tone: 'warning'},
  downloading: {label: 'Model downloading', description: 'The model is being downloaded.', tone: 'info'},
  loading: {label: 'Model loading', description: 'The model is loading into the local runtime.', tone: 'info'},
  ready: {label: 'Model ready', description: 'The local provider is ready.', tone: 'success'},
  failed: {label: 'Provider failed', description: 'The local provider is not responding.', tone: 'error'},
  'fallback-active': {label: 'Provider fallback active', description: 'Lumen has moved to CPU fallback without interrupting exact search.', tone: 'warning'},
};

function ModelProgress({label = 'Downloading', value}: {label?: string; value: number}) {
  return (
    <ProgressBar aria-label="Model download" className="grid w-[190px] gap-1" value={value}>
      {({percentage, valueText}) => (
        <>
          <div className="flex justify-between gap-2">
            <LumenText variant="meta">{label}</LumenText>
            <LumenText tone="tertiary" variant="meta">{valueText}</LumenText>
          </div>
          <div className="h-1 overflow-hidden rounded-pill bg-surface-raised"><div className="h-full rounded-pill bg-accent transition-[width] duration-150" style={{width: `${percentage}%`}} /></div>
        </>
      )}
    </ProgressBar>
  );
}

function formatDiskSize(bytes: number) {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function LocalAiPage({
  model,
  provisioningService = defaultProvisioningService,
}: {
  model?: Pick<LocalAiViewModel, 'hardware' | 'state'> & Partial<LocalAiViewModel>;
  provisioningService?: ProvisioningService;
}) {
  const native = isNativeRuntime();
  const storedHardware = useGatewayStore((state) => state.hardwareState);
  const storedModel = useGatewayStore((state) => state.modelState);
  const storedProgress = useGatewayStore((state) => state.modelProgress);
  const modelName = useGatewayStore((state) => state.modelName);
  const providerName = useGatewayStore((state) => state.providerName);
  const keepLocalWarm = useSettingsStore((state) => state.ai.keepLocalWarm);
  const runtimeMode = useSettingsStore((state) => state.ai.runtimeMode);
  const updateAi = useSettingsStore((state) => state.updateAi);
  const [nativeHealth, setNativeHealth] = useState<LocalRuntimeHealth>();
  const [nativeError, setNativeError] = useState('');
  const [provisioning, setProvisioning] = useState<ProvisioningStatus>();
  const [provisioningError, setProvisioningError] = useState('');
  const refreshNative = useCallback(async () => {
    if (!native || model) return;
    try {
      setNativeHealth(await nativeAiService.localRuntimeHealth());
      setNativeError('');
    } catch (error) {
      setNativeError(error instanceof Error ? error.message : String(error));
    }
  }, [model, native]);
  useEffect(() => {
    void refreshNative();
  }, [refreshNative]);
  useEffect(() => {
    if (!native || model) return;
    let current = true;
    let unlisten: (() => void) | undefined;
    void provisioningService.status()
      .then((status) => {
        if (current) setProvisioning(status);
      })
      .catch((error) => {
        if (current) setProvisioningError(error instanceof Error ? error.message : String(error));
      });
    void provisioningService.subscribe((status) => {
      if (current) setProvisioning(status);
    }).then((stop) => {
      if (current) unlisten = stop;
      else stop();
    }).catch(() => undefined);
    return () => {
      current = false;
      unlisten?.();
    };
  }, [model, native, provisioningService]);
  const nativeHardware: HardwareState | undefined = nativeHealth?.profile === 'laptop-amd-npu'
    ? 'npu'
    : nativeHealth?.profile === 'desktop-nvidia-cuda' ? 'gpu' : nativeHealth ? 'cpu' : undefined;
  const provisionedState: ModelState | undefined = provisioning?.state === 'working'
    ? 'downloading'
    : provisioning?.state === 'ready'
      ? undefined
      : provisioning?.state === 'failed'
        ? 'failed'
        : provisioning ? 'missing' : undefined;
  const view = {
    hardware: model?.hardware ?? nativeHardware ?? storedHardware,
    state: model?.state ?? provisionedState ?? (nativeHealth ? (nativeHealth.state === 'ready' ? 'ready' : 'failed') : storedModel),
    progress: model?.progress ?? provisioning?.progress ?? storedProgress,
    modelName: model?.modelName ?? nativeHealth?.answerModel ?? modelName,
    provider: model?.provider ?? (nativeHealth ? `Lemonade ${nativeHealth.lemonade.version ?? 'missing'} / FLM ${nativeHealth.flm.version ?? 'missing'}` : providerName),
  };
  const hardware = hardwareCopy[view.hardware];
  const state = modelCopy[view.state];
  const startProvisioning = () => {
    if (!provisioning) return;
    setProvisioningError('');
    setProvisioning({...provisioning, state: 'working', canDownload: false, canUpdate: false, canCancel: true});
    void provisioningService.start('local-core')
      .then((status) => {
        setProvisioning(status);
        return refreshNative();
      })
      .catch((error) => setProvisioningError(error instanceof Error ? error.message : String(error)));
  };
  const cancelProvisioning = () => {
    void provisioningService.cancel()
      .then(setProvisioning)
      .catch((error) => setProvisioningError(error instanceof Error ? error.message : String(error)));
  };

  return (
    <SettingsPage>
      <section className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-6 rounded-surface border border-border-subtle bg-surface-inset p-6" data-testid={`hardware-${view.hardware}`}>
        <span aria-hidden="true" className="grid size-[52px] place-items-center rounded-surface bg-accent/10 text-accent">{hardware.icon}</span>
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <LumenText as="h2" variant="bodyLarge" weight="semibold">{hardware.label}</LumenText>
            <StatusBadge tone={hardware.tone}>{view.hardware.toUpperCase()}</StatusBadge>
          </div>
          <LumenText tone="secondary">{hardware.description}</LumenText>
        </div>
      </section>
      <SettingsCallout>
        {nativeHealth
          ? `${nativeHealth.profile} · ${nativeHealth.accelerator}. ${nativeHealth.detail ?? 'The loopback provider is ready.'}`
          : nativeError || provisioningError || provisioning?.detail || 'Exact filename and content search remain independent of local inference.'}
      </SettingsCallout>
      <SettingSection title="Model and provider">
        <SettingRow
          label={view.modelName}
          description={nativeHealth ? `Answers: ${nativeHealth.answerModel}; embeddings: ${nativeHealth.embeddingModel}; transcription: ${nativeHealth.transcriptionModel}.` : state.description}
          status={<StatusBadge tone={state.tone}>{state.label}</StatusBadge>}
        >
          <div data-testid={`model-${view.state}`}>
            {view.state === 'downloading' ? <ModelProgress label={provisioning?.detail ?? 'Downloading'} value={view.progress} /> : null}
            {native && !model && provisioning?.canDownload ? (
              <LumenButton aria-label="Download local core" size="small" onPress={startProvisioning}>
                <LumenUiIcon name="download" size="small" /> Download
              </LumenButton>
            ) : null}
            {native && !model && provisioning?.canUpdate ? (
              <LumenButton aria-label="Update local core" size="small" onPress={startProvisioning}>
                <LumenUiIcon name="download" size="small" /> Update
              </LumenButton>
            ) : null}
            {native && !model && provisioning?.canCancel ? (
              <LumenButton aria-label="Cancel local core download" size="small" variant="quiet" onPress={cancelProvisioning}>Cancel</LumenButton>
            ) : null}
            {['loading', 'ready', 'fallback-active'].includes(view.state) ? <LocalAiIcon size={22} /> : null}
            {native ? <LumenButton aria-label={nativeHealth ? 'Refresh local runtime' : 'Retry runtime check'} size="small" variant="quiet" onPress={() => void refreshNative()}><LumenUiIcon name="refresh" size="small" /> {nativeHealth ? 'Refresh' : 'Retry'}</LumenButton> : null}
          </div>
        </SettingRow>
        <SettingRow label="Provider" description={nativeHealth?.baseUrl ?? 'No native runtime detected.'}>
          <LumenText tone="secondary" variant="meta">{view.provider}</LumenText>
        </SettingRow>
        {native && !model && provisioning && provisioning.state !== 'ready' ? (
          <SettingRow label="Required disk space" description="Runtime, answer model, embedding model, and rollback headroom.">
            <LumenText tone="secondary" variant="meta">{formatDiskSize(provisioning.requiredDiskBytes)}</LumenText>
          </SettingRow>
        ) : null}
        <SettingRow label="Keep local model warm" description="Keeps local inference available in Cloud mode; search itself is always warm.">
          <LumenSwitch
            aria-label="Keep local model warm"
            isSelected={keepLocalWarm}
            onChange={(value) => {
              void updateAi({keepLocalWarm: value});
              if (isNativeRuntime()) void nativeAiService.setLocalRuntimeMode(runtimeMode, value).then(refreshNative);
            }}
          />
        </SettingRow>
      </SettingSection>
      <WindowsLocalAiControls />
    </SettingsPage>
  );
}
