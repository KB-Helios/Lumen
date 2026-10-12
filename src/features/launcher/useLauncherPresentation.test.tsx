import {StrictMode} from 'react';
import {act, renderHook, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';

import type {
  WindowMode,
  WindowStateEvent,
} from '../../platform/window/window-service';
import {WindowService} from '../../platform/window/window-service';
import {useLauncherStore} from './launcher.store';
import {useQueryStore} from './query.store';
import {
  requestWindowHide,
  requestWindowShow,
  useNativeLauncherLifecycle,
  useLauncherPresentation,
} from './useLauncherPresentation';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, reject, resolve};
}

class DeferredWindowService extends WindowService {
  readonly calls: WindowMode[] = [];
  hideCalls = 0;
  nativeMode: WindowMode | 'unknown' = 'collapsed';
  nativeVisibility: 'hidden' | 'unknown' | 'visible' = 'visible';
  private deferredHide: ReturnType<typeof deferred<void>> | null = null;
  private readonly deferredShows: Array<{
    mode: WindowMode;
    operation: ReturnType<typeof deferred<void>>;
  }> = [];

  protected performShow(mode: WindowMode) {
    this.calls.push(mode);
    const operation = deferred<void>();
    this.deferredShows.push({mode, operation});
    return operation.promise.then((): WindowStateEvent => {
      this.nativeMode = mode;
      this.nativeVisibility = 'visible';
      return {mode, source: 'command', visible: true};
    });
  }

  resolveShow(mode: WindowMode, occurrence = 0) {
    this.deferredShows.filter((entry) => entry.mode === mode)[occurrence]?.operation.resolve();
  }

  rejectShow(mode: WindowMode, error: Error, occurrence = 0) {
    this.deferredShows.filter((entry) => entry.mode === mode)[occurrence]?.operation.reject(error);
  }

  deferHide() {
    this.deferredHide = deferred<void>();
    return this.deferredHide;
  }

  protected async performHide(): Promise<WindowStateEvent> {
    this.hideCalls += 1;
    try {
      await this.deferredHide?.promise;
      this.nativeVisibility = 'hidden';
      return {mode: null, source: 'command', visible: false};
    } catch (error) {
      this.nativeMode = 'unknown';
      this.nativeVisibility = 'unknown';
      throw error;
    }
  }
  async focusInput() {}
  async setShortcut() {}

  emitExternal(event: WindowStateEvent) {
    this.nativeMode = event.mode ?? this.nativeMode;
    this.nativeVisibility = event.visible ? 'visible' : 'hidden';
    this.publishNativeState(event);
  }
}

afterEach(() => {
  vi.useRealTimers();
  useLauncherStore.getState().reset();
  useQueryStore.getState().reset();
});

describe('useLauncherPresentation', () => {
  it('waits for the actual exit and ignores a completion from an interrupted exit', async () => {
    vi.useFakeTimers();
    const windowService = new DeferredWindowService();
    const {result, rerender} = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: true}},
    );
    await act(async () => { windowService.resolveShow('expanded'); });
    rerender({hasContent: false});
    const obsoleteExit = result.current.onWorkspaceExitComplete;
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(windowService.calls).toEqual(['expanded']);
    rerender({hasContent: true});
    await act(async () => { windowService.resolveShow('expanded', 1); });
    act(() => obsoleteExit());
    expect(windowService.calls).toEqual(['expanded']);
    rerender({hasContent: false});
    await act(async () => result.current.onWorkspaceExitComplete());
    expect(windowService.calls).toEqual(['expanded', 'collapsed']);
  });
  it('restores collapsed native bounds when a current Settings request fails', async () => {
    const windowService = new DeferredWindowService();
    const request = requestWindowShow(windowService, 'settings');

    expect(windowService.calls).toEqual(['settings']);
    await act(async () => {
      windowService.rejectShow('settings', new Error('Settings resize failed'));
      await Promise.resolve();
    });

    expect(windowService.calls).toEqual(['settings', 'collapsed']);
    await act(async () => {
      windowService.resolveShow('collapsed');
      await Promise.resolve();
    });
    await expect(request).resolves.toBe(false);
    expect(useLauncherStore.getState()).toMatchObject({mode: 'collapsed', visible: true});
  });

  it('preserves onboarding ownership when Alt+Space reactivates collapsed bounds', async () => {
    const windowService = new DeferredWindowService();
    useLauncherStore.getState().show('onboarding');
    renderHook(() => useNativeLauncherLifecycle(windowService));

    act(() => windowService.emitExternal({mode: 'collapsed', source: 'shortcut', visible: true}));

    expect(useLauncherStore.getState()).toMatchObject({mode: 'onboarding', visible: true});
    expect(windowService.calls).toEqual(['onboarding']);
    await act(async () => {
      windowService.resolveShow('onboarding');
      await Promise.resolve();
    });
  });

  it('lets Settings take ownership before an expanded launcher unmounts', async () => {
    const windowService = new DeferredWindowService();
    const launcher = renderHook(() => {
      useNativeLauncherLifecycle(windowService);
      return useLauncherPresentation({hasContent: true, windowService});
    });

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    act(() => { void requestWindowShow(windowService, 'settings'); });
    launcher.unmount();

    expect(windowService.calls).toEqual(['expanded', 'settings']);
    await act(async () => {
      windowService.resolveShow('settings');
      await Promise.resolve();
    });
    expect(windowService.calls).toEqual(['expanded', 'settings']);
    expect(useLauncherStore.getState()).toMatchObject({mode: 'settings', visible: true});
  });

  it('keeps file-open hide authoritative after the launcher unmounts', async () => {
    const windowService = new DeferredWindowService();
    const hideOperation = windowService.deferHide();
    const launcher = renderHook(
      () => useLauncherPresentation({hasContent: true, windowService}),
    );

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    act(() => { void requestWindowHide(windowService); });
    launcher.unmount();

    expect(windowService.hideCalls).toBe(1);
    expect(useLauncherStore.getState().visible).toBe(false);
    await act(async () => {
      hideOperation.resolve();
      await Promise.resolve();
    });
    expect(windowService.calls).toEqual(['expanded']);
    expect(windowService.nativeVisibility).toBe('hidden');
  });

  it('reconciles native close and Alt+Space notifications with a retained query', async () => {
    const windowService = new DeferredWindowService();
    useQueryStore.getState().setDraft('retained report');
    const launcher = renderHook(() => {
      useNativeLauncherLifecycle(windowService);
      return useLauncherPresentation({hasContent: true, windowService});
    });

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    act(() => windowService.emitExternal({mode: null, source: 'close', visible: false}));
    expect(useLauncherStore.getState()).toMatchObject({mode: 'expanded', visible: false});
    expect(windowService.calls).toEqual(['expanded']);

    act(() => windowService.emitExternal({mode: 'collapsed', source: 'shortcut', visible: true}));
    expect(useLauncherStore.getState()).toMatchObject({mode: 'expanded', visible: true});
    expect(windowService.calls).toEqual(['expanded', 'expanded']);
    await act(async () => {
      windowService.resolveShow('expanded', 1);
      await Promise.resolve();
    });
    expect(launcher.result.current.expanded).toBe(true);
  });

  it('lets a newer launcher generation recover after a stale Settings rejection', async () => {
    const windowService = new DeferredWindowService();
    const launcher = renderHook(
      () => useLauncherPresentation({hasContent: true, windowService}),
    );

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    act(() => { void requestWindowShow(windowService, 'settings'); });
    act(() => { void requestWindowShow(windowService, 'expanded'); });
    await act(async () => {
      windowService.rejectShow('settings', new Error('Stale Settings resize failed'));
      await Promise.resolve();
    });

    expect(windowService.calls).toEqual(['expanded', 'settings', 'expanded']);
    await act(async () => {
      windowService.resolveShow('expanded', 1);
      await Promise.resolve();
    });
    expect(launcher.result.current).toMatchObject({expanded: true, presentationError: null});
    expect(useLauncherStore.getState()).toMatchObject({mode: 'expanded', visible: true});
  });

  it('waits for native expanded bounds before showing the workspace', async () => {
    const windowService = new DeferredWindowService();
    const {result, rerender} = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: false}},
    );

    expect(result.current.expanded).toBe(false);

    rerender({hasContent: true});
    expect(windowService.calls).toEqual(['expanded']);
    expect(result.current.expanded).toBe(false);

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });

    expect(result.current.expanded).toBe(true);
    expect(useLauncherStore.getState().mode).toBe('expanded');
  });

  it('reconciles native expansion after the development strict-mode remount', async () => {
    const windowService = new DeferredWindowService();
    const {result, rerender} = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: false}, wrapper: StrictMode},
    );

    rerender({hasContent: true});
    expect(windowService.calls).toEqual(['expanded']);
    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });

    expect(result.current.expanded).toBe(true);
  });

  it('hands an unresolved native expansion to a new collapsed hook instance', async () => {
    const windowService = new DeferredWindowService();
    const first = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: false}},
    );

    first.rerender({hasContent: true});
    expect(windowService.calls).toEqual(['expanded']);
    first.unmount();

    const second = renderHook(
      () => useLauncherPresentation({hasContent: false, windowService}),
    );
    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    expect(windowService.calls).toEqual(['expanded', 'collapsed']);

    await act(async () => {
      windowService.resolveShow('collapsed');
      await Promise.resolve();
    });
    expect(second.result.current.expanded).toBe(false);
    expect(useLauncherStore.getState().mode).toBe('collapsed');
  });

  it('reconciles an unresolved strict-mode expansion after remount changes intent to collapsed', async () => {
    const windowService = new DeferredWindowService();
    const {result, rerender} = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: true}, wrapper: StrictMode},
    );

    expect(windowService.calls).toEqual(['expanded']);
    rerender({hasContent: false});
    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    expect(windowService.calls).toEqual(['expanded', 'collapsed']);

    await act(async () => {
      windowService.resolveShow('collapsed');
      await Promise.resolve();
    });
    expect(result.current.expanded).toBe(false);
    expect(useLauncherStore.getState().mode).toBe('collapsed');
  });

  it('does not retry a persistently rejected detached collapse until a client attaches', async () => {
    vi.useFakeTimers();
    const windowService = new DeferredWindowService();
    const first = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: true}},
    );

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    first.rerender({hasContent: false});
    await act(async () => first.result.current.onWorkspaceExitComplete());
    first.unmount();
    act(() => windowService.rejectShow('collapsed', new Error('Detached collapse failed')));
    await act(async () => { await Promise.resolve(); });

    expect(windowService.calls).toEqual(['expanded', 'collapsed']);
    expect(windowService.hideCalls).toBe(0);
    expect(useLauncherStore.getState().mode).toBe('collapsed');

    const second = renderHook(
      () => useLauncherPresentation({hasContent: false, windowService}),
    );
    expect(windowService.calls).toEqual(['expanded', 'collapsed', 'collapsed']);

    act(() => windowService.rejectShow('collapsed', new Error('Current collapse failed'), 1));
    await act(async () => { await Promise.resolve(); });
    expect(windowService.calls).toEqual(['expanded', 'collapsed', 'collapsed']);
    expect(windowService.hideCalls).toBe(1);
    expect(second.result.current.expanded).toBe(false);
  });

  it('keeps a newer collapsed client collapsed when a detached owner collapse fails', async () => {
    vi.useFakeTimers();
    const windowService = new DeferredWindowService();
    const first = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: true}},
    );

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    first.rerender({hasContent: false});
    await act(async () => first.result.current.onWorkspaceExitComplete());
    first.unmount();

    const second = renderHook(
      () => useLauncherPresentation({hasContent: false, windowService}),
    );
    act(() => windowService.rejectShow('collapsed', new Error('Stale collapse failed')));
    await act(async () => { await Promise.resolve(); });

    expect(windowService.calls).toEqual(['expanded', 'collapsed', 'collapsed']);
    expect(second.result.current.expanded).toBe(false);
    expect(useLauncherStore.getState().mode).toBe('collapsed');

    act(() => windowService.rejectShow('collapsed', new Error('Current collapse failed'), 1));
    await act(async () => { await Promise.resolve(); });
    expect(windowService.calls).toEqual(['expanded', 'collapsed', 'collapsed']);
    expect(windowService.hideCalls).toBe(1);
    expect(second.result.current.expanded).toBe(false);
    expect(second.result.current.presentationError).toBe('Current collapse failed');
    expect(useLauncherStore.getState()).toMatchObject({mode: 'collapsed', visible: false});
  });

  it('recovers a later expanded intent after fallback hide is rejected', async () => {
    vi.useFakeTimers();
    const windowService = new DeferredWindowService();
    const hideOperation = windowService.deferHide();
    const first = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: true}},
    );

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    first.rerender({hasContent: false});
    await act(async () => first.result.current.onWorkspaceExitComplete());
    first.unmount();

    const second = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: false}},
    );
    act(() => windowService.rejectShow('collapsed', new Error('Detached collapse failed')));
    await act(async () => { await Promise.resolve(); });
    act(() => windowService.rejectShow('collapsed', new Error('Current collapse failed'), 1));
    await act(async () => { await Promise.resolve(); });
    expect(windowService.hideCalls).toBe(1);

    await act(async () => {
      hideOperation.reject(new Error('Native hide unavailable'));
      await Promise.resolve();
    });
    expect(second.result.current.presentationError).toBe('Native hide unavailable');
    expect(second.result.current.expanded).toBe(false);
    expect(windowService.calls).toEqual(['expanded', 'collapsed', 'collapsed', 'expanded']);
    await act(async () => {
      windowService.resolveShow('expanded', 1);
      await Promise.resolve();
    });
    expect(second.result.current.expanded).toBe(true);
    expect(useLauncherStore.getState()).toMatchObject({mode: 'expanded', visible: true});

    second.rerender({hasContent: true});
    expect(windowService.calls).toEqual(['expanded', 'collapsed', 'collapsed', 'expanded']);
    expect(second.result.current.expanded).toBe(true);
    expect(useLauncherStore.getState()).toMatchObject({mode: 'expanded', visible: true});
  });

  it('serializes a newer expanded intent after a stale fallback hide resolves', async () => {
    vi.useFakeTimers();
    const windowService = new DeferredWindowService();
    const hideOperation = windowService.deferHide();
    const first = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: true}},
    );

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    first.rerender({hasContent: false});
    await act(async () => first.result.current.onWorkspaceExitComplete());
    first.unmount();

    const second = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: false}},
    );
    act(() => windowService.rejectShow('collapsed', new Error('Detached collapse failed')));
    await act(async () => { await Promise.resolve(); });
    act(() => windowService.rejectShow('collapsed', new Error('Current collapse failed'), 1));
    await act(async () => { await Promise.resolve(); });
    expect(windowService.hideCalls).toBe(1);

    second.rerender({hasContent: true});
    expect(windowService.calls).toEqual(['expanded', 'collapsed', 'collapsed']);
    expect(second.result.current.presentationError).toBeNull();

    await act(async () => {
      hideOperation.resolve();
      await Promise.resolve();
    });
    expect(windowService.calls).toEqual(['expanded', 'collapsed', 'collapsed', 'expanded']);
    expect(second.result.current.presentationError).toBeNull();

    await act(async () => {
      windowService.resolveShow('expanded', 1);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    expect(windowService.calls).toEqual(['expanded', 'collapsed', 'collapsed', 'expanded']);
    expect(windowService.hideCalls).toBe(1);
    expect(windowService).toMatchObject({nativeMode: 'expanded', nativeVisibility: 'visible'});
    expect(second.result.current).toMatchObject({expanded: true, presentationError: null});
    expect(useLauncherStore.getState()).toMatchObject({mode: 'expanded', visible: true});
  });

  it('serializes a new expanded client after a stale fallback hide rejects', async () => {
    vi.useFakeTimers();
    const windowService = new DeferredWindowService();
    const hideOperation = windowService.deferHide();
    const first = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: true}},
    );

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    first.rerender({hasContent: false});
    await act(async () => first.result.current.onWorkspaceExitComplete());
    first.unmount();

    const stale = renderHook(
      () => useLauncherPresentation({hasContent: false, windowService}),
    );
    act(() => windowService.rejectShow('collapsed', new Error('Detached collapse failed')));
    await act(async () => { await Promise.resolve(); });
    act(() => windowService.rejectShow('collapsed', new Error('Current collapse failed'), 1));
    await act(async () => { await Promise.resolve(); });
    expect(windowService.hideCalls).toBe(1);

    stale.unmount();
    const current = renderHook(
      () => useLauncherPresentation({hasContent: true, windowService}),
    );
    expect(windowService.calls).toEqual(['expanded', 'collapsed', 'collapsed']);

    await act(async () => {
      hideOperation.reject(new Error('Native hide unavailable'));
      await Promise.resolve();
    });
    expect(windowService.calls).toEqual(['expanded', 'collapsed', 'collapsed', 'expanded']);
    expect(current.result.current.presentationError).toBeNull();

    await act(async () => {
      windowService.resolveShow('expanded', 1);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    expect(windowService.calls).toEqual(['expanded', 'collapsed', 'collapsed', 'expanded']);
    expect(windowService.hideCalls).toBe(1);
    expect(windowService).toMatchObject({nativeMode: 'expanded', nativeVisibility: 'visible'});
    expect(current.result.current).toMatchObject({expanded: true, presentationError: null});
    expect(useLauncherStore.getState()).toMatchObject({mode: 'expanded', visible: true});
  });

  it('hides the workspace before requesting collapsed native bounds', async () => {
    vi.useFakeTimers();
    const windowService = new DeferredWindowService();
    const {result, rerender} = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: true}},
    );

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    expect(result.current.expanded).toBe(true);

    rerender({hasContent: false});
    expect(result.current.expanded).toBe(false);
    expect(windowService.calls).toEqual(['expanded']);

    await act(async () => vi.advanceTimersByTimeAsync(119));
    expect(windowService.calls).toEqual(['expanded']);

    await act(async () => result.current.onWorkspaceExitComplete());
    expect(windowService.calls).toEqual(['expanded', 'collapsed']);
    expect(useLauncherStore.getState().mode).toBe('collapsed');
  });

  it('accepts immediate exit completion without a timer', async () => {
    vi.useFakeTimers();
    const windowService = new DeferredWindowService();
    const {result, rerender} = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: true}},
    );

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    expect(result.current.expanded).toBe(true);

    rerender({hasContent: false});
    await act(async () => result.current.onWorkspaceExitComplete());

    expect(result.current.expanded).toBe(false);
    expect(windowService.calls).toEqual(['expanded', 'collapsed']);
  });

  it('does not allow a stale collapse timer to shrink a newly expanded launcher', async () => {
    vi.useFakeTimers();
    const windowService = new DeferredWindowService();
    const {result, rerender} = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: true}},
    );

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    expect(result.current.expanded).toBe(true);

    rerender({hasContent: false});
    rerender({hasContent: true});
    await act(async () => {
      windowService.resolveShow('expanded', 1);
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(120));

    expect(result.current.expanded).toBe(true);
    expect(windowService.calls).toEqual(['expanded']);
  });

  it('reconciles a clear that arrives while native expansion is pending back to collapsed bounds', async () => {
    const windowService = new DeferredWindowService();
    const {result, rerender} = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: false}},
    );

    rerender({hasContent: true});
    rerender({hasContent: false});
    expect(result.current.expanded).toBe(false);
    expect(windowService.calls).toEqual(['expanded']);

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    expect(windowService.calls).toEqual(['expanded', 'collapsed']);

    await act(async () => {
      windowService.resolveShow('collapsed');
      await Promise.resolve();
    });
    expect(useLauncherStore.getState().mode).toBe('collapsed');
    expect(result.current.expanded).toBe(false);
  });

  it('serializes collapse followed by expansion so the final native mode is expanded', async () => {
    vi.useFakeTimers();
    const windowService = new DeferredWindowService();
    const {result, rerender} = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: true}},
    );

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    rerender({hasContent: false});
    await act(async () => result.current.onWorkspaceExitComplete());
    rerender({hasContent: true});
    expect(windowService.calls).toEqual(['expanded', 'collapsed']);

    await act(async () => {
      windowService.resolveShow('collapsed');
      await Promise.resolve();
    });
    expect(windowService.calls).toEqual(['expanded', 'collapsed', 'expanded']);

    await act(async () => {
      windowService.resolveShow('expanded', 1);
      await Promise.resolve();
    });
    expect(result.current.expanded).toBe(true);
    expect(useLauncherStore.getState().mode).toBe('expanded');
  });

  it('restores a visible expanded workspace when native collapse is rejected', async () => {
    vi.useFakeTimers();
    const windowService = new DeferredWindowService();
    const {result, rerender} = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: true}},
    );

    await act(async () => {
      windowService.resolveShow('expanded');
      await Promise.resolve();
    });
    rerender({hasContent: false});
    await act(async () => result.current.onWorkspaceExitComplete());
    act(() => windowService.rejectShow('collapsed', new Error('Native collapse unavailable')));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.presentationError).toBe('Native collapse unavailable');
    expect(result.current.expanded).toBe(false);
    expect(windowService.calls).toEqual(['expanded', 'collapsed', 'expanded']);
    await act(async () => {
      windowService.resolveShow('expanded', 1);
      await Promise.resolve();
    });
    expect(result.current.expanded).toBe(true);
    expect(useLauncherStore.getState().mode).toBe('expanded');
  });

  it('reports failed native presentation without retaining an expanded workspace', async () => {
    const windowService = new DeferredWindowService();
    const {result, rerender} = renderHook(
      ({hasContent}) => useLauncherPresentation({hasContent, windowService}),
      {initialProps: {hasContent: false}},
    );

    rerender({hasContent: true});
    act(() => windowService.rejectShow('expanded', new Error('Native resize unavailable')));

    await waitFor(() => expect(result.current.presentationError).toBe('Native resize unavailable'));
    expect(result.current.expanded).toBe(false);
    expect(useLauncherStore.getState().mode).toBe('collapsed');
  });
});
