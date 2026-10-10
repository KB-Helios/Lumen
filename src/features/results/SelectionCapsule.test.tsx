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
