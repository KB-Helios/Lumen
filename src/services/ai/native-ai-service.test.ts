import {invoke} from '@tauri-apps/api/core';
import {describe, expect, it, vi} from 'vitest';

import {DevelopmentFileSearchService} from '../search/development-file-search-service';
import {nativeAiService, type IndexRootInput} from './native-ai-service';

vi.mock('@tauri-apps/api/core', () => ({invoke: vi.fn()}));

const ready = {phase: 'ready', generation: 1, pendingItems: 0, indexedItems: 0, queuedEnrichment: 0, skippedItems: 0, message: 'Ready'};
const root = (path: string, cloudEnrichment = false): IndexRootInput => ({path, cloudEnrichment, exclusions: [], includeHidden: false, maxFileSizeMb: 256});

describe('shared native root admission', () => {
  it.each([
    {first: 'search', supersede: false}, {first: 'settings', supersede: false},
    {first: 'search', supersede: true}, {first: 'settings', supersede: true},
  ] as const)('orders both typed services with $first first and queued supersession=$supersede', async ({first, supersede}) => {
    let roots = ['C:\\Old'];
    let nativeRoots: IndexRootInput[] = [];
    const completed: string[][] = [];
    let releaseOld!: () => void;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'synchronize_index_roots') {
        const admitted = (args as {roots: IndexRootInput[]}).roots;
        if (admitted[0]?.path === 'C:\\Old') await new Promise<void>(resolve => {releaseOld = resolve;});
        nativeRoots = admitted;
        completed.push(admitted.map(value => value.path));
        return {...ready, generation: completed.length};
      }
      if (command === 'search_hybrid') return {items: [], semantic: {phase: 'disabled', reason: null}};
      return {...ready, generation: completed.length};
    });
    const service = new DevelopmentFileSearchService({getRoots: () => roots});
    const request = {requestId: 1, query: 'notes', scope: 'all' as const, filters: [], limit: 10};
    const older = first === 'search' ? service.search(request) : nativeAiService.synchronizeRoots([root('C:\\Old', true)]);
    await vi.waitFor(() => expect(releaseOld).toBeDefined());
    const searches = [older];
    if (supersede) {
      roots = ['C:\\Middle'];
      searches.push(first === 'search' ? nativeAiService.synchronizeRoots([root('C:\\Middle', true)]) : service.search({...request, requestId: 2}));
    }
    roots = ['C:\\New'];
    const newer = first === 'search' ? nativeAiService.synchronizeRoots([root('C:\\New')]) : service.search({...request, requestId: 2});
    searches.push(newer);
    await expect(nativeAiService.indexStatus()).resolves.toMatchObject({phase: 'ready'});
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseOld();
    await Promise.all(searches);
    expect(nativeRoots).toEqual([root('C:\\New')]);
    expect(completed).toEqual([['C:\\Old'], ['C:\\New']]);
  });
});
