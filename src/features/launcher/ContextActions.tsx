import {LumenUiIcon} from '../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../design-system/primitives/LumenButton';
import type {SearchResult} from '../../services/search/search.types';

export interface ContextActionsProps {
  isOpening?: boolean;
  result: SearchResult | null;
  onDetails(): void;
  onOpen(): void;
  onOpenContainingFolder(): void;
  onPin(): void;
}

export function ContextActions({
  isOpening = false,
  result,
  onDetails,
  onOpen,
  onOpenContainingFolder,
  onPin,
}: ContextActionsProps) {
  return (
    <div
      aria-label="Result actions"
      className="@container/actions flex min-h-[40px] min-w-0 shrink-0 items-center gap-[4px] border-t border-[color:var(--einui-command-divider)] px-[12px] py-[4px]"
    >
      <span
        className="min-w-0 flex-1 truncate text-xs text-[color:var(--einui-command-muted-text)]"
        title={result?.path}
      >
        {result ? result.name : 'Choose a result for actions'}
      </span>
      <ActionButtons
        hasResult={result !== null}
        isOpening={isOpening}
        isAppContent={result?.kind === 'app-content'}
        canPin={Boolean(result?.provenance)}
        pinned={Boolean(result?.pinned)}
        onDetails={onDetails}
        onOpen={onOpen}
        onOpenContainingFolder={onOpenContainingFolder}
        onPin={onPin}
      />
    </div>
  );
}

// Selection text changes every row; button work only changes with eligibility.
const ActionButtons = memo(function ActionButtons({
  hasResult, isOpening, isAppContent, canPin, pinned,
  onDetails, onOpen, onOpenContainingFolder, onPin,
}: Omit<ContextActionsProps, 'result'> & {
  hasResult: boolean;
  isAppContent: boolean;
  canPin: boolean;
  pinned: boolean;
}) {
  return <>
      <LumenButton
        aria-label={isOpening ? 'Opening selected result' : 'Open selected result'}
        isDisabled={!hasResult || isOpening}
        size="small"
        variant="quiet"
        onPress={onOpen}
      >
        <LumenUiIcon name="forward" size="small" />
        <span className="hidden @min-[640px]/actions:inline">{isOpening ? 'Opening' : 'Open'}</span>
        <kbd aria-hidden="true" className="ml-1 font-sans text-xs text-[color:var(--einui-command-muted-text)]">↵</kbd>
      </LumenButton>
      <LumenButton
        aria-label="Open containing folder"
        isDisabled={!hasResult || isAppContent}
        size="small"
        variant="quiet"
        onPress={onOpenContainingFolder}
      >
        <LumenUiIcon name="folderOpen" size="small" />
        <span className="hidden @min-[640px]/actions:inline">Folder</span>
      </LumenButton>
      <LumenButton
        aria-label={pinned ? 'Unpin selected result' : 'Pin selected result'}
        isDisabled={!canPin}
        size="small"
        variant="quiet"
        onPress={onPin}
      >
        <LumenUiIcon name={pinned ? 'pinned' : 'pin'} size="small" />
        <span className="hidden @min-[640px]/actions:inline">{pinned ? 'Unpin' : 'Pin'}</span>
      </LumenButton>
      <LumenButton
        aria-label="Show file details"
        isDisabled={!hasResult}
        size="small"
        variant="quiet"
        onPress={onDetails}
      >
        <LumenUiIcon name="info" size="small" />
        <span className="hidden @min-[640px]/actions:inline">Details</span>
      </LumenButton>
    </>;
});
import {memo} from 'react';
