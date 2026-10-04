import {describe, expect, it, vi} from 'vitest';
import {CatalogueSearchService} from './catalogue-search-service';
import {DevelopmentSearchService} from './development-search-service';
import {UnavailableWindowsAiService} from '../windows-ai/unavailable-windows-ai-service';
import {defaultWindowsAiPreferences} from '../windows-ai/windows-ai.types';

describe('public app content search', () => {
  it('opens only a trusted settings target without passing it to the file opener', async () => {
    const files = new DevelopmentSearchService();
    const navigate = vi.fn();
    const service = new CatalogueSearchService(files, new UnavailableWindowsAiService(), () => ({...defaultWindowsAiPreferences, appContentEnabled: true}), navigate);
    const results = await service.search({requestId: 1, query: 'privacy', scope: 'all', filters: [], limit: 10});
    const item = results.groups.flatMap((group) => group.items).find((item) => item.kind === 'app-content');
    expect(item).toBeDefined();
    await service.openFile(item!.id);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('privacy');
    expect(files.openedFiles).toEqual([]);
    await expect(service.openFile('app-content:untrusted')).rejects.toThrow();
    expect(files.openedFiles).toEqual([]);
  });
  it('does not ask the semantic index to participate in ordinary all-scope file search', async () => {
    const windows = new UnavailableWindowsAiService();
    const semantic = vi.spyOn(windows, 'searchContent');
    const service = new CatalogueSearchService(new DevelopmentSearchService(), windows, () => ({...defaultWindowsAiPreferences, appContentEnabled: true}), vi.fn());
    await service.search({requestId: 1, query: 'report', scope: 'all', filters: [], limit: 10});
    expect(semantic).not.toHaveBeenCalled();
  });
});
