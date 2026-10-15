import {FileGlyph} from '../../design-system/file-glyphs/FileGlyph';
import type {FilePreview, SearchResultKind} from '../../services/search/search.types';
import {SafeMarkdown} from './SafeMarkdown';

function isSafeImageSource(sourceUrl?: string) {
  if (!sourceUrl) return false;
  if (/^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i.test(sourceUrl)) return true;
  try {
    return ['https:', 'http:', 'blob:', 'asset:', 'tauri:'].includes(new URL(sourceUrl).protocol);
  } catch {
    return false;
  }
}

function Placeholder({kind, label}: {kind: SearchResultKind; label: string}) {
  return (
    <div className="grid min-h-44 place-items-center gap-3 rounded-control border border-[color:var(--einui-command-divider)] bg-[var(--lumen-surface-inset)] p-6 text-center">
      <FileGlyph kind={kind} size={48} />
      <span className="font-sans text-[0.9375rem] font-medium text-text-secondary">{label}</span>
    </div>
  );
}

function previewBody(preview: FilePreview) {
  switch (preview.kind) {
    case 'folder':
      return preview.children?.length ? (
        <ul className="grid list-none gap-1.5 p-0">
          {preview.children.map((child) => (
            <li key={child.id} className="grid min-h-10 grid-cols-[32px_minmax(0,1fr)] items-center gap-3 rounded-control px-3">
              <FileGlyph kind={child.kind} size="medium" />
              <span className="truncate font-sans text-sm text-[color:var(--einui-command-text)]">{child.name}</span>
            </li>
          ))}
        </ul>
      ) : <Placeholder kind="folder" label="This folder is empty" />;
    case 'text':
      return <p className="m-0 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-[color:var(--einui-command-text)]">{preview.text || 'No text preview available.'}</p>;
    case 'source':
      return <pre className="m-0 overflow-auto rounded-control border border-[color:var(--einui-command-divider)] bg-[var(--lumen-surface-inset)] p-3 font-mono text-xs leading-relaxed text-[color:var(--einui-command-text)] whitespace-pre-wrap"><code>{preview.text || 'No source preview available.'}</code></pre>;
    case 'markdown':
      return <SafeMarkdown source={preview.text || 'No Markdown preview available.'} />;
    case 'pdf':
    case 'document':
    case 'presentation':
      return preview.text
        ? <p className="m-0 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-[color:var(--einui-command-text)]">{preview.text}</p>
        : <Placeholder kind={preview.kind} label={{pdf: 'PDF document', document: 'Document preview', presentation: 'Presentation preview'}[preview.kind]} />;
    case 'spreadsheet':
      return preview.rows?.length ? (
        <div className="min-w-0 overflow-auto rounded-control border border-[color:var(--einui-command-divider)]">
          <table className="w-full border-collapse font-sans text-xs text-text-secondary">
            {preview.columns?.length ? <thead><tr>{preview.columns.map((column, index) => <th key={`${column}-${index}`} className="min-w-24 border-b border-[color:var(--einui-command-divider)] bg-[var(--lumen-surface-raised)] px-3 py-2.5 text-left font-semibold text-[color:var(--einui-command-text)]" scope="col">{column}</th>)}</tr></thead> : null}
            <tbody>{preview.rows.map((row, rowIndex) => <tr key={`row-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`cell-${rowIndex}-${cellIndex}`} className="min-w-24 border-b border-[color:var(--einui-command-divider)] px-3 py-2.5 text-left">{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : <Placeholder kind="spreadsheet" label="Spreadsheet preview" />;
    case 'image':
      return isSafeImageSource(preview.sourceUrl)
        ? <img alt={preview.title} className="block max-h-70 w-full rounded-control border border-[color:var(--einui-command-divider)] bg-[var(--lumen-surface-inset)] object-contain" decoding="async" src={preview.sourceUrl} />
        : <Placeholder kind="image" label="Image preview unavailable" />;
    case 'audio': return <Placeholder kind="audio" label="Audio file" />;
    case 'video': return <Placeholder kind="video" label="Video file" />;
    case 'permissionDenied': return <Placeholder kind="unknown" label="Permission required" />;
    case 'unsupported': return <Placeholder kind="unknown" label="Preview unavailable" />;
  }
}

export function PreviewContent({preview}: {preview: FilePreview}) {
  const metadata = Object.entries(preview.metadata);
  return (
    <div className="grid min-h-70 min-w-0 content-start gap-6 bg-canvas high-contrast:bg-[Canvas] p-4" data-preview-surface="opaque" data-testid={`preview-${preview.kind}`}>
      {previewBody(preview)}
      {preview.metadata.Preview === 'Truncated' ? <p className="m-0 font-sans text-xs text-text-secondary">Preview truncated at 64 KiB.</p> : null}
      {metadata.length ? (
        <dl className="grid grid-cols-[minmax(84px,auto)_minmax(0,1fr)] gap-2 border-t border-[color:var(--einui-command-divider)] pt-3 font-sans text-sm">
          {metadata.flatMap(([key, value]) => [
            <dt key={`${key}-key`} className="text-[color:var(--einui-command-muted-text)]">{key}</dt>,
            <dd key={`${key}-value`} className="m-0 break-words text-text-secondary">{value}</dd>,
          ])}
        </dl>
      ) : null}
    </div>
  );
}
