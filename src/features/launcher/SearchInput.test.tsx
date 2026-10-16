import {act, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {SearchInput} from './SearchInput';
import {useQueryStore} from './query.store';

afterEach(() => {
  useQueryStore.getState().reset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SearchInput composition admission', () => {
  for (const boundary of ['before frame', 'after frame before timer']) {
    it(`publishes preceding ordinary input when composition starts ${boundary}`, () => {
      vi.useFakeTimers();
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 0;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        const id = ++nextFrame;
        frames.set(id, callback);
        return id;
      });
      vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
      const flushInputWork = () => act(() => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((frame) => frame(16));
        vi.runOnlyPendingTimers();
      });
      render(<SearchInput onEscapeEmpty={() => undefined} />);
      const input = screen.getByRole('searchbox') as HTMLInputElement;

      fireEvent.input(input, {target: {value: 'report'}});
      flushInputWork();
      fireEvent.input(input, {target: {value: ''}});
      flushInputWork();
      expect(useQueryStore.getState().committed).toBe('');
      fireEvent.input(input, {target: {value: 'report again'}});
      input.setSelectionRange(3, 3);
      if (boundary.startsWith('after')) act(() => {
        frames.get(nextFrame)!(16);
        frames.clear();
      });
      fireEvent.compositionStart(input);
      flushInputWork();

      expect(screen.getByRole('searchbox')).toBe(input);
      expect(input).toHaveValue('report again');
      expect(input.selectionStart).toBe(3);
      expect(input.selectionEnd).toBe(3);
      expect(useQueryStore.getState()).toMatchObject({
        committed: 'report again', draft: 'report again', isComposing: true,
      });

      fireEvent.input(input, {target: {value: 'report again\u30eb'}});
      flushInputWork();
      expect(useQueryStore.getState()).toMatchObject({
        committed: 'report again', draft: 'report again\u30eb', isComposing: true,
      });
      fireEvent.compositionEnd(input);
      expect(useQueryStore.getState()).toMatchObject({
        committed: 'report again\u30eb', isComposing: false,
      });
      expect(screen.getByRole('searchbox')).toBe(input);
    });
  }
});
