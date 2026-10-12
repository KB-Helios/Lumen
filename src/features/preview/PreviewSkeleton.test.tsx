import {act, render} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {useLauncherStore} from '../launcher/launcher.store';
import {PreviewSkeleton} from './PreviewSkeleton';

const native = vi.hoisted(() => ({animate: vi.fn(), stop: vi.fn()}));
vi.mock('motion/mini', () => ({animate: native.animate}));
afterEach(() => { vi.restoreAllMocks(); native.animate.mockReset(); native.stop.mockReset(); useLauncherStore.getState().reset(); });

describe('PreviewSkeleton', () => {
  it('runs only one sweep and stops hidden work without replaying on show', () => {
    native.animate.mockReturnValue({stop: native.stop});
    const {unmount} = render(<PreviewSkeleton />);
    expect(native.animate).toHaveBeenCalledOnce();
    expect(native.animate.mock.calls[0][2]).not.toHaveProperty('repeat');
    act(() => useLauncherStore.getState().hide());
    expect(native.stop).toHaveBeenCalledOnce();
    act(() => useLauncherStore.getState().show('expanded'));
    expect(native.animate).toHaveBeenCalledOnce();
    unmount();
  });
  it('keeps reduced motion static', () => {
    render(<PreviewSkeleton reducedMotion />);
    expect(native.animate).not.toHaveBeenCalled();
  });
});
