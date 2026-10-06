import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {StrictMode} from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {readDiagnosticMetrics, resetDiagnosticMetrics} from '../diagnostics/diagnostics.metrics';
import {useSettingsStore} from '../settings/settings.store';
import {BrowserWindowService} from '../../platform/window/browser-window-service';
import {useLauncherStore} from './launcher.store';
import {CollapsedLauncher} from './CollapsedLauncher';
import {useQueryStore} from './query.store';
import {useScopeStore} from './scope.store';

afterEach(() => {
  resetDiagnosticMetrics();
  vi.unstubAllGlobals();
  useLauncherStore.getState().reset();
  useQueryStore.getState().reset();
  useScopeStore.getState().reset();
  useSettingsStore.getState().reset();
});

describe('CollapsedLauncher', () => {
  it('records 24 launcher-visible samples across 24 hide and show transitions', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));

    render(<StrictMode><CollapsedLauncher windowService={new BrowserWindowService()} /></StrictMode>);
    act(() => useLauncherStore.getState().hide());
    frames.clear();
    resetDiagnosticMetrics();

    for (let transition = 0; transition < 24; transition += 1) {
      act(() => useLauncherStore.getState().show('collapsed'));
      for (const callback of frames.values()) callback(16 + transition);
      frames.clear();
      act(() => useLauncherStore.getState().hide());
    }

    expect(readDiagnosticMetrics().timings.filter((sample) => sample.name === 'launcher-visible')).toHaveLength(24);
  });

  it('keeps one command-palette surface while a query expands the workspace', async () => {
    const user = userEvent.setup();
    render(<CollapsedLauncher windowService={new BrowserWindowService()} />);

    const palette = screen.getByLabelText('Lumen launcher');
    expect(palette).toHaveAttribute('data-upstream', 'einui-glass-command-palette');
    expect(palette).toHaveAttribute('data-expanded', 'false');
    expect(palette.querySelector('[data-einui-slot="composer"]')).toBeInTheDocument();
    expect(palette.querySelector('[data-einui-slot="workspace"]')).not.toBeInTheDocument();
    expect(palette.querySelector('[data-einui-layer="surface"]')).toHaveStyle({
      borderRadius: 'var(--lumen-radius-pill)',
    });

    await user.type(screen.getByRole('searchbox', {name: 'Search files'}), 'release');

    await waitFor(() => expect(palette).toHaveAttribute('data-expanded', 'true'));
    expect(palette.querySelector('[data-einui-slot="workspace"]')).toBeInTheDocument();
    expect(palette.querySelector('[data-einui-slot="scopes"]')).toBeInTheDocument();
    expect(palette.querySelector('[data-einui-slot="footer"]')).toHaveTextContent('Ready');
    expect(palette.querySelector('[data-einui-layer="surface"]')).toHaveStyle({
      borderRadius: 'var(--lumen-radius-surface)',
    });
  });

  it('commits an IME query only after composition ends', async () => {
    const user = userEvent.setup();
    render(<CollapsedLauncher windowService={new BrowserWindowService()} />);
    const input = screen.getByRole('searchbox', {name: 'Search files'});

    fireEvent.compositionStart(input);
    await user.type(input, 'ルーメン');
    expect(useQueryStore.getState().committed).toBe('');

    fireEvent.compositionEnd(input);
    expect(useQueryStore.getState().committed).toBe('ルーメン');
  });

  it('expands for a Unicode query and preserves long controlled input', async () => {
    const user = userEvent.setup();
    const windowService = new BrowserWindowService();
    render(<CollapsedLauncher windowService={windowService} />);
    const input = screen.getByRole('searchbox', {name: 'Search files'});
    const query = `årsrapport-${'very-long-'.repeat(16)}終`;

    await user.type(input, query);

    expect(input).toHaveValue(query);
    await waitFor(() =>
      expect(windowService.snapshot()).toMatchObject({
        mode: 'expanded',
        visible: true,
        width: 800,
      }),
    );
  });

  it('clears on the first Escape and hides on the second', async () => {
    const user = userEvent.setup();
    const windowService = new BrowserWindowService();
    render(<CollapsedLauncher windowService={windowService} />);
    const input = screen.getByRole('searchbox', {name: 'Search files'});

    await user.type(input, 'report');
    await user.keyboard('{Escape}');
    expect(input).toHaveValue('');
    await waitFor(() => expect(useLauncherStore.getState().mode).toBe('collapsed'));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(windowService.snapshot().visible).toBe(false));
    expect(useLauncherStore.getState().visible).toBe(false);
  });

  it('exposes named controls and all implemented scopes when expanded', async () => {
    const user = userEvent.setup();
    useQueryStore.getState().setDraft('docs');
    render(
      <CollapsedLauncher
        windowService={new BrowserWindowService()}
        onVoiceRequest={() => undefined}
      />,
    );

    expect(screen.getByRole('button', {name: 'Start voice input'})).toBeVisible();
    await waitFor(() => expect(
      screen.getByRole('tablist', {name: 'Search scopes'}),
    ).toBeVisible());
    expect(screen.getAllByRole('tab')).toHaveLength(6);

    await user.click(screen.getByRole('tab', {name: 'Documents'}));
    expect(useScopeStore.getState().activeScope).toBe('documents');
  });

  it('shows only the search scopes enabled in settings', async () => {
    useSettingsStore.setState((state) => ({
      search: {...state.search, enabledScopes: ['all', 'documents', 'recent']},
    }));
    useQueryStore.getState().setDraft('docs');

    render(<CollapsedLauncher windowService={new BrowserWindowService()} />);

    await waitFor(() => expect(screen.getByRole('tablist', {name: 'Search scopes'})).toBeVisible());
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['All', 'Documents', 'Recent']);
  });

  it('switches to an explicit browser-agent task without exposing file scopes', async () => {
    const user = userEvent.setup();
    let submitted = '';
    render(
      <CollapsedLauncher
        windowService={new BrowserWindowService()}
        onComputerSubmit={(task) => submitted = task}
      />,
    );

    await user.click(screen.getByRole('button', {name: 'Switch to Computer Use'}));
    const input = screen.getByRole('searchbox', {name: 'Describe a computer task'});
    await user.type(input, 'Find the latest Lumen release{Enter}');

    expect(useLauncherStore.getState().intent).toBe('computer');
    expect(screen.queryByRole('tablist', {name: 'Search scopes'})).not.toBeInTheDocument();
    expect(submitted).toBe('Find the latest Lumen release');
    expect(useQueryStore.getState().committed).toBe('Find the latest Lumen release');
  });

  it('clears a local search before entering Computer Use', async () => {
    const user = userEvent.setup();
    let submitted = '';
    useQueryStore.getState().setDraft('confidential acquisition notes');
    render(
      <CollapsedLauncher
        windowService={new BrowserWindowService()}
        onComputerSubmit={(task) => submitted = task}
      />,
    );

    await user.click(screen.getByRole('button', {name: 'Switch to Computer Use'}));
    const input = screen.getByRole('searchbox', {name: 'Describe a computer task'});

    expect(input).toHaveValue('');
    expect(useQueryStore.getState().committed).toBe('');
    await user.keyboard('{Enter}');
    expect(submitted).toBe('');
  });

  it('does not submit another task while Computer Use is locked', async () => {
    const user = userEvent.setup();
    let submitted = '';
    useLauncherStore.getState().setIntent('computer');
    render(
      <CollapsedLauncher
        intentLocked
        windowService={new BrowserWindowService()}
        onComputerSubmit={(task) => submitted = task}
      />,
    );

    await user.type(
      screen.getByRole('searchbox', {name: 'Describe a computer task'}),
      'Replace the active task{Enter}',
    );

    expect(submitted).toBe('');
  });
});
