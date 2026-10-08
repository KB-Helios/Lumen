import {invoke as tauriInvoke} from '@tauri-apps/api/core';
import {z} from 'zod';

type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export const providerIdSchema = z.enum(['local', 'openai', 'anthropic', 'google', 'openai-compatible']);
export const modelCapabilitySchema = z.enum(['answer', 'embedding', 'vision', 'audio', 'rerank']);
const providerDescriptorSchema = z.object({
  id: providerIdSchema,
  label: z.string().min(1),
  cloud: z.boolean(),
  credentialConfigured: z.boolean(),
});
const modelDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  providerId: providerIdSchema,
  capabilities: z.array(modelCapabilitySchema).min(1),
});
const routeDescriptorSchema = z.object({
  alias: z.string().regex(/^lumen\.(answer|embed|vision|audio|rerank|improvement)\.(local|cloud)$/),
  capability: modelCapabilitySchema,
  providerId: providerIdSchema,
  modelId: z.string().min(1),
  status: z.enum(['ready', 'needsConsent', 'needsCredential']),
  baseUrl: z.string().url().nullable(),
  upstreamModel: z.string().min(1).nullable(),
});
const registrySnapshotSchema = z.object({
  providers: z.array(providerDescriptorSchema),
  models: z.array(modelDescriptorSchema),
  routes: z.array(routeDescriptorSchema),
});
export const routeUpdateSchema = z.object({
  alias: routeDescriptorSchema.shape.alias,
  providerId: providerIdSchema,
  modelId: z.string().min(1),
  baseUrl: z.string().url().nullable(),
  upstreamModel: z.string().min(1).nullable(),
});
const routeApplyResultSchema = z.object({
  applied: z.boolean(),
  message: z.string().min(1),
  route: routeDescriptorSchema,
});
const routeTestResultSchema = z.object({ready: z.boolean(), message: z.string().min(1)});

export type ProviderId = z.infer<typeof providerIdSchema>;
export type ProviderRegistrySnapshot = z.infer<typeof registrySnapshotSchema>;
export type ProviderRouteDescriptor = z.infer<typeof routeDescriptorSchema>;
export type ProviderRouteUpdate = z.infer<typeof routeUpdateSchema>;
export type ProviderRouteApplyResult = z.infer<typeof routeApplyResultSchema>;
export type ProviderRouteTestResult = z.infer<typeof routeTestResultSchema>;

export interface ProviderRegistryService {
  list(): Promise<ProviderRegistrySnapshot>;
  setRoute(update: ProviderRouteUpdate): Promise<ProviderRouteApplyResult>;
  testRoute(alias: string): Promise<ProviderRouteTestResult>;
}

export class TauriProviderRegistryService implements ProviderRegistryService {
  constructor(private readonly invoke: InvokeCommand = tauriInvoke) {}

  async list() {
    return registrySnapshotSchema.parse(await this.invoke('list_provider_registry'));
  }

  async setRoute(update: ProviderRouteUpdate) {
    const parsed = routeUpdateSchema.parse(update);
    return routeApplyResultSchema.parse(await this.invoke('set_provider_route', {update: parsed}));
  }

  async testRoute(alias: string) {
    return routeTestResultSchema.parse(await this.invoke('test_provider_route', {
      alias: routeDescriptorSchema.shape.alias.parse(alias),
    }));
  }
}

export const providerRegistryService = new TauriProviderRegistryService();
