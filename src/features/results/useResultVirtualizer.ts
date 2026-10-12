import {useCallback, type RefObject} from 'react';

import {useVirtualizer} from '@tanstack/react-virtual';

export const resultVirtualizationThreshold = 120;
export const comfortableResultHeight = 58;
export const compactResultHeight = 46;

export function useResultVirtualizer(
  count: number,
  scrollRef: RefObject<HTMLDivElement | null>,
  getItemKey: (index: number) => string,
  viewportHeight: number,
  rowHeight = comfortableResultHeight,
) {
  const virtualizer = useVirtualizer({
    count,
    enabled: count > resultVirtualizationThreshold,
    estimateSize: () => rowHeight,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    initialRect: {width: 800, height: viewportHeight},
    observeElementRect: (instance, callback) => {
      const element = instance.scrollElement;
      if (!element) {
        return;
      }

      const measure = () => {
        const rect = element.getBoundingClientRect();
        callback({
          width: Math.round(rect.width || 800),
          height: Math.round(rect.height || viewportHeight),
        });
      };
      measure();

      if (typeof ResizeObserver !== 'function') {
        return () => undefined;
      }
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    },
    overscan: 5,
    useFlushSync: false,
  });
  const scrollToIndex = useCallback((index: number) => {
    virtualizer.scrollToIndex(index, {align: 'auto', behavior: 'auto'});
  }, [virtualizer]);

  return {
    isVirtualized: count > resultVirtualizationThreshold,
    totalSize: virtualizer.getTotalSize(),
    virtualItems: virtualizer.getVirtualItems(),
    scrollToIndex,
  };
}
