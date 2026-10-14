import {invoke} from '@tauri-apps/api/core';
import {z} from 'zod';

import {isNativeRuntime} from '../ai/native-ai-service';

export const semanticSearchStatusSchema = z.object({
  vectorAvailable: z.boolean(),
  semanticAvailable: z.boolean(),
  relatedAvailable: z.boolean(),
  indexedChunks: z.number().int().nonnegative(),
  pendingJobs: z.number().int().nonnegative(),
  reason: z.string().nullable(),
});

export type SemanticSearchStatus = z.infer<typeof semanticSearchStatusSchema>;

export interface SemanticSearchService {
  status(): Promise<SemanticSearchStatus>;
}

const unavailableStatus: SemanticSearchStatus = {
  vectorAvailable: false,
  semanticAvailable: false,
  relatedAvailable: false,
  indexedChunks: 0,
  pendingJobs: 0,
  reason: 'Semantic search status is available in the Windows app.',
};

export const unavailableSemanticSearchService: SemanticSearchService = {
  async status() { return unavailableStatus; },
};

export const semanticSearchService: SemanticSearchService = {
  async status() {
    if (!isNativeRuntime()) return unavailableStatus;
    return semanticSearchStatusSchema.parse(await invoke('get_semantic_search_status'));
  },
};
