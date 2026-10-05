import type {Ref} from 'react';

import {LumenUiIcon} from '../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../design-system/primitives/LumenButton';
import type {SearchResult} from '../../services/search/search.types';

export interface ContextActionsProps {
  isOpening?: boolean;
  result: SearchResult | null;
  resultLabelRef?: Ref<HTMLSpanElement>;
  onDetails(): void;
  onOpen(): void;
  onOpenContainingFolder(): void;
  onPin(): void;
}

export function ContextActions({
  isOpening = false,
  result,
  resultLabelRef,
  onDetails,
  onOpen,
  onOpenContainingFolder,
  onPin,
}: ContextActionsProps) {
  return (
    <div
      aria-label="Result actions"
      className="flex min-h-[46px] min-w-0 items-center gap-1.5 border-t border-[color:var(--einui-command-divider)] px-4 py-2"
    >
      <span
        ref={resultLabelRef}
        className="min-w-0 flex-1 truncate text-xs text-[color:var(--einui-command-muted-text)]"
        title={result?.path}
      >
        {result ? result.name : 'Choose a result for actions'}
      </span>
      <LumenButton
        aria-label={isOpening ? 'Opening selected result' : 'Open selected result'}
        isDisabled={!result || isOpening}
        size="small"
        variant="quiet"
        onPress={onOpen}
      >
        <LumenUiIcon name="forward" size="small" />
        <span className="hidden sm:inline">{isOpening ? 'Opening' : 'Open'}</span>
        <kbd aria-hidden="true" className="ml-1 font-sans text-xs text-[color:var(--einui-command-muted-text)]">↵</kbd>
      </LumenButton>
      <LumenButton
        aria-label="Open containing folder"
        isDisabled={!result || result.kind === 'app-content'}
        size="small"
        variant="quiet"
        onPress={onOpenContainingFolder}
      >
        <LumenUiIcon name="folderOpen" size="small" />
        <span className="hidden sm:inline">Folder</span>
      </LumenButton>
      <LumenButton
        aria-label={result?.pinned ? 'Unpin selected result' : 'Pin selected result'}
        isDisabled={!result?.provenance}
        size="small"
        variant="quiet"
        onPress={onPin}
      >
        <LumenUiIcon name={result?.pinned ? 'pinned' : 'pin'} size="small" />
        <span className="hidden sm:inline">{result?.pinned ? 'Unpin' : 'Pin'}</span>
      </LumenButton>
      <LumenButton
        aria-label="Show file details"
        isDisabled={!result}
        size="small"
        variant="quiet"
        onPress={onDetails}
      >
        <LumenUiIcon name="info" size="small" />
        <span className="hidden sm:inline">Details</span>
      </LumenButton>
    </div>
  );
}
