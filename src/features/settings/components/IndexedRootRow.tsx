import {useState} from 'react';

import {LumenUiIcon} from '../../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../../design-system/primitives/LumenButton';
import {LumenIconButton} from '../../../design-system/primitives/LumenIconButton';
import {LumenText} from '../../../design-system/primitives/LumenText';
import type {IndexedRoot} from '../settings.schema';
import {ConfirmationDialog} from './ConfirmationDialog';
import {LumenSelect, LumenSwitch, LumenTextField} from './SettingsControls';
import {StatusBadge} from './StatusBadge';

const rootStatus = {
  ready: {label: 'Ready', tone: 'success'},
  indexing: {label: 'Indexing', tone: 'info'},
  paused: {label: 'Paused', tone: 'warning'},
  error: {label: 'Needs attention', tone: 'error'},
} as const;

function validateExclusion(pattern: string) {
  const value = pattern.trim();
  if (!value || value.includes('..') || /^[a-z]:\\/i.test(value) || value.startsWith('\\\\')) {
    return 'Keep exclusions relative to this root and omit parent traversal.';
  }
  return '';
}

export interface IndexedRootRowProps {
  cloudEnrichment: boolean;
  root: IndexedRoot;
  onCloudEnrichmentChange(value: boolean): void;
  onChange(root: IndexedRoot): void;
  onRemove(): void;
}

export function IndexedRootRow({cloudEnrichment, root, onChange, onCloudEnrichmentChange, onRemove}: IndexedRootRowProps) {
  const [pattern, setPattern] = useState('');
  const [error, setError] = useState('');
  const status = rootStatus[root.status];

  const addExclusion = () => {
    const nextError = validateExclusion(pattern);
    setError(nextError);
    if (nextError) {
      return;
    }
    const value = pattern.trim();
    if (!root.exclusions.includes(value)) {
      onChange({...root, exclusions: [...root.exclusions, value]});
    }
    setPattern('');
  };

  const togglePaused = () => onChange({
    ...root,
    paused: !root.paused,
    status: root.paused ? 'ready' : 'paused',
  });

  return (
    <article aria-label={`Indexed root ${root.path}`} className="grid min-w-0 gap-[16px] border-b border-border-subtle p-[16px] last:border-b-0">
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-[12px] @min-[32rem]/settings:grid-cols-[auto_minmax(0,1fr)_auto]">
        <span aria-hidden="true" className="grid size-[40px] place-items-center rounded-control bg-surface-inset text-text-secondary"><LumenUiIcon name="folder" size="medium" /></span>
        <div className="grid min-w-0 gap-1">
          <LumenText className="truncate" weight="medium">{root.path}</LumenText>
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        </div>
        <div className="col-span-full flex items-center gap-[4px] @min-[32rem]/settings:col-auto">
          <LumenIconButton
            aria-label={`${root.paused ? 'Resume' : 'Pause'} ${root.path}`}
            size="small"
            variant="quiet"
            onPress={togglePaused}
          >
            {root.paused ? <LumenUiIcon name="play" size="small" /> : <LumenUiIcon name="pause" size="small" />}
          </LumenIconButton>
          <ConfirmationDialog
            confirmLabel="Remove root permanently"
            description={`Lumen will stop searching ${root.path}. No files will be deleted.`}
            title="Remove indexed root"
            onConfirm={onRemove}
          >
            <LumenIconButton aria-label={`Remove ${root.path}`} size="small" variant="quiet">
              <LumenUiIcon name="delete" size="small" />
            </LumenIconButton>
          </ConfirmationDialog>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-[12px]">
        <LumenText className="w-full" tone="tertiary" variant="meta">Root policy</LumenText>
        <LumenSwitch
          aria-label={`Allow cloud enrichment for ${root.path}`}
          isSelected={cloudEnrichment}
          onChange={onCloudEnrichmentChange}
        />
        <LumenSwitch
          aria-label={`Include hidden directories for ${root.path}`}
          isSelected={root.includeHidden}
          onChange={(includeHidden) => onChange({...root, includeHidden})}
        />
        <LumenSelect
          aria-label={`File size limit for ${root.path}`}
          options={[
            {id: '64', label: '64 MB'},
            {id: '256', label: '256 MB'},
            {id: '1024', label: '1 GB'},
          ]}
          value={String(root.maxFileSizeMb) as '64' | '256' | '1024'}
          onChange={(value) => onChange({...root, maxFileSizeMb: Number(value)})}
        />
      </div>
      <div className="grid min-w-0 gap-[8px]">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-[8px] @min-[32rem]/settings:grid-cols-[minmax(0,1fr)_auto]">
          <LumenTextField
            aria-label={`Exclusion pattern for ${root.path}`}
            placeholder="Examples: node_modules or *.tmp"
            value={pattern}
            onChange={(value) => {
              setPattern(value);
              if (error) setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addExclusion();
              }
            }}
          />
          <LumenButton aria-label={`Add exclusion for ${root.path}`} className="justify-self-start" size="small" onPress={addExclusion}>Add</LumenButton>
        </div>
        {error ? <LumenText className="text-danger" role="alert" variant="meta">{error}</LumenText> : null}
        {root.exclusions.length ? (
          <div aria-label={`Exclusions for ${root.path}`} className="flex min-w-0 flex-wrap gap-[8px]">
            {root.exclusions.map((exclusion) => (
              <span key={exclusion} className="inline-flex min-h-[32px] min-w-0 max-w-full items-center gap-[4px] rounded-pill bg-surface-inset px-[10px] font-sans text-xs text-text-secondary">
                <span className="min-w-0 [overflow-wrap:anywhere]">{exclusion}</span>
                <LumenIconButton
                  aria-label={`Remove exclusion ${exclusion}`}
                  size="small"
                  variant="quiet"
                  onPress={() => onChange({...root, exclusions: root.exclusions.filter((item) => item !== exclusion)})}
                >
                  <LumenUiIcon name="close" size="small" />
                </LumenIconButton>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}
