import {invoke} from '@tauri-apps/api/core';
import {parseProviderPayload, providerUsageRowsSchema, type ProviderUsage} from '../providers/providers.types';
import {tauriProvidersService} from '../providers/tauri-providers-service';
import type {ProviderProfileInput} from '../providers/providers.types';

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

/** Profile persistence uses the typed provider service; OAuth remains a separate sidecar boundary. */
export const providersApi = {
  /** Save metadata and a native credential without activating the profile. */
  add(input: ProviderProfileInput) {
    return tauriProvidersService.add(input);
  },
  /** Submit provider edits, sending an empty key when the stored key should be retained. */
  update(input: ProviderProfileInput) {
    return tauriProvidersService.update(input);
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
  /** Native aggregation of usage counters; composite credential keys stay in Rust. */
  async apiKeyUsage(): Promise<ProviderUsage[]> {
    return parseProviderPayload(providerUsageRowsSchema, await invoke('cliproxy_usage'));
  },
};
