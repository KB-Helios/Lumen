import type {ReactNode} from 'react';

import {LumenIcon} from '../icons/LumenIcon';
import {cn} from '../../lib/cn';
import type {FileKind} from './file-kind';

function Sheet({children}: {children: ReactNode}) {
  return (
    <>
      <path d="M6 2.75h7.7L18.5 7.5v13.75H6Z" />
      <path d="M13.7 2.75V7.5h4.8" />
      {children}
    </>
  );
}

function glyphFor(kind: FileKind) {
  switch (kind) {
    case 'folder':
      return (
        <>
          <path d="M3.5 7.5h6l2-2h9v14h-17Z" />
          <path d="M3.5 10h17" />
        </>
      );
    case 'pdf':
      return (
        <Sheet>
          <path d="M8.5 15.5h7M8.5 12.25h7" />
          <path d="m9 18 2-2 2 2 2-2" />
        </Sheet>
      );
    case 'document':
      return (
        <Sheet>
          <path d="M8.5 11h7M8.5 14h7M8.5 17h5" />
        </Sheet>
      );
    case 'spreadsheet':
      return (
        <Sheet>
          <path d="M8.5 11h7v7h-7ZM8.5 14.5h7M12 11v7" />
        </Sheet>
      );
    case 'presentation':
      return (
        <Sheet>
          <path d="M8.5 11h7v5h-7ZM12 16v2.5M9.8 18.5h4.4" />
        </Sheet>
      );
    case 'source':
      return (
        <Sheet>
          <path d="m10.5 11-2.25 2.5L10.5 16M14 11l2.25 2.5L14 16" />
        </Sheet>
      );
    case 'image':
      return (
        <Sheet>
          <circle cx="10" cy="11.5" r="1" />
          <path d="m8.5 18 3.2-3.4 1.8 1.8 2-2.1" />
        </Sheet>
      );
    case 'video':
      return (
        <Sheet>
          <path d="m10.5 11 5 3-5 3Z" fill="currentColor" stroke="none" />
        </Sheet>
      );
    case 'audio':
      return (
        <Sheet>
          <path d="M9 15h2l3 2.5v-8L11 12H9ZM16 12.5c1 .8 1 2.2 0 3" />
        </Sheet>
      );
    case 'archive':
      return (
        <Sheet>
          <path d="M11.5 8.5h2M11.5 11h2M11.5 13.5h2M11.5 16h2M10.5 18.5h4" />
        </Sheet>
      );
    case 'executable':
      return (
        <Sheet>
          <path d="m9 12 2 2-2 2M12.5 16H16" />
        </Sheet>
      );
    case 'model':
      return (
        <Sheet>
          <path d="m12 10 4 2.2v4.6L12 19l-4-2.2v-4.6ZM8 12.2l4 2.3 4-2.3M12 14.5V19" />
        </Sheet>
      );
    case 'unknown':
      return (
        <Sheet>
          <path d="M10.2 12a2 2 0 1 1 3.1 1.65c-.8.5-1.3.85-1.3 1.6M12 18h.01" />
        </Sheet>
      );
  }
}

export interface FileGlyphProps {
  kind: FileKind;
  selected?: boolean;
  size?: 'small' | 'medium' | 'large' | number;
  title?: string;
}

export function FileGlyph({
  kind,
  selected = false,
  size = 'large',
  title,
}: FileGlyphProps) {
  return (
    <span
      className={cn(
        'inline-grid shrink-0 place-items-center',
        selected ? 'text-accent' : 'text-text-secondary',
      )}
      data-kind={kind}
      data-selected={selected}
      data-testid="file-glyph"
    >
      <LumenIcon size={size} title={title}>
        {glyphFor(kind)}
      </LumenIcon>
    </span>
  );
}

