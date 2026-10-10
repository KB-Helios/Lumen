import {useEffect, useRef, useState} from 'react';

import {LumenButton} from '../../../design-system/primitives/LumenButton';
import {LumenText} from '../../../design-system/primitives/LumenText';
import {isNativeRuntime} from '../../../services/ai/native-ai-service';
import {loadProvidersOverview} from '../../../services/providers/providers-query';
import type {ProvidersService} from '../../../services/providers/providers-service';
import {tauriProvidersService} from '../../../services/providers/tauri-providers-service';
import {SettingSection} from '../components/SettingSection';
import {SettingsCallout, SettingsPage} from '../components/SettingsPage';
import {StatusBadge} from '../components/StatusBadge';
import {AuthCenterPanel} from '../components/AuthCenterPanel';
import {UsagePanel} from '../components/UsagePanel';
import {AddProviderDialog} from '../components/AddProviderDialog';
import {EditProviderDialog} from '../components/EditProviderDialog';
import {ConfirmationDialog} from '../components/ConfirmationDialog';
import type {ProviderApp, ProviderProfile} from '../../../services/providers/providers.types';
import {toProviderErrorMessage} from '../../../services/providers/providers-service';

/** Exclusive tools: exactly one provider feeds the live config (mirrors the Rust file-switch engine). */
export const SWITCH_APPS = ['claude', 'codex', 'gemini'] as const;
/** Coexisting tools: provider nodes accumulate in the live config. */
export const ADDITIVE_APPS = ['opencode', 'openclaw'] as const;

export interface ProviderSections {
  switchApps: string[];
  additiveApps: string[];
}

export function buildSections(apps: string[]): ProviderSections {
  const switchSet = new Set<string>(SWITCH_APPS);
  return {
    switchApps: apps.filter((app) => switchSet.has(app)),
    additiveApps: apps.filter((app) => !switchSet.has(app)),
  };
}

const ALL_APPS = [...SWITCH_APPS, ...ADDITIVE_APPS];

export interface ProvidersPageProps {
  providersService?: ProvidersService;
  nativeRuntime?: boolean;
}

export function ProvidersPage({
  providersService = tauriProvidersService,
  nativeRuntime,
}: ProvidersPageProps = {}) {
  const native = nativeRuntime ?? isNativeRuntime();
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [loading, setLoading] = useState(native);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const busy = useRef(false);
  const epoch = useRef(0);
  const sections = buildSections(ALL_APPS);

  useEffect(() => {
    let cancelled = false;
    const generation = ++epoch.current;
    busy.current = false;
    setPending(false);
    if (!native) { setLoading(false); setProfiles([]); return; }
    void loadProvidersOverview(providersService).then((overview) => {
      if (cancelled) return;
      setHealthy(overview.healthy);
      if (overview.error) setError(overview.error);
    });
    void providersService.list().then((rows) => {
      if (!cancelled && generation === epoch.current) setProfiles(rows);
    }).catch((caught: unknown) => {
      if (!cancelled && generation === epoch.current) setError(toProviderErrorMessage(caught));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      ++epoch.current;
    };
  }, [native, providersService, revision]);

  const refresh = () => { setLoading(true); setError(''); setRevision((value) => value + 1); };
  const changeLive = async (profile: ProviderProfile, remove = false) => {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setError('');
    const generation = epoch.current;
    try {
      if (remove) await providersService.removeFromLive(profile.app, profile.id);
      else await providersService.activate(profile.app, profile.id);
      if (generation === epoch.current) refresh();
      return true;
    } catch (caught) {
      if (generation === epoch.current) setError(toProviderErrorMessage(caught));
      return false;
    } finally {
      if (generation === epoch.current) { busy.current = false; setPending(false); }
    }
  };

  const renderApp = (app: string) => (
    <div key={app} className="grid min-w-0 gap-3 border-b border-border-subtle p-5 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <LumenText weight="medium">{app}</LumenText>
        <AddProviderDialog app={app as ProviderApp} api={{add: (input) => providersService.add(input)}} onAdded={refresh}>
          <LumenButton aria-label={`Add ${app}`} size="small" isDisabled={!native || loading || pending}>Add profile</LumenButton>
        </AddProviderDialog>
      </div>
      {profiles.filter((profile) => profile.app === app).map((profile) => (
        <div key={profile.id} className="grid min-w-0 gap-2 rounded-control bg-surface-inset p-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <LumenText weight="medium">{profile.id}</LumenText>
            <StatusBadge tone={profile.active ? 'success' : 'neutral'}>{profile.active ? 'Active' : profile.enabled ? 'Saved changes not applied' : 'Saved'}</StatusBadge>
          </div>
          <LumenText tone="tertiary" variant="meta">{profile.model} · {profile.baseUrl}</LumenText>
          <div className="flex flex-wrap gap-2">
            <LumenButton size="small" aria-label={`${ADDITIVE_APPS.includes(app as typeof ADDITIVE_APPS[number]) ? 'Enable' : 'Switch'} ${profile.id}`} isDisabled={pending || loading || profile.active} onPress={() => void changeLive(profile)}>{ADDITIVE_APPS.includes(app as typeof ADDITIVE_APPS[number]) ? 'Enable' : 'Switch'}</LumenButton>
            <EditProviderDialog provider={profile} api={{update: (input) => providersService.update(input)}} onSaved={refresh}>
              <LumenButton size="small" aria-label={`Edit ${profile.id}`} isDisabled={pending || loading}>Edit</LumenButton>
            </EditProviderDialog>
            {profile.enabled ? <ConfirmationDialog title={`Remove ${profile.id} from live config?`} description="Remove this profile's connection settings from the tool. The saved profile and key remain available." confirmLabel="Remove from live" onConfirm={() => changeLive(profile, true)}>
              <LumenButton size="small" aria-label={`Remove ${profile.id} from live`} isDisabled={pending || loading}>Remove from live</LumenButton>
            </ConfirmationDialog> : null}
          </div>
        </div>
      ))}
      {!profiles.some((profile) => profile.app === app) ? <LumenText tone="tertiary" variant="meta">No saved profiles</LumenText> : null}
    </div>
  );

  return (
    <SettingsPage>
      <AddProviderDialog api={{add: (input) => providersService.add(input)}} onAdded={refresh}>
        <LumenButton size="small" isDisabled={!native || loading || pending}>Add provider</LumenButton>
      </AddProviderDialog>
      {error ? <SettingsCallout tone="error">{error} <LumenButton size="small" isDisabled={pending || loading} onPress={refresh}>Retry</LumenButton></SettingsCallout> : null}
      {!native ? (
        <SettingsCallout>
          Provider switching needs the Lumen desktop runtime; the list below previews the grouping.
        </SettingsCallout>
      ) : null}
      <SettingSection title="Sidecar" description="Go proxy health on the loopback management port.">
        <div className="flex min-h-16 items-center gap-4 p-5">
          <StatusBadge tone={healthy ? 'success' : healthy === false ? 'warning' : 'neutral'}>
            {!native ? 'Sidecar unavailable' : healthy ? 'Sidecar ready' : healthy === false ? 'Sidecar unavailable' : 'Checking sidecar'}
          </StatusBadge>
        </div>
      </SettingSection>
      <div data-testid="provider-list" className="grid content-start gap-8">
        <SettingSection title="Switch" description="One live provider per tool; switching rewrites the floor keys.">
          {sections.switchApps.map(renderApp)}
        </SettingSection>
        <SettingSection title="Additive" description="Providers accumulate; enable or remove each one.">
          {sections.additiveApps.map(renderApp)}
        </SettingSection>
        <LumenText tone="tertiary" variant="meta">Adding or editing saves a profile. Switch or Enable applies it to the tool. API keys are stored in Windows Credential Manager.</LumenText>
      </div>
      <SettingSection title="Authorization center" description="OAuth sign-in for ChatGPT, Anthropic, and xAI through the loopback sidecar. Only link status is shown; secrets never leave the sidecar.">
        <AuthCenterPanel nativeRuntime={native} />
      </SettingSection>
      <SettingSection title="Usage" description="Recent per-provider request counts from the sidecar. Pricing and model breakdowns follow later.">
        <div className="p-5">
          <UsagePanel nativeRuntime={native} />
        </div>
      </SettingSection>
    </SettingsPage>
  );
}
