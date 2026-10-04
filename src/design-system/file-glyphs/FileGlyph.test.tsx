import {render, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';

import {fileKinds} from './file-kind';
import {FileGlyph} from './FileGlyph';

describe('FileGlyph', () => {
  it.each(fileKinds)('renders a neutral %s glyph with an accessible title', (kind) => {
    const {container} = render(<FileGlyph kind={kind} title={`${kind} file`} />);
    const glyph = screen.getByTestId('file-glyph');

    expect(screen.getByTitle(`${kind} file`)).toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('stroke', 'currentColor');
    expect(glyph).toHaveClass('text-text-secondary');
    expect(glyph).not.toHaveClass('text-success');
    expect(glyph).not.toHaveClass('text-warning');
    expect(glyph).not.toHaveClass('text-danger');
  });

  it('is decorative when no title is provided', () => {
    const {container} = render(<FileGlyph kind="document" />);

    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('uses the shared accent when selected without changing geometry', () => {
    const {rerender} = render(<FileGlyph kind="source" selected />);
    const selected = screen.getByTestId('file-glyph');
    const viewBox = selected.querySelector('svg')?.getAttribute('viewBox');

    expect(selected).toHaveAttribute('data-selected', 'true');
    expect(selected).toHaveClass('text-accent');
    rerender(<FileGlyph kind="source" selected={false} />);
    expect(screen.getByTestId('file-glyph')).toHaveClass('text-text-secondary');
    expect(screen.getByTestId('file-glyph').querySelector('svg')).toHaveAttribute(
      'viewBox',
      viewBox,
    );
  });
});

