import {invoke} from '@tauri-apps/api/core';

export interface AddProviderInput {
  app: string;
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface UpdateProviderInput {
  app: string;
  id: string;
  baseUrl: string;
  model: string;
  /** Omitted (or empty) when the stored key should be kept. */
  apiKey?: string;
}

/**
 * Provider add/update seam behind the settings dialogs. The Rust
 * `add_provider` / `update_provider` commands land with the file-switch
 * engine; until then these typecheck the dialog wiring.
 */
export const providersApi = {
  add(input: AddProviderInput): Promise<string[]> {
    return invoke<string[]>('add_provider', {
      app: input.app,
      id: input.id,
      base_url: input.baseUrl,
      api_key: input.apiKey,
      model: input.model,
    });
  },
  update(input: UpdateProviderInput): Promise<void> {
    return invoke<void>('update_provider', {
      app: input.app,
      id: input.id,
      base_url: input.baseUrl,
      api_key: input.apiKey ?? '',
      model: input.model,
    });
  },
};
