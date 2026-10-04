import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';

import {motionTokens} from '../../design-system/motion';
import {createWindowService} from '../../platform/window/tauri-window-service';
import type {WindowService} from '../../platform/window/window-service';
import type {AnswerService} from '../../services/answer/answer-service';
import {UnavailableAnswerService} from '../../services/answer/unavailable-answer-service';
import type {ComputerUseService} from '../../services/computer-use/computer-use-service';
import {UnavailableComputerUseService} from '../../services/computer-use/unavailable-computer-use-service';
import type {SearchService} from '../../services/search/search-service';
import type {SearchFilter} from '../../services/search/search.types';
import {windowsAiService} from '../../services/windows-ai';
import type {DictationSession} from '../../services/windows-ai/windows-ai-service';
import {canUseWindowsAiFeature} from '../../services/windows-ai/windows-ai.types';
import {useWindowsAiStore} from '../windows-ai/windows-ai.store';
import {WindowsAgentPicker} from '../windows-ai/WindowsAgentPicker';
import {useLumenKeyboard} from '../keyboard/useLumenKeyboard';
import {ComputerUsePanel} from '../computer-use/ComputerUsePanel';
import {useComputerUseController} from '../computer-use/useComputerUseController';
import {measureAfterPaint} from '../diagnostics/diagnostics.metrics';
import {AnswerPanel} from '../answer/AnswerPanel';
import {useAnswerController} from '../answer/useAnswerController';
import {LazyPreviewPane} from '../preview/LazyPreviewPane';
import {useSettingsStore} from '../settings/settings.store';
import {CollapsedLauncher} from './CollapsedLauncher';
import {ExpandedWorkspace} from './ExpandedWorkspace';
import {useLauncherStore} from './launcher.store';
import {useQueryStore} from './query.store';
import {useScopeStore} from './scope.store';
import {
  readSelectionIntent,
  useSelectionStore,
} from './selection.store';
import {useSearchController} from './useSearchController';
import {requestWindowHide, requestWindowShow} from './useLauncherPresentation';

const unavailableAnswerService = new UnavailableAnswerService();
const unavailableComputerUseService = new UnavailableComputerUseService();
const queryDebounceMs = 80;

function QueryBoundComputerUsePanel(
  props: Omit<ComponentProps<typeof ComputerUsePanel>, 'draftTask'>,
) {
  const draftTask = useQueryStore((state) => state.committed);
  return <ComputerUsePanel {...props} draftTask={draftTask} />;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function statusLabel(
  lifecycle: ReturnType<typeof useSearchController>['lifecycle'],
  count: number,
) {
  if (lifecycle === 'searching') {
    return 'Searching';
  }
  if (lifecycle === 'error') {
    return 'Unavailable';
  }
  if (lifecycle === 'ready' || lifecycle === 'empty') {
    return `${count} ${count === 1 ? 'result' : 'results'}`;
  }
  return 'Ready';
}

export interface SearchExperienceProps {
  service: SearchService;
  answerService?: AnswerService;
  computerUseService?: ComputerUseService;
  windowService?: WindowService;
  onOpenSettings?: () => void;
}

export function SearchExperience({
  service,
  answerService = unavailableAnswerService,
  computerUseService = unavailableComputerUseService,
  windowService: providedWindowService,
  onOpenSettings,
}: SearchExperienceProps) {
  const windowService = useMemo(
    () => providedWindowService ?? createWindowService(),
    [providedWindowService],
  );
  const activeFilters = useScopeStore((state) => state.activeFilters);
  const controller = useSearchController(service, activeFilters);
  const intent = useLauncherStore((state) => state.intent);
  const runtimeMode = useSettingsStore((state) => state.ai.runtimeMode);
  const cloudAnswerConsent = useSettingsStore((state) => state.ai.cloudAnswerConsent);
  const updateAi = useSettingsStore((state) => state.updateAi);
  const computerUseSettings = useSettingsStore((state) => state.computerUse);
  const previewsEnabled = useSettingsStore((state) => state.privacy.previewsEnabled);
  const setActiveSettingsPage = useSettingsStore((state) => state.setActivePage);
  const submittedQuery = useQueryStore((state) => state.submitted);
  const submissionRevision = useQueryStore((state) => state.submissionRevision);
  const answer = useAnswerController(answerService, {
    delayMs: 0,
    mode: runtimeMode,
    cloudConsent: cloudAnswerConsent,
    query: intent === 'search' ? submittedQuery : '',
    restartKey: submissionRevision,
  });
  const computerUse = useComputerUseController(computerUseService, computerUseSettings);
  const activeScope = useScopeStore((state) => state.activeScope);
  const clearFilters = useScopeStore((state) => state.clearFilters);
  const toggleFilter = useScopeStore((state) => state.toggleFilter);
  const mode = useLauncherStore((state) => state.mode);
  const visible = useLauncherStore((state) => state.visible);
  const selectStoreResult = useSelectionStore((state) => state.select);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsMounted, setDetailsMounted] = useState(false);
  const [detailsFileId, setDetailsFileId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const windowsSnapshot = useWindowsAiStore((state) => state.snapshot);
  const [externalAgentId, setExternalAgentId] = useState('');
  const [externalAgentBusy, setExternalAgentBusy] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const voice = useRef<DictationSession | null>(null);
  const voiceGeneration = useRef(0);
  const voiceReady = canUseWindowsAiFeature(windowsSnapshot?.features.find((item) => item.id === 'edgeSpeech'));
  const stopVoice = useCallback(() => {
    voiceGeneration.current += 1;
    voice.current?.stop(); voice.current = null; setVoiceActive(false);
  }, []);
  useEffect(() => {
    if (!visible || !voiceReady) stopVoice();
    return stopVoice;
  }, [intent, stopVoice, visible, voiceReady]);
  useEffect(() => {
    if (!windowsSnapshot?.preferences.agentsEnabled || !windowsSnapshot.agents.some((agent) => agent.id === externalAgentId)) setExternalAgentId('');
  }, [externalAgentId, windowsSnapshot]);
  const toggleVoice = async () => {
    if (voiceActive) { stopVoice(); return; }
    const generation = ++voiceGeneration.current;
    const initial = useQueryStore.getState().draft.trim();
    setVoiceActive(true);
    try {
      const session = await windowsAiService.startDictation({
        onText: (text) => {
          if (generation !== voiceGeneration.current) return;
          useQueryStore.getState().setDraft(`${initial} ${text}`.trim());
        },
        onEnd: () => { if (generation === voiceGeneration.current) { voice.current = null; setVoiceActive(false); } },
        onError: () => { if (generation === voiceGeneration.current) { setActionMessage('Local dictation could not start. Check microphone permission and the selected language.'); setVoiceActive(false); } },
      });
      if (generation !== voiceGeneration.current || !useLauncherStore.getState().visible) session.stop();
      else voice.current = session;
    } catch { if (generation === voiceGeneration.current) { setVoiceActive(false); setActionMessage('Local dictation is unavailable in this host.'); } }
  };

  useEffect(() => {
    let pendingQuery = 0;
    const scheduleQuery = (query: string) => {
      window.clearTimeout(pendingQuery);
      pendingQuery = window.setTimeout(() => controller.setQuery(
        intent === 'search' ? query : '',
      ), queryDebounceMs);
    };
    scheduleQuery(useQueryStore.getState().committed);
    const unsubscribe = useQueryStore.subscribe(
      (state) => state.committed,
      scheduleQuery,
    );
    return () => {
      window.clearTimeout(pendingQuery);
      unsubscribe();
    };
  }, [controller.setQuery, intent]);
  useEffect(
    () => controller.setScope(activeScope),
    [activeScope, controller.setScope],
  );
  useEffect(
    () => {
      selectStoreResult(controller.selectedId);
    },
    [controller.selectedId, selectStoreResult],
  );
  useEffect(() => {
    setActionMessage('');
    if (!controller.selectedId) {
      setDetailsOpen(false);
    }
  }, [controller.selectedId]);

  const handleSelect = useCallback((fileId: string | null) => {
    const startedAt = performance.now();
    controller.rememberSelection(fileId);
    selectStoreResult(fileId);
    measureAfterPaint('selection-paint', startedAt);
  }, [controller.rememberSelection, selectStoreResult]);

  const handleOpen = useCallback(async (requestedId?: string) => {
    const fileId = requestedId ?? readSelectionIntent() ?? controller.selectedId;
    if (!fileId || openingId) {
      return;
    }
    const result = controller.results.find((item) => item.id === fileId);
    setOpeningId(fileId);
    setActionMessage(`Opening ${result?.name ?? 'file'}`);
    try {
      await service.openFile(fileId);
      if (result?.kind === 'app-content') return;
      await delay(motionTokens.duration.press * 1000);
      const hidden = await requestWindowHide(windowService);
      if (!hidden) setActionMessage(`Opened ${result?.name ?? 'file'}, but Lumen could not hide.`);
    } catch (error) {
      setActionMessage(
        error instanceof Error ? error.message : 'The selected file could not be opened.',
      );
    } finally {
      setOpeningId(null);
    }
  }, [
    controller.selectedId,
    controller.results,
    openingId,
    service,
    windowService,
  ]);

  const handleOpenContainingFolder = useCallback(async () => {
    const fileId = readSelectionIntent() ?? controller.selectedId;
    if (!fileId) {
      return;
    }
    try {
      await service.openContainingFolder(fileId);
      const result = controller.results.find((item) => item.id === fileId);
      setActionMessage(`Opened the folder containing ${result?.name ?? 'the result'}`);
    } catch (error) {
      setActionMessage(
        error instanceof Error ? error.message : 'The containing folder could not be opened.',
      );
    }
  }, [controller.results, controller.selectedId, service]);

  const handlePin = useCallback(async () => {
    const fileId = readSelectionIntent() ?? controller.selectedId;
    const result = controller.results.find((item) => item.id === fileId);
    if (!fileId || !result?.provenance) return;
    try {
      const applied = await service.setPinned(fileId, !result.pinned);
      if (applied) {
        setActionMessage(result.pinned ? `Unpinned ${result.name}` : `Pinned ${result.name}`);
        controller.refresh();
      }
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'The pin could not be updated.');
    }
  }, [controller, service]);

  const handleShowDetails = useCallback(() => {
    if (!previewsEnabled) {
      setActionMessage('File previews are disabled in Privacy settings.');
      return;
    }
    const fileId = readSelectionIntent() ?? controller.selectedId;
    if (fileId) {
      setDetailsFileId(fileId);
      setDetailsMounted(true);
      setDetailsOpen(true);
    }
  }, [controller.selectedId, previewsEnabled]);

  const handleRequestHide = useCallback(async () => {
    await requestWindowHide(windowService);
  }, [windowService]);

  const handleOpenSettings = useCallback(async (page?: 'computer-use') => {
    if (page) setActiveSettingsPage(page);
    const presentation = requestWindowShow(windowService, 'settings');
    onOpenSettings?.();
    await presentation;
  }, [onOpenSettings, setActiveSettingsPage, windowService]);

  const handleStartComputerUse = useCallback(() => {
    void computerUse.start(inputRef.current?.value ?? useQueryStore.getState().committed);
  }, [computerUse.start]);

  const handleRunExternalAgent = useCallback(async (task: string) => {
    if (!externalAgentId || externalAgentBusy) return;
    setExternalAgentBusy(true); setActionMessage('');
    try { const result = await windowsAiService.invokeAgent(externalAgentId, task); setActionMessage(result.message); }
    catch { setActionMessage('The selected Windows agent could not accept the prompt. Refresh its availability in settings.'); }
    finally { setExternalAgentBusy(false); }
  }, [externalAgentBusy, externalAgentId]);

  const handleSubmitComputerUse = useCallback((task: string) => {
    if (externalAgentId) void handleRunExternalAgent(task);
    else void computerUse.start(task);
  }, [computerUse.start, externalAgentId, handleRunExternalAgent]);

  const handleRemoveFilter = useCallback((filter: SearchFilter) => {
    toggleFilter(filter);
  }, [toggleFilter]);

  useLumenKeyboard({
    detailsOpen,
    inputRef,
    intent,
    isExpanded: mode === 'expanded',
    results: intent === 'search' ? controller.results : [],
    selectedId: controller.selectedId,
    onCloseDetails: () => setDetailsOpen(false),
    onOpen: handleOpen,
    onOpenContainingFolder: handleOpenContainingFolder,
    onOpenSettings: () => handleOpenSettings(),
    onRequestHide: handleRequestHide,
    onSelect: handleSelect,
    onShowDetails: handleShowDetails,
  });

  const announcement = useMemo(() => {
    if (actionMessage) {
      return actionMessage;
    }
    if (controller.lifecycle === 'searching') {
      return 'Searching local files';
    }
    if (controller.lifecycle === 'error') {
      return controller.error?.message ?? 'Search is unavailable';
    }
    if (controller.lifecycle === 'empty') {
      return 'No results';
    }
    if (controller.lifecycle === 'ready') {
      return `${controller.results.length} ${controller.results.length === 1 ? 'result' : 'results'}`;
    }
    return 'Lumen is ready';
  }, [
    actionMessage,
    controller.error?.message,
    controller.lifecycle,
    controller.results.length,
  ]);
  const answerRunning = answer.phase === 'waiting' || answer.phase === 'streaming';

  return (
    <div className="contents" data-launcher-visible={visible}>
      <CollapsedLauncher
        expandedContent={intent === 'computer' ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <WindowsAgentPicker selected={externalAgentId} busy={externalAgentBusy || computerUse.phase === 'running' || computerUse.phase === 'approval' || computerUse.phase === 'starting'} message={actionMessage} onChange={setExternalAgentId} onRun={() => void handleRunExternalAgent(useQueryStore.getState().committed)} />
          {!externalAgentId ? (
          <QueryBoundComputerUsePanel
            cloudConsent={computerUseSettings.cloudConsent}
            controller={computerUse}
            onOpenSettings={() => void handleOpenSettings('computer-use')}
            onStart={handleStartComputerUse}
          />
          ) : null}
          </div>
        ) : (
          <ExpandedWorkspace
            activeFilters={activeFilters}
            announcement={announcement}
            answerPanel={submittedQuery.trim() ? (
              <AnswerPanel
                answer={answer}
                mode={runtimeMode}
                onModeChange={(nextMode) => void updateAi({runtimeMode: nextMode})}
                onOpenCitation={(fileId) => void handleOpen(fileId)}
                onRetry={answer.retry}
                onStop={answer.stop}
              />
            ) : null}
            error={controller.error}
            lifecycle={controller.lifecycle}
            openingId={openingId}
            previewAllowed={previewsEnabled}
            results={controller.results}
            service={service}
            onClearFilters={clearFilters}
            onDetails={handleShowDetails}
            onOpen={handleOpen}
            onOpenContainingFolder={handleOpenContainingFolder}
            onPin={handlePin}
            onRemoveFilter={handleRemoveFilter}
            onSelectionChange={handleSelect}
          />
        )}
        inputRef={inputRef}
        intentLocked={externalAgentBusy || computerUse.phase === 'starting' || computerUse.phase === 'running' || computerUse.phase === 'approval'}
        onVoiceRequest={voiceReady || voiceActive ? () => void toggleVoice() : undefined}
        voiceActive={voiceActive}
        searching={intent === 'computer'
          ? computerUse.phase === 'starting' || computerUse.phase === 'running'
          : controller.lifecycle === 'searching' || answerRunning}
        statusLabel={intent === 'computer'
          ? computerUse.phase === 'approval' ? 'Approval'
            : computerUse.phase === 'completed' ? 'Done'
              : computerUse.phase === 'error' ? 'Unavailable'
                : computerUse.phase === 'running' || computerUse.phase === 'starting' ? 'Working'
                  : 'Browser agent'
          : answerRunning ? 'Answering'
            : statusLabel(controller.lifecycle, controller.results.length)}
        windowService={windowService}
        onComputerSubmit={handleSubmitComputerUse}
      />
      {detailsMounted && previewsEnabled ? (
        <Suspense fallback={null}>
          <LazyPreviewPane
            fileId={detailsFileId}
            isOpen={detailsOpen}
            mode="dialog"
            restoreFocusRef={inputRef}
            service={service}
            onOpenChange={setDetailsOpen}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
