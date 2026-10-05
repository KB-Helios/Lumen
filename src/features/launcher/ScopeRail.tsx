import {useEffect, useMemo, useState} from 'react';
import {Tab, TabList, TabPanel, Tabs} from 'react-aria-components';

import {motion} from 'motion/react';

import {useLumenMotion} from '../../design-system/MotionProvider';
import {cn} from '../../lib/cn';
import type {SearchScope} from '../../services/search/search.types';
import {semanticSearchService} from '../../services/search/semantic-search-service';
import {useSettingsStore} from '../settings/settings.store';
import {useWindowsAiStore} from '../windows-ai/windows-ai.store';
import {useScopeStore} from './scope.store';

export const searchScopes: ReadonlyArray<{id: SearchScope; label: string}> = [
  {id: 'all', label: 'All'},
  {id: 'files', label: 'Files'},
  {id: 'folders', label: 'Folders'},
  {id: 'documents', label: 'Documents'},
  {id: 'code', label: 'Code'},
  {id: 'images', label: 'Images'},
  {id: 'recent', label: 'Recent'},
  {id: 'related', label: 'Related'},
  {id: 'app-content', label: 'App content'},
];

export function ScopeRail() {
  const {layoutTransition} = useLumenMotion();
  const activeScope = useScopeStore((state) => state.activeScope);
  const setScope = useScopeStore((state) => state.setScope);
  const enabledScopeIds = useSettingsStore((state) => state.search.enabledScopes);
  const historyEnabled = useSettingsStore((state) => state.general.historyEnabled);
  const appContentEnabled = useWindowsAiStore((state) => state.snapshot?.preferences.appContentEnabled === true);
  const [relatedAvailable, setRelatedAvailable] = useState(false);
  useEffect(() => {
    let current = true;
    void semanticSearchService.status()
      .then((status) => { if (current) setRelatedAvailable(status.relatedAvailable); })
      .catch(() => { if (current) setRelatedAvailable(false); });
    return () => { current = false; };
  }, []);
  const enabledScopes = useMemo(
    () => searchScopes.filter((scope) =>
      (scope.id === 'app-content' ? appContentEnabled : enabledScopeIds.includes(scope.id)) &&
      (scope.id !== 'recent' || historyEnabled) &&
      (scope.id !== 'related' || relatedAvailable)),
    [appContentEnabled, enabledScopeIds, historyEnabled, relatedAvailable],
  );

  useEffect(() => {
    if (!enabledScopes.some((scope) => scope.id === activeScope)) {
      setScope(enabledScopes[0]?.id ?? 'all');
    }
  }, [activeScope, enabledScopes, setScope]);

  return (
    <Tabs
      className="min-w-0 border-t border-[color:var(--einui-command-divider)]"
      selectedKey={activeScope}
      onSelectionChange={(key) => setScope(key as SearchScope)}
    >
      <TabList aria-label="Search scopes" className="flex items-center gap-1 overflow-x-auto px-4 py-2 [scrollbar-width:none]" items={enabledScopes}>
        {(scope) => (
          <Tab
            id={scope.id}
            className={({isFocusVisible, isHovered, isSelected}) =>
              cn(
                'relative shrink-0 cursor-default rounded-[var(--lumen-radius-control)] bg-transparent px-3 py-2 font-sans text-sm font-medium text-[color:var(--einui-command-muted-text)] outline-2 outline-offset-1 outline-transparent transition-[background-color,color,outline-color] duration-[120ms] ease-standard',
                isHovered && 'bg-[var(--einui-command-row-hover)] text-[color:var(--einui-command-text)]',
                isSelected && 'text-[color:var(--einui-command-text)]',
                isFocusVisible && 'outline-[color:var(--lumen-focus)]',
              )
            }
          >
            {({isSelected}) => (
              <>
                {isSelected ? (
                  <motion.span
                    aria-hidden="true"
                    layoutId="lumen-scope-indicator"
                    transition={layoutTransition}
                    className="absolute inset-0 z-0 rounded-[var(--lumen-radius-control)] border border-[color:var(--einui-command-divider)] bg-[var(--einui-command-row-selected)] shadow-[var(--lumen-shadow-control)]"
                  />
                ) : null}
                <span className="relative z-10">{scope.label}</span>
              </>
            )}
          </Tab>
        )}
      </TabList>
      {enabledScopes.map((scope) => (
        <TabPanel key={scope.id} className="hidden" id={scope.id} />
      ))}
    </Tabs>
  );
}
