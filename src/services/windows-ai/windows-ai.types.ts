import {z} from 'zod';

export const windowsAiFeatureIds = [
  'languageModel', 'aion', 'summarize', 'rewrite', 'ocr', 'imageDescription',
  'appContentSearch', 'agentDiscovery', 'agentInvocation', 'agentRegistration',
  'edgePrompt', 'edgeSummarize', 'edgeWrite', 'edgeRewrite',
  'edgeLanguageDetection', 'edgeTranslation', 'edgeSpeech',
] as const;
export const windowsAiFeatureIdSchema = z.enum(windowsAiFeatureIds);
export type WindowsAiFeatureId = z.infer<typeof windowsAiFeatureIdSchema>;

export const windowsAiAvailabilitySchema = z.enum([
  'ready', 'downloadable', 'preparing', 'unavailable', 'accessRequired',
  'identityRequired', 'runtimeRequired', 'unsupported', 'disabled', 'failed',
]);
export const windowsAiFeatureSchema = z.object({
  id: windowsAiFeatureIdSchema,
  host: z.enum(['windows', 'edge']),
  label: z.string().min(1).max(120),
  availability: windowsAiAvailabilitySchema,
  reasonCode: z.string().min(1).max(80),
  detail: z.string().max(600).nullable(),
  enabled: z.boolean(),
  model: z.string().max(160).nullable(),
});
export type WindowsAiFeature = z.infer<typeof windowsAiFeatureSchema>;

export const windowsAiEngineSchema = z.enum(['auto', 'runtime', 'windows', 'aion', 'edge']);
export type WindowsAiEngine = z.infer<typeof windowsAiEngineSchema>;
const languageSchema = z.string().min(2).max(35).regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/);
export const windowsAiPreferencesSchema = z.object({
  localEngine: windowsAiEngineSchema.default('auto'),
  windowsEnabled: z.boolean().default(false),
  modelDownloadsAllowed: z.boolean().default(false),
  appContentEnabled: z.boolean().default(false),
  agentsEnabled: z.boolean().default(false),
  registerLumenAgent: z.boolean().default(false),
  textToolsEnabled: z.boolean().default(false),
  ocrEnabled: z.boolean().default(false),
  imageDescriptionsEnabled: z.boolean().default(false),
  edgeEnabled: z.boolean().default(false),
  dictationEnabled: z.boolean().default(false),
  sourceLanguage: languageSchema.default('en'),
  targetLanguage: languageSchema.default('sv'),
  speechLanguage: languageSchema.default('en-US'),
  keepWarm: z.boolean().default(false),
});
export type WindowsAiPreferences = z.infer<typeof windowsAiPreferencesSchema>;
export const windowsAiPreferencePatchSchema = windowsAiPreferencesSchema.partial().strict();
export const defaultWindowsAiPreferences = windowsAiPreferencesSchema.parse({});

export const windowsAgentSchema = z.object({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(256),
  displayName: z.string().min(1).max(160),
  description: z.string().max(600),
  packageFamilyName: z.string().min(1).max(256),
  actionId: z.string().min(1).max(256),
});
export type WindowsAgent = z.infer<typeof windowsAgentSchema>;

export const windowsAiHostSchema = z.object({
  osBuild: z.string().max(64),
  architecture: z.enum(['x64', 'arm64', 'x86', 'unknown']),
  packageIdentity: z.boolean(),
  runtimeVersion: z.string().max(100).nullable(),
  npuProviders: z.array(z.string().max(200)).max(32),
});
export const windowsAiIndexSchema = z.object({
  state: z.enum(['disabled', 'ready', 'indexing', 'unavailable', 'error']),
  items: z.number().int().min(0).max(1000),
});
export const windowsAiSnapshotSchema = z.object({
  version: z.literal(1),
  host: windowsAiHostSchema,
  features: z.array(windowsAiFeatureSchema).max(32),
  preferences: windowsAiPreferencesSchema,
  agents: z.array(windowsAgentSchema).max(128),
  appIndex: windowsAiIndexSchema,
  accessTokenConfigured: z.boolean(),
});
export type WindowsAiSnapshot = z.infer<typeof windowsAiSnapshotSchema>;

export const windowsAiRequestIdSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/);
export const windowsAiTextTaskSchema = z.enum(['answer', 'summarize', 'rewrite', 'write', 'translate', 'detectLanguage']);
export type WindowsAiTextTask = z.infer<typeof windowsAiTextTaskSchema>;
export const windowsAiTextRequestSchema = z.object({
  requestId: windowsAiRequestIdSchema,
  engine: z.enum(['windows', 'aion', 'edge']),
  task: windowsAiTextTaskSchema,
  text: z.string().trim().min(1).max(65_536),
  sourceLanguage: languageSchema.optional(),
  targetLanguage: languageSchema.optional(),
}).strict();
export type WindowsAiTextRequest = z.infer<typeof windowsAiTextRequestSchema>;
export const windowsAiImageRequestSchema = z.object({
  requestId: windowsAiRequestIdSchema,
  fileId: z.string().min(1).max(2048),
  operation: z.enum(['ocr', 'describe']),
}).strict();
export type WindowsAiImageRequest = z.infer<typeof windowsAiImageRequestSchema>;
export const windowsAiCitationSchema = z.object({
  fileId: z.string().min(1).max(2048), label: z.string().min(1).max(512),
  page: z.number().int().positive().optional(), timestampSeconds: z.number().nonnegative().optional(),
});
export const windowsAiTextResultSchema = z.object({
  text: z.string().max(262_144),
  engine: z.enum(['windows', 'aion', 'edge']),
  model: z.string().max(160).nullable(),
  citations: z.array(windowsAiCitationSchema).max(20).default([]),
  detectedLanguage: languageSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type WindowsAiTextResult = z.infer<typeof windowsAiTextResultSchema>;

export const windowsAiEventSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('delta'), requestId: windowsAiRequestIdSchema, text: z.string().max(65_536)}),
  z.object({type: z.literal('progress'), requestId: windowsAiRequestIdSchema, phase: z.string().max(160), progress: z.number().min(0).max(1).nullable()}),
  z.object({type: z.literal('completed'), requestId: windowsAiRequestIdSchema}),
  z.object({type: z.literal('cancelled'), requestId: windowsAiRequestIdSchema}),
  z.object({type: z.literal('failed'), requestId: windowsAiRequestIdSchema, code: z.string().max(80), message: z.string().max(600)}),
]);
export type WindowsAiEvent = z.infer<typeof windowsAiEventSchema>;

export const windowsAiSettingsPages = ['general', 'appearance', 'indexed-roots', 'search', 'local-ai', 'agent-gateway', 'computer-use', 'activity', 'privacy', 'diagnostics'] as const;
export const appContentMatchSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  description: z.string().max(1000),
  settingsPage: z.enum(windowsAiSettingsPages),
  source: z.enum(['semantic', 'lexical']),
});
export type AppContentMatch = z.infer<typeof appContentMatchSchema>;
export const windowsAiOperationResultSchema = z.object({ok: z.boolean(), message: z.string().max(600), code: z.string().max(80).optional()});
export type WindowsAiOperationResult = z.infer<typeof windowsAiOperationResultSchema>;
export const windowsAgentActivationSchema = z.object({activationId: windowsAiRequestIdSchema, agentName: z.literal('lumen.browser'), prompt: z.string().trim().min(1).max(4000)});
export type WindowsAgentActivation = z.infer<typeof windowsAgentActivationSchema>;

export function canUseWindowsAiFeature(feature: WindowsAiFeature | undefined): boolean {
  return feature?.enabled === true && feature.availability === 'ready';
}
