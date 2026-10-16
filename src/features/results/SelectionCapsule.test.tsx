import {createRef} from 'react';
import {act, render, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {SelectionCapsule} from './SelectionCapsule';
import {useSelectionStore} from '../launcher/selection.store';
import {useLauncherStore} from '../launcher/launcher.store';

const native = vi.hoisted(() => ({animate: vi.fn(), stop: vi.fn()}));
vi.mock('motion/mini', () => ({animate: native.animate}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); native.animate.mockReset(); native.stop.mockReset(); useSelectionStore.getState().reset(); useLauncherStore.getState().reset(); });

describe('SelectionCapsule native geometry', () => {
  it('skips unchanged resize notifications and measures actual size changes in both directions', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const resizeCallbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
      observe() {}
      disconnect() {}
    });
    let rowHeight = 52;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return {top: this.dataset.resultId ? 46 : 0, width: 200, height: this.dataset.resultId ? rowHeight : 400} as DOMRect;
    });
    const ref = createRef<HTMLDivElement>();
    const {container} = render(<div ref={ref}><SelectionCapsule containerRef={ref} selectedId="a" reducedMotion /><div data-result-id="a" /></div>);
    await act(async () => {});
    const row = container.querySelector('[data-result-id]')!;
    const capsule = container.querySelector<HTMLElement>('[data-selection-capsule]')!;
    const notify = () => resizeCallbacks[0]!([{target: row, borderBoxSize: [{inlineSize: 200, blockSize: rowHeight}]} as unknown as ResizeObserverEntry], {} as ResizeObserver);
    act(notify);
    expect(frames.size).toBe(0);
    for (const height of [60, 52]) {
      rowHeight = height;
      act(notify);
      expect(frames.size).toBe(1);
      act(() => { const callback = frames.values().next().value!; frames.clear(); callback(0); });
      expect(capsule.style.height).toBe(`${height}px`);
      act(notify);
      expect(frames.size).toBe(0);
    }
  });

  it.each(['native', 'document'] as const)('disconnects observers and cancels pending measurements while %s hidden, then snaps the latest selection', async (visibility) => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
    const observing = new Set<Element>();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
      observe(element: Element) {
        observing.add(element);
        queueMicrotask(() => this.callback([{target: element} as ResizeObserverEntry], this as unknown as ResizeObserver));
      }
      disconnect() { observing.clear(); }
    });
    const contentObserving = new Set<Node>();
    vi.stubGlobal('MutationObserver', class {
      observe(element: Node) { contentObserving.add(element); }
      disconnect() { contentObserving.clear(); }
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return {top: this.dataset.resultId === 'b' ? 204 : this.dataset.resultId === 'a' ? 146 : 100, height: 58} as DOMRect;
    });
    let documentVisible = true;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => documentVisible ? 'visible' : 'hidden');
    const ref = createRef<HTMLDivElement>();
    const {container} = render(<div ref={ref}><SelectionCapsule containerRef={ref} selectedId="a" /><div data-result-id="a" /><div data-result-id="b" /></div>);
    const capsule = container.querySelector<HTMLElement>('[data-selection-capsule]')!;
    capsule.animate = vi.fn();
    await act(async () => {});
    expect(frames.size).toBe(1);
    act(() => {
      if (visibility === 'native') useLauncherStore.getState().hide();
      else { documentVisible = false; document.dispatchEvent(new Event('visibilitychange')); }
    });
    expect(frames.size).toBe(0);
    expect(observing.size).toBe(0);
    expect(contentObserving.size).toBe(0);
    act(() => { useSelectionStore.getState().select('b'); resizeCallbacks[0]!([], {} as ResizeObserver); });
    expect(frames.size).toBe(0);
    expect(capsule.style.transform).toBe('translateY(46px)');
    await act(async () => {
      if (visibility === 'native') useLauncherStore.setState({visible: true});
      else { documentVisible = true; document.dispatchEvent(new Event('visibilitychange')); }
    });
    expect(capsule.style.transform).toBe('translateY(104px)');
    expect(native.animate).not.toHaveBeenCalled();
    expect(observing.size).toBe(1);
    expect(contentObserving.size).toBe(2);
    expect(frames.size).toBe(1);
    await act(async () => { const callback = frames.values().next().value!; frames.clear(); callback(0); });
    expect(frames.size).toBe(0);
  });

  it('settles after the initial ResizeObserver notification without reobserving the same row', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }));
    const observe = vi.fn((element: Element, callback: ResizeObserverCallback, observer: ResizeObserver) => {
      queueMicrotask(() => callback([{target: element} as ResizeObserverEntry], observer));
    });
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) { observe(element, this.callback, this as unknown as ResizeObserver); }
      disconnect() {}
    });
    const ref = createRef<HTMLDivElement>();
    render(<div ref={ref}><SelectionCapsule containerRef={ref} selectedId="a" reducedMotion /><div data-result-id="a" /></div>);
    await act(async () => {});
    expect(frames).toHaveLength(1);
    await act(async () => { frames.shift()!(0); });
    expect(frames).toHaveLength(0);
    expect(observe).toHaveBeenCalledOnce();
  });

  it('uses scrolled virtual row rects and coalesces rapid retargets before stopping the previous spring', async () => {
    native.animate.mockReturnValue({stop: native.stop});
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    const frames: FrameRequestCallback[] = [];
    vi.mocked(requestAnimationFrame).mockImplementation((callback) => { frames.push(callback); return frames.length; });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return {top: this.dataset.resultId === 'a' ? 146 : this.dataset.resultId === 'b' ? 204 : this.dataset.resultId === 'c' ? 262 : 100, height: 58} as DOMRect;
    });
    const ref = createRef<HTMLDivElement>();
    const {container, unmount} = render(<div ref={ref}>
      <SelectionCapsule containerRef={ref} selectedId="a" />
      <div data-result-id="a" /><div data-result-id="b" /><div data-result-id="c" />
    </div>);
    Object.defineProperty(ref.current, 'scrollTop', {value: 400});
    const capsule = container.querySelector<HTMLElement>('[data-selection-capsule]')!;
    capsule.animate = vi.fn();
    await act(async () => {});
    await waitFor(() => expect(capsule.style.transform).toBe('translateY(446px)'));
    act(() => { useSelectionStore.getState().select('b'); useSelectionStore.getState().select('c'); });
    expect(frames).toHaveLength(1);
    act(() => frames.shift()!(0));
    expect(native.animate).toHaveBeenLastCalledWith(capsule, {transform: 'translateY(562px)'}, expect.objectContaining({stiffness: 560, damping: 38, mass: 0.7}));
    act(() => useSelectionStore.getState().select('b'));
    act(() => frames.shift()!(16));
    expect(native.stop).toHaveBeenCalledOnce();
    act(() => useLauncherStore.getState().hide());
    expect(native.stop).toHaveBeenCalledTimes(2);
    expect(capsule.style.transform).toBe('translateY(504px)');
    unmount();
    expect(native.stop).toHaveBeenCalledTimes(2);
  });

  it('snaps reduced motion geometry without a native animation and hides missing rows', async () => {
    const ref = createRef<HTMLDivElement>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return {top: this.dataset.resultId ? 158 : 100, height: 46} as DOMRect;
    });
    const {container, rerender} = render(<div ref={ref}><SelectionCapsule containerRef={ref} selectedId="a" reducedMotion /><div data-result-id="a" /></div>);
    const capsule = container.querySelector<HTMLElement>('[data-selection-capsule]')!;
    await waitFor(() => expect(capsule.style.transform).toBe('translateY(58px)'));
    expect(capsule.style.height).toBe('46px');
    expect(native.animate).not.toHaveBeenCalled();
    rerender(<div ref={ref}><SelectionCapsule containerRef={ref} selectedId="missing" reducedMotion /></div>);
    await waitFor(() => expect(capsule.style.opacity).toBe('0'));
  });
});
