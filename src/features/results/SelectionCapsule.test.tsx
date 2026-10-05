import {createRef} from 'react';
import {act, render, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {motionTokens} from '../../design-system/motion';
import {useSelectionStore} from '../launcher/selection.store';
import {SelectionCapsule} from './SelectionCapsule';

const animation = vi.hoisted(() => ({stop: vi.fn(), animate: vi.fn()}));
vi.mock('motion/mini', async (importOriginal) => ({
  ...await importOriginal<typeof import('motion/mini')>(),
  animate: animation.animate,
}));

function renderCapsule(reducedMotion = false) {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((frame: number) => frames.delete(frame)));
  animation.animate.mockReturnValue({stop: animation.stop});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this.dataset.resultId === 'b' ? 280 : 100, 300, 58);
  });
  const containerRef = createRef<HTMLDivElement>();
  const content = (reduce: boolean) => (
    <div ref={containerRef}>
      <div data-result-id="a" />
      <div data-result-id="b" style={{transform: 'translateY(180px)'}} />
      <SelectionCapsule containerRef={containerRef} reducedMotion={reduce} selectedId="a" />
    </div>
  );
  const view = render(content(reducedMotion));
  const capsule = view.container.querySelector<HTMLElement>('[data-selection-capsule]')!;
  capsule.animate = vi.fn<HTMLElement['animate']>();
  const flushSelection = () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const frame of pending) frame(100);
  });
  return {...view, capsule, containerRef, flushSelection, rerenderCapsule: (reduce: boolean) => view.rerender(content(reduce))};
}

afterEach(() => {
  useSelectionStore.getState().reset();
  animation.animate.mockReset();
  animation.stop.mockReset();
  vi.unstubAllGlobals();
});

describe('SelectionCapsule', () => {
  it('keeps selection positioned if native animation is unavailable', () => {
    const {capsule, flushSelection} = renderCapsule();
    Reflect.deleteProperty(capsule, 'animate');
    act(() => useSelectionStore.getState().select('b'));
    flushSelection();
    expect(capsule).toHaveStyle({transform: 'translateY(180px)'});
    expect(animation.animate).not.toHaveBeenCalled();
  });

  it('positions a selected row when the collection mounts it after the capsule', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, this.dataset.resultId ? 280 : 100, 300, 58);
    });
    const containerRef = createRef<HTMLDivElement>();
    const content = (ready: boolean) => <div ref={containerRef}>
      <SelectionCapsule containerRef={containerRef} reducedMotion selectedId="b" />
      {ready ? <div data-result-id="b" /> : null}
    </div>;
    const {container, rerender} = render(content(false));
    rerender(content(true));
    await waitFor(() => expect(container.querySelector('[data-selection-capsule]'))
      .toHaveStyle({opacity: '1', height: '58px', transform: 'translateY(180px)'}));
  });

  it('snaps to the first row, then delegates full-transform spring movement', () => {
    const {capsule, flushSelection} = renderCapsule();
    expect(capsule).toHaveStyle({transform: 'translateY(0px)', opacity: '1'});
    expect(animation.animate).not.toHaveBeenCalled();

    act(() => useSelectionStore.getState().select('b'));
    flushSelection();

    expect(animation.animate).toHaveBeenCalledWith(
      capsule, {transform: 'translateY(180px)'}, {...motionTokens.selectionSpring, type: expect.any(Function)},
    );
  });

  it('keeps the current imperative selection when reduced motion changes', () => {
    const {capsule, rerenderCapsule} = renderCapsule();
    act(() => useSelectionStore.getState().select('b'));
    rerenderCapsule(true);
    expect(capsule).toHaveStyle({transform: 'translateY(180px)'});
  });

  it('positions transformed virtual rows within the scrolled content under reduced motion', () => {
    const {capsule, containerRef, flushSelection} = renderCapsule(true);
    containerRef.current!.scrollTop = 40;
    act(() => useSelectionStore.getState().select('b'));
    flushSelection();

    expect(capsule).toHaveStyle({transform: 'translateY(220px)'});
    expect(animation.animate).not.toHaveBeenCalled();
  });

  it('remeasures a selected virtual row when its inline transform changes', async () => {
    const {capsule, containerRef, flushSelection} = renderCapsule(true);
    act(() => useSelectionStore.getState().select('b'));
    flushSelection();
    expect(capsule).toHaveStyle({transform: 'translateY(180px)'});

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, this.dataset.resultId === 'b' ? 400 : 100, 300, 58);
    });
    await act(async () => {
      containerRef.current!.querySelector<HTMLElement>('[data-result-id="b"]')!.style.transform = 'translateY(300px)';
      await Promise.resolve();
    });
    flushSelection();
    expect(capsule).toHaveStyle({transform: 'translateY(300px)'});
  });

  it('stops interrupted movement and cancels animation when selection disappears', () => {
    const {capsule, unmount, flushSelection} = renderCapsule();
    act(() => useSelectionStore.getState().select('b'));
    flushSelection();
    act(() => useSelectionStore.getState().select('a'));
    flushSelection();
    expect(animation.stop).toHaveBeenCalledOnce();

    act(() => useSelectionStore.getState().select(null));
    flushSelection();
    expect(animation.stop).toHaveBeenCalledTimes(2);
    expect(capsule).toHaveStyle({opacity: '0'});
    act(() => useSelectionStore.getState().select('b'));
    flushSelection();
    expect(capsule).toHaveStyle({transform: 'translateY(180px)'});
    unmount();
  });

  it('coalesces a selection burst into one native animation for the last intent', () => {
    const {capsule, flushSelection} = renderCapsule();
    act(() => {
      for (let index = 0; index < 31; index += 1) {
        useSelectionStore.getState().select(index % 2 === 0 ? 'b' : 'a');
      }
    });
    expect(animation.animate).not.toHaveBeenCalled();
    flushSelection();
    expect(animation.animate).toHaveBeenCalledOnce();
    expect(animation.animate).toHaveBeenCalledWith(
      capsule, {transform: 'translateY(180px)'}, {...motionTokens.selectionSpring, type: expect.any(Function)},
    );
  });

  it('cancels queued selection work on unmount', () => {
    const {unmount, flushSelection} = renderCapsule();
    act(() => useSelectionStore.getState().select('b'));
    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
    flushSelection();
    expect(animation.animate).not.toHaveBeenCalled();
  });
});
