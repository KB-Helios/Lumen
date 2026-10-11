import type {ProvisioningService, ProvisioningStatus} from '../../services/ai/provisioning-service';
import type {ProvidersService} from '../../services/providers/providers-service';
import type {ProviderProfile} from '../../services/providers/providers.types';
import type {AuthCenterApi} from '../settings/components/AuthCenterPanel';
import type {UsageApi} from '../settings/components/UsagePanel';
import type {GalleryProviderState} from './gallery.types';

export const galleryProfile: ProviderProfile = {app: 'codex', id: 'simulated-long-profile-name-for-responsive-layout', model: 'simulated-model', baseUrl: 'https://example.test/simulated/v1', active: false, enabled: true};

export function galleryProvidersService(state: GalleryProviderState): ProvidersService {
  let rows = state === 'empty' ? [] : [galleryProfile];
  return {
    async health() { return false; },
    async getConfig() { return null; },
    async list() { if (state === 'error') throw new Error('Simulated profile load failed. Retry remains available.'); return rows; },
    async add({app, id, model, baseUrl}) { const profile = {app, id, model, baseUrl, active: false, enabled: false}; rows = [...rows, profile]; return profile; },
    async update(input) { rows = rows.map((row) => row.id === input.id ? {...row, baseUrl: input.baseUrl, model: input.model, active: false} : row); return rows.find((row) => row.id === input.id)!; },
    async activate(_app, id) { rows = rows.map((row) => ({...row, active: row.id === id, enabled: row.id === id})); return rows.find((row) => row.id === id)!; },
    async switchProvider() { return []; },
    async removeFromLive(_app, id) { rows = rows.map((row) => row.id === id ? {...row, active: false, enabled: false} : row); return true; },
  };
}

export const galleryAuthApi: AuthCenterApi = {
  async oauthLinked() { return false; },
  async oauthAuthUrl() { throw new Error('OAuth is unavailable in this simulated development fixture.'); },
  async oauthPoll() { return {done: false}; },
  async oauthCancel() { return true; },
  async importToken() { throw new Error('Token import is unavailable in this simulated development fixture.'); },
};
export const galleryUsageApi: UsageApi = {async apiKeyUsage() { return []; }};
export const galleryAiService = {
  async localRuntimeHealth(): Promise<never> { throw new Error('Simulated development runtime; no native request runs.'); },
  async setLocalRuntimeMode() {},
};

export function galleryProvisioningService(state: 'provisioning' | 'error' | 'cancelled'): ProvisioningService {
  let status: ProvisioningStatus = {
    profileId: 'local-core', label: 'Simulated local core', version: '11.5.2', installedVersion: null,
    state: state === 'provisioning' ? 'working' : state === 'error' ? 'failed' : 'cancelled', phase: 'simulated',
    downloadedBytes: 420, totalBytes: 1000, requiredDiskBytes: 4_200_000_000, progress: state === 'provisioning' ? 42 : 0,
    canDownload: state !== 'provisioning', canUpdate: false, canCancel: state === 'provisioning',
    detail: `Simulated development provisioning ${state}.`, models: [],
  };
  return {
    async status() { return status; },
    async start() { status = {...status, state: 'working', canDownload: false, canCancel: true, progress: 42}; return status; },
    async cancel() { status = {...status, state: 'cancelled', canDownload: true, canCancel: false, detail: 'Simulated download cancelled.'}; return status; },
    async subscribe() { return () => undefined; },
  };
}
