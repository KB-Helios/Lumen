import {useEffect, useMemo, useState} from 'react';

import {LumenButton} from '../../design-system/primitives/LumenButton';
import {LumenText} from '../../design-system/primitives/LumenText';
import type {
  ProviderRegistrySnapshot,
  ProviderRouteDescriptor,
  ProviderRouteUpdate,
} from '../../services/ai/provider-registry-service';
import {LumenSelect, LumenTextField} from '../settings/components/SettingsControls';
import {StatusBadge} from '../settings/components/StatusBadge';

interface CustomDraft {
  baseUrl: string;
  upstreamModel: string;
}

function statusLabel(route: ProviderRouteDescriptor) {
  if (route.status === 'ready') return 'Ready';
  if (route.status === 'needsConsent') return 'Needs consent';
  return 'Needs key';
}

export function ProviderRegistryList({
  registry,
  cloudConsent,
  onSet,
  onTest,
}: {
  registry: ProviderRegistrySnapshot;
  cloudConsent: boolean;
  onSet(update: ProviderRouteUpdate): Promise<void>;
  onTest(alias: string): Promise<void>;
}) {
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
  const [customDrafts, setCustomDrafts] = useState<Record<string, CustomDraft>>({});
  useEffect(() => {
    setSelectedModels(Object.fromEntries(registry.routes.map((route) => [route.alias, route.modelId])));
    setCustomDrafts(Object.fromEntries(registry.routes.flatMap((route) => route.providerId === 'openai-compatible'
      ? [[route.alias, {baseUrl: route.baseUrl ?? '', upstreamModel: route.upstreamModel ?? ''}]]
      : [])));
  }, [registry]);
  const providerLabels = useMemo(
    () => new Map(registry.providers.map((provider) => [provider.id, provider.label])),
    [registry.providers],
  );

  return (
    <div className="min-w-0">
      {registry.routes.map((route) => {
        const compatibleModels = registry.models.filter((model) =>
          model.capabilities.includes(route.capability) &&
          (route.alias.endsWith('.local') ? model.providerId === 'local' : model.providerId !== 'local'),
        );
        const selectedModelId = selectedModels[route.alias] ?? route.modelId;
        const selectedModel = registry.models.find((model) => model.id === selectedModelId);
        const custom = selectedModel?.providerId === 'openai-compatible';
        const draft = customDrafts[route.alias] ?? {baseUrl: '', upstreamModel: ''};
        const update: ProviderRouteUpdate | null = selectedModel ? {
          alias: route.alias,
          providerId: selectedModel.providerId,
          modelId: selectedModel.id,
          baseUrl: custom ? draft.baseUrl : null,
          upstreamModel: custom ? draft.upstreamModel : null,
        } : null;
        return (
          <div key={route.alias} className="grid min-w-0 gap-[12px] border-b border-border-subtle p-[16px] last:border-b-0">
            <div className="grid min-h-[40px] min-w-0 grid-cols-[minmax(0,1fr)] items-center gap-[12px] @min-[36rem]/settings:grid-cols-[minmax(0,.7fr)_minmax(0,1fr)_auto]">
              <div className="grid min-w-0 gap-1">
                <LumenText weight="medium">{route.alias}</LumenText>
                <StatusBadge tone={route.status === 'ready' ? 'success' : 'warning'}>{statusLabel(route)}</StatusBadge>
              </div>
              <LumenSelect
                aria-label={`Model for ${route.alias}`}
                isDisabled={route.alias.endsWith('.cloud') && !cloudConsent}
                options={compatibleModels.map((model) => ({
                  id: model.id,
                  label: `${providerLabels.get(model.providerId) ?? model.providerId} · ${model.label}`,
                }))}
                value={selectedModelId}
                onChange={(modelId) => {
                  const model = registry.models.find((item) => item.id === modelId);
                  if (!model) return;
                  setSelectedModels((current) => ({...current, [route.alias]: modelId}));
                  if (model.providerId !== 'openai-compatible') {
                    void onSet({alias: route.alias, providerId: model.providerId, modelId, baseUrl: null, upstreamModel: null});
                  }
                }}
              />
              <LumenButton className="justify-self-start" size="small" variant="quiet" onPress={() => void onTest(route.alias)}>Test</LumenButton>
            </div>
            {custom ? (
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-[8px] @min-[36rem]/settings:grid-cols-[minmax(0,1fr)_minmax(0,.6fr)_auto]">
                <LumenTextField aria-label={`Base URL for ${route.alias}`} placeholder="https://api.example.com/v1" value={draft.baseUrl} onChange={(baseUrl) => setCustomDrafts((current) => ({...current, [route.alias]: {...draft, baseUrl}}))} />
                <LumenTextField aria-label={`Upstream model for ${route.alias}`} placeholder="model-id" value={draft.upstreamModel} onChange={(upstreamModel) => setCustomDrafts((current) => ({...current, [route.alias]: {...draft, upstreamModel}}))} />
                <LumenButton className="justify-self-start" isDisabled={!update || !draft.baseUrl || !draft.upstreamModel} size="small" variant="primary" onPress={() => update && void onSet(update)}>Apply</LumenButton>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
