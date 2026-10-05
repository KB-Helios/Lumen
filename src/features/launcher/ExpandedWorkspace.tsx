import type {ReactNode} from 'react';
import {Suspense, useEffect, useLayoutEffect, useRef, useState} from 'react';

import {useLumenMotion} from '../../design-system/MotionProvider';
import type {SearchService} from '../../services/search/search-service';
import {useAppearanceStore} from '../../state/appearance.store';
import type {
  SearchError,
  SearchFilter,
  SearchResult,
} from '../../services/search/search.types';
import {LazyPreviewPane} from '../preview/LazyPreviewPane';
import {ResultGrid} from '../results/ResultGrid';
import {ContextActions} from './ContextActions';
import {FilterChips} from './FilterChips';
import {useSelectionStore} from './selection.store';
import type {SearchLifecycle} from './useSearchController';

export interface ExpandedWorkspaceProps {
  activeFilters: readonly SearchFilter[];
  announcement: string;
  answerPanel?: ReactNode;
  error: SearchError | null;
  lifecycle: SearchLifecycle;
  openingId: string | null;
  previewAllowed?: boolean;
  results: readonly SearchResult[];
  selectedId?: string | null;
  service: SearchService;
  onClearFilters(): void;
  onDetails(): void;
  onOpen(fileId?: string): void;
  onOpenContainingFolder(): void;
  onPin(): void;
  onRemoveFilter(filter: SearchFilter): void;
  onSelectionChange(fileId: string | null): void;
}

function SelectionBoundResults({
  openingId,
  reducedMotion,
  results,
  selectedId: selectedIdOverride,
  emptyState,
  onOpen,
  onSelectionChange,
}: {
  openingId: string | null;
  reducedMotion: boolean;
  results: readonly SearchResult[];
  selectedId?: string | null;
  emptyState: string;
  onOpen(fileId?: string): void;
  onSelectionChange(fileId: string | null): void;
}) {
  const requestedSelectedId = selectedIdOverride === undefined
    ? useSelectionStore.getState().selectedId
    : selectedIdOverride;
  const selectedId = results.some((item) => item.id === requestedSelectedId)
    ? requestedSelectedId
    : results.find((item) => (item.availability ?? 'available') === 'available')?.id ?? null;
  const generation = useRef(0);
  const previousResults = useRef(results);
  if (previousResults.current !== results) {
    previousResults.current = results;
    generation.current += 1;
  }
  return (
    <ResultGrid
      key={`${results[0]?.id ?? 'empty'}-${results.length}`}
      animateRows={generation.current > 1}
      emptyLabel={emptyState}
      maxHeight={338}
      openingId={openingId}
      reducedMotion={reducedMotion}
      results={results}
      selectedId={selectedId}
      onAction={onOpen}
      onSelectionChange={onSelectionChange}
    />
  );
}

function useSettledSelection(delayMs = 48) {
  const [selectedId, setSelectedId] = useState(
    () => useSelectionStore.getState().selectedId,
  );
  useEffect(() => {
    let pending = 0;
    const unsubscribe = useSelectionStore.subscribe(
      (state) => state.selectedId,
      (nextId) => {
        window.clearTimeout(pending);
        pending = window.setTimeout(() => setSelectedId(nextId), delayMs);
      },
    );
    return () => {
      window.clearTimeout(pending);
      unsubscribe();
    };
  }, [delayMs]);
  return selectedId;
}

function SelectionBoundPreview({
  reducedMotion,
  selectedId: selectedIdOverride,
  service,
}: {
  reducedMotion: boolean;
  selectedId?: string | null;
  service: SearchService;
}) {
  const settledSelectedId = useSettledSelection();
  const fileId = selectedIdOverride === undefined
    ? settledSelectedId
    : selectedIdOverride;
  return <LazyPreviewPane fileId={fileId} reducedMotion={reducedMotion} service={service} />;
}

function SelectionBoundActions({
  isOpening,
  results,
  selectedId: selectedIdOverride,
  onDetails,
  onOpen,
  onOpenContainingFolder,
  onPin,
}: {
  isOpening: boolean;
  results: readonly SearchResult[];
  selectedId?: string | null;
  onDetails(): void;
  onOpen(fileId?: string): void;
  onOpenContainingFolder(): void;
  onPin(): void;
}) {
  const resultLabelRef = useRef<HTMLSpanElement>(null);
  const storedSelectedId = useSelectionStore.getState().selectedId;
  const selectedId = selectedIdOverride === undefined
    ? storedSelectedId
    : selectedIdOverride;
  const result = results.find((item) => item.id === selectedId) ??
    results.find((item) => (item.availability ?? 'available') === 'available') ??
    null;
  useLayoutEffect(() => {
    if (selectedIdOverride !== undefined) return;
    const updateLabel = (fileId: string | null) => {
      const selectedResult = results.find((item) => item.id === fileId) ?? null;
      if (resultLabelRef.current) {
        resultLabelRef.current.textContent = selectedResult?.name ?? 'Choose a result for actions';
        resultLabelRef.current.title = selectedResult?.path ?? '';
      }
    };
    updateLabel(useSelectionStore.getState().selectedId);
    return useSelectionStore.subscribe(
      (state) => state.selectedId,
      updateLabel,
    );
  }, [results, selectedIdOverride]);
  return (
    <ContextActions
      isOpening={isOpening}
      result={result}
      resultLabelRef={resultLabelRef}
      onDetails={onDetails}
      onOpen={onOpen}
      onOpenContainingFolder={onOpenContainingFolder}
      onPin={onPin}
    />
  );
}

function SelectionAnnouncement({
  announcement,
  results,
  selectedId: selectedIdOverride,
}: {
  announcement: string;
  results: readonly SearchResult[];
  selectedId?: string | null;
}) {
  const announcementRef = useRef<HTMLDivElement>(null);
  const storedSelectedId = useSelectionStore.getState().selectedId;
  const selectedId = selectedIdOverride === undefined
    ? storedSelectedId
    : selectedIdOverride;
  const selectedResult = results.find((result) => result.id === selectedId);
  useEffect(() => {
    if (selectedIdOverride !== undefined) return;
    const announceSelection = (fileId: string | null) => {
      const result = results.find((item) => item.id === fileId);
      if (announcementRef.current) {
        announcementRef.current.textContent = [announcement, result ? `${result.name} selected` : '']
          .filter(Boolean)
          .join('. ');
      }
    };
    announceSelection(useSelectionStore.getState().selectedId);
    return useSelectionStore.subscribe(
      (state) => state.selectedId,
      announceSelection,
    );
  }, [announcement, results, selectedIdOverride]);
  return (
    <div
      ref={announcementRef}
      aria-atomic="true"
      aria-live="polite"
      className="sr-only"
      data-testid="search-announcement"
    >
      {[announcement, selectedResult ? `${selectedResult.name} selected` : '']
        .filter(Boolean)
        .join('. ')}
    </div>
  );
}

function emptyLabel(lifecycle: SearchLifecycle, error: SearchError | null) {
  if (lifecycle === 'searching') return 'Searching local files…';
  if (lifecycle === 'error') return error?.message ?? 'Search could not be completed.';
  return 'No files found';
}

function useInlinePreview(preview: 'automatic' | 'always' | 'never', allowed: boolean) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [hasRoom, setHasRoom] = useState(false);
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element || !allowed || preview === 'never') {
      setHasRoom(false);
      return;
    }
    const measure = () => {
      const {width, height} = element.getBoundingClientRect();
      // Allow for the launcher's two border pixels at the native 800/760 px sizes.
      const minimumWidth = preview === 'always' ? 760 : 800;
      setHasRoom(width + 2 >= minimumWidth && height >= 220);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [allowed, preview]);
  return {contentRef, showInlinePreview: allowed && preview !== 'never' && hasRoom};
}

export function ExpandedWorkspace({
  activeFilters,
  announcement,
  answerPanel,
  error,
  lifecycle,
  openingId,
  previewAllowed = true,
  results,
  selectedId,
  service,
  onClearFilters,
  onDetails,
  onOpen,
  onOpenContainingFolder,
  onPin,
  onRemoveFilter,
  onSelectionChange,
}: ExpandedWorkspaceProps) {
  const {reducedMotion} = useLumenMotion();
  const preview = useAppearanceStore((state) => state.preview);
  const {contentRef, showInlinePreview} = useInlinePreview(preview, previewAllowed);
  const countLabel = lifecycle === 'searching'
    ? 'Searching'
    : `${results.length} ${results.length === 1 ? 'result' : 'results'}`;

  return (
    <section
      aria-label="Search workspace"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-t border-[color:var(--einui-command-divider)]"
    >
      <FilterChips filters={activeFilters} onClear={onClearFilters} onRemove={onRemoveFilter} />
      <div className="lumen-workspace-scroll flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        {answerPanel}
        <div ref={contentRef} data-workspace-content className={showInlinePreview
          ? 'grid min-h-[94px] min-w-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(280px,38%)] overflow-hidden'
          : 'grid min-h-[94px] min-w-0 flex-1 grid-cols-1 overflow-hidden'}>
          <section aria-label="Search result list" className="flex min-h-0 min-w-0 flex-col">
            <header className="flex min-h-[24px] shrink-0 items-center justify-between gap-[8px] px-[16px]">
              <span className="font-sans text-xs font-medium text-[color:var(--einui-command-text)]">Local results</span>
              <span className="font-sans text-[0.6875rem] text-[color:var(--einui-command-muted-text)]">{countLabel}</span>
            </header>
            <SelectionBoundResults
              emptyState={emptyLabel(lifecycle, error)}
              openingId={openingId}
              reducedMotion={reducedMotion}
              results={results}
              selectedId={selectedId}
              onOpen={onOpen}
              onSelectionChange={onSelectionChange}
            />
          </section>
          {showInlinePreview ? <div className="min-h-0 min-w-0">
            <Suspense fallback={<div aria-label="File preview" className="grid h-full min-h-0 place-items-center font-sans text-xs text-[color:var(--einui-command-muted-text)]">Preparing preview…</div>}>
              <SelectionBoundPreview reducedMotion={reducedMotion} selectedId={selectedId} service={service} />
            </Suspense>
          </div> : null}
        </div>
      </div>
      <SelectionBoundActions
        isOpening={openingId !== null}
        results={results}
        selectedId={selectedId}
        onDetails={onDetails}
        onOpen={onOpen}
        onOpenContainingFolder={onOpenContainingFolder}
        onPin={onPin}
      />
      <SelectionAnnouncement announcement={announcement} results={results} selectedId={selectedId} />
    </section>
  );
}
