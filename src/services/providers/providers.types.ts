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
