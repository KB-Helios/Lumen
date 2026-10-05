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

export interface OAuthStart {
  url: string;
  state: string;
  userCode?: string;
}

export interface OAuthPoll {
  /** True once the sidecar has stored the credential. */
  done: boolean;
  error?: string;
}

/**
 * Provider add/update seam behind the settings dialogs. The Rust
 * `add_provider` / `update_provider` commands land with the file-switch
 * engine; until then these typecheck the dialog wiring.
 *
 * The `cliproxy_oauth_*` / `cliproxy_usage` commands below are the same kind
 * of seam for Task 7: they front the sidecar loopback surface
 * (`GET /v8/management/oauth/auth-url?provider=`, `GET /oauth/status?state=`,
 * `DELETE /oauth/session?state=`, `POST /oauth/import?provider=`,
 * `GET /observability/usage/api-keys`). Status is boolean-only; key material
 * is never returned to the webview.
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
  /** `GET /v8/management/oauth/auth-url?provider=` — returns the sign-in URL, never a secret. */
  oauthAuthUrl(provider: string): Promise<OAuthStart> {
    return invoke<OAuthStart>('cliproxy_oauth_auth_url', {provider});
  },
  /** `GET /v8/management/oauth/status?state=` — poll until done or error. */
  oauthPoll(state: string): Promise<OAuthPoll> {
    return invoke<OAuthPoll>('cliproxy_oauth_poll', {state});
  },
  /** `DELETE /v8/management/oauth/session?state=` — cancel a pending flow. */
  oauthCancel(state: string): Promise<boolean> {
    return invoke<boolean>('cliproxy_oauth_cancel', {state});
  },
  /** Boolean link status per provider; the sidecar never returns key material. */
  oauthLinked(provider: string): Promise<boolean> {
    return invoke<boolean>('cliproxy_oauth_linked', {provider});
  },
  /** `POST /v8/management/oauth/import?provider=` — store a pasted token server-side. */
  importToken(provider: string, token: string): Promise<void> {
    return invoke<void>('cliproxy_oauth_import', {provider, token});
  },
  /** `GET /v8/management/observability/usage/api-keys` — per-key counters. */
  apiKeyUsage(): Promise<unknown> {
    return invoke<unknown>('cliproxy_usage');
  },
};
