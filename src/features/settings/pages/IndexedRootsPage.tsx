import {useEffect, useRef, useState} from 'react';

import {LumenUiIcon} from '../../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../../design-system/primitives/LumenButton';
import {LumenText} from '../../../design-system/primitives/LumenText';
import {
  createRootSelectionService,
  type RootSelectionService,
} from '../../onboarding/root-selection-service';
import {IndexedRootRow} from '../components/IndexedRootRow';
import {createIndexedRoot} from '../indexed-root';
import {SettingSection} from '../components/SettingSection';
import {SettingsCallout, SettingsPage} from '../components/SettingsPage';
import {useSettingsStore} from '../settings.store';
import {isNativeRuntime, nativeAiService} from '../../../services/ai/native-ai-service';
import {DevelopmentFileSearchService} from '../../../services/search/development-file-search-service';
import type {SearchService} from '../../../services/search/search-service';
import type {SearchStatus} from '../../../services/search/search.types';

const defaultRootService = createRootSelectionService();
const defaultStatusService = new DevelopmentFileSearchService({
  getRoots: () => useSettingsStore.getState().roots.filter((root) => !root.paused).map((root) => root.path),
  invoke: () => nativeAiService.indexStatus(),
});

interface PageNotice {
  text: string;
  tone: 'info' | 'error';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function IndexedRootsPage({rootService = defaultRootService, statusService = defaultStatusService}: {rootService?: RootSelectionService; statusService?: Pick<SearchService, 'subscribeToStatus'>}) {
  const roots = useSettingsStore((state) => state.roots);
  const setRoots = useSettingsStore((state) => state.setRoots);
  const removeRoot = useSettingsStore((state) => state.removeRoot);
  const cloudEnrichedRootIds = useSettingsStore((state) => state.ai.cloudEnrichedRootIds);
  const updateAi = useSettingsStore((state) => state.updateAi);
  const [notice, setNotice] = useState<PageNotice>();
  const [choosing, setChoosing] = useState(false);
  const [indexBusy, setIndexBusy] = useState(false);
  const mutationPending = useRef(false);
  const pickerPending = useRef(false);
  const mounted = useRef(true);
  const [indexStatus, setIndexStatus] = useState<SearchStatus>();

  useEffect(() => {
    mounted.current = true;
    if (!isNativeRuntime()) return () => {mounted.current = false;};
    let active = true;
    const unsubscribe = statusService.subscribeToStatus((status) => {
      if (!active || mutationPending.current) return;
      setIndexStatus(status);
      setNotice({text: status.message ?? 'Index status updated.', tone: status.phase === 'degraded' ? 'error' : 'info'});
    });
    void nativeAiService.indexStatus()
      .then((status) => {
        if (active && !mutationPending.current) {setIndexStatus({...status, updatedAt: new Date().toISOString()}); setNotice({text: status.message, tone: 'info'});}
      })
      .catch((error: unknown) => {
        if (active) setNotice({text: `Index status is unavailable: ${errorMessage(error)}`, tone: 'error'});
      });
    return () => {
      active = false;
      mounted.current = false;
      unsubscribe();
    };
  }, [statusService]);

  const synchronize = async (nextRoots = roots, cloudIds = cloudEnrichedRootIds) => {
    if (!isNativeRuntime()) return true;
    try {
      const status = await nativeAiService.synchronizeRoots(nextRoots
        .filter((root) => !root.paused)
        .map((root) => ({
          path: root.path,
          cloudEnrichment: cloudIds.includes(root.id),
          exclusions: root.exclusions,
          includeHidden: root.includeHidden,
          maxFileSizeMb: root.maxFileSizeMb,
        })));
      setNotice({text: status.message, tone: 'info'});
      setIndexStatus({...status, updatedAt: new Date().toISOString()});
      return true;
    } catch (error) {
      setNotice({text: `Index synchronization failed: ${errorMessage(error)}`, tone: 'error'});
      return false;
    }
  };

  const persistAndSynchronize = async (
    persist: () => Promise<boolean>,
    nextRoots = roots,
    cloudIds = cloudEnrichedRootIds,
  ) => {
    if (mutationPending.current) return false;
    mutationPending.current = true;
    setIndexBusy(true);
    setIndexStatus(undefined);
    try {
      if (!await persist()) {
        setNotice({text: 'The root settings could not be saved, so the local index was not changed.', tone: 'error'});
        return false;
      }
      return await synchronize(nextRoots, cloudIds);
    } catch (error) {
      setNotice({text: `The root settings could not be updated: ${errorMessage(error)}`, tone: 'error'});
      return false;
    } finally {
      mutationPending.current = false;
      if (mounted.current) setIndexBusy(false);
    }
  };

  const addRoot = async () => {
    if (pickerPending.current || mutationPending.current) return;
    pickerPending.current = true;
    setChoosing(true);
    setNotice(undefined);
    try {
      const path = await rootService.chooseRoot();
      if (!mounted.current) return;
      if (!path) {
        setNotice({text: 'No folder was selected.', tone: 'info'});
        return;
      }
      const currentRoots = useSettingsStore.getState().roots;
      if (currentRoots.some((root) => root.path.toLowerCase() === path.toLowerCase())) {
        setNotice({text: 'That folder is already an indexed root.', tone: 'info'});
        return;
      }
      const nextRoots = [...currentRoots, createIndexedRoot(path)];
      if (await persistAndSynchronize(() => setRoots(nextRoots), nextRoots)) {
        if (!isNativeRuntime()) setNotice({text: `${path} was added. Native indexing is unavailable in this browser preview.`, tone: 'info'});
      }
    } catch (error) {
      setNotice({text: `The indexed root could not be added: ${errorMessage(error)}`, tone: 'error'});
    } finally {
      pickerPending.current = false;
      if (mounted.current) setChoosing(false);
    }
  };

  const rebuildIndex = async () => {
    if (mutationPending.current || pickerPending.current) return;
    mutationPending.current = true;
    setIndexBusy(true);
    setIndexStatus(undefined);
    try {
      await synchronize();
    } finally {
      mutationPending.current = false;
      setIndexBusy(false);
    }
  };

  return (
    <SettingsPage>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-[12px]">
        <LumenText tone="secondary">{roots.length} {roots.length === 1 ? 'root' : 'roots'}</LumenText>
        <div className="flex min-w-0 flex-wrap items-center gap-[8px]">
          <LumenButton isDisabled={indexBusy || choosing || roots.length === 0} size="small" onPress={rebuildIndex}>
            {indexBusy ? 'Working…' : 'Rebuild index'}
          </LumenButton>
          <LumenButton aria-label="Add root" isDisabled={choosing || indexBusy} size="small" variant="primary" onPress={addRoot}>
            <LumenUiIcon name="folderOpen" size="small" />
            {choosing ? 'Choosing…' : 'Add root'}
          </LumenButton>
        </div>
      </div>
      {notice ? <SettingsCallout tone={notice.tone}>{notice.text}</SettingsCallout> : null}
      <SettingSection title="Indexed search directories" description="Content stays local unless cloud enrichment is enabled explicitly for that root.">
        {roots.length === 0 ? (
          <div className="grid min-h-[190px] min-w-0 place-items-center gap-[12px] p-[20px] text-center">
            <span aria-hidden="true" className="grid size-[56px] place-items-center rounded-surface bg-surface-inset text-text-secondary"><LumenUiIcon name="folderOpen" size="large" /></span>
            <div>
              <LumenText as="p" weight="semibold">Choose a focused folder to begin</LumenText>
              <LumenText as="p" tone="tertiary" variant="meta">Project folders keep the development adapter quick and predictable.</LumenText>
            </div>
          </div>
        ) : roots.map((root) => (
          <IndexedRootRow
            isDisabled={indexBusy || choosing}
            cloudEnrichment={cloudEnrichedRootIds.includes(root.id)}
            key={root.id}
            root={root.paused || !indexStatus ? root : {...root, status: indexStatus.phase === 'degraded' ? 'error' : indexStatus.phase === 'ready' ? 'ready' : indexStatus.phase === 'paused' ? 'paused' : 'indexing'}}
            onCloudEnrichmentChange={(enabled) => {
              const nextIds = enabled
                ? [...new Set([...cloudEnrichedRootIds, root.id])]
                : cloudEnrichedRootIds.filter((id) => id !== root.id);
              void persistAndSynchronize(
                () => updateAi({cloudEnrichedRootIds: nextIds}),
                roots,
                nextIds,
              );
            }}
            onChange={(next) => {
              const nextRoots = roots.map((item) => item.id === root.id ? next : item);
              void persistAndSynchronize(() => setRoots(nextRoots), nextRoots);
            }}
            onRemove={async () => {
              if (mutationPending.current || pickerPending.current) return false;
              mutationPending.current = true;
              setIndexBusy(true);
              setIndexStatus(undefined);
              try {
                return await removeRoot(root.id, async (nextRoots, nextIds) => {
                  if (!await synchronize(nextRoots, nextIds)) throw new Error('Native root removal was not admitted. Try again.');
                });
              } finally {
                mutationPending.current = false;
                if (mounted.current) setIndexBusy(false);
              }
            }}
          />
        ))}
      </SettingSection>
    </SettingsPage>
  );
}
