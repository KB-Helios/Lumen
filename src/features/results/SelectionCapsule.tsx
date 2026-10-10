import {useLayoutEffect, useRef, type RefObject} from 'react';
import {spring} from 'motion';
import {animate} from 'motion/mini';

import {motionTokens} from '../../design-system/motion';
import {useSelectionStore} from '../launcher/selection.store';
import {useLauncherStore} from '../launcher/launcher.store';
import {comfortableResultHeight} from './useResultVirtualizer';

const capsuleSpring = {...motionTokens.selectionSpring, type: spring};

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
  const capsuleRef = useRef<HTMLDivElement>(null);
  const hasPositioned = useRef(false);
  const selectionRef = useRef(selectedId);
  const previousSelectionProp = useRef(selectedId);

  useLayoutEffect(() => {
    const capsule = capsuleRef.current;
    // The parent's ref attaches after this child's first layout effect.
    const container = containerRef.current ?? capsule?.parentElement;
    if (!container || !capsule) return;
    if (previousSelectionProp.current !== selectedId) {
      selectionRef.current = selectedId;
      previousSelectionProp.current = selectedId;
    }
    let observer: ResizeObserver | undefined;
    let styleObserver: MutationObserver | undefined;
    let movement: ReturnType<typeof animate> | undefined;
    let lastTransform: string | undefined;
    let selectionFrame: number | undefined;
    let active = true;
    const updateSelection = (fileId: string | null) => {
      selectionRef.current = fileId;
      observer?.disconnect();
      observer = undefined;
      styleObserver?.disconnect();
      styleObserver = undefined;
      const selected = fileId
        ? [...(container?.querySelectorAll<HTMLElement>('[data-result-id]') ?? [])]
            .find((element) => element.dataset.resultId === fileId)
        : null;
      if (!selected) {
        movement?.stop();
        movement = undefined;
        capsule.style.opacity = '0';
        hasPositioned.current = false;
        lastTransform = undefined;
        return;
      }
      const measure = () => {
        if (!selected.isConnected) { scheduleSelection(selectionRef.current); return; }
        if (selected.dataset.resultId !== selectionRef.current) return;
        // Rects include virtual-row transforms; offsetTop alone does not.
        const bounds = selected.getBoundingClientRect();
        const top = bounds.top - container.getBoundingClientRect().top +
          container.scrollTop - container.clientTop;
        const transform = `translateY(${top}px)`;
        capsule.style.height = `${bounds.height || rowHeight}px`;
        capsule.style.opacity = '1';
        if (transform === lastTransform) return;
        lastTransform = transform;
        movement?.stop();
        if (!hasPositioned.current || reducedMotion || document.visibilityState === 'hidden' || !useLauncherStore.getState().visible || typeof capsule.animate !== 'function') {
          capsule.style.transform = transform;
          movement = undefined;
        } else {
          try {
            movement = animate(capsule, {transform}, capsuleSpring);
          } catch {
            capsule.style.transform = transform;
            movement = undefined;
          }
        }
        hasPositioned.current = true;
      };
      measure();
      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(() => scheduleSelection(selectionRef.current));
        observer.observe(selected);
      }
      // Virtualization can move a mounted row without changing its dimensions.
      if (typeof MutationObserver === 'function') {
        styleObserver = new MutationObserver(() => scheduleSelection(selectionRef.current));
        styleObserver.observe(selected, {attributes: true, attributeFilter: ['style']});
      }
    };
    const scheduleSelection = (fileId: string | null) => {
      selectionRef.current = fileId;
      if (selectionFrame !== undefined) return;
      // Key bursts keep their latest intent without repeatedly measuring or
      // interrupting native animations before the display can paint.
      selectionFrame = requestAnimationFrame(() => {
        selectionFrame = undefined;
        if (active) updateSelection(selectionRef.current);
      });
    };
    queueMicrotask(() => { if (active) updateSelection(selectionRef.current); });
    // React Aria collections and virtual rows can mount after this effect.
    const contentObserver = typeof MutationObserver === 'function'
      ? new MutationObserver(() => scheduleSelection(selectionRef.current)) : undefined;
    contentObserver?.observe(container, {childList: true, subtree: true});
    const stopHidden = () => {
      if (document.visibilityState === 'hidden' || !useLauncherStore.getState().visible) {
        movement?.stop();
        movement = undefined;
        if (lastTransform) capsule.style.transform = lastTransform;
      }
    };
    document.addEventListener('visibilitychange', stopHidden);
    const unsubscribeVisibility = useLauncherStore.subscribe((state) => state.visible, stopHidden);
    const unsubscribe = useSelectionStore.subscribe(
      (state) => state.selectedId,
      scheduleSelection,
    );
    return () => {
      active = false;
      observer?.disconnect();
      styleObserver?.disconnect();
      contentObserver?.disconnect();
      document.removeEventListener('visibilitychange', stopHidden);
      unsubscribe();
      unsubscribeVisibility();
      if (selectionFrame !== undefined) cancelAnimationFrame(selectionFrame);
      movement?.stop();
    };
  }, [containerRef, reducedMotion, rowHeight, selectedId]);

  return (
    <div
      ref={capsuleRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-1.5 top-0 z-10 rounded-control border border-[color:var(--einui-command-divider)] bg-[var(--einui-command-row-selected)] shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] high-contrast:shadow-none"
      data-selection-capsule="true"
    />
  );
}
