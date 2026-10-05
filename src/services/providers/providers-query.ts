import {toProviderErrorMessage, type ProvidersService} from './providers-service';

export interface ProvidersOverview {
  healthy: boolean;
  config: unknown;
  error: string | null;
}

/** Load health and config concurrently, converting failures into an error overview. */
export async function loadProvidersOverview(service: ProvidersService): Promise<ProvidersOverview> {
  try {
    const [healthy, config] = await Promise.all([service.health(), service.getConfig()]);
    return {healthy, config, error: null};
  } catch (error) {
    return {healthy: false, config: null, error: toProviderErrorMessage(error)};
  }
}
