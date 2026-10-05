import {useEffect, useState} from 'react';

import {LumenButton} from '../../../design-system/primitives/LumenButton';
import {LumenText} from '../../../design-system/primitives/LumenText';
import {isNativeRuntime} from '../../../services/ai/native-ai-service';
import {loadProvidersOverview} from '../../../services/providers/providers-query';
import type {ProvidersService} from '../../../services/providers/providers-service';
import {tauriProvidersService} from '../../../services/providers/tauri-providers-service';
import {SettingSection} from '../components/SettingSection';
import {SettingsCallout, SettingsPage} from '../components/SettingsPage';
import {StatusBadge} from '../components/StatusBadge';

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
  const sections = buildSections(ALL_APPS);

  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    void loadProvidersOverview(providersService).then((overview) => {
      if (cancelled) return;
      setHealthy(overview.healthy);
      setError(overview.error ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [native, providersService]);

  return (
    <SettingsPage>
      {error ? <SettingsCallout tone="error">{error}</SettingsCallout> : null}
      {!native ? (
        <SettingsCallout>
          Provider switching needs the Lumen desktop runtime; the list below previews the grouping.
        </SettingsCallout>
      ) : null}
      <SettingSection title="Sidecar" description="Go proxy health on the loopback management port.">
        <div className="flex min-h-16 items-center gap-4 p-5">
          <StatusBadge tone={healthy ? 'success' : healthy === false ? 'warning' : 'neutral'}>
            {healthy ? 'Sidecar ready' : healthy === false ? 'Sidecar unavailable' : 'Checking sidecar'}
          </StatusBadge>
        </div>
      </SettingSection>
      <div data-testid="provider-list" className="grid content-start gap-8">
        <SettingSection title="Switch" description="One live provider per tool; switching rewrites the floor keys.">
          {sections.switchApps.map((app) => (
            <div key={app} className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border-subtle p-5 last:border-b-0">
              <div className="grid gap-1">
                <LumenText weight="medium">{app}</LumenText>
                <LumenText tone="tertiary" variant="meta">Exclusive live config</LumenText>
              </div>
              <LumenButton
                aria-label={`Switch ${app}`}
                isDisabled
                size="small"
              >
                Switch
              </LumenButton>
            </div>
          ))}
        </SettingSection>
        <SettingSection title="Additive" description="Providers accumulate; enable or remove each one.">
          {sections.additiveApps.map((app) => (
            <div key={app} className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border-subtle p-5 last:border-b-0">
              <div className="grid gap-1">
                <LumenText weight="medium">{app}</LumenText>
                <LumenText tone="tertiary" variant="meta">Coexisting provider nodes</LumenText>
              </div>
              <LumenButton
                aria-label={`Add ${app}`}
                isDisabled
                size="small"
              >
                Add
              </LumenButton>
            </div>
          ))}
        </SettingSection>
        <LumenText tone="tertiary" variant="meta">Switch and add actions enable once provider dialogs land.</LumenText>
      </div>
    </SettingsPage>
  );
}
