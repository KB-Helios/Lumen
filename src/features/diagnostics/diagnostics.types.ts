export interface TimingSample {
  name: 'launcher-visible' | 'input-response' | 'input-next-frame' | 'selection-paint' | 'other';
  durationMs: number;
  timestamp: number;
}

export interface DiagnosticsSnapshot {
  appVersion: string;
  webViewVersion: string;
  tauriVersion: string;
  monitor: string;
  dpiScale: number;
  refreshRateHz: number | null;
  activeAnimations: number;
  reactCommitMs: number;
  reactCommits: number[];
  browserLongTasks: number[];
  timings: TimingSample[];
  activity: string;
  gateway: string;
  providerRoutes: string[];
  logs: string[];
}

export interface DiagnosticsExport {
  filename: string;
  contents: string;
}

const secretKey = /(api[-_]?key|token|secret|password|authorization|prompt|credential|content|body|error|logs?|message|detail|path|directory)/i;
const windowsPath = /(?:[a-z]:[\\/]|\\\\|(?:^|[\s"'(])\/\/)[^\r\n"']+/gi;

function sanitizeString(value: string) {
  return value.replace(windowsPath, '[local-path]');
}

export function sanitizeDiagnostics(value: unknown, key = ''): unknown {
  if (secretKey.test(key)) {
    return '[redacted]';
  }
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnostics(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeDiagnostics(childValue, childKey)]),
    );
  }
  return value;
}

export function createDiagnosticsExport(value: unknown, now = new Date()): DiagnosticsExport {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return {
    filename: `lumen-diagnostics-${timestamp}.json`,
    contents: JSON.stringify(sanitizeDiagnostics(value), null, 2),
  };
}
