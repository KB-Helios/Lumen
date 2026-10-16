import {render, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {filePreviewSchema} from '../../services/search/search.types';
import {PreviewContent} from './PreviewContent';

describe('bounded document previews', () => {
  it.each(['pdf', 'document', 'presentation'] as const)('renders %s excerpts as passive text', kind => {
    const text = '<script>alert("preview")</script> & <img src=x onerror=alert(1)>';
    const {container} = render(<PreviewContent preview={{fileId: 'doc', kind, title: 'Document', text, metadata: {Preview: 'Indexed excerpt'}}} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(container.querySelector('script, iframe, object, img')).toBeNull();
  });

  it('rejects an aggregate table body over 64 KiB measured as UTF-8', () => {
    expect(filePreviewSchema.safeParse({fileId: 'table', kind: 'spreadsheet', title: 'Workbook', columns: ['A'], rows: Array.from({length: 20}, () => ['😀'.repeat(1000)])}).success).toBe(false);
  });

  it('keeps the complete bounded prefix and shows the truncation notice separately', () => {
    const text = 'a'.repeat(64 * 1024);
    const preview = filePreviewSchema.parse({fileId: 'text', kind: 'text', title: 'Large text', text, metadata: {Preview: 'Truncated'}});
    render(<PreviewContent preview={preview} />);
    expect(screen.getByText(text).textContent).toBe(text);
    expect(screen.getByText('Preview truncated at 64 KiB.')).toBeInTheDocument();
  });

  it('renders table attack strings as cells and retains accessible column headings', () => {
    const text = '<img src=x onerror=alert(1)> & =HYPERLINK("https://example.com")';
    const {container} = render(<PreviewContent preview={{fileId: 'table', kind: 'spreadsheet', title: 'Workbook', columns: ['A'], rows: [[text]], metadata: {}}} />);
    expect(screen.getByRole('columnheader', {name: 'A'})).toBeInTheDocument();
    expect(screen.getByRole('cell', {name: text})).toBeInTheDocument();
    expect(container.querySelector('script, iframe, object, img, a')).toBeNull();
  });

  it.each([
    {rows: Array.from({length: 41}, () => ['cell'])},
    {columns: Array.from({length: 13}, () => 'column')},
    {rows: [Array.from({length: 13}, () => 'cell')]},
    {text: '😀'.repeat(16385)},
    {text: 'a'.repeat(65530), columns: ['1234567']},
  ])('rejects oversized preview dimensions and mixed bodies %#', body => {
    expect(filePreviewSchema.safeParse({fileId: 'bad', kind: 'spreadsheet', title: 'Workbook', ...body}).success).toBe(false);
  });
});
