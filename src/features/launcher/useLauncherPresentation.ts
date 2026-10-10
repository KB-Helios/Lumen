import {useEffect, useRef, useState} from 'react';

import type {
  WindowMode,
  WindowService,
  WindowStateEvent,
} from '../../platform/window/window-service';
import {useLauncherStore} from './launcher.store';
import {useQueryStore} from './query.store';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The launcher presentation could not be updated.';
}

function restoreLauncherSnapshot(mode: WindowMode, visible: boolean) {
  if (visible) useLauncherStore.getState().show(mode);
  else {
    useLauncherStore.getState().setMode(mode);
    useLauncherStore.getState().hide();
  }
}

async function restoreNativeSnapshot(
  windowService: WindowService,
  mode: WindowMode,
  visible: boolean,
) {
  try {
    if (visible) await windowService.show(mode);
    else await windowService.hide();
  } catch {
    // The request already reports failure; the next intent or native event retries reconciliation.
  }
}

export async function requestWindowShow(windowService: WindowService, mode: WindowMode) {
  const previous = useLauncherStore.getState();
  useLauncherStore.getState().show(mode);
  try {
    return await windowService.show(mode);
  } catch {
    const current = useLauncherStore.getState();
    if (current.visible && current.mode === mode) {
      restoreLauncherSnapshot(previous.mode, previous.visible);
      await restoreNativeSnapshot(windowService, previous.mode, previous.visible);
    }
    return false;
  }
}

export async function requestWindowHide(windowService: WindowService) {
  const previous = useLauncherStore.getState();
  useLauncherStore.getState().hide();
  try {
    return await windowService.hide();
  } catch {
    if (!useLauncherStore.getState().visible) {
      restoreLauncherSnapshot(previous.mode, previous.visible);
      await restoreNativeSnapshot(windowService, previous.mode, previous.visible);
    }
    return false;
  }
}

function reconcileNativeLauncherEvent(
  windowService: WindowService,
  event: WindowStateEvent,
  routeOwnedMode: WindowMode | null,
) {
  if (event.source === 'command') return;
  if (!event.visible) {
    useLauncherStore.getState().hide();
    return;
  }
  const currentMode = useLauncherStore.getState().mode;
  const ownedSurface = routeOwnedMode ?? (
    currentMode === 'onboarding' || currentMode === 'settings' || currentMode === 'gallery'
      ? currentMode
      : null
  );
  const targetMode = ownedSurface ?? (useQueryStore.getState().committed
    ? 'expanded'
    : 'collapsed');
  useLauncherStore.getState().show(targetMode);
  if (event.mode !== targetMode) void requestWindowShow(windowService, targetMode);
}

/** App-level native close/shortcut/second-instance reconciliation. */
export function useNativeLauncherLifecycle(
  windowService: WindowService,
  routeOwnedMode: WindowMode | null = null,
) {
  useEffect(
    () => windowService.subscribe((event) =>
      reconcileNativeLauncherEvent(windowService, event, routeOwnedMode)),
    [routeOwnedMode, windowService],
  );
}

export interface LauncherPresentationOptions {
  hasContent: boolean;
  windowService: WindowService;
}

export function useLauncherPresentation({
  hasContent,
  windowService,
}: LauncherPresentationOptions) {
  const [expanded, setExpanded] = useState(false);
  const [presentationError, setPresentationError] = useState<string | null>(null);
  const attached = useRef(false);
  const expandedRef = useRef(false);
  const hasContentRef = useRef(hasContent);
  const [onWorkspaceExitComplete, setExitComplete] = useState<() => void>(() => () => undefined);
  const requestGeneration = useRef(0);

  hasContentRef.current = hasContent;

  const hideExpandedWorkspace = () => {
    if (!attached.current) return;
    expandedRef.current = false;
    setExpanded(false);
  };

  useEffect(() => {
    attached.current = true;
    return () => {
      attached.current = false;
      requestGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    const generation = ++requestGeneration.current;

    const showExpanded = async (failureToReport?: unknown, force = false) => {
      try {
        const applied = await windowService.show('expanded');
        if (!applied || !attached.current || generation !== requestGeneration.current ||
          (!force && !hasContentRef.current)) return;
        useLauncherStore.getState().show('expanded');
        expandedRef.current = true;
        setExpanded(true);
        if (failureToReport !== undefined) setPresentationError(errorMessage(failureToReport));
      } catch (error) {
        if (!attached.current || generation !== requestGeneration.current) return;
        useLauncherStore.getState().setMode('collapsed');
        hideExpandedWorkspace();
        setPresentationError(errorMessage(error));
        void windowService.show('collapsed').catch(() => undefined);
      }
    };

    if (hasContent) {
      setPresentationError(null);
      void showExpanded();
      return;
    }

    const hadVisibleWorkspace = expandedRef.current;
    hideExpandedWorkspace();
    const native = windowService.presentationSnapshot();
    const requiresCollapse = hadVisibleWorkspace ||
      (native.desired?.visible === true && native.desired.mode === 'expanded') ||
      (native.confirmed.visible === true && native.confirmed.mode === 'expanded') ||
      (native.desired?.visible === true && native.desired.mode === 'collapsed' &&
        native.confirmed.visible === 'unknown');
    if (!requiresCollapse) {
      useLauncherStore.getState().setMode('collapsed');
      return;
    }
    const requestCollapse = async () => {
      if (!attached.current || generation !== requestGeneration.current || !useLauncherStore.getState().visible) return;
      useLauncherStore.getState().setMode('collapsed');
      try {
        const applied = await windowService.show('collapsed');
        if (!applied || !attached.current || generation !== requestGeneration.current) return;
      } catch (error) {
        if (!attached.current || generation !== requestGeneration.current) return;
        if (hadVisibleWorkspace) {
          setPresentationError(errorMessage(error));
          await showExpanded(undefined, true);
          return;
        }
        setPresentationError(errorMessage(error));
        try {
          const hidden = await windowService.hide();
          if (hidden && attached.current && generation === requestGeneration.current) {
            useLauncherStore.getState().hide();
          }
        } catch (hideError) {
          if (attached.current && generation === requestGeneration.current) {
            setPresentationError(errorMessage(hideError));
            await showExpanded(undefined, true);
          }
        }
      }
    };

    if (hadVisibleWorkspace) {
      setExitComplete(() => () => { void requestCollapse(); });
    } else {
      void requestCollapse();
    }
  }, [hasContent, windowService]);

  return {expanded, presentationError, onWorkspaceExitComplete};
}
