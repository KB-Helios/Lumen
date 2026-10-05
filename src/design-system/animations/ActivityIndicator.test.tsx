import {render, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const animation = vi.hoisted(() => ({
  context: vi.fn(),
  createEase: vi.fn(() => 'lumen-standard'),
  destroy: vi.fn(),
  fromTo: vi.fn(),
  loadAnimation: vi.fn(),
  registerPlugin: vi.fn(),
  revert: vi.fn(),
  setSubframe: vi.fn(),
}));

vi.mock('lottie-web/build/player/lottie_svg', () => ({
  default: {loadAnimation: animation.loadAnimation},
}));

vi.mock('gsap', () => ({
  gsap: {
    context: animation.context,
    fromTo: animation.fromTo,
    registerPlugin: animation.registerPlugin,
  },
}));

vi.mock('gsap/CustomEase', () => ({
  CustomEase: {create: animation.createEase},
}));

import {ActivityIndicator} from './ActivityIndicator';

let forcedColorsActive = false;

beforeEach(() => {
  vi.clearAllMocks();
  animation.setSubframe.mockReset();
  forcedColorsActive = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(forced-colors: active)' ? forcedColorsActive : false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  animation.context.mockImplementation((callback: () => void) => {
    callback();
    return {revert: animation.revert};
  });
  animation.loadAnimation.mockReturnValue({
    destroy: animation.destroy,
    setSubframe: animation.setSubframe,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ActivityIndicator', () => {
  it('owns one local SVG animation and destroys it when activity settles', async () => {
    const {container, rerender} = render(
      <ActivityIndicator active reducedMotion={false} tone="success" />,
    );

    const indicator = container.querySelector('[data-activity-indicator]');
    expect(indicator).toHaveAttribute('data-activity-state', 'active');
    expect(indicator).toHaveAttribute('data-activity-running', 'true');
    expect(container.querySelector('[data-lottie-host]')).toBeInTheDocument();
    await waitFor(() => {
      expect(animation.loadAnimation).toHaveBeenCalledWith(expect.objectContaining({
        animationData: expect.objectContaining({fr: 60, h: 24, w: 48}),
        autoplay: true,
        loop: true,
        renderer: 'svg',
      }));
      expect(animation.setSubframe).toHaveBeenCalledWith(false);
    });

    rerender(<ActivityIndicator active={false} reducedMotion={false} tone="success" />);

    expect(animation.destroy).toHaveBeenCalledOnce();
    expect(indicator).toHaveAttribute('data-activity-state', 'idle');
    expect(indicator).not.toHaveAttribute('data-activity-running');
    expect(container.querySelector('[data-static-activity="single"]')).toBeVisible();
  });

  it('uses a static resting frame and no tween under reduced motion', () => {
    const {container} = render(
      <ActivityIndicator active reducedMotion tone="success" />,
    );

    expect(animation.loadAnimation).not.toHaveBeenCalled();
    expect(animation.fromTo).not.toHaveBeenCalled();
    expect(container.querySelector('[data-activity-running]')).not.toBeInTheDocument();
    expect(container.querySelectorAll('[data-static-activity="dot"]')).toHaveLength(3);
  });

  it('limits the GSAP settle to compositor-friendly properties and reverts it', () => {
    const {container, unmount} = render(
      <ActivityIndicator active reducedMotion={false} tone="success" />,
    );

    const indicator = container.querySelector('[data-activity-indicator]');
    expect(animation.context).toHaveBeenCalledWith(expect.any(Function), indicator);
    expect(animation.fromTo).toHaveBeenCalledWith(
      indicator,
      {autoAlpha: 0, y: 4, willChange: 'transform,opacity'},
      expect.objectContaining({
        autoAlpha: 1,
        clearProps: 'opacity,transform,visibility,willChange',
        duration: 0.14,
        ease: 'lumen-standard',
        force3D: true,
        y: 0,
      }),
    );

    unmount();
    expect(animation.revert).toHaveBeenCalled();
  });

  it('falls back to the static active mark if Lottie initialization fails', async () => {
    animation.loadAnimation.mockImplementation(() => {
      throw new Error('renderer unavailable');
    });
    const {container} = render(
      <ActivityIndicator active reducedMotion={false} tone="success" />,
    );

    await waitFor(() => expect(
      container.querySelector('[data-activity-running]'),
    ).not.toBeInTheDocument());
    expect(container.querySelectorAll('[data-static-activity="dot"]')).toHaveLength(3);
  });

  it('destroys a loaded Lottie instance if its performance setup fails', async () => {
    animation.setSubframe.mockImplementation(() => {
      throw new Error('subframe setup unavailable');
    });
    const {container} = render(
      <ActivityIndicator active reducedMotion={false} tone="success" />,
    );

    await waitFor(() => expect(
      container.querySelector('[data-activity-running]'),
    ).not.toBeInTheDocument());
    expect(animation.destroy).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('[data-static-activity="dot"]')).toHaveLength(3);
  });

  it('creates a Lottie animation for an active non-reduced-motion indicator and destroys it on unmount', async () => {
    const {container, unmount} = render(
      <ActivityIndicator active reducedMotion={false} tone="success" />,
    );

    await waitFor(() => {
      expect(animation.loadAnimation).toHaveBeenCalled();
    });
    expect(container.querySelector('[data-activity-running]')).toBeInTheDocument();

    unmount();

    expect(animation.destroy).toHaveBeenCalledOnce();
  });

  it('prevents GSAP and Lottie when forced colors are active', () => {
    forcedColorsActive = true;
    const {container} = render(
      <ActivityIndicator active reducedMotion={false} tone="success" />,
    );

    expect(animation.loadAnimation).not.toHaveBeenCalled();
    expect(animation.fromTo).not.toHaveBeenCalled();
    expect(container.querySelector('[data-activity-running]')).not.toBeInTheDocument();
    expect(container.querySelectorAll('[data-static-activity="dot"]')).toHaveLength(3);
  });
});
