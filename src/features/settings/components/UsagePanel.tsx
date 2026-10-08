import {useEffect, useState} from 'react';

import {LumenText} from '../../../design-system/primitives/LumenText';
import {isNativeRuntime} from '../../../services/ai/native-ai-service';
import {providersApi} from '../../../services/api/providers';
import {toProviderErrorMessage} from '../../../services/providers/providers-service';
import {parseProviderPayload, providerUsageRowsSchema, type ProviderUsage} from '../../../services/providers/providers.types';

/** Injectable usage seam (defaults to the Tauri invoke backend). */
export interface UsageApi {
  apiKeyUsage(): Promise<unknown>;
}

export type {ProviderUsage} from '../../../services/providers/providers.types';

/** Validate native allowlisted counters before they enter UI state. */
export function parseApiKeyUsage(payload: unknown): ProviderUsage[] {
  return parseProviderPayload(providerUsageRowsSchema, payload);
}

function MetricCard({label, value}: {label: string; value: string}) {
  return (
    <div className="grid min-h-16 content-center gap-1 rounded-control border border-border-subtle bg-surface-inset px-4 py-3">
      <LumenText tone="tertiary" variant="meta">{label}</LumenText>
      <LumenText variant="bodyLarge" weight="semibold">{value}</LumenText>
    </div>
  );
}

/** Rolled-up counters (port of the cc-switch UsageHero; pricing/model split deferred). */
export function UsageHero({rows}: {rows: ProviderUsage[]}) {
  const success = rows.reduce((sum, row) => sum + row.success, 0);
  const failed = rows.reduce((sum, row) => sum + row.failed, 0);
  const total = success + failed;
  const rate = total > 0 ? `${((success / total) * 100).toFixed(1)}%` : '—';
  return (
    <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4" data-testid="usage-hero">
      <MetricCard label="Total requests" value={String(total)} />
      <MetricCard label="Successful" value={String(success)} />
      <MetricCard label="Failed" value={String(failed)} />
      <MetricCard label="Success rate" value={rate} />
    </div>
  );
}

/** Per-provider request counts (port of the cc-switch RequestLogTable core). */
export function RequestLogTable({rows}: {rows: ProviderUsage[]}) {
  return (
    <div className="overflow-x-auto" data-testid="request-log">
      <table className="w-full min-w-[420px] border-collapse font-sans text-sm text-text-primary" aria-label="Request log">
        <thead>
          <tr className="border-b border-border-subtle text-left">
            <th className="px-4 py-2 font-medium text-text-secondary" scope="col">Provider</th>
            <th className="px-4 py-2 text-right font-medium text-text-secondary" scope="col">Successful</th>
            <th className="px-4 py-2 text-right font-medium text-text-secondary" scope="col">Failed</th>
            <th className="px-4 py-2 text-right font-medium text-text-secondary" scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="px-4 py-3 text-text-tertiary" colSpan={4}>No usage recorded yet.</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.provider} className="border-b border-border-subtle tabular-nums last:border-b-0">
                <td className="px-4 py-2">{row.provider}</td>
                <td className="px-4 py-2 text-right">{row.success}</td>
                <td className="px-4 py-2 text-right">{row.failed}</td>
                <td className="px-4 py-2 text-right font-medium">{row.total}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export interface UsagePanelProps {
  api?: UsageApi;
  /** Override the Tauri runtime check (defaults to `isNativeRuntime()`). */
  nativeRuntime?: boolean;
}

export function UsagePanel({api, nativeRuntime}: UsagePanelProps = {}) {
  // An explicitly injected api (tests, previews) always wins; otherwise the
  // Tauri invoke backend needs the desktop runtime.
  const effectiveApi = api ?? ((nativeRuntime ?? isNativeRuntime()) ? providersApi : null);
  const [rows, setRows] = useState<ProviderUsage[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (effectiveApi === null) return;
    let cancelled = false;
    void effectiveApi
      .apiKeyUsage()
      .then((payload) => {
        if (!cancelled) setRows(parseApiKeyUsage(payload));
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(toProviderErrorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveApi]);

  if (effectiveApi === null) {
    return (
      <LumenText tone="tertiary" variant="meta">
        Usage needs the Lumen desktop runtime.
      </LumenText>
    );
  }

  if (error) {
    return (
      <LumenText tone="secondary" variant="meta" role="alert">{error}</LumenText>
    );
  }
  if (rows === null) {
    return (
      <LumenText tone="tertiary" variant="meta">Loading usage…</LumenText>
    );
  }
  return (
    <div className="grid gap-4" data-testid="usage-panel">
      <UsageHero rows={rows} />
      <RequestLogTable rows={rows} />
    </div>
  );
}
