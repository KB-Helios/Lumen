import {z} from 'zod';

/** Tools the Rust file-switch engine can rewrite. Switch apps are exclusive; additive apps coexist. */
export const providerAppSchema = z.enum(['claude', 'codex', 'gemini', 'opencode', 'openclaw']);
export type ProviderApp = z.infer<typeof providerAppSchema>;

export const switchProviderInputSchema = z.object({
  app: providerAppSchema,
  id: z.string().min(1).max(128),
  baseUrl: z.string().min(1).max(2048),
  apiKey: z.string().min(1).max(4096),
  model: z.string().min(1).max(256),
});
export type SwitchProviderInput = z.infer<typeof switchProviderInputSchema>;

const noControlCharacters = (value: string) => !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const singleLine = (max: number) => z.string().trim().min(1).max(max).refine(noControlCharacters);
export const providerProfileInputSchema = z.object({
  app: providerAppSchema,
  id: singleLine(128).refine((value) => !value.includes('..') && !/[\\/]/.test(value)),
  baseUrl: singleLine(2048).refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }),
  model: singleLine(256),
  apiKey: z.string().max(4096).refine(noControlCharacters).optional(),
});
export type ProviderProfileInput = z.infer<typeof providerProfileInputSchema>;
export const providerProfileSchema = providerProfileInputSchema.omit({apiKey: true}).extend({active: z.boolean(), enabled: z.boolean()});
export type ProviderProfile = z.infer<typeof providerProfileSchema>;

export const managedProviderSchema = z.enum(['codex', 'openai', 'claude', 'anthropic', 'gemini', 'qwen', 'xai', 'grok', 'iflow', 'kimi', 'antigravity', 'vertex', 'copilot']);
const counterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const providerUsageSchema = z.object({
  provider: managedProviderSchema,
  success: counterSchema,
  failed: counterSchema,
  total: counterSchema,
});
export const providerUsageRowsSchema = z.array(providerUsageSchema);
export type ProviderUsage = z.infer<typeof providerUsageSchema>;

export const providerConfigSchema = z.object({
  routingStrategy: z.enum(['round-robin', 'fill-first']).nullable(),
  usageStatisticsEnabled: z.boolean(),
  providerCounts: z.array(z.object({provider: managedProviderSchema, count: counterSchema})),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/** Keep malformed payload details out of user-visible errors. */
export function parseProviderPayload<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error('The provider runtime returned an invalid response.');
  return parsed.data;
}
