import {useLayoutEffect, useRef, type RefObject} from 'react';
import {motion, useMotionValue, useSpring} from 'motion/react';

import {motionTokens} from '../../design-system/motion';
import {useSelectionStore} from '../launcher/selection.store';
import {comfortableResultHeight} from './useResultVirtualizer';

export interface SelectionCapsuleProps {
  containerRef: RefObject<HTMLDivElement | null>;
  reducedMotion?: boolean;
  rowHeight?: number;
  selectedId: string | null;
}

export function SelectionCapsule({
  containerRef,
  reducedMotion = false,
  rowHeight = comfortableResultHeight,
  selectedId,
}: SelectionCapsuleProps) {
  const targetY = useMotionValue(0);
  const springY = useSpring(targetY, motionTokens.selectionSpring);
  const height = useMotionValue(rowHeight);
  const opacity = useMotionValue(0);
  const hasPositioned = useRef(false);

  useLayoutEffect(() => {
    let resizeObserver: ResizeObserver | undefined;
    let styleObserver: MutationObserver | undefined;
    let collectionObserver: MutationObserver | undefined;
    let selectionFrame: number | undefined;
    let pendingSelectedId = selectedId;
    let active = true;
    const updateSelection = (fileId: string | null) => {
      const container = containerRef.current;
      resizeObserver?.disconnect();
      resizeObserver = undefined;
      styleObserver?.disconnect();
      styleObserver = undefined;
      collectionObserver?.disconnect();
      collectionObserver = undefined;
      const selected = fileId
        ? [...(container?.querySelectorAll<HTMLElement>('[data-result-id]') ?? [])]
            .find((element) => element.dataset.resultId === fileId)
        : null;
      if (!container || !selected) {
        opacity.set(0);
        hasPositioned.current = false;
        // React Aria mounts collection rows after the parent's layout effects.
        // Observe only until this selected row exists, then measure that row.
        if (container && fileId && typeof MutationObserver === 'function') {
          collectionObserver = new MutationObserver(() => updateSelection(fileId));
          collectionObserver.observe(container, {childList: true, subtree: true});
        }
        return;
      }
      const measure = () => {
        if (!selected.isConnected) {
          updateSelection(fileId);
          return;
        }
        const transformY = selected.style.transform && typeof DOMMatrixReadOnly === 'function'
          ? new DOMMatrixReadOnly(selected.style.transform).m42
          : 0;
        const positionY = selected.offsetTop + transformY;
        if (!hasPositioned.current) {
          hasPositioned.current = true;
          springY.jump(positionY);
        }
        targetY.set(positionY);
        height.set(selected.offsetHeight || rowHeight);
        opacity.set(1);
      };
      measure();
      if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(measure);
        resizeObserver.observe(selected);
      }
      // Observe inline style changes (transform) for virtualized row position updates.
      // Only remeasure when the transform value actually changes to avoid overhead
      // during hover/focus style changes that don't affect position.
      if (typeof MutationObserver === 'function') {
        let lastTransform = selected.style.transform;
        styleObserver = new MutationObserver(() => {
          const currentTransform = selected.style.transform;
          if (currentTransform !== lastTransform) {
            lastTransform = currentTransform;
            measure();
          }
        });
        styleObserver.observe(selected, {attributes: true, attributeFilter: ['style']});
      }
    };
    // Child layout effects run before the containing viewport's ref is attached.
    // Measure after that commit, without waiting for the next animation frame.
    queueMicrotask(() => { if (active) updateSelection(selectedId); });
    const unsubscribe = useSelectionStore.subscribe(
      (state) => state.selectedId,
      (fileId) => {
        pendingSelectedId = fileId;
        // Selection attributes update immediately. Read highlight geometry once
        // before paint, even when several key events arrive in the same frame.
        selectionFrame ??= requestAnimationFrame(() => {
          selectionFrame = undefined;
          if (active) updateSelection(pendingSelectedId);
        });
      },
    );
    return () => {
      active = false;
      if (selectionFrame !== undefined) cancelAnimationFrame(selectionFrame);
      resizeObserver?.disconnect();
      styleObserver?.disconnect();
      collectionObserver?.disconnect();
      unsubscribe();
    };
  }, [containerRef, height, opacity, rowHeight, selectedId, springY, targetY]);

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-1.5 top-0 z-10 rounded-control border border-[color:var(--einui-command-divider)] bg-[var(--einui-command-row-selected)] shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] high-contrast:shadow-none"
      data-selection-capsule="true"
      layoutId="lumen-result-selection"
      style={{height, opacity, y: reducedMotion ? targetY : springY}}
    />
  );
}
