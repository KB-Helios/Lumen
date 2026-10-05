import {useEffect, useState} from 'react';

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

const defaultRootService = createRootSelectionService();

interface PageNotice {
  text: string;
  tone: 'info' | 'error';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function IndexedRootsPage({rootService = defaultRootService}: {rootService?: RootSelectionService}) {
  const roots = useSettingsStore((state) => state.roots);
  const setRoots = useSettingsStore((state) => state.setRoots);
  const setRootsAndAi = useSettingsStore((state) => state.setRootsAndAi);
  const cloudEnrichedRootIds = useSettingsStore((state) => state.ai.cloudEnrichedRootIds);
  const updateAi = useSettingsStore((state) => state.updateAi);
  const [notice, setNotice] = useState<PageNotice>();
  const [choosing, setChoosing] = useState(false);
  const [indexBusy, setIndexBusy] = useState(false);

  useEffect(() => {
    if (!isNativeRuntime()) return;
    let active = true;
    void nativeAiService.indexStatus()
      .then((status) => {
        if (active) setNotice({text: status.message, tone: 'info'});
      })
      .catch((error: unknown) => {
        if (active) setNotice({text: `Index status is unavailable: ${errorMessage(error)}`, tone: 'error'});
      });
    return () => {
      active = false;
    };
  }, []);

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
    try {
      if (!await persist()) {
        setNotice({text: 'The root settings could not be saved, so the local index was not changed.', tone: 'error'});
        return false;
      }
      return await synchronize(nextRoots, cloudIds);
    } catch (error) {
      setNotice({text: `The root settings could not be updated: ${errorMessage(error)}`, tone: 'error'});
      return false;
    }
  };

  const addRoot = async () => {
    setChoosing(true);
    setNotice(undefined);
    try {
      const path = await rootService.chooseRoot();
      if (!path) {
        setNotice({text: 'No folder was selected.', tone: 'info'});
        return;
      }
      if (roots.some((root) => root.path.toLowerCase() === path.toLowerCase())) {
        setNotice({text: 'That folder is already an indexed root.', tone: 'info'});
        return;
      }
      const nextRoots = [...roots, createIndexedRoot(path)];
      if (await persistAndSynchronize(() => setRoots(nextRoots), nextRoots)) {
        setNotice({text: `${path} is indexed locally.`, tone: 'info'});
      }
    } catch (error) {
      setNotice({text: `The indexed root could not be added: ${errorMessage(error)}`, tone: 'error'});
    } finally {
      setChoosing(false);
    }
  };

  const rebuildIndex = async () => {
    setIndexBusy(true);
    try {
      await synchronize();
    } finally {
      setIndexBusy(false);
    }
  };

  return (
    <SettingsPage>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-[12px]">
        <LumenText tone="secondary">{roots.length} {roots.length === 1 ? 'root' : 'roots'}</LumenText>
        <div className="flex min-w-0 flex-wrap items-center gap-[8px]">
          <LumenButton isDisabled={indexBusy || roots.length === 0} size="small" onPress={rebuildIndex}>
            {indexBusy ? 'Working…' : 'Rebuild index'}
          </LumenButton>
          <LumenButton aria-label="Add root" isDisabled={choosing} size="small" variant="primary" onPress={addRoot}>
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
            cloudEnrichment={cloudEnrichedRootIds.includes(root.id)}
            key={root.id}
            root={root}
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
            onRemove={() => {
              const nextRoots = roots.filter((item) => item.id !== root.id);
              const nextIds = cloudEnrichedRootIds.filter((id) => id !== root.id);
              void persistAndSynchronize(
                () => setRootsAndAi(nextRoots, {cloudEnrichedRootIds: nextIds}),
                nextRoots,
                nextIds,
              );
            }}
          />
        ))}
      </SettingSection>
    </SettingsPage>
  );
}
