import {invoke} from '@tauri-apps/api/core';
import {z} from 'zod';

import type {ProvidersService} from './providers-service';
import {switchProviderInputSchema, type SwitchProviderInput} from './providers.types';

export class TauriProvidersService implements ProvidersService {
  async health(): Promise<boolean> {
    return z.boolean().parse(await invoke('cliproxy_health'));
  }

  async getConfig(): Promise<unknown> {
    return await invoke('cliproxy_get_config');
  }

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

  async removeFromLive(app: string, id: string): Promise<boolean> {
    return z.boolean().parse(await invoke('remove_from_live', {app, id}));
  }
}

export const tauriProvidersService = new TauriProvidersService();
