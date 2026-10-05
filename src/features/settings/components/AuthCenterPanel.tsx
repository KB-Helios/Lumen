import {useEffect, useState} from 'react';

import {LumenButton} from '../../../design-system/primitives/LumenButton';
import {LumenText} from '../../../design-system/primitives/LumenText';
import {isNativeRuntime} from '../../../services/ai/native-ai-service';
import {providersApi, type OAuthStart} from '../../../services/api/providers';
import {toProviderErrorMessage} from '../../../services/providers/providers-service';
import {LumenTextField} from './SettingsControls';
import {StatusBadge} from './StatusBadge';

/** Injectable cliproxy OAuth seam (defaults to the Tauri invoke backend). */
export interface AuthCenterApi {
  oauthLinked(provider: string): Promise<boolean>;
  oauthAuthUrl(provider: string): Promise<OAuthStart>;
  oauthPoll(state: string): Promise<{done: boolean; error?: string}>;
  oauthCancel(state: string): Promise<boolean>;
  importToken(provider: string, token: string): Promise<void>;
}

export interface AuthCenterPanelProps {
  api?: AuthCenterApi;
  /** Override the Tauri runtime check (defaults to `isNativeRuntime()`). */
  nativeRuntime?: boolean;
  /** Delay between OAuth status polls; exposed so tests stay fast. */
  pollIntervalMs?: number;
}

interface OAuthProvider {
  provider: string;
  name: string;
  description: string;
}

/** Mirrors the cc-switch auth center groups, routed through the cliproxy sidecar. */
const OAUTH_PROVIDERS: readonly OAuthProvider[] = [
  {provider: 'codex', name: 'ChatGPT', description: 'ChatGPT Plus/Pro sign-in for Codex-backed requests.'},
  {provider: 'claude', name: 'Anthropic', description: 'Anthropic OAuth for Claude-backed requests.'},
  {provider: 'xai', name: 'xAI', description: 'xAI OAuth for Grok-backed requests.'},
];

function OAuthAccountSection({
  api,
  provider,
  name,
  description,
  pollIntervalMs,
}: {
  api: AuthCenterApi;
} & OAuthProvider & {pollIntervalMs: number}) {
  const [linked, setLinked] = useState<boolean | null>(null);
  const [session, setSession] = useState<OAuthStart | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .oauthLinked(provider)
      .then((value) => {
        if (!cancelled) setLinked(value);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(toProviderErrorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [api, provider]);

  useEffect(() => {
    if (session === null) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await api.oauthPoll(session.state);
        if (cancelled) return;
        if (result.error) {
          setError(result.error);
          setSession(null);
        } else if (result.done) {
          setSession(null);
          setLinked(true);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(toProviderErrorMessage(caught));
          setSession(null);
        }
      }
    };
    const timer = window.setInterval(() => void poll(), pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, session, pollIntervalMs]);

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      setSession(await api.oauthAuthUrl(provider));
    } catch (caught) {
      setError(toProviderErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (session === null) return;
    setBusy(true);
    try {
      await api.oauthCancel(session.state);
    } catch (caught) {
      setError(toProviderErrorMessage(caught));
    } finally {
      setSession(null);
      setBusy(false);
    }
  };

  const canSaveToken = token.length > 0 && !busy;

  const saveToken = async () => {
    if (!canSaveToken) return;
    setBusy(true);
    setError('');
    try {
      await api.importToken(provider, token);
      setLinked(true);
    } catch (caught) {
      setError(toProviderErrorMessage(caught));
    } finally {
      // Never keep the secret in component state longer than the submit.
      setToken('');
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-16 gap-3 border-b border-border-subtle p-5 last:border-b-0">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
        <div className="grid gap-1">
          <LumenText weight="medium">{name}</LumenText>
          <LumenText tone="tertiary" variant="meta">{description}</LumenText>
        </div>
        <StatusBadge tone={linked ? 'success' : linked === false ? 'neutral' : 'info'}>
          {linked ? 'Signed in' : linked === false ? 'Not linked' : 'Checking'}
        </StatusBadge>
      </div>
      {session !== null ? (
        <div className="grid gap-2">
          <LumenText tone="secondary" variant="meta">
            Complete sign-in in the browser, then wait for confirmation here.
          </LumenText>
          <a
            className="font-sans text-sm text-accent underline underline-offset-2 outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus/70"
            href={session.url}
            rel="noreferrer"
            target="_blank"
          >
            Open authorization page
          </a>
          {session.userCode ? (
            <LumenText tone="secondary" variant="meta">
              Device code: <span className="font-mono text-text-primary">{session.userCode}</span>
            </LumenText>
          ) : null}
          <div>
            <LumenButton
              aria-label="Cancel sign-in"
              isDisabled={busy}
              size="small"
              variant="quiet"
              onPress={() => void cancel()}
            >
              Cancel sign-in
            </LumenButton>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          <div>
            <LumenButton
              aria-label={`Sign in with ${name}`}
              isDisabled={busy}
              size="small"
              onPress={() => void start()}
            >
              {busy ? 'Starting…' : `Sign in with ${name}`}
            </LumenButton>
          </div>
          <label className="grid gap-1 font-sans text-sm text-text-secondary">
            Or paste an access token
            <span className="flex gap-2">
              <LumenTextField
                aria-label={`Access token for ${name}`}
                placeholder="••••••"
                type="password"
                value={token}
                onChange={setToken}
              />
              <LumenButton
                aria-label={`Save ${name} token`}
                isDisabled={!canSaveToken}
                size="small"
                variant="primary"
                onPress={() => void saveToken()}
              >
                {busy ? 'Saving…' : 'Save'}
              </LumenButton>
            </span>
          </label>
        </div>
      )}
      {error ? (
        <LumenText tone="secondary" variant="meta" role="alert">{error}</LumenText>
      ) : null}
    </div>
  );
}

/**
 * Authorization center: one OAuth card per provider group (mirrors the
 * cc-switch AuthCenterPanel layout). All flows go through the cliproxy
 * sidecar; link status is boolean-only and secrets never reach the DOM.
 */
export function AuthCenterPanel({
  api,
  nativeRuntime,
  pollIntervalMs = 2000,
}: AuthCenterPanelProps = {}) {
  // An explicitly injected api (tests, previews) always wins; otherwise the
  // Tauri invoke backend needs the desktop runtime. Outside it the panel stays
  // quiet instead of surfacing invoke errors.
  const effectiveApi = api ?? ((nativeRuntime ?? isNativeRuntime()) ? providersApi : null);
  if (effectiveApi === null) {
    return (
      <LumenText tone="tertiary" variant="meta">
        Authorization needs the Lumen desktop runtime.
      </LumenText>
    );
  }
  return (
    <div data-testid="auth-center">
      {OAUTH_PROVIDERS.map((entry) => (
        <OAuthAccountSection
          key={entry.provider}
          api={effectiveApi}
          pollIntervalMs={pollIntervalMs}
          {...entry}
        />
      ))}
    </div>
  );
}
