import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {LumenMotionProvider} from '../../design-system/MotionProvider';
import {BrowserWindowService} from '../../platform/window/browser-window-service';
import type {WindowMode} from '../../platform/window/window-service';
import {useLauncherStore} from '../launcher/launcher.store';
import type {RootSelectionService} from './root-selection-service';
import {OnboardingFlow} from './OnboardingFlow';
import {useOnboardingStore} from './onboarding.store';

class DeferredRootService implements RootSelectionService {
  private resolveSelection?: (path: string | null) => void;

  chooseRoot(): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolveSelection = resolve;
    });
  }

  resolve(path: string | null) {
    this.resolveSelection?.(path);
  }
}

class RejectingOnboardingWindowService extends BrowserWindowService {
  onboardingCalls = 0;

  protected override async performShow(mode: WindowMode) {
    if (mode === 'onboarding') {
      this.onboardingCalls += 1;
      throw new Error('Native onboarding resize failed');
    }
    return super.performShow(mode);
  }
}

function renderFlow(service: RootSelectionService, reducedMotion = true) {
  return render(
    <LumenMotionProvider reducedMotion={reducedMotion}>
      <OnboardingFlow rootService={service} />
    </LumenMotionProvider>,
  );
}

afterEach(() => {
  useLauncherStore.getState().reset();
  useOnboardingStore.getState().reset();
  localStorage.clear();
});

describe('OnboardingFlow', () => {
  it('retains setup choices and offers retry when completion cannot be saved', async () => {
    const user = userEvent.setup();
    useOnboardingStore.setState({root: 'C:\\Projects', currentIndex: 3});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {throw new Error('Disk unavailable');});
    renderFlow({chooseRoot: vi.fn()});
    await user.click(screen.getByRole('button', {name: 'Start using Lumen'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk unavailable');
    expect(useOnboardingStore.getState()).toMatchObject({completed: false, root: 'C:\\Projects', currentIndex: 3});
    await user.click(screen.getByRole('button', {name: 'Start using Lumen'}));
    await waitFor(() => expect(useOnboardingStore.getState().completed).toBe(true));
  });

  it('disables the folder picker while its native dialog is pending', async () => {
    const user = userEvent.setup();
    const service = new DeferredRootService();
    useOnboardingStore.setState({currentIndex: 1});
    renderFlow(service);
    await user.click(screen.getByRole('button', {name: 'Choose folder'}));
    expect(screen.getByRole('button', {name: 'Choose folder'})).toBeDisabled();
    await act(async () => service.resolve(null));
    expect(screen.getByRole('button', {name: 'Choose folder'})).toBeEnabled();
  });
  it('lets the surface own the onboarding grid rows directly', () => {
    renderFlow({chooseRoot: vi.fn()});

    const surface = screen.getByLabelText('Welcome to Lumen');
    expect(screen.getByRole('banner').parentElement).toBe(surface);
    expect(screen.getByTestId('onboarding-primary-action').closest('footer')?.parentElement).toBe(surface);
  });

  it('completes four focused scenes only after native setup succeeds', async () => {
    const user = userEvent.setup();
    const service = new DeferredRootService();
    const onComplete = vi.fn(async () => true);
    const windowService = new BrowserWindowService();
    const setShortcut = vi.spyOn(windowService, 'setShortcut');
    render(
      <LumenMotionProvider reducedMotion>
        <OnboardingFlow rootService={service} windowService={windowService} onComplete={onComplete} />
      </LumenMotionProvider>,
    );

    await user.click(screen.getByRole('button', {name: 'Begin'}));
    await user.click(await screen.findByRole('button', {name: 'Choose folder'}));
    await act(async () => service.resolve('C:\\Projects'));
    expect(screen.getByText('C:\\Projects')).toBeVisible();

    await user.click(screen.getByRole('button', {name: 'Continue'}));
    await user.click(screen.getByRole('button', {name: 'Continue'}));
    expect(screen.getByLabelText('Step 4 of 4')).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Start using Lumen'}));

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(setShortcut).toHaveBeenCalledWith('Alt + Space');
    expect(useOnboardingStore.getState()).toMatchObject({completed: true, root: 'C:\\Projects'});
    expect(JSON.parse(localStorage.getItem('lumen-onboarding') ?? '{}')).toMatchObject({
      completed: true,
      root: 'C:\\Projects',
    });
  });

  it('keeps onboarding open when native setup fails', async () => {
    const user = userEvent.setup();
    const service = new DeferredRootService();
    render(
      <LumenMotionProvider reducedMotion>
        <OnboardingFlow rootService={service} onComplete={async () => false} />
      </LumenMotionProvider>,
    );

    await user.click(screen.getByRole('button', {name: 'Begin'}));
    await user.click(await screen.findByRole('button', {name: 'Choose folder'}));
    await act(async () => service.resolve('C:\\Projects'));
    await user.click(screen.getByRole('button', {name: 'Continue'}));
    await user.click(screen.getByRole('button', {name: 'Continue'}));
    await user.click(screen.getByRole('button', {name: 'Start using Lumen'}));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not start');
    expect(useOnboardingStore.getState().completed).toBe(false);
  });

  it('keeps the selected root when navigating back with Escape', async () => {
    const user = userEvent.setup();
    const service = new DeferredRootService();
    renderFlow(service);

    await user.click(screen.getByRole('button', {name: 'Begin'}));
    await user.click(await screen.findByRole('button', {name: 'Choose folder'}));
    await act(async () => service.resolve('C:\\Work'));
    await user.click(screen.getByRole('button', {name: 'Continue'}));
    await user.keyboard('{Escape}');

    expect(await screen.findByRole('heading', {name: 'Choose one place to start'})).toBeVisible();
    expect(screen.getByText('C:\\Work')).toBeVisible();
  });

  it('does not advance when folder selection is cancelled or invalid', async () => {
    const user = userEvent.setup();
    const service = new DeferredRootService();
    renderFlow(service);

    await user.click(screen.getByRole('button', {name: 'Begin'}));
    await user.click(await screen.findByRole('button', {name: 'Choose folder'}));
    await act(async () => service.resolve(null));

    expect(await screen.findByRole('heading', {name: 'Choose one place to start'})).toBeVisible();
    expect(screen.getByText('No folder was selected.')).toBeVisible();
    expect(screen.getByRole('button', {name: 'Continue'})).toBeDisabled();
  });

  it('uses a cross-fade scene contract when reduced motion is active', () => {
    renderFlow({chooseRoot: vi.fn()}, true);

    expect(screen.getByTestId('onboarding-scene')).toHaveAttribute(
      'data-motion-direction',
      'fade',
    );
  });

  it('uses a spatial scene contract when full motion is active', () => {
    renderFlow({chooseRoot: vi.fn()}, false);

    expect(screen.getByTestId('onboarding-scene')).toHaveAttribute(
      'data-motion-direction',
      'spatial',
    );
  });

  it('retains onboarding ownership when the native show request is rejected', async () => {
    const windowService = new RejectingOnboardingWindowService();
    render(
      <LumenMotionProvider reducedMotion>
        <OnboardingFlow rootService={{chooseRoot: vi.fn()}} windowService={windowService} />
      </LumenMotionProvider>,
    );

    await waitFor(() => expect(windowService.onboardingCalls).toBe(1));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));

    expect(useLauncherStore.getState()).toMatchObject({mode: 'onboarding', visible: true});
  });

  it('keeps a single primary action and a single labelled back action on reversible scenes', async () => {
    const user = userEvent.setup();
    renderFlow({chooseRoot: vi.fn()});

    expect(screen.getAllByTestId('onboarding-primary-action')).toHaveLength(1);
    expect(screen.queryByTestId('onboarding-back-action')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', {name: 'Begin'}));

    expect(screen.getAllByTestId('onboarding-primary-action')).toHaveLength(1);
    expect(screen.getAllByTestId('onboarding-back-action')).toHaveLength(1);
    expect(screen.getByTestId('onboarding-back-action')).toHaveAccessibleName('Back');
  });

  it('keeps folder selection actionable without competing with the root-step primary action', async () => {
    const user = userEvent.setup();
    renderFlow({chooseRoot: vi.fn()});

    await user.click(screen.getByRole('button', {name: 'Begin'}));

    const chooseFolder = await screen.findByRole('button', {name: 'Choose folder'});
    expect(screen.getAllByRole('button').filter((button) => button.dataset.variant === 'primary')).toHaveLength(1);
    expect(chooseFolder).toHaveAttribute('data-variant', 'subtle');
  });
});
