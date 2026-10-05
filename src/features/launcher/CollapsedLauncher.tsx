import {useLayoutEffect, useRef, type ReactNode, type RefObject} from 'react';

import {GlassCommandPalette} from '../../components/ui/GlassCommandPalette';
import {LumenMark} from '../../design-system/icons/LumenMark';
import {LumenUiIcon} from '../../design-system/icons/LumenUiIcon';
import {useLumenMotion} from '../../design-system/MotionProvider';
import {LumenButton} from '../../design-system/primitives/LumenButton';
import {createWindowService} from '../../platform/window/tauri-window-service';
import type {WindowService} from '../../platform/window/window-service';
import {measureAfterPaint} from '../diagnostics/diagnostics.metrics';
import {LauncherStatus} from './LauncherStatus';
import {useLauncherStore} from './launcher.store';
import {useQueryStore} from './query.store';
import {ScopeRail} from './ScopeRail';
import {SearchInput} from './SearchInput';
import {requestWindowHide, useLauncherPresentation} from './useLauncherPresentation';


interface LauncherComposerProps {
  inputRef: RefObject<HTMLInputElement | null>;
  intentLocked: boolean;
  onComputerSubmit?: (task: string) => void;
  onEscapeEmpty(): void;
  onIntentChange(): void;
  onVoiceRequest?: () => void;
  voiceActive?: boolean;
}

function LauncherComposer({
  inputRef,
  intentLocked,
  onComputerSubmit,
  onEscapeEmpty,
  onIntentChange,
  onVoiceRequest,
  voiceActive = false,
}: LauncherComposerProps) {
  const intent = useLauncherStore((state) => state.intent);
  return (
    <div className="flex w-full min-w-0 items-center gap-[10px]" data-tauri-drag-region>
      <span
        aria-hidden="true"
        className="grid size-[32px] shrink-0 place-items-center rounded-[var(--lumen-radius-control)] border border-[color:var(--einui-command-divider)] bg-[var(--einui-command-row)] text-accent"
      >
        <LumenMark size="medium" />
      </span>
      <LumenButton
        aria-label={intent === 'computer' ? 'Switch to file search' : 'Switch to Computer Use'}
        className="max-w-[180px] min-w-8 shrink-0"
        isDisabled={intentLocked}
        size="small"
        variant="quiet"
        onPress={onIntentChange}
      >
        <LumenUiIcon name={intent === 'computer' ? 'search' : 'computer'} size="small" />
        <span className="min-w-0 truncate">
          {intent === 'computer' ? 'File search' : 'Computer Use'}
        </span>
      </LumenButton>
      <SearchInput
        ref={inputRef}
        intent={intent}
        onEscapeEmpty={onEscapeEmpty}
        onSubmit={intentLocked ? undefined : onComputerSubmit}
      />
      {onVoiceRequest ? (
        <LumenButton
          aria-label={voiceActive ? 'Stop voice input' : 'Start voice input'}
          className="shrink-0"
          size="small"
          variant="quiet"
          onPress={onVoiceRequest}
        >
          <LumenUiIcon name="voice" size="small" />
        </LumenButton>
      ) : null}
      <kbd className="einui-command-shortcut shrink-0" aria-label="Alt plus Space">
        Alt&nbsp;&nbsp;Space
      </kbd>
    </div>
  );
}

function LauncherFooter({
  searching,
  statusLabel,
}: {
  searching: boolean;
  statusLabel?: string;
}) {
  return (
    <>
      <LauncherStatus label={statusLabel} searching={searching} />
      <span className="text-[color:var(--einui-command-muted-text)]">Local runtime</span>
    </>
  );
}

export interface CollapsedLauncherProps {
  expandedContent?: ReactNode;
  inputRef?: RefObject<HTMLInputElement | null>;
  searching?: boolean;
  statusLabel?: string;
  windowService?: WindowService;
  onVoiceRequest?: () => void;
  voiceActive?: boolean;
  intentLocked?: boolean;
  focusOnMount?: boolean;
  onComputerSubmit?: (task: string) => void;
}

export function CollapsedLauncher({
  expandedContent,
  inputRef: providedInputRef,
  searching = false,
  statusLabel,
  windowService: providedWindowService,
  onVoiceRequest,
  voiceActive = false,
  intentLocked = false,
  focusOnMount = true,
  onComputerSubmit,
}: CollapsedLauncherProps) {
  const windowServiceRef = useRef<WindowService | null>(null);
  if (!windowServiceRef.current) {
    windowServiceRef.current = providedWindowService ?? createWindowService();
  }
  const windowService = providedWindowService ?? windowServiceRef.current;
  const hasCommittedQuery = useQueryStore((state) => state.committed.length > 0);
  const clearQuery = useQueryStore((state) => state.clear);
  const visible = useLauncherStore((state) => state.visible);
  const intent = useLauncherStore((state) => state.intent);
  const setIntent = useLauncherStore((state) => state.setIntent);
  const {reducedMotion} = useLumenMotion();
  const fallbackInputRef = useRef<HTMLInputElement>(null);
  const previousVisible = useRef(visible);
  const visibleRenderStartedAt = useRef<number | null>(visible ? performance.now() : null);
  if (visible) {
    if (!previousVisible.current) {
      visibleRenderStartedAt.current = performance.now();
    }
  } else {
    visibleRenderStartedAt.current = null;
  }
  previousVisible.current = visible;
  const inputRef = providedInputRef ?? fallbackInputRef;
  const {expanded, presentationError} = useLauncherPresentation({
    hasContent: hasCommittedQuery,
    reducedMotion,
    windowService,
  });

  useLayoutEffect(() => {
    if (!visible || !focusOnMount) {
      return;
    }
    inputRef.current?.focus();
    void windowService.focusInput();
    return measureAfterPaint(
      'launcher-visible',
      visibleRenderStartedAt.current ?? performance.now(),
    );
  }, [focusOnMount, inputRef, visible, windowService]);

  const handleEscapeEmpty = () => {
    void requestWindowHide(windowService);
  };

  const handleIntentChange = () => {
    clearQuery();
    setIntent(intent === 'computer' ? 'search' : 'computer');
  };

  const visibleWorkspace = expanded ? expandedContent : null;

  return (
    <GlassCommandPalette
      aria-label="Lumen launcher"
      composer={(
        <LauncherComposer
          inputRef={inputRef}
          intentLocked={intentLocked}
          onComputerSubmit={onComputerSubmit}
          onEscapeEmpty={handleEscapeEmpty}
          onIntentChange={handleIntentChange}
          onVoiceRequest={onVoiceRequest}
          voiceActive={voiceActive}
        />
      )}
      expanded={expanded}
      scopes={intent === 'search' ? <ScopeRail /> : null}
      body={visibleWorkspace}
      footer={(
        <LauncherFooter
          searching={searching}
          statusLabel={presentationError ?? statusLabel}
        />
      )}
      reducedMotion={reducedMotion}
    />
  );
}
