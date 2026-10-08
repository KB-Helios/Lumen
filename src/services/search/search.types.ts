import {z} from 'zod';
import {windowsAiSettingsPages} from '../windows-ai/windows-ai.types';

export const searchScopeSchema = z.enum([
  'all',
  'files',
  'folders',
  'documents',
  'code',
  'images',
  'recent',
  'related',
  'app-content',
]);
export type SearchScope = z.infer<typeof searchScopeSchema>;

export const searchResultKindSchema = z.enum([
  'folder',
  'pdf',
  'document',
  'spreadsheet',
  'presentation',
  'source',
  'image',
  'video',
  'audio',
  'archive',
  'executable',
  'model',
  'unknown',
  'app-content',
]);
export type SearchResultKind = z.infer<typeof searchResultKindSchema>;

export const searchAvailabilitySchema = z.enum([
  'available',
  'loading',
  'unavailable',
  'permissionDenied',
]);
export type SearchAvailability = z.infer<typeof searchAvailabilitySchema>;

export const matchSourceSchema = z.enum([
  'filename',
  'content',
  'metadata',
  'ocr',
  'semantic',
  'related',
]);

export const searchMatchSchema = z.object({
  source: matchSourceSchema,
  fragment: z.string().optional(),
  ranges: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().positive()])).optional(),
  score: z.number().min(0).max(1).optional(),
});
export type SearchMatch = z.infer<typeof searchMatchSchema>;

export const searchMetadataSchema = z.object({
  extension: z.string().optional(),
  modifiedAt: z.iso.datetime().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dimensions: z.string().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  tags: z.array(z.string()).optional(),
});
export type SearchMetadata = z.infer<typeof searchMetadataSchema>;

export const searchProvenanceSchema = z.object({
  extractionKind: z.string().min(1),
  fileHash: z.string().min(1),
  page: z.number().int().positive().optional(),
  timeStartMs: z.number().int().nonnegative().optional(),
  timeEndMs: z.number().int().nonnegative().optional(),
  embeddingModel: z.string().min(1).optional(),
  indexRevision: z.number().int().positive(),
});
export type SearchProvenance = z.infer<typeof searchProvenanceSchema>;

export const searchResultSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  kind: searchResultKindSchema,
  match: searchMatchSchema,
  metadata: searchMetadataSchema,
  provenance: searchProvenanceSchema.optional(),
  pinned: z.boolean().optional(),
  availability: searchAvailabilitySchema.optional().default('available'),
  target: z.object({kind: z.literal('app-content'), itemId: z.string().min(1).max(80), settingsPage: z.enum(windowsAiSettingsPages)}).optional(),
}).refine((result) => result.kind === 'app-content' ? result.target !== undefined : result.target === undefined, {message: 'Only app content results may carry a settings target.'});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchFilterSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1),
});
export type SearchFilter = z.infer<typeof searchFilterSchema>;

export const searchRequestSchema = z.object({
  requestId: z.number().int().positive(),
  query: z.string(),
  scope: searchScopeSchema,
  filters: z.array(searchFilterSchema).default([]),
  limit: z.number().int().positive().max(10_000).default(500),
  relatedTo: z.string().min(1).optional(),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export interface SearchGroup {
  id: string;
  label: string;
  items: readonly SearchResult[];
}

export const searchGroupSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  items: z.array(searchResultSchema),
});

export interface SearchResponse {
  requestId: number;
  groups: readonly SearchGroup[];
  elapsedMs: number;
  total: number;
}

export const searchResponseSchema = z.object({
  requestId: z.number().int().positive(),
  groups: z.array(searchGroupSchema),
  elapsedMs: z.number().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const searchStatusSchema = z.object({
  phase: z.enum(['idle', 'indexing', 'ready', 'paused', 'degraded']),
  indexedItems: z.number().int().nonnegative().optional(),
  generation: z.number().int().nonnegative().optional(),
  pendingItems: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
  updatedAt: z.iso.datetime(),
});
export type SearchStatus = z.infer<typeof searchStatusSchema>;

export const searchErrorSchema = z.object({
  code: z.enum([
    'search-failed',
    'preview-failed',
    'permission-denied',
    'unavailable',
    'invalid-response',
  ]),
  message: z.string().min(1),
  recoverable: z.boolean().default(true),
});
export type SearchError = z.infer<typeof searchErrorSchema>;

export const previewKindSchema = z.enum([
  'folder',
  'text',
  'source',
  'markdown',
  'pdf',
  'document',
  'presentation',
  'spreadsheet',
  'image',
  'audio',
  'video',
  'unsupported',
  'permissionDenied',
]);
export type PreviewKind = z.infer<typeof previewKindSchema>;

export const filePreviewSchema = z.object({
  fileId: z.string().min(1),
  kind: previewKindSchema,
  title: z.string().min(1),
  subtitle: z.string().optional(),
  text: z.string().optional(),
  sourceUrl: z.string().optional(),
  mimeType: z.string().optional(),
  rows: z.array(z.array(z.string())).optional(),
  columns: z.array(z.string()).optional(),
  children: z.array(z.object({id: z.string(), name: z.string(), kind: searchResultKindSchema})).optional(),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type FilePreview = z.infer<typeof filePreviewSchema>;

export function flattenSearchGroups(groups: readonly SearchGroup[]): SearchResult[] {
  return groups.flatMap((group) => group.items);
}

export function isSelectableResult(result: SearchResult): boolean {
  return (result.availability ?? 'available') === 'available';
}

