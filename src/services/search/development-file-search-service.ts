import {invoke as tauriInvoke} from '@tauri-apps/api/core';
import {z} from 'zod';
import {admitIndexRoots, indexStatusSchema, type IndexStatus} from '../ai/native-ai-service';

import type {SearchService} from './search-service';
import {
  filePreviewSchema,
  previewKindSchema,
  searchResultKindSchema,
  type FilePreview,
  type SearchError,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
  type SearchScope,
  type SearchStatus,
} from './search.types';

type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const defaultInvoke: InvokeCommand = (command, args) => tauriInvoke(command, args);

const rustFileSchema = z.object({
  path: z.string().min(1),
  relativePath: z.string().min(1),
  name: z.string().min(1),
  kind: searchResultKindSchema,
  extension: z.string().nullable().optional(),
  sizeBytes: z.number().int().nonnegative(),
  modifiedMs: z.number().int().nonnegative().nullable().optional(),
});

const rustMatchSchema = rustFileSchema.extend({
  score: z.number().min(0).max(1),
  ranges: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().positive()])),
});

const rustSearchResponseSchema = z.object({
  items: z.array(rustMatchSchema),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  elapsedMs: z.number().int().nonnegative(),
  warnings: z.array(z.object({message: z.string(), path: z.string()})),
});

const rustIndexedHitSchema = z.object({
  stableId: z.string().min(1),
  rootPath: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1),
  contentHash: z.string().min(1),
  indexRevision: z.number().int().positive(),
  extractionKind: z.string().min(1),
  snippet: z.string().transform(value => value.slice(0, 1000)).optional(),
  page: z.number().int().positive().nullable().optional(),
  timeStartMs: z.number().int().nonnegative().nullable().optional(),
  timeEndMs: z.number().int().nonnegative().nullable().optional(),
  rank: z.number().min(0).max(1),
  metadata: rustFileSchema,
  matchSource: z.enum(['filename', 'content', 'metadata', 'ocr', 'semantic', 'related']),
  semanticScore: z.number().min(0).max(1).nullable().optional(),
  embeddingModel: z.string().min(1).nullable().optional(),
  pinned: z.boolean(),
});
const rustIndexedHitsSchema = z.array(rustIndexedHitSchema);
const rustHybridResponseSchema = z.object({
  items: rustIndexedHitsSchema,
  semantic: z.object({
    phase: z.enum(['disabled', 'ready', 'degraded']),
    reason: z.string().min(1).max(256).nullable(),
  }).refine(status => status.phase === 'degraded' ? status.reason !== null : status.reason === null),
});
const pinUpdateSchema = z.object({applied: z.boolean(), pinned: z.boolean()});

const rustPreviewSchema = z.object({
  kind: previewKindSchema,
  title: z.string().min(1),
  subtitle: z.string(),
  text: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  mimeType: z.string().nullable().optional(),
  children: z.array(z.object({
    id: z.string(),
    name: z.string(),
    kind: searchResultKindSchema,
  })),
  metadata: z.record(z.string(), z.string()),
});

interface KnownFile {
  path: string;
  root: string;
}

export interface DevelopmentFileSearchServiceOptions {
  isReady?(): boolean;
  getRoots(): readonly string[];
  getRootConfigurations?(): readonly {
    id: string;
    path: string;
    cloudEnrichment: boolean;
    exclusions: string[];
    includeHidden: boolean;
    maxFileSizeMb: number;
  }[];
  getSearchPreferences?(): {
    filenamePriority: number;
    recency: 'low' | 'balanced' | 'high';
    showPinned: boolean;
    semanticEnabled: boolean;
    rerankingEnabled: boolean;
  };
  invoke?: InvokeCommand;
}

const defaultSearchPreferences = {
  filenamePriority: 82,
  recency: 'balanced',
  showPinned: true,
  semanticEnabled: false,
  rerankingEnabled: false,
} as const;

function normalizedPath(value: string) {
  return displayPath(value).replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
}

function displayPath(value: string) {
  return value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
}

function formatBytes(value: string) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return value;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function presentPreview(preview: z.infer<typeof rustPreviewSchema>) {
  const metadata = {...preview.metadata};
  const modifiedMs = Number(metadata.Modified);
  if (Number.isFinite(modifiedMs) && modifiedMs > 0) {
    metadata.Modified = new Date(modifiedMs).toLocaleString();
  }
  if (metadata.Size) {
    metadata.Size = formatBytes(metadata.Size);
  }
  return {
    ...preview,
    subtitle: displayPath(preview.subtitle),
    metadata,
  };
}

function stableFileId(root: string, relativePath: string) {
  return `local:${encodeURIComponent(`${normalizedPath(root)}\0${normalizedPath(relativePath)}`)}`;
}

function uniqueRoots(roots: readonly string[]) {
  const seen = new Set<string>();
  return roots.filter((root) => {
    const normalized = normalizedPath(root.trim());
    if (!normalized || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function isInScope(kind: SearchResult['kind'], scope: SearchScope) {
  switch (scope) {
    case 'files': return kind !== 'folder';
    case 'folders': return kind === 'folder';
    case 'documents': return ['pdf', 'document', 'spreadsheet', 'presentation'].includes(kind);
    case 'code': return kind === 'source';
    case 'images': return kind === 'image';
    case 'related': return true;
    default: return true;
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('Request aborted.', 'AbortError');
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Request aborted.', 'AbortError'));
    signal.addEventListener('abort', abort, {once: true});
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function commandFailure(error: unknown, fallbackMessage: string): SearchError {
  if (error && typeof error === 'object') {
    const candidate = error as {code?: unknown; message?: unknown; recoverable?: unknown};
    const code = candidate.code === 'invalid-response' ? 'invalid-response' : candidate.code === 'permission-denied'
      ? 'permission-denied'
      : fallbackMessage.toLocaleLowerCase().includes('preview')
        ? 'preview-failed'
        : 'search-failed';
    return {
      code,
      message: typeof candidate.message === 'string' ? candidate.message : fallbackMessage,
      recoverable: candidate.recoverable !== false,
    };
  }
  return {
    code: fallbackMessage.toLocaleLowerCase().includes('preview') ? 'preview-failed' : 'search-failed',
    message: error instanceof Error ? error.message : fallbackMessage,
    recoverable: true,
  };
}

export class DevelopmentFileSearchService implements SearchService {
  private readonly isReady: () => boolean;
  private readonly getRoots: () => readonly string[];
  private readonly getRootConfigurations?: DevelopmentFileSearchServiceOptions['getRootConfigurations'];
  private readonly getSearchPreferences: NonNullable<DevelopmentFileSearchServiceOptions['getSearchPreferences']>;
  private readonly invoke: InvokeCommand;
  private readonly knownFiles = new Map<string, KnownFile>();
  private readonly listeners = new Set<(status: SearchStatus) => void>();
  private synchronizedRootSignature = '';
  private pendingRootSignature = '';
  private configurationOperation = 0;
  private rootSynchronization: Promise<void> = Promise.resolve();
  private nativeStatus?: IndexStatus;
  private searchDegradation?: string;
  private statusTimer?: ReturnType<typeof setInterval>;
  private statusPollRunning = false;
  private statusPollFailed = false;

  constructor({getRoots, getRootConfigurations, getSearchPreferences = () => defaultSearchPreferences, isReady = () => true, invoke = defaultInvoke}: DevelopmentFileSearchServiceOptions) {
    this.isReady = isReady;
    this.getRoots = getRoots;
    this.getRootConfigurations = getRootConfigurations;
    this.getSearchPreferences = getSearchPreferences;
    this.invoke = invoke;
  }

  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    throwIfAborted(signal);
    this.requireReady();
    let roots = uniqueRoots(this.getRoots());
    const startedAt = performance.now();
    let raw: unknown;
    let fallback: unknown;
    let usedFallback = false;
    let degradationMessage: string | undefined;
    for (const [id, known] of this.knownFiles) {
      if (!roots.some(root => normalizedPath(displayPath(root)) === normalizedPath(displayPath(known.root)))) this.knownFiles.delete(id);
    }
    if (!roots.length) this.knownFiles.clear();
    try {
      // Settings may change while an already-issued admission is held. Recheck
      // the desired policy after completion before reading indexed content.
      let desired = this.rootSignature(this.rootConfigurations(roots));
      for (;;) {
        await abortable(this.synchronizeRoots(roots), signal);
        this.requireReady();
        const currentRoots = uniqueRoots(this.getRoots());
        const currentPolicy = this.rootSignature(this.rootConfigurations(currentRoots));
        if (currentPolicy === desired) break;
        roots = currentRoots;
        desired = currentPolicy;
        if (desired === this.synchronizedRootSignature && !this.pendingRootSignature) break;
      }
    } catch (error) {
      throwIfAborted(signal);
      this.requireReady();
      const failure = commandFailure(error, 'Local root synchronization failed.');
      if (failure.code === 'permission-denied' || request.scope === 'recent' || request.scope === 'related') throw failure;
      fallback = error;
      usedFallback = true;
    }
    throwIfAborted(signal);
    if (!roots.length) {
      this.publishStatus(this.createStatus());
      return {requestId: request.requestId, groups: [], elapsedMs: performance.now() - startedAt, total: 0};
    }
    if (request.scope === 'related' && !request.relatedTo) {
      return {requestId: request.requestId, groups: [], elapsedMs: performance.now() - startedAt, total: 0};
    }
    const preferences = this.getSearchPreferences();
    const args = {
      requestId: request.requestId, query: request.query, scope: request.scope,
      filters: request.filters.map(({id, value}) => ({id, value})), limit: request.limit,
      ...preferences,
    };
    if (!usedFallback) {
      try {
        raw = await abortable(request.scope === 'related'
          ? this.invoke('search_related', {...args, stableId: request.relatedTo})
          : this.invoke('search_hybrid', args), signal);
      } catch (error) {
        throwIfAborted(signal);
        if (request.scope === 'recent' || request.scope === 'related') throw commandFailure(error, 'Local index search failed.');
        fallback = error;
        usedFallback = true;
      }
    }
    throwIfAborted(signal);
    this.requireReady();
    let mapped: SearchResult[];
    if (!usedFallback) {
      const parsed = request.scope === 'related'
        ? rustIndexedHitsSchema.transform(items => ({items, semantic: {phase: 'disabled' as const, reason: null}})).safeParse(raw)
        : rustHybridResponseSchema.safeParse(raw);
      if (!parsed.success) throw {code: 'invalid-response', message: 'The local index returned an invalid response.', recoverable: true} satisfies SearchError;
      if (parsed.data.semantic.phase === 'degraded') degradationMessage = parsed.data.semantic.reason ?? undefined;
      const seen = new Set<string>();
      const currentRoots = uniqueRoots(this.getRoots());
      mapped = parsed.data.items.filter(item => {
        if (!currentRoots.some(root => normalizedPath(displayPath(root)) === normalizedPath(displayPath(item.rootPath)))) return false;
        const path = normalizedPath(displayPath(item.path));
        if (seen.has(path)) return false;
        seen.add(path);
        return true;
      }).map(item => {
        this.knownFiles.set(item.stableId, {root: item.rootPath, path: item.path});
        return {
          id: item.stableId, name: item.name, path: displayPath(item.path), kind: item.metadata.kind,
          match: {source: item.matchSource, score: 1 - item.rank,
            fragment: ['content', 'ocr', 'semantic', 'related'].includes(item.matchSource) ? item.snippet : undefined},
          metadata: {extension: item.metadata.extension ?? undefined, sizeBytes: item.metadata.sizeBytes,
            modifiedAt: item.metadata.modifiedMs == null ? undefined : new Date(item.metadata.modifiedMs).toISOString()},
          pinned: item.pinned,
          provenance: {extractionKind: item.extractionKind, fileHash: item.contentHash,
            page: item.page ?? undefined, timeStartMs: item.timeStartMs ?? undefined,
            timeEndMs: item.timeEndMs ?? undefined, embeddingModel: item.embeddingModel ?? undefined,
            indexRevision: item.indexRevision}, availability: 'available',
        } satisfies SearchResult;
      });
    } else {
      const configurations = this.rootConfigurations(roots);
      const settled = await abortable(Promise.allSettled(configurations.map(root => this.invoke('search_filenames', {
        root: root.path, query: request.query,
        scope: request.scope, filters: args.filters,
        policy: {exclusions: root.exclusions, includeHidden: root.includeHidden, maxFileSizeMb: root.maxFileSizeMb},
      }))), signal);
      throwIfAborted(signal);
      this.requireReady();
      mapped = [];
      let usable = 0;
      let malformed = 0;
      let failed = 0;
      let warnings = 0;
      let truncated = 0;
      for (const [index, response] of settled.entries()) {
        if (response.status === 'rejected') {failed++; continue;}
        const parsed = rustSearchResponseSchema.safeParse(response.value);
        if (!parsed.success) {malformed++; continue;}
        usable++;
        warnings += parsed.data.warnings.length;
        if (parsed.data.truncated) truncated++;
        const root = configurations[index]!.path;
        if (!uniqueRoots(this.getRoots()).some(current => normalizedPath(displayPath(current)) === normalizedPath(displayPath(root)))) continue;
        for (const item of parsed.data.items) {
          if (!isInScope(item.kind, request.scope) || !request.filters.every(filter =>
            filter.id === 'extension' ? item.extension?.toLowerCase() === filter.value.replace(/^\./, '').toLowerCase()
              : filter.id === 'kind' && item.kind === filter.value.toLowerCase())) continue;
          const id = stableFileId(root, item.relativePath);
          this.knownFiles.set(id, {root, path: item.path});
          mapped.push({id, name: item.name, path: displayPath(item.path), kind: item.kind,
            match: {source: 'filename', fragment: item.relativePath, ranges: item.ranges, score: item.score},
            metadata: {extension: item.extension ?? undefined, sizeBytes: item.sizeBytes,
              modifiedAt: item.modifiedMs == null ? undefined : new Date(item.modifiedMs).toISOString()}, availability: 'available'});
        }
      }
      if (!usable && malformed) throw {code: 'invalid-response', message: 'The local filename adapter returned an invalid response.', recoverable: true} satisfies SearchError;
      if (!usable) throw commandFailure(fallback, 'Local search failed.');
      degradationMessage = 'Local index unavailable; using policy-aware filename search';
      if (failed) degradationMessage += `; ${failed} root${failed === 1 ? '' : 's'} failed`;
      if (malformed) degradationMessage += `; ${malformed} roots returned an invalid response`;
      if (warnings) degradationMessage += `; ${warnings} traversal warning${warnings === 1 ? '' : 's'}`;
      if (truncated) degradationMessage += `; ${truncated} root${truncated === 1 ? '' : 's'} truncated`;
      degradationMessage = degradationMessage.slice(0, 256);
      mapped.sort((left, right) => (right.match.score ?? 0) - (left.match.score ?? 0) || left.path.localeCompare(right.path));
      const seen = new Set<string>();
      mapped = mapped.filter(item => {const path = normalizedPath(item.path); if (seen.has(path)) return false; seen.add(path); return true;});
    }
    this.searchDegradation = degradationMessage;
    this.publishStatus({phase: degradationMessage ? 'degraded' : this.nativeStatus?.phase ?? 'indexing', indexedItems: this.nativeStatus?.indexedItems,
      generation: this.nativeStatus?.generation, pendingItems: this.nativeStatus?.pendingItems,
      message: degradationMessage ?? this.nativeStatus?.message ?? 'Preparing local inventory',
      updatedAt: new Date().toISOString()});
    const visible = mapped.slice(0, request.limit);
    return {requestId: request.requestId, groups: visible.length ? [{id: 'local-files', label: 'Local files', items: visible}] : [],
      elapsedMs: Math.max(0, performance.now() - startedAt), total: mapped.length};
  }

  async getPreview(fileId: string, signal?: AbortSignal): Promise<FilePreview> {
    throwIfAborted(signal);
    const known = this.requireKnownFile(fileId);
    try {
      const rawPreview = await this.invoke('get_basic_preview', {root: known.root, path: known.path});
      throwIfAborted(signal);
      this.requireKnownFile(fileId);
      const parsed = rustPreviewSchema.safeParse(rawPreview);
      if (!parsed.success) {
        throw {
          code: 'invalid-response',
          message: 'The local preview adapter returned an invalid response.',
          recoverable: true,
        } satisfies SearchError;
      }
      return filePreviewSchema.parse({
        fileId,
        ...presentPreview(parsed.data),
        text: parsed.data.text ?? undefined,
        sourceUrl: parsed.data.sourceUrl ?? undefined,
        mimeType: parsed.data.mimeType ?? undefined,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw commandFailure(error, 'The local preview could not be loaded.');
    }
  }

  async openFile(fileId: string): Promise<void> {
    const known = this.requireKnownFile(fileId);
    try {
      await this.invoke('open_file', {root: known.root, path: known.path});
    } catch (error) {
      const message = commandFailure(error, 'The selected file could not be opened.').message;
      throw Object.assign(new Error(message), {cause: error});
    }
  }

  async openContainingFolder(fileId: string): Promise<void> {
    const known = this.requireKnownFile(fileId);
    try {
      await this.invoke('open_containing_folder', {root: known.root, path: known.path});
    } catch (error) {
      const message = commandFailure(error, 'The containing folder could not be opened.').message;
      throw Object.assign(new Error(message), {cause: error});
    }
  }

  async setPinned(fileId: string, pinned: boolean): Promise<boolean> {
    if (!fileId.startsWith('indexed:')) {
      return false;
    }
    try {
      const parsed = pinUpdateSchema.parse(await this.invoke('set_indexed_file_pinned', {
        stableId: fileId,
        pinned,
      }));
      return parsed.applied && parsed.pinned === pinned;
    } catch (error) {
      const message = commandFailure(error, 'The selected file pin could not be updated.').message;
      throw Object.assign(new Error(message), {cause: error});
    }
  }

  subscribeToStatus(listener: (status: SearchStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.createStatus());
    this.statusTimer ??= setInterval(() => {void this.pollStatus();}, 1000);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.statusTimer !== undefined) {
        clearInterval(this.statusTimer);
        this.statusTimer = undefined;
      }
    };
  }

  private async pollStatus() {
    if (this.statusPollRunning || !this.listeners.size || !this.isReady() || !this.getRoots().length) return;
    this.statusPollRunning = true;
    try {
      const status = indexStatusSchema.parse(await this.invoke('get_index_status'));
      if (!this.isReady()) return;
      if (!this.statusPollFailed && JSON.stringify(status) === JSON.stringify(this.nativeStatus)) return;
      this.statusPollFailed = false;
      if (status.generation !== this.nativeStatus?.generation) this.synchronizedRootSignature = '';
      this.nativeStatus = status;
      this.publishStatus({...status, phase: this.searchDegradation ? 'degraded' : status.phase,
        message: this.searchDegradation ?? status.message, updatedAt: new Date().toISOString()});
    } catch {
      this.statusPollFailed = true;
      this.publishStatus({phase: 'degraded', message: 'Local index status is unavailable.', updatedAt: new Date().toISOString()});
    } finally {
      this.statusPollRunning = false;
    }
  }

  private createStatus(): SearchStatus {
    if (!this.isReady()) return {phase: 'indexing', message: 'Loading indexed root settings', updatedAt: new Date().toISOString()};
    const roots = uniqueRoots(this.getRoots());
    return roots.length > 0
      ? {
          phase: this.nativeStatus?.phase ?? 'indexing',
          message: `${roots.length} local ${roots.length === 1 ? 'root' : 'roots'} configured`,
          updatedAt: new Date().toISOString(),
        }
      : {
          phase: 'degraded',
          message: 'No indexed roots',
          updatedAt: new Date().toISOString(),
        };
  }

  private publishStatus(status: SearchStatus) {
    this.listeners.forEach((listener) => listener(status));
  }

  private rootConfigurations(roots: readonly string[]) {
    return (this.getRootConfigurations?.() ?? roots.map(path => ({
      id: normalizedPath(path), path, cloudEnrichment: false, exclusions: [], includeHidden: false, maxFileSizeMb: 256,
    }))).filter(configuration => roots.some(root => normalizedPath(root) === normalizedPath(configuration.path)));
  }

  private async synchronizeRoots(roots: readonly string[]): Promise<void> {
    const operation = ++this.configurationOperation;
    const configuredRoots = this.rootConfigurations(roots);
    const signature = this.rootSignature(configuredRoots);
    const stillDesired = () => this.isReady() && signature === this.rootSignature(this.rootConfigurations(uniqueRoots(this.getRoots())));
    const current = () => operation === this.configurationOperation
      && stillDesired();
    if (signature === this.synchronizedRootSignature && !this.pendingRootSignature) {
      const status = indexStatusSchema.parse(await this.invoke('get_index_status'));
      if (!current()) return;
      if (status.generation === this.nativeStatus?.generation) {
        this.nativeStatus = status;
        return;
      }
      this.synchronizedRootSignature = '';
    }
    if (signature === this.pendingRootSignature) {
      return this.rootSynchronization;
    }
    if (!current()) return;
    this.pendingRootSignature = signature;
    const synchronization: Promise<void> = admitIndexRoots(configuredRoots.map((root) => ({
      path: root.path,
      cloudEnrichment: root.cloudEnrichment,
      exclusions: root.exclusions,
      includeHidden: root.includeHidden,
      maxFileSizeMb: root.maxFileSizeMb,
    })), this.invoke, stillDesired).then(status => {
      if (status && this.rootSynchronization === synchronization && stillDesired()) {
        this.nativeStatus = status;
        this.synchronizedRootSignature = signature;
      }
    });
    this.rootSynchronization = synchronization;
    return synchronization.finally(() => {
      if (this.rootSynchronization === synchronization) {
        this.pendingRootSignature = '';
      }
    });
  }

  private rootSignature(configurations: ReturnType<NonNullable<DevelopmentFileSearchServiceOptions['getRootConfigurations']>>) {
    return JSON.stringify(configurations.map(root => ({path: normalizedPath(root.path), cloudEnrichment: root.cloudEnrichment,
      exclusions: root.exclusions, includeHidden: root.includeHidden, maxFileSizeMb: root.maxFileSizeMb})));
  }

  private requireKnownFile(fileId: string) {
    this.requireReady();
    const known = this.knownFiles.get(fileId);
    if (!known) {
      throw {
        code: 'unavailable',
        message: 'Search again before opening this local item.',
        recoverable: true,
      } satisfies SearchError;
    }
    const authorized = uniqueRoots(this.getRoots()).some((root) =>
      normalizedPath(displayPath(root)) === normalizedPath(displayPath(known.root)),
    );
    if (!authorized) {
      this.knownFiles.delete(fileId);
      throw {
        code: 'permission-denied',
        message: 'This local root is no longer enabled. Search again after enabling it.',
        recoverable: true,
      } satisfies SearchError;
    }
    return known;
  }

  private requireReady() {
    if (!this.isReady()) throw {code: 'unavailable', message: 'Indexed root settings are still loading.', recoverable: true} satisfies SearchError;
  }
}
