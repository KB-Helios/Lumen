import {useEffect, useState} from 'react';
import {WindowsAppContentControls} from '../../windows-ai/WindowsAiControls';

import {LumenText} from '../../../design-system/primitives/LumenText';
import {
  semanticSearchService as defaultSemanticSearchService,
  type SemanticSearchService,
  type SemanticSearchStatus,
} from '../../../services/search/semantic-search-service';
import {SettingRow} from '../components/SettingRow';
import {SettingSection} from '../components/SettingSection';
import {LumenCheckbox, LumenSelect, LumenSlider, LumenSwitch} from '../components/SettingsControls';
import {SettingsPage} from '../components/SettingsPage';
import type {SearchSettings} from '../settings.schema';
import {useSettingsStore} from '../settings.store';

const scopes = [
  ['all', 'All'],
  ['files', 'Files'],
  ['folders', 'Folders'],
  ['documents', 'Documents'],
  ['code', 'Code'],
  ['images', 'Images'],
] as const;

const extendedScopes = [
  ['recent', 'Recent'],
  ['related', 'Related'],
] as const;

export function SearchPage({semanticService = defaultSemanticSearchService}: {semanticService?: SemanticSearchService}) {
  const search = useSettingsStore((state) => state.search);
  const updateSearch = useSettingsStore((state) => state.updateSearch);
  const [semanticStatus, setSemanticStatus] = useState<SemanticSearchStatus | null>(null);

  useEffect(() => {
    let current = true;
    void semanticService.status()
      .then((status) => { if (current) setSemanticStatus(status); })
      .catch(() => { if (current) setSemanticStatus(null); });
    return () => { current = false; };
  }, [semanticService]);

  const toggleScope = (scope: SearchSettings['enabledScopes'][number], selected: boolean) => {
    const enabledScopes = selected
      ? [...new Set([...search.enabledScopes, scope])]
      : search.enabledScopes.filter((item) => item !== scope);
    if (enabledScopes.length > 0) {
      void updateSearch({enabledScopes});
    }
  };

  return (
    <SettingsPage>
      <SettingSection title="Result scopes" description="Choose which scope tabs stay available in the launcher.">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-[8px] p-[16px] @min-[24rem]/settings:grid-cols-2">
          {scopes.map(([id, label]) => (
            <LumenCheckbox
              key={id}
              isSelected={search.enabledScopes.includes(id)}
              onChange={(selected) => toggleScope(id, selected)}
            >
              {label}
            </LumenCheckbox>
          ))}
          {extendedScopes.map(([id, label]) => {
            const available = id === 'recent' || semanticStatus?.relatedAvailable === true;
            return (
              <LumenCheckbox
                key={id}
                isDisabled={!available}
                isSelected={search.enabledScopes.includes(id)}
                onChange={(selected) => toggleScope(id, selected)}
              >
                {label}
              </LumenCheckbox>
            );
          })}
        </div>
      </SettingSection>
      <SettingSection title="Ranking" description="Tune exact filename and recent-item emphasis for the local adapter.">
        <SettingRow label="Filename priority" description="Higher values favor direct filename matches before path fragments.">
          <LumenSlider label="Filename priority" value={search.filenamePriority} onChange={(filenamePriority) => void updateSearch({filenamePriority})} />
        </SettingRow>
        <SettingRow label="Recency preference">
          <LumenSelect
            aria-label="Recency preference"
            options={[{id: 'low', label: 'Low'}, {id: 'balanced', label: 'Balanced'}, {id: 'high', label: 'High'}]}
            value={search.recency}
            onChange={(recency) => void updateSearch({recency})}
          />
        </SettingRow>
        {semanticStatus?.semanticAvailable ? (
            <SettingRow label="Semantic search" description="Combine exact and content matches with local vector similarity.">
              <LumenSwitch aria-label="Semantic search" isSelected={search.semanticEnabled} onChange={(semanticEnabled) => void updateSearch({semanticEnabled})} />
            </SettingRow>
        ) : null}
        <SettingRow label="Reranking" description="Blend filename, content, recent, pin, and available semantic signals in the native ranker.">
          <LumenSwitch aria-label="Reranking" isSelected={search.rerankingEnabled} onChange={(rerankingEnabled) => void updateSearch({rerankingEnabled})} />
        </SettingRow>
        <SettingRow label="Pinned items" description="Give pinned indexed files a small bounded ranking preference.">
          <LumenSwitch aria-label="Pinned items" isSelected={search.showPinned} onChange={(showPinned) => void updateSearch({showPinned})} />
        </SettingRow>
      </SettingSection>
      <LumenText tone="tertiary" variant="caption">
        {semanticStatus?.semanticAvailable
          ? `${semanticStatus.indexedChunks} embedded chunks`
          : semanticStatus?.reason ?? 'Exact filename and folder search remains available with every AI provider off.'}
      </LumenText>
      <WindowsAppContentControls />
    </SettingsPage>
  );
}
