import {beforeEach, describe, expect, it, vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {providersApi} from './providers';
import {TauriProvidersService} from '../providers/tauri-providers-service';

vi.mock('@tauri-apps/api/core', () => ({invoke: vi.fn()}));
beforeEach(() => vi.mocked(invoke).mockReset());

describe('provider IPC validation', () => {
  it('validates saved profiles and strips credential fields from native responses', async () => {
    vi.mocked(invoke).mockResolvedValue([{app: 'claude', id: 'one', baseUrl: 'https://example.com', model: 'test', active: false, enabled: false, apiKey: 'secret'}]);
    const profiles = await new TauriProvidersService().list();
    expect(profiles).toEqual([{app: 'claude', id: 'one', baseUrl: 'https://example.com', model: 'test', active: false, enabled: false}]);
    expect(JSON.stringify(profiles)).not.toContain('secret');
  });

  it('rejects unsupported profile targets before saving', async () => {
    await expect(providersApi.add({app: 'unsupported' as 'claude', id: 'one', baseUrl: 'https://example.com', apiKey: 'secret', model: 'test'})).rejects.toThrow('Invalid provider');
  });

  it('rejects a raw usage map without exposing it in an error', async () => {
    vi.mocked(invoke).mockResolvedValue({codex: {'sk-audit-secret': {success: 3}}});
    await expect(providersApi.apiKeyUsage()).rejects.toThrow('invalid response');
  });

  it('strips unexpected fields from safe usage DTOs', async () => {
    vi.mocked(invoke).mockResolvedValue([{provider: 'codex', success: 3, failed: 2, total: 5, token: 'sk-audit-secret'}]);
    const rows = await providersApi.apiKeyUsage();
    expect(rows).toEqual([{provider: 'codex', success: 3, failed: 2, total: 5}]);
    expect(JSON.stringify(rows)).not.toContain('sk-audit-secret');
  });

  it('rejects raw config instead of placing it in overview state', async () => {
    vi.mocked(invoke).mockResolvedValue({'api-keys': ['sk-audit-secret']});
    await expect(new TauriProvidersService().getConfig()).rejects.toThrow('invalid response');
  });
});
