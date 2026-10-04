import {useEffect, useRef, type CSSProperties} from 'react';
import {GridListItem} from 'react-aria-components';

import {FileGlyph} from '../../design-system/file-glyphs/FileGlyph';
import {motionTokens} from '../../design-system/motion';
import type {SearchResult} from '../../services/search/search.types';

const sourceLabels: Record<SearchResult['match']['source'], string> = {
  filename: 'Name', content: 'Content', metadata: 'Metadata', ocr: 'OCR', semantic: 'Meaning', related: 'Related',
};

const availabilityLabels: Record<NonNullable<SearchResult['availability']>, string> = {
  available: '', loading: 'Loading', unavailable: 'Unavailable', permissionDenied: 'Permission required',
};

function formatSize(sizeBytes?: number) {
  if (sizeBytes === undefined) return '';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function accessibilityLabel(result: SearchResult) {
  const state = availabilityLabels[result.availability ?? 'available'];
  return [result.name, result.path, sourceLabels[result.match.source], state]
    .filter(Boolean)
    .join(', ');
}

export interface ResultRowProps {
  animateEntrance?: boolean;
  entranceIndex?: number;
  isOpening?: boolean;
  reducedMotion?: boolean;
  result: SearchResult;
  selected?: boolean;
  positionStyle?: CSSProperties;
  positionIndex?: number;
  totalCount?: number;
}

export function ResultRow({
  animateEntrance = false,
  entranceIndex = 0,
  isOpening = false,
  reducedMotion = false,
  result,
  selected = false,
  positionStyle,
  positionIndex,
  totalCount,
}: ResultRowProps) {
  const isDisabled = (result.availability ?? 'available') !== 'available';
  const stateLabel = availabilityLabels[result.availability ?? 'available'];
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = rowRef.current;
    if (!animateEntrance || !element || typeof element.animate !== 'function') return;
    const {duration, stagger, maxStaggered, reducedDuration} = motionTokens.rowEntrance;
    const animation = element.animate([{opacity: 0}, {opacity: 1}], {
      delay: reducedMotion ? 0 : Math.min(entranceIndex, maxStaggered) * stagger * 1000,
      duration: (reducedMotion ? reducedDuration : duration) * 1000,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      fill: 'backwards',
    });
    return () => animation.cancel();
  }, []);

  return (
    <GridListItem
      ref={rowRef}
      id={result.id}
      aria-label={accessibilityLabel(result)}
      aria-posinset={positionIndex === undefined ? undefined : positionIndex + 1}
      aria-setsize={totalCount}
      className="relative z-20 grid min-h-[var(--lumen-result-row-height)] min-w-0 cursor-default grid-cols-[36px_minmax(0,1fr)_minmax(72px,auto)] items-center gap-3 rounded-control border border-transparent px-4 text-[color:var(--einui-command-text)] outline-none transition-[background-color,color,transform] duration-[90ms] ease-standard data-[hovered]:bg-[var(--einui-command-row-hover)] data-[focus-visible]:ring-2 data-[focus-visible]:ring-[var(--lumen-focus)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-65 data-[opening]:scale-[.992] min-[760px]:grid-cols-[36px_minmax(0,1fr)_auto_minmax(72px,auto)_42px]"
      data-opening={isOpening || undefined}
      data-result-id={result.id}
      isDisabled={isDisabled}
      style={positionStyle}
      textValue={result.name}
    >
      <>
        <FileGlyph kind={result.kind} selected={selected} size="large" />
        <div className="grid min-w-0 gap-0.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-sans text-sm font-medium text-[color:var(--einui-command-text)]">{result.name}</span>
            {result.metadata.extension ? <span className="shrink-0 font-sans text-[0.6875rem] text-[color:var(--einui-command-muted-text)]">{result.metadata.extension.toUpperCase()}</span> : null}
          </div>
          <div className="flex min-w-0 items-center gap-2 font-sans text-[0.6875rem] leading-[1.45]">
            <span className="min-w-0 truncate text-[color:var(--einui-command-muted-text)]" title={result.path}>{result.path}</span>
            {result.match.fragment ? <span className="min-w-0 truncate text-[color:var(--einui-command-muted-text)]">{result.match.fragment}</span> : null}
          </div>
        </div>
        <span className="hidden shrink-0 rounded-pill bg-[var(--einui-command-row)] px-2 py-0.5 font-sans text-[0.6875rem] text-[color:var(--einui-command-muted-text)] min-[760px]:block">{sourceLabels[result.match.source]}</span>
        <span className="flex min-w-[88px] justify-end font-sans text-[0.6875rem] text-[color:var(--einui-command-muted-text)]">{stateLabel || formatSize(result.metadata.sizeBytes)}</span>
        <kbd aria-hidden="true" className="hidden min-w-[42px] justify-end font-sans text-xs text-[color:var(--einui-command-muted-text)] min-[760px]:flex">Enter</kbd>
      </>
    </GridListItem>
  );
}
