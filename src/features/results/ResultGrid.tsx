import {useLayoutEffect, useMemo, useRef} from 'react';
import {GridList, type Key, type Selection} from 'react-aria-components';
import {motion} from 'motion/react';

import {motionTokens} from '../../design-system/motion';
import type {SearchResult} from '../../services/search/search.types';
import {useAppearanceStore} from '../../state/appearance.store';
import {useSelectionStore} from '../launcher/selection.store';
import {ResultRow} from './ResultRow';
import {SelectionCapsule} from './SelectionCapsule';
import {
  comfortableResultHeight,
  compactResultHeight,
  useResultVirtualizer,
} from './useResultVirtualizer';

interface VirtualResult {
  id: string;
  index: number;
  result: SearchResult;
  start: number;
  size: number;
}

export interface ResultGridProps {
  animateRows?: boolean;
  emptyLabel?: string;
  openingId?: string | null;
  results: readonly SearchResult[];
  selectedId: string | null;
  maxHeight?: number;
  reducedMotion?: boolean;
  onSelectionChange?: (fileId: string | null) => void;
  onAction?: (fileId: string) => void;
}

export function ResultGrid({
  animateRows = false,
  emptyLabel = 'No files found',
  openingId = null,
  results,
  selectedId,
  maxHeight = 384,
  reducedMotion = false,
  onSelectionChange,
  onAction,
}: ResultGridProps) {
  const density = useAppearanceStore((state) => state.density);
  const rowHeight = density === 'compact' ? compactResultHeight : comfortableResultHeight;
  const viewportRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const selectedResult = results.find((result) => result.id === selectedId);
  const effectiveSelectedId = selectedResult && (selectedResult.availability ?? 'available') === 'available'
    ? selectedId
    : null;
  const selectedKeys = useMemo(
    () => new Set<Key>(effectiveSelectedId ? [effectiveSelectedId] : []),
    [effectiveSelectedId],
  );
  const disabledKeys = useMemo(
    () => new Set<Key>(
      results
        .filter((result) => (result.availability ?? 'available') !== 'available')
        .map((result) => result.id),
    ),
    [results],
  );

  useLayoutEffect(() => {
    if (selectedId !== null && effectiveSelectedId === null) {
      onSelectionChange?.(null);
    }
  }, [effectiveSelectedId, onSelectionChange, selectedId]);

  const {isVirtualized, totalSize, virtualItems} = useResultVirtualizer(
    results.length,
    viewportRef,
    (index) => results[index]?.id ?? String(index),
    maxHeight,
    rowHeight,
  );
  const visibleResults = useMemo<readonly VirtualResult[]>(
    () => virtualItems.flatMap((item) => {
      const result = results[item.index];
      return result
        ? [{id: result.id, index: item.index, result, start: item.start, size: item.size}]
        : [];
    }),
    [results, virtualItems],
  );
  const plainEntries = useMemo(
    () => results.map((result, index) => ({id: result.id, index, result})),
    [results],
  );

  useLayoutEffect(() => {
    gridRef.current?.setAttribute('aria-rowcount', String(results.length));
  }, [results.length]);

  useLayoutEffect(() => {
    const applySelection = (fileId: string | null) => {
      for (const row of gridRef.current?.querySelectorAll<HTMLElement>('[data-result-id]') ?? []) {
        const isSelected = row.dataset.resultId === fileId;
        row.setAttribute('aria-selected', String(isSelected));
        if (isSelected) row.setAttribute('data-selected', 'true');
        else row.removeAttribute('data-selected');
      }
    };
    applySelection(effectiveSelectedId);
    return useSelectionStore.subscribe(
      (state) => state.selectedId,
      applySelection,
    );
  }, [effectiveSelectedId]);

  const handleSelectionChange = (selection: Selection) => {
    if (selection === 'all') return;
    const key = selection.values().next().value;
    onSelectionChange?.(key === undefined ? null : String(key));
  };
  const handleAction = onAction ? (key: Key) => onAction(String(key)) : undefined;
  const renderEmptyState = () => (
    <motion.div
      animate={{opacity: 1}}
      className="grid min-h-[220px] place-items-center p-6 text-center font-sans text-[0.9375rem] text-[color:var(--einui-command-muted-text)]"
      initial={reducedMotion ? false : {opacity: 0}}
      transition={{duration: motionTokens.duration.selection}}
    >
      {emptyLabel}
    </motion.div>
  );
  const gridClassName = 'relative grid content-start gap-1 p-1.5 outline-none';

  return (
    <div
      ref={viewportRef}
      className="relative min-h-0 min-w-0 overflow-y-auto [scrollbar-color:var(--einui-command-divider)_transparent] [scrollbar-width:thin]"
      style={{maxHeight, height: maxHeight}}
    >
      <SelectionCapsule
        containerRef={viewportRef}
        reducedMotion={reducedMotion}
        rowHeight={rowHeight}
        selectedId={effectiveSelectedId}
      />
      {isVirtualized ? (
        <GridList
          ref={gridRef}
          aria-label="Search results"
          aria-rowcount={results.length}
          className={gridClassName}
          disabledKeys={disabledKeys}
          items={visibleResults}
          renderEmptyState={renderEmptyState}
          defaultSelectedKeys={selectedKeys}
          selectionBehavior="replace"
          selectionMode="single"
          style={{height: totalSize}}
          onAction={handleAction}
          onSelectionChange={handleSelectionChange}
        >
          {(entry) => (
            <ResultRow
              isOpening={entry.id === openingId}
              positionIndex={entry.index}
              positionStyle={{
                position: 'absolute', top: 0, left: 0, width: '100%', height: entry.size,
                transform: `translateY(${entry.start}px)`,
              }}
              result={entry.result}
              selected={entry.id === effectiveSelectedId}
              totalCount={results.length}
            />
          )}
        </GridList>
      ) : (
        <GridList
          ref={gridRef}
          aria-label="Search results"
          aria-rowcount={results.length}
          className={gridClassName}
          disabledKeys={disabledKeys}
          items={plainEntries}
          renderEmptyState={renderEmptyState}
          defaultSelectedKeys={selectedKeys}
          selectionBehavior="replace"
          selectionMode="single"
          onAction={handleAction}
          onSelectionChange={handleSelectionChange}
        >
          {(entry) => (
            <ResultRow
              animateEntrance={animateRows}
              entranceIndex={entry.index}
              isOpening={entry.result.id === openingId}
              reducedMotion={reducedMotion}
              result={entry.result}
              selected={entry.id === effectiveSelectedId}
              totalCount={results.length}
            />
          )}
        </GridList>
      )}
    </div>
  );
}
