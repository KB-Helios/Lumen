import {describe, expect, it, vi} from 'vitest';

import {DevelopmentFileSearchService} from './development-file-search-service';

const readyStatus = {phase: 'ready', generation: 1, pendingItems: 0, indexedItems: 1, queuedEnrichment: 0, skippedItems: 0, message: 'Ready'};

function createService(options: ConstructorParameters<typeof DevelopmentFileSearchService>[0]) {
  return new DevelopmentFileSearchService({...options, invoke: async (command, args) => {
    const value = await options.invoke?.(command, args);
    return value === undefined && (command === 'synchronize_index_roots' || command === 'get_index_status') ? readyStatus : value;
  }});
}

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

function indexedHit(name: string, rank = 0.1) {
  return {stableId: `indexed:${name}`, rootPath: 'C:\\Projects', path: `C:\\Projects\\${name}`,
    name, contentHash: 'hash', indexRevision: 1, extractionKind: 'metadata', rank,
    matchSource: 'filename', pinned: true,
    metadata: {...rustResponse().items[0], name, path: `C:\\Projects\\${name}`, relativePath: name}};
}

function nativeResponse(items: unknown[]) {
  return {items, semantic: {phase: 'disabled', reason: null}};
}

describe('DevelopmentFileSearchService', () => {
  it('blocks native reads and admissions until root policy is ready, then admits configured and empty policies', async () => {
    let ready = false;
    let roots = ['C:\\Projects'];
    const invoke = vi.fn(async (command: string) => command === 'search_hybrid' ? nativeResponse([indexedHit('Readme.md')]) : undefined);
    const options = {getRoots: () => roots, isReady: () => ready, invoke};
    const service = createService(options);
    await expect(service.search(request)).rejects.toMatchObject({code: 'unavailable'});
    expect(invoke).not.toHaveBeenCalled();
    ready = true;
    expect((await service.search(request)).total).toBe(1);
    ready = false;
    invoke.mockClear();
    await expect(service.openFile('indexed:Readme.md')).rejects.toMatchObject({code: 'unavailable'});
    await expect(service.getPreview('indexed:Readme.md')).rejects.toMatchObject({code: 'unavailable'});
    expect(invoke).not.toHaveBeenCalled();
    ready = true;
    roots = [];
    expect((await service.search(request)).total).toBe(0);
    expect(invoke).toHaveBeenCalledWith('synchronize_index_roots', {roots: []});
  });

  it.each(['UNC', 'unc'])('admits extended %s paths under ordinary UNC roots and preserves canonical opener paths', async prefix => {
    let roots = ['\\\\server\\share'];
    const root = `\\\\?\\${prefix}\\server\\share`;
    const path = `${root}\\Readme.md`;
    const hit = {...indexedHit('Readme.md'), rootPath: root, path};
    const invoke = vi.fn(async (command: string) => {
      if (command === 'search_hybrid') return nativeResponse([hit, {...hit, stableId: 'indexed:duplicate', rootPath: roots[0], path: '\\\\server\\share\\Readme.md'}]);
      if (command === 'get_basic_preview') return {kind: 'markdown', title: 'Readme.md', subtitle: path, text: '# Readme', children: [], metadata: {}};
    });
    const service = createService({getRoots: () => roots,
      getRootConfigurations: () => [{id: 'unc', path: root, cloudEnrichment: false, exclusions: [], includeHidden: false, maxFileSizeMb: 256}], invoke});
    const response = await service.search(request);
    expect(invoke).toHaveBeenCalledWith('synchronize_index_roots', {roots: [{path: root, cloudEnrichment: false, exclusions: [], includeHidden: false, maxFileSizeMb: 256}]});
    expect(response.groups[0]?.items.map(item => [item.id, item.path])).toEqual([['indexed:Readme.md', '\\\\server\\share\\Readme.md']]);
    await expect(service.getPreview('indexed:Readme.md')).resolves.toMatchObject({subtitle: '\\\\server\\share\\Readme.md'});
    await service.openFile('indexed:Readme.md');
    await service.openContainingFolder('indexed:Readme.md');
    expect(invoke).toHaveBeenCalledWith('open_file', {root, path});
    expect(invoke).toHaveBeenCalledWith('open_containing_folder', {root, path});
    roots = [];
    invoke.mockClear();
    await expect(service.openFile('indexed:Readme.md')).rejects.toMatchObject({code: 'permission-denied'});
    expect(invoke).not.toHaveBeenCalled();
  });

  it('blocks status polling until the root-policy provider is ready', async () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async () => readyStatus);
    const options = {getRoots: () => ['C:\\Projects'], isReady: () => false, invoke};
    const service = createService(options);
    const statuses: string[] = [];
    const unsubscribe = service.subscribeToStatus(status => statuses.push(status.message ?? ''));
    try {
      await vi.advanceTimersByTimeAsync(2000);
      expect(invoke).not.toHaveBeenCalled();
      expect(statuses[0]).toMatch(/loading/i);
    } finally { unsubscribe(); vi.useRealTimers(); }
  });

  it('closes query and fallback admission when readiness is withdrawn during root synchronization', async () => {
    let ready = true;
    let finish!: () => void;
    const invoke = vi.fn(async (command: string) => {
      if (command === 'synchronize_index_roots') await new Promise<void>(resolve => {finish = resolve;});
      return readyStatus;
    });
    const options = {getRoots: () => ['C:\\Projects'], isReady: () => ready, invoke};
    const service = createService(options);
    const pending = service.search(request);
    await vi.waitFor(() => expect(finish).toBeDefined());
    ready = false;
    finish();
    await expect(pending).rejects.toMatchObject({code: 'unavailable'});
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('reports rejected fallback roots and incomplete traversal without exposing native details', async () => {
    const statuses: string[] = [];
    const service = createService({getRoots: () => ['C:\\Projects', 'C:\\Private'], invoke: async (command, args) => {
      if (command === 'search_hybrid') throw new Error('index offline');
      if (command === 'search_filenames') {
        if (args?.root === 'C:\\Private') throw new Error('secret-token private path');
        return {...rustResponse(), truncated: true, warnings: [{path: 'secret path', message: 'secret-token'}]};
      }
    }});
    const unsubscribe = service.subscribeToStatus(status => statuses.push(status.message ?? ''));
    try {
      expect((await service.search(request)).total).toBe(1);
      const message = statuses[statuses.length - 1]!;
      expect(message).toMatch(/1 root.*failed/i);
      expect(message).toMatch(/1 traversal warning/i);
      expect(message).toMatch(/truncat/i);
      expect(message).not.toMatch(/secret|private/i);
      expect(message.length).toBeLessThanOrEqual(256);
    } finally { unsubscribe(); }
  });

  it('keeps an entirely rejected fallback a structured failure', async () => {
    const service = createService({getRoots: () => ['C:\\Projects', 'C:\\Other'], invoke: async command => {
      if (command.startsWith('search_')) throw {code: 'search-failed', message: 'Index unavailable', recoverable: true};
    }});
    await expect(service.search(request)).rejects.toMatchObject({code: 'search-failed', recoverable: true});
  });

  it.each(['abort', 'revoke'] as const)('does not admit fallback files after pending traversal %s', async action => {
    let roots = ['C:\\Projects'];
    let finish!: (value: unknown) => void;
    const statuses: string[] = [];
    const service = createService({getRoots: () => roots, invoke: async command => {
      if (command === 'search_hybrid') throw new Error('offline');
      if (command === 'search_filenames') return new Promise(resolve => {finish = resolve;});
    }});
    const unsubscribe = service.subscribeToStatus(status => statuses.push(status.message ?? ''));
    const controller = new AbortController();
    const pending = service.search(request, controller.signal);
    try {
      await vi.waitFor(() => expect(finish).toBeDefined());
      if (action === 'abort') controller.abort();
      else roots = [];
      finish({...rustResponse(), warnings: [{path: 'private', message: 'secret'}], truncated: true});
      if (action === 'abort') {
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(statuses).toHaveLength(1);
      } else await expect(pending).resolves.toMatchObject({groups: [], total: 0});
      await expect(service.openFile('local:c%3A%2Fprojects%00readme.md')).rejects.toMatchObject({code: 'unavailable'});
    } finally { unsubscribe(); }
  });

  it.each(['content', 'ocr', 'semantic', 'related'] as const)('preserves the bounded native %s excerpt', async matchSource => {
    const snippet = 'excerpt '.repeat(200);
    const service = createService({getRoots: () => ['C:\\Projects'], invoke: async command => {
      const items = [{...indexedHit('Readme.md'), matchSource, snippet}];
      if (command === 'search_related') return items;
      if (command === 'search_hybrid') return nativeResponse(items);
    }});
    const result = await service.search({...request, scope: matchSource === 'related' ? 'related' : 'all', relatedTo: 'indexed:source'});
    expect(result.groups[0]?.items[0]?.match.fragment).toBe(snippet.slice(0, 1000));
  });

  it('keeps filename display independent of a native excerpt and rejects untyped excerpts', async () => {
    let snippet: unknown = 'content body';
    const service = createService({getRoots: () => ['C:\\Projects'], invoke: async command => {
      if (command === 'search_hybrid') return nativeResponse([{...indexedHit('Readme.md'), snippet}]);
    }});
    expect((await service.search(request)).groups[0]?.items[0]?.match.fragment).toBeUndefined();
    snippet = {text: 'untyped body'};
    await expect(service.search(request)).rejects.toMatchObject({code: 'invalid-response'});
  });
  it.each([false, true])('orders already-issued admission mutations and discards superseded queued roots=%s', async queueSuperseded => {
    let roots = ['C:\\Old'];
    let nativeRoots: string[] = [];
    const completed: string[][] = [];
    let releaseOld!: () => void;
    const service = createService({getRoots: () => roots, invoke: async (command, args) => {
      if (command === 'synchronize_index_roots') {
        const admitted = (args?.roots as {path: string}[]).map(root => root.path);
        if (admitted[0] === 'C:\\Old') await new Promise<void>(resolve => {releaseOld = resolve;});
        nativeRoots = admitted;
        completed.push(admitted);
        return {...readyStatus, generation: completed.length};
      }
      if (command === 'search_hybrid') return nativeResponse([]);
      return {...readyStatus, generation: completed.length};
    }});
    const older = service.search(request);
    await vi.waitFor(() => expect(releaseOld).toBeDefined());
    const searches = [older];
    if (queueSuperseded) {
      roots = ['C:\\Middle'];
      searches.push(service.search({...request, requestId: 8}));
    }
    roots = ['C:\\New'];
    searches.push(service.search({...request, requestId: 9}));
    // Allow already-issued New IPCs to finish before Old at the broken boundary.
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseOld();
    await Promise.all(searches);
    expect(nativeRoots).toEqual(['C:\\New']);
    expect(completed).toEqual([['C:\\Old'], ['C:\\New']]);
  });
  it('publishes recovery after a failed poll even when healthy native status is unchanged', async () => {
    vi.useFakeTimers();
    let failPoll = true;
    const phases: string[] = [];
    const service = createService({getRoots: () => ['C:\\Projects'], invoke: async command => {
      if (command === 'get_index_status' && failPoll) throw new Error('temporarily unavailable');
      if (command === 'search_hybrid') return nativeResponse([]);
      return readyStatus;
    }});
    const unsubscribe = service.subscribeToStatus(status => phases.push(status.phase));
    try {
      await service.search(request);
      await vi.advanceTimersByTimeAsync(1000);
      expect(phases[phases.length - 1]).toBe('degraded');
      failPoll = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(phases[phases.length - 1]).toBe('ready');
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });
  it('does not re-admit revoked roots when an older status read finishes after a new admission', async () => {
    let roots = ['C:\\Old'];
    let releaseStatus!: (value: unknown) => void;
    const admissions: string[][] = [];
    let delayStatus = false;
    const service = createService({getRoots: () => roots, invoke: async (command, args) => {
      if (command === 'synchronize_index_roots') {
        admissions.push((args?.roots as {path: string}[]).map(root => root.path));
        return {...readyStatus, generation: admissions.length};
      }
      if (command === 'get_index_status' && delayStatus) return new Promise(resolve => {releaseStatus = resolve;});
      if (command === 'search_hybrid') return nativeResponse([]);
      return readyStatus;
    }});
    await service.search(request);
    delayStatus = true;
    const olderSearch = service.search({...request, requestId: 8});
    await vi.waitFor(() => expect(releaseStatus).toBeDefined());
    roots = ['C:\\New'];
    await service.search({...request, requestId: 9});
    releaseStatus({...readyStatus, generation: 1});
    await olderSearch;
    expect(admissions).toEqual([['C:\\Old'], ['C:\\New']]);
  });
  it('updates subscribed native progress after asynchronous work completes without another query', async () => {
    vi.useFakeTimers();
    let phase = 'indexing';
    const phases: string[] = [];
    const service = createService({getRoots: () => ['C:\\Projects'], invoke: async command => {
      if (command === 'synchronize_index_roots' || command === 'get_index_status') return {...readyStatus, phase, pendingItems: phase === 'indexing' ? 1 : 0};
      if (command === 'search_hybrid') return nativeResponse([]);
    }});
    const unsubscribe = service.subscribeToStatus(status => phases.push(status.phase));
    try {
      await service.search(request);
      phase = 'ready';
      await vi.advanceTimersByTimeAsync(1000);
      expect(phases[phases.length - 1]).toBe('ready');
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });
  it.each(['indexing', 'paused'] as const)('keeps native %s status after usable inventory search', async phase => {
    const statuses: string[] = [];
    const service = createService({getRoots: () => ['C:\\Projects'], invoke: async command => {
      if (command === 'synchronize_index_roots' || command === 'get_index_status') return {phase, generation: 1, pendingItems: 2, indexedItems: 5, queuedEnrichment: 0, skippedItems: 0, message: 'Pending native content'};
      if (command === 'search_hybrid') return nativeResponse([indexedHit('Readme.md')]);
    }});
    service.subscribeToStatus(status => statuses.push(status.phase));
    expect((await service.search(request)).total).toBe(1);
    expect(statuses[statuses.length - 1]).toBe(phase);
  });

  it('re-admits unchanged roots after index deletion invalidates the native generation', async () => {
    let generation = 1;
    let admissions = 0;
    const service = createService({getRoots: () => ['C:\\Projects'], invoke: async command => {
      if (command === 'synchronize_index_roots') {admissions++; return {phase: 'ready', generation, pendingItems: 0, indexedItems: 1, queuedEnrichment: 0, skippedItems: 0, message: 'Ready'};}
      if (command === 'get_index_status') return {phase: 'ready', generation, pendingItems: 0, indexedItems: 0, queuedEnrichment: 0, skippedItems: 0, message: 'Deleted'};
      if (command === 'search_hybrid') return nativeResponse([]);
    }});
    await service.search(request);
    generation++;
    await service.search({...request, requestId: 8});
    expect(admissions).toBe(2);
  });
  it.each([false, true])('surfaces semantic degradation with empty results=%s', async empty => {
    const statuses: {phase: string; message?: string}[] = [];
    const service = createService({getRoots: () => ['C:\\Projects'], invoke: async command => {
      if (command === 'search_hybrid') return {items: empty ? [] : [{...indexedHit('notes.md'), matchSource: 'content'}],
        semantic: {phase: 'degraded', reason: 'Semantic vectors unavailable; filename and content search remain available.'}};
    }});
    service.subscribeToStatus(status => statuses.push(status));
    const response = await service.search(request);
    expect(response.total).toBe(empty ? 0 : 1);
    expect(statuses[statuses.length - 1]).toMatchObject({phase: 'degraded', message: expect.stringMatching(/semantic/i)});
    if (!empty) expect(response.groups[0]?.items[0]?.match.source).toBe('content');
  });
  it('reports invalid-response when every fallback root payload is malformed', async () => {
    const service = createService({getRoots: () => ['C:\\Projects'], invoke: async command => {
      if (command === 'search_hybrid') throw new Error('index offline');
      if (command === 'search_filenames') return {items: [{score: Number.NaN}]};
    }});
    await expect(service.search(request)).rejects.toMatchObject({code: 'invalid-response', recoverable: true});
  });

  it('reports partial malformed fallback roots while retaining usable matches', async () => {
    const statuses: string[] = [];
    const service = createService({getRoots: () => ['C:\\Projects', 'C:\\Other'], invoke: async (command, args) => {
      if (command === 'search_hybrid') throw new Error('index offline');
      if (command === 'search_filenames') return args?.root === 'C:\\Other' ? {items: []} : rustResponse();
    }});
    service.subscribeToStatus(status => statuses.push(status.message ?? ''));
    await expect(service.search(request)).resolves.toMatchObject({total: 1});
    expect(statuses[statuses.length - 1]).toMatch(/invalid response/i);
  });

  it('admits a current-root duplicate after rejecting a revoked-root copy', async () => {
    const current = indexedHit('Readme.md');
    const revoked = {...current, stableId: 'indexed:revoked', rootPath: 'C:\\Revoked'};
    const service = createService({getRoots: () => ['C:\\Projects'], invoke: async command => {
      if (command === 'search_hybrid') return nativeResponse([revoked, current]);
    }});
    expect((await service.search(request)).groups[0]?.items.map(item => item.id)).toEqual(['indexed:Readme.md']);
  });

  it('forwards fallback scope and filters before native response limits', async () => {
    const service = createService({getRoots: () => ['C:\\Projects'], invoke: async (command, args) => {
      if (command === 'search_hybrid') throw new Error('index offline');
      if (command === 'search_filenames') {
        // IPC is unavailable in jsdom; the real cap case is covered in matching.rs.
        if (args?.scope === 'documents' && JSON.stringify(args.filters) === '[{"id":"extension","value":".md"},{"id":"kind","value":"document"}]') return rustResponse();
        return {...rustResponse(), items: [], total: 0};
      }
    }});
    const response = await service.search({...request, scope: 'documents', limit: 1, filters: [
      {id: 'extension', label: '.md', value: '.md'}, {id: 'kind', label: 'Documents', value: 'document'},
    ]});
    expect(response.groups[0]?.items.map(item => item.name)).toEqual(['Readme.md']);
  });
  it('discards native results when their root is revoked while search is pending', async () => {
    let roots = ['C:\\Projects'];
    let completeSearch!: (value: unknown) => void;
    const invoke = vi.fn(async (command: string) => {
      if (command === 'search_hybrid') return new Promise(resolve => {completeSearch = resolve;});
    });
    const service = createService({getRoots: () => roots, invoke});
    const pending = service.search(request);
    await vi.waitFor(() => expect(completeSearch).toBeDefined());
    roots = [];
    completeSearch(nativeResponse([indexedHit('Readme.md')]));
    await expect(pending).resolves.toMatchObject({groups: [], total: 0});
    roots = ['C:\\Projects'];
    await expect(service.getPreview('indexed:Readme.md')).rejects.toMatchObject({code: 'unavailable'});
  });

  it('treats a rejected undefined index response as a genuine fallback failure', async () => {
    const statuses: string[] = [];
    const service = createService({getRoots: () => ['C:\\Projects'], invoke: async command => {
      if (command === 'search_hybrid') return Promise.reject(undefined);
      if (command === 'search_filenames') return rustResponse();
    }});
    service.subscribeToStatus(status => statuses.push(status.phase));
    await expect(service.search(request)).resolves.toMatchObject({total: 1});
    expect(statuses[statuses.length - 1]).toBe('degraded');
  });

  it('uses policy-aware degraded filename search when the index cannot synchronize', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'synchronize_index_roots') throw new Error('Index database unavailable');
      if (command === 'search_filenames') return rustResponse();
    });
    const service = createService({getRoots: () => ['C:\\Projects'], invoke});
    await expect(service.search(request)).resolves.toMatchObject({total: 1});
    expect(invoke).not.toHaveBeenCalledWith('search_hybrid', expect.anything());
    await expect(service.search({...request, scope: 'recent'})).rejects.toMatchObject({code: 'search-failed'});
  });

  it('uses the native ranked inventory without adding unfiltered traversal results', async () => {
    const service = createService({getRoots: () => ['C:\\Projects'], invoke: async (command) => {
      if (command === 'search_hybrid') return nativeResponse([indexedHit('report.md')]);
      if (command === 'search_filenames') return {...rustResponse(), items: [{...rustResponse().items[0], name: 'report.tmp'}]};
    }});
    const response = await service.search({...request, filters: [{id: 'extension', label: '.md', value: '.md'}]});
    expect(response.groups.flatMap(group => group.items).map(item => item.name)).toEqual(['report.md']);
  });

  it('preserves native order, metadata and identity when filename candidates overlap', async () => {
    const service = createService({getRoots: () => ['C:\\Projects'], invoke: async (command) => {
      if (command === 'search_hybrid') return nativeResponse([indexedHit('z-report.md', 0.05), indexedHit('Readme.md', 0.2)]);
      if (command === 'search_filenames') return rustResponse();
    }});
    const response = await service.search(request);
    expect(response.groups[0]?.items.map(item => item.id)).toEqual(['indexed:z-report.md', 'indexed:Readme.md']);
    expect(response.groups[0]?.items[0]?.metadata).toMatchObject({extension: 'md', sizeBytes: 128});
  });

  it.each(['recent', 'related'] as const)('rejects %s index failures', async (scope) => {
    const service = createService({getRoots: () => ['C:\\Projects'], invoke: async (command) => {
      if (command.startsWith('search_')) throw new Error('index unavailable');
    }});
    await expect(service.search({...request, scope, relatedTo: 'indexed:source'})).rejects.toMatchObject({recoverable: true});
  });

  it('rejects invalid native index payloads instead of masking them with filename results', async () => {
    const service = createService({getRoots: () => ['C:\\Projects'], invoke: async (command) => {
      if (command === 'search_hybrid') return nativeResponse([{rank: Number.NaN}]);
      if (command === 'search_filenames') return rustResponse();
    }});
    await expect(service.search(request)).rejects.toMatchObject({code: 'invalid-response', recoverable: true});
  });

  it('reports filename fallback as degraded and forwards root exclusions', async () => {
    const statuses: string[] = [];
    const policies: unknown[] = [];
    const service = createService({getRoots: () => ['C:\\Projects'],
      getRootConfigurations: () => [{id: 'root', path: 'C:\\Projects', cloudEnrichment: false, exclusions: ['cache'], includeHidden: false, maxFileSizeMb: 256}],
      invoke: async (command, args) => {
        if (command === 'search_hybrid') throw new Error('index offline');
        if (command === 'search_filenames') {policies.push(args?.policy); return rustResponse();}
      }});
    service.subscribeToStatus(status => statuses.push(status.phase));
    await service.search(request);
    expect(statuses[statuses.length - 1]).toBe('degraded');
    expect(policies[0]).toMatchObject({exclusions: ['cache']});
  });

  it('synchronizes empty roots and permanently clears previously cached admission', async () => {
    let roots = ['C:\\Projects'];
    const synchronized: unknown[] = [];
    const service = createService({getRoots: () => roots, invoke: async (command, args) => {
      if (command === 'search_hybrid') return nativeResponse([indexedHit('Readme.md')]);
      if (command === 'search_filenames') return rustResponse();
      if (command === 'synchronize_index_roots') synchronized.push(args?.roots);
    }});
    const result = (await service.search(request)).groups[0]!.items[0]!;
    roots = [];
    await service.search(request);
    expect(synchronized[synchronized.length - 1]).toEqual([]);
    roots = ['C:\\Projects'];
    await expect(service.getPreview(result.id)).rejects.toMatchObject({code: 'unavailable'});
  });
  it('rejects a preview whose root is revoked while the native read is pending', async () => {
    let roots = ['C:\\Projects'];
    let finishPreview!: (value: unknown) => void;
    const service = createService({getRoots: () => roots, invoke: async (command) => {
      if (command === 'search_filenames') return rustResponse();
      if (command === 'search_hybrid') return nativeResponse([indexedHit('Readme.md')]);
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
    const service = createService({
      getRoots: () => roots,
      invoke: async (command) => {
        if (command === 'search_filenames') return rustResponse();
        if (command === 'search_hybrid') return nativeResponse([indexedHit('Readme.md')]);
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

  it('maps indexed content hits with their native provenance', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'search_filenames') return {...rustResponse(), items: [], total: 0};
      if (command === 'search_hybrid') return nativeResponse([{
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
        rank: 0.09,
        metadata: {...indexedHit('Report.pdf').metadata, extension: 'pdf', kind: 'pdf'},
        matchSource: 'semantic',
        semanticScore: 0.91,
        embeddingModel: 'lumen.embed.local',
        pinned: true,
      }]);
      return readyStatus;
    });
    const service = createService({getRoots: () => ['C:\\Projects'], invoke});

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
      if (command === 'search_hybrid') return Promise.resolve(nativeResponse([]));
      return Promise.resolve(undefined);
    });
    const service = createService({getRoots: () => ['C:\\Projects'], invoke});

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
      : command === 'search_hybrid' ? nativeResponse([]) : undefined);
    const service = createService({
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
    const invoke = vi.fn(async (command: string) => {
      if (command === 'search_hybrid') throw new Error('Index unavailable');
      if (command === 'search_filenames') return rustResponse();
    });
    const service = createService({getRoots: () => ['C:\\Projects'], invoke});

    const first = await service.search(request);
    const second = await service.search({...request, requestId: 8});

    expect(invoke).toHaveBeenCalledWith('search_filenames', expect.objectContaining({root: 'C:\\Projects', query: 'read'}));
    expect(first.groups[0]?.items[0]).toMatchObject({
      id: expect.stringMatching(/^local:/),
      name: 'Readme.md',
      kind: 'document',
      match: {source: 'filename', fragment: 'Readme.md', score: 0.94},
    });
    expect(second.groups[0]?.items[0]?.id).toBe(first.groups[0]?.items[0]?.id);
  });

  it('sends persisted ranking preferences to the native ranker', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'search_hybrid') return nativeResponse([indexedHit('Older exact.md', 0.05), indexedHit('Recent readme.md', 0.18)]);
      return undefined;
    });
    const service = createService({
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
      if (command === 'search_hybrid') return nativeResponse([indexedHit('Readme.md')]);
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
    const service = createService({getRoots: () => ['C:\\Projects'], invoke});
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
        metadata: indexedHit('Related.md').metadata,
        matchSource: 'related',
        semanticScore: 0.9,
        embeddingModel: 'lumen.embed.local',
        pinned: false,
      }];
      if (command === 'set_indexed_file_pinned') return {applied: true, pinned: true};
      return undefined;
    });
    const service = createService({getRoots: () => ['C:\\Projects'], invoke});

    const response = await service.search({...request, scope: 'related', relatedTo: 'indexed:source'});
    expect(response.groups[0]?.items[0]).toMatchObject({
      id: 'indexed:related',
      match: {source: 'related'},
    });
    await expect(service.setPinned('indexed:related', true)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('search_related', expect.objectContaining({stableId: 'indexed:source', limit: 500, filters: []}));
    expect(invoke).toHaveBeenCalledWith('set_indexed_file_pinned', {
      stableId: 'indexed:related',
      pinned: true,
    });
  });

  it('keeps canonical paths for native commands while presenting friendly Windows values', async () => {
    const canonicalPath = '\\\\?\\C:\\Projects\\Readme.md';
    const response = indexedHit('Readme.md');
    response.path = canonicalPath;
    response.metadata.path = canonicalPath;
    const invoke = vi.fn(async (command: string) => {
      if (command === 'search_hybrid') return nativeResponse([response]);
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
    const service = createService({getRoots: () => ['C:\\Projects'], invoke});
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
    const service = createService({getRoots: () => [], invoke});
    const statuses: string[] = [];
    service.subscribeToStatus((status) => statuses.push(status.message ?? ''));

    await expect(service.search(request)).resolves.toMatchObject({groups: [], total: 0});
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('synchronize_index_roots', {roots: []});
    expect(statuses[statuses.length - 1]).toBe('No indexed roots');
  });

  it('preserves structured permission failures', async () => {
    const invoke = vi.fn(async () => Promise.reject({
      code: 'permission-denied',
      message: 'Root access was denied.',
      recoverable: true,
    }));
    const service = createService({getRoots: () => ['C:\\Private'], invoke});

    await expect(service.search(request)).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'Root access was denied.',
    });
  });

  it('honors aborts around non-cancellable invoke calls', async () => {
    let resolveInvoke: ((value: unknown) => void) | undefined;
    const invoke = vi.fn(() => new Promise((resolve) => { resolveInvoke = resolve; }));
    const service = createService({getRoots: () => ['C:\\Projects'], invoke});
    const controller = new AbortController();
    const pending = service.search(request, controller.signal);
    controller.abort();
    resolveInvoke?.(rustResponse());

    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
  });
});
