import type {SwitchProviderInput} from './providers.types';

export interface ProvidersService {
  health(): Promise<boolean>;
  getConfig(): Promise<unknown>;
  switchProvider(input: SwitchProviderInput): Promise<string[]>;
  removeFromLive(app: string, id: string): Promise<boolean>;
}

/** Backend rejects with plain strings, so Error.message alone would render an empty toast. */
export function toProviderErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
