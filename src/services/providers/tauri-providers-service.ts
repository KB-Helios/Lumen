import {invoke} from '@tauri-apps/api/core';
import {z} from 'zod';

import type {ProvidersService} from './providers-service';
import {parseProviderPayload, providerConfigSchema, switchProviderInputSchema, type ProviderConfig, type SwitchProviderInput} from './providers.types';
import {providerAppSchema, providerProfileSchema, providerProfileInputSchema, type ProviderApp, type ProviderProfile, type ProviderProfileInput} from './providers.types';

export class TauriProvidersService implements ProvidersService {
  async list(): Promise<ProviderProfile[]> {
    return parseProviderPayload(z.array(providerProfileSchema), await invoke('list_provider_profiles'));
  }

  private async save(input: ProviderProfileInput, command: string, adding: boolean): Promise<ProviderProfile> {
    const parsed = providerProfileInputSchema.safeParse(input);
    if (!parsed.success || (adding && !parsed.data.apiKey?.trim())) throw new Error('Invalid provider profile. Check the URL, model and API key.');
    return parseProviderPayload(providerProfileSchema, await invoke(command, {input: parsed.data}));
  }

  add(input: ProviderProfileInput): Promise<ProviderProfile> { return this.save(input, 'add_provider', true); }
  update(input: ProviderProfileInput): Promise<ProviderProfile> { return this.save(input, 'update_provider', false); }

  async activate(app: ProviderApp, id: string): Promise<ProviderProfile> {
    return parseProviderPayload(providerProfileSchema, await invoke('activate_provider_profile', {app: providerAppSchema.parse(app), id}));
  }
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
    return parseProviderPayload(z.boolean(), await invoke('remove_provider_profile_from_live', {app: providerAppSchema.parse(app), id}));
  }
}

export const tauriProvidersService = new TauriProvidersService();
