import {invoke} from '@tauri-apps/api/core';
import {z} from 'zod';

import type {ProvidersService} from './providers-service';
import {parseProviderPayload, providerConfigSchema, switchProviderInputSchema, type ProviderConfig, type SwitchProviderInput} from './providers.types';

export class TauriProvidersService implements ProvidersService {
  /** Query the native sidecar health command and validate its boolean result. */
  async health(): Promise<boolean> {
    return z.boolean().parse(await invoke('cliproxy_health'));
  }

  /** Retrieve the sidecar configuration through the native command boundary. */
  async getConfig(): Promise<ProviderConfig> {
    return parseProviderPayload(providerConfigSchema, await invoke('cliproxy_get_config'));
  }

  /** Validate the target, invoke the native switch, and validate the changed file paths. */
  async switchProvider(input: SwitchProviderInput): Promise<string[]> {
    const parsed = switchProviderInputSchema.parse(input);
    return z.array(z.string()).parse(await invoke('switch_provider', {
      app: parsed.app,
      id: parsed.id,
      base_url: parsed.baseUrl,
      api_key: parsed.apiKey,
      model: parsed.model,
    }));
  }

  /** Remove a provider from live config and validate whether anything changed. */
  async removeFromLive(app: string, id: string): Promise<boolean> {
    return z.boolean().parse(await invoke('remove_from_live', {app, id}));
  }
}

export const tauriProvidersService = new TauriProvidersService();
