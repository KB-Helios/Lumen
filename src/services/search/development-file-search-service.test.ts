import {describe, expect, it, vi} from 'vitest';

import {DevelopmentFileSearchService} from './development-file-search-service';

const request = {
  requestId: 7,
  query: 'read',
  scope: 'all' as const,
  filters: [],
  limit: 500,
};

function rustResponse() {
  return {
    items: [{
      path: 'C:\\Projects\\Readme.md',
      relativePath: 'Readme.md',
      name: 'Readme.md',
      kind: 'document',
      extension: 'md',
      sizeBytes: 128,
      modifiedMs: 1_786_000_000_000,
      score: 0.94,
      ranges: [[0, 4]],
    }],
    total: 1,
    truncated: false,
    elapsedMs: 2,
    warnings: [],
  };
}

describe('DevelopmentFileSearchService', () => {
  it('rejects a preview whose root is revoked while the native read is pending', async () => {
    let roots = ['C:\\Projects'];
    let finishPreview!: (value: unknown) => void;
    const service = new DevelopmentFileSearchService({getRoots: () => roots, invoke: async (command) => {
      if (command === 'search_filenames') return rustResponse();
      if (command === 'search_hybrid') return [];
      if (command === 'get_basic_preview') return new Promise((resolve) => {finishPreview = resolve;});
      return undefined;
    }});
    const result = (await service.search(request)).groups[0]!.items[0]!;
    const pending = service.getPreview(result.id);
    roots = [];
    finishPreview({kind: 'markdown', title: 'Readme.md', subtitle: result.path,
      text: 'revoked content', children: [], metadata: {}});
    await expect(pending).rejects.toMatchObject({code: 'permission-denied'});
  });

  it.each(['preview', 'open', 'folder'] as const)('rejects cached %s admission after its root is revoked', async (action) => {
    let roots = ['C:\\Projects'];
    const nativeActions: string[] = [];
    const service = new DevelopmentFileSearchService({
      getRoots: () => roots,
      invoke: async (command) => {
        if (command === 'search_filenames') return rustResponse();
        if (command === 'search_hybrid') return [];
        if (command !== 'synchronize_index_roots') nativeActions.push(command);
        return undefined;
      },
    });
    const result = (await service.search(request)).groups[0]!.items[0]!;
    roots = [];
    const pending = action === 'preview' ? service.getPreview(result.id)
      : action === 'open' ? service.openFile(result.id) : service.openContainingFolder(result.id);
    await expect(pending).rejects.toMatchObject({code: 'permission-denied'});
    expect(nativeActions).toEqual([]);
  });

  it('merges indexed content hits with provenance without replacing filename search', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'search_filenames') return {...rustResponse(), items: [], total: 0};
      if (command === 'search_hybrid') return [{
        stableId: 'indexed:report',
        rootPath: 'C:\\Projects',
        path: 'C:\\Projects\\Report.pdf',
        name: 'Report.pdf',
        contentHash: 'abc123',
        indexRevision: 4,
        extractionKind: 'pdf-text',
        page: 7,
        timeStartMs: null,
        timeEndMs: null,
        rank: -3.2,
        matchSource: 'semantic',
        semanticScore: 0.91,
        embeddingModel: 'lumen.embed.local',
        pinned: true,
      }];
      return {phase: 'ready', indexedItems: 1, queuedEnrichment: 0, skippedItems: 0, message: 'ready'};
    });
    const service = new DevelopmentFileSearchService({getRoots: () => ['C:\\Projects'], invoke});

    const response = await service.search(request);

    expect(response.groups[0]?.items[0]).toMatchObject({
      id: 'indexed:report',
      kind: 'pdf',
      match: {source: 'semantic'},
      pinned: true,
      provenance: {
        extractionKind: 'pdf-text',
        fileHash: 'abc123',
        page: 7,
        embeddingModel: 'lumen.embed.local',
        indexRevision: 4,
      },
    });
  });

  it('waits for root synchronization before searching indexed content', async () => {
    let finishSynchronization: (() => void) | undefined;
    const invoke = vi.fn((command: string) => {
      if (command === 'synchronize_index_roots') {
        return new Promise<void>((resolve) => { finishSynchronization = resolve; });
      }
      if (command === 'search_filenames') return Promise.resolve({...rustResponse(), items: [], total: 0});
      if (command === 'search_hybrid') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const service = new DevelopmentFileSearchService({getRoots: () => ['C:\\Projects'], invoke});

    const search = service.search(request);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('synchronize_index_roots', expect.anything()));
    expect(invoke).not.toHaveBeenCalledWith('search_hybrid', expect.anything());

    finishSynchronization?.();
    await expect(search).resolves.toMatchObject({total: 0});
    expect(invoke).toHaveBeenCalledWith('search_hybrid', expect.objectContaining({
      requestId: 7,
      query: 'read',
      scope: 'all',
      limit: 500,
      semanticEnabled: false,
      rerankingEnabled: false,
    }));
  });

  it('sends every configured root policy to native synchronization', async () => {
    const invoke = vi.fn(async (command: string) => command === 'search_filenames'
      ? {...rustResponse(), items: [], total: 0}
      : command === 'search_hybrid' ? [] : undefined);
    const service = new DevelopmentFileSearchService({
      getRoots: () => ['C:\\Projects'],
      getRootConfigurations: () => [{
        id: 'projects',
        path: 'C:\\Projects',
        cloudEnrichment: true,
        exclusions: ['cache', '*.tmp'],
        includeHidden: true,
        maxFileSizeMb: 64,
      }],
      invoke,
    });

    await service.search(request);

    expect(invoke).toHaveBeenCalledWith('synchronize_index_roots', {roots: [{
      path: 'C:\\Projects',
      cloudEnrichment: true,
      exclusions: ['cache', '*.tmp'],
      includeHidden: true,
      maxFileSizeMb: 64,
    }]});
  });

  it('maps Tauri filename matches into stable SearchResult values', async () => {
    const invoke = vi.fn(async () => rustResponse());
    const service = new DevelopmentFileSearchService({getRoots: () => ['C:\\Projects'], invoke});

    const first = await service.search(request);
    const second = await service.search({...request, requestId: 8});

    expect(invoke).toHaveBeenCalledWith('search_filenames', {root: 'C:\\Projects', query: 'read'});
    expect(first.groups[0]?.items[0]).toMatchObject({
      id: expect.stringMatching(/^local:/),
      name: 'Readme.md',
      kind: 'document',
      match: {source: 'filename', fragment: 'Readme.md', score: 0.94},
    });
    expect(second.groups[0]?.items[0]?.id).toBe(first.groups[0]?.items[0]?.id);
  });

  it('sends persisted ranking preferences to the native ranker', async () => {
    const now = Date.now();
    const invoke = vi.fn(async (command: string) => {
      if (command === 'search_filenames') return {
        ...rustResponse(),
        items: [
          {...rustResponse().items[0], name: 'Older exact.md', relativePath: 'Older exact.md', path: 'C:\\Projects\\Older exact.md', score: 0.95, modifiedMs: now - 120 * 86_400_000},
          {...rustResponse().items[0], name: 'Recent readme.md', relativePath: 'Recent readme.md', path: 'C:\\Projects\\Recent readme.md', score: 0.82, modifiedMs: now},
        ],
        total: 2,
      };
      if (command === 'search_hybrid') return [];
      return undefined;
    });
    const service = new DevelopmentFileSearchService({
      getRoots: () => ['C:\\Projects'],
      getSearchPreferences: () => ({
        filenamePriority: 20,
        recency: 'high',
        showPinned: true,
        semanticEnabled: false,
        rerankingEnabled: true,
      }),
      invoke,
    });

    const response = await service.search(request);

    expect(response.groups[0]?.items.map((item) => item.name)).toEqual([
      'Older exact.md',
      'Recent readme.md',
    ]);
    expect(invoke).toHaveBeenCalledWith('search_hybrid', expect.objectContaining({
      filenamePriority: 20,
      recency: 'high',
      rerankingEnabled: true,
    }));
  });

  it('maps previews and opener commands through the known confined file', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'search_filenames') return rustResponse();
      if (command === 'get_basic_preview') return {
        kind: 'markdown',
        title: 'Readme.md',
        subtitle: 'C:\\Projects\\Readme.md',
        text: '# Readme',
        sourceUrl: null,
        mimeType: null,
        children: [],
        metadata: {Type: 'MD'},
      };
      return undefined;
    });
    const service = new DevelopmentFileSearchService({getRoots: () => ['C:\\Projects'], invoke});
    const response = await service.search(request);
    const id = response.groups[0]?.items[0]?.id ?? '';

    await expect(service.getPreview(id)).resolves.toMatchObject({fileId: id, kind: 'markdown', text: '# Readme'});
    await service.openFile(id);
    await service.openContainingFolder(id);

    expect(invoke).toHaveBeenCalledWith('get_basic_preview', {root: 'C:\\Projects', path: 'C:\\Projects\\Readme.md'});
    expect(invoke).toHaveBeenCalledWith('open_file', {root: 'C:\\Projects', path: 'C:\\Projects\\Readme.md'});
    expect(invoke).toHaveBeenCalledWith('open_containing_folder', {root: 'C:\\Projects', path: 'C:\\Projects\\Readme.md'});
  });

  it('routes Related through the selected indexed result and applies pins natively', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'search_related') return [{
        stableId: 'indexed:related',
        rootPath: 'C:\\Projects',
        path: 'C:\\Projects\\Related.md',
        name: 'Related.md',
        contentHash: 'related-hash',
        indexRevision: 1,
        extractionKind: 'text',
        page: null,
        timeStartMs: null,
        timeEndMs: null,
        rank: 0.1,
        matchSource: 'related',
        semanticScore: 0.9,
        embeddingModel: 'lumen.embed.local',
        pinned: false,
      }];
      if (command === 'set_indexed_file_pinned') return {applied: true, pinned: true};
      return undefined;
    });
    const service = new DevelopmentFileSearchService({getRoots: () => ['C:\\Projects'], invoke});

    const response = await service.search({...request, scope: 'related', relatedTo: 'indexed:source'});
    expect(response.groups[0]?.items[0]).toMatchObject({
      id: 'indexed:related',
      match: {source: 'related'},
    });
    await expect(service.setPinned('indexed:related', true)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('search_related', {stableId: 'indexed:source', limit: 500});
    expect(invoke).toHaveBeenCalledWith('set_indexed_file_pinned', {
      stableId: 'indexed:related',
      pinned: true,
    });
  });

  it('keeps canonical paths for native commands while presenting friendly Windows values', async () => {
    const canonicalPath = '\\\\?\\C:\\Projects\\Readme.md';
    const response = rustResponse();
    response.items[0]!.path = canonicalPath;
    const invoke = vi.fn(async (command: string) => {
      if (command === 'search_filenames') return response;
      if (command === 'get_basic_preview') return {
        kind: 'markdown',
        title: 'Readme.md',
        subtitle: canonicalPath,
        text: '# Readme',
        sourceUrl: null,
        mimeType: null,
        children: [],
        metadata: {Modified: '1786000000000', Size: '128', Type: 'MD'},
      };
      return undefined;
    });
    const service = new DevelopmentFileSearchService({getRoots: () => ['C:\\Projects'], invoke});
    const search = await service.search(request);
    const result = search.groups[0]?.items[0];

    expect(result?.path).toBe('C:\\Projects\\Readme.md');
    const preview = await service.getPreview(result?.id ?? '');
    expect(preview.subtitle).toBe('C:\\Projects\\Readme.md');
    expect(preview.metadata).toMatchObject({Size: '128 B', Type: 'MD'});
    expect(preview.metadata?.Modified).not.toBe('1786000000000');

    await service.openFile(result?.id ?? '');
    expect(invoke).toHaveBeenCalledWith('open_file', {
      root: 'C:\\Projects',
      path: canonicalPath,
    });
  });

  it('returns the no-root state without invoking native traversal', async () => {
    const invoke = vi.fn();
    const service = new DevelopmentFileSearchService({getRoots: () => [], invoke});
    const statuses: string[] = [];
    service.subscribeToStatus((status) => statuses.push(status.message ?? ''));

    await expect(service.search(request)).resolves.toMatchObject({groups: [], total: 0});
    expect(invoke).not.toHaveBeenCalled();
    expect(statuses[statuses.length - 1]).toBe('No indexed roots');
  });

  it('preserves structured permission failures', async () => {
    const invoke = vi.fn(async () => Promise.reject({
      code: 'permission-denied',
      message: 'Root access was denied.',
      recoverable: true,
    }));
    const service = new DevelopmentFileSearchService({getRoots: () => ['C:\\Private'], invoke});

    await expect(service.search(request)).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'Root access was denied.',
    });
  });

  it('honors aborts around non-cancellable invoke calls', async () => {
    let resolveInvoke: ((value: unknown) => void) | undefined;
    const invoke = vi.fn(() => new Promise((resolve) => { resolveInvoke = resolve; }));
    const service = new DevelopmentFileSearchService({getRoots: () => ['C:\\Projects'], invoke});
    const controller = new AbortController();
    const pending = service.search(request, controller.signal);
    controller.abort();
    resolveInvoke?.(rustResponse());

    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
  });
});
