import {publicCatalogue, searchPublicCatalogue, resolvePublicMatches} from '../windows-ai/catalogue';
import type {WindowsAiService} from '../windows-ai/windows-ai-service';
import type {AppContentMatch, WindowsAiPreferences} from '../windows-ai/windows-ai.types';
import type {SearchService} from './search-service';
import type {FilePreview, SearchRequest, SearchResponse, SearchResult} from './search.types';

const prefix = 'app-content:';
function result(item: AppContentMatch): SearchResult {
  return {id: `${prefix}${item.id}`, kind: 'app-content', name: item.title, path: 'Lumen help and settings', match: {source: item.source === 'semantic' ? 'semantic' : 'metadata', fragment: item.description}, metadata: {}, availability: 'available', target: {kind: 'app-content', itemId: item.id, settingsPage: item.settingsPage}};
}
export class CatalogueSearchService implements SearchService {
  constructor(private readonly files: SearchService, private readonly windows: WindowsAiService, private readonly preferences: () => WindowsAiPreferences, private readonly navigate: (page: AppContentMatch['settingsPage']) => void | Promise<void>) {}
  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    signal?.throwIfAborted();
    const enabled = this.preferences().appContentEnabled;
    let help: AppContentMatch[] = enabled && (request.scope === 'all' || request.scope === 'app-content') ? searchPublicCatalogue(request.query) : [];
    if (request.scope === 'app-content' && enabled && request.query.trim()) {
      try { const semantic = resolvePublicMatches(await this.windows.searchContent(request.query, signal)); if (semantic.length) help = semantic; }
      catch { signal?.throwIfAborted(); /* Public keyword search remains available. */ }
    }
    if (request.scope === 'app-content') return {requestId: request.requestId, groups: help.length ? [{id: 'app-content', label: 'Lumen help', items: help.slice(0, request.limit).map(result)}] : [], total: Math.min(help.length, request.limit), elapsedMs: 0};
    const response = await this.files.search(request, signal);
    const count = Math.max(0, request.limit - response.total);
    const items = help.slice(0, count).map(result);
    return items.length ? {...response, groups: [...response.groups, {id: 'app-content', label: 'Lumen help', items}], total: response.total + items.length} : response;
  }
  private entry(id: string) {
    const item = publicCatalogue.find((item) => `${prefix}${item.id}` === id);
    if (!item || !this.preferences().appContentEnabled) throw new Error('This Lumen help item is unavailable.');
    return item;
  }
  async getPreview(id: string, signal?: AbortSignal): Promise<FilePreview> {
    if (!id.startsWith(prefix)) return this.files.getPreview(id, signal);
    signal?.throwIfAborted();
    const item = this.entry(id);
    return {fileId: id, kind: 'text', title: item.title, subtitle: 'Public Lumen help', text: item.description, metadata: {Destination: item.settingsPage, Content: 'Public help catalogue'}};
  }
  async openFile(id: string) { if (id.startsWith(prefix)) await this.navigate(this.entry(id).settingsPage); else await this.files.openFile(id); }
  async openContainingFolder(id: string) { if (id.startsWith(prefix)) throw new Error('Help items open in Lumen settings.'); await this.files.openContainingFolder(id); }
  async setPinned(id: string, pinned: boolean) { return id.startsWith(prefix) ? false : this.files.setPinned(id, pinned); }
  subscribeToStatus: SearchService['subscribeToStatus'] = (listener) => this.files.subscribeToStatus(listener);
}
