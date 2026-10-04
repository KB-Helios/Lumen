import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';

import type {SearchResult} from '../../services/search/search.types';
import {appearanceStore} from '../../state/appearance.store';
import {ResultGrid} from './ResultGrid';

function file(id: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id,
    name: `${id}.tsx`,
    path: `C:\\Projects\\Lumen\\src\\${id}.tsx`,
    kind: 'source',
    match: {source: 'content', fragment: `export function ${id}()`},
    metadata: {
      extension: 'tsx',
      modifiedAt: '2026-07-31T10:00:00.000Z',
      sizeBytes: 2048,
    },
    availability: 'available',
    ...overrides,
  };
}

describe('ResultGrid', () => {
  afterEach(() => appearanceStore.setState({density: 'comfortable'}));

  it('renders compact rows with the compact virtual canvas height', async () => {
    appearanceStore.setState({density: 'compact'});
    const results = Array.from({length: 10_000}, (_, index) => file(`file-${index}`));
    const {container} = render(
      <ResultGrid results={results} selectedId="file-0" maxHeight={400} />,
    );

    await waitFor(() => expect(screen.getByRole('grid', {name: 'Search results'})).toHaveStyle({height: '460000px'}));
    expect(container.querySelector('[data-result-id]')).toHaveClass('min-h-[var(--lumen-result-row-height)]');
  });

  it('keeps the selected file when a result is inserted above it', () => {
    const {rerender} = render(
      <ResultGrid results={[file('a'), file('b')]} selectedId="b" />,
    );

    rerender(
      <ResultGrid
        results={[file('new'), file('a'), file('b')]}
        selectedId="b"
      />,
    );

    expect(screen.getByRole('row', {name: /b\.tsx/i})).toHaveAttribute(
      'data-selected',
      'true',
    );
  });

  it('selects an available row and labels unavailable states without color alone', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(
      <ResultGrid
        results={[
          file('ready'),
          file('denied', {availability: 'permissionDenied'}),
        ]}
        selectedId={null}
        onSelectionChange={onSelectionChange}
      />,
    );

    await user.click(screen.getByRole('row', {name: /ready\.tsx/i}));
    expect(onSelectionChange).toHaveBeenCalledWith('ready');
    expect(screen.getByRole('row', {name: /permission required/i})).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('suppresses the selection capsule inset shadow in app-controlled high contrast', () => {
    const results = [file('selected')];
    const {container} = render(
      <ResultGrid results={results} selectedId="selected" />,
    );

    const capsule = container.querySelector('[data-selection-capsule]');

    expect(capsule).not.toBeNull();
    expect(capsule).toHaveClass('high-contrast:shadow-none');
    expect(capsule?.className).toContain(
      'shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]',
    );
  });

  it('clears a disabled selection so sibling surfaces cannot retain it', () => {
    const onSelectionChange = vi.fn();
    const {container, rerender} = render(
      <ResultGrid
        results={[file('blocked', {availability: 'permissionDenied'})]}
        selectedId="blocked"
        onSelectionChange={onSelectionChange}
      />,
    );

    expect(container.querySelector('[aria-selected="true"]')).toBeNull();
    expect(onSelectionChange).toHaveBeenCalledWith(null);
    rerender(
      <ResultGrid
        results={[]}
        selectedId="blocked"
        onSelectionChange={onSelectionChange}
      />,
    );
    expect(container.querySelector('[aria-selected="true"]')).toBeNull();
  });

  it('activates the row that was clicked by stable ID', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <ResultGrid
        results={[file('alpha'), file('beta')]}
        selectedId="alpha"
        onAction={onAction}
      />,
    );

    await user.click(screen.getByRole('row', {name: /beta\.tsx/i}));

    expect(onAction).toHaveBeenCalledWith('beta');
  });

  it('virtualizes 10,000 results with a bounded mounted row count', async () => {
    const results = Array.from({length: 10_000}, (_, index) => file(`file-${index}`));
    const {container} = render(
      <ResultGrid results={results} selectedId="file-0" maxHeight={400} />,
    );

    await waitFor(() =>
      expect(container.querySelectorAll('[data-result-id]').length).toBeGreaterThan(0),
    );
    expect(screen.getByRole('grid', {name: 'Search results'})).toHaveAttribute(
      'aria-rowcount',
      '10000',
    );
    expect(container.querySelectorAll('[data-result-id]').length).toBeLessThan(40);
  });

  it('renders the selected result FileGlyph with text-accent', () => {
    const {rerender} = render(
      <ResultGrid
        results={[file('alpha'), file('beta'), file('gamma')]}
        selectedId="beta"
      />,
    );

    const selectedRow = screen.getByRole('row', {name: /beta\.tsx/i});
    const selectedGlyph = selectedRow.querySelector('[data-testid="file-glyph"]');
    expect(selectedGlyph).toHaveClass('text-accent');
    expect(selectedGlyph).toHaveAttribute('data-selected', 'true');

    const unselectedRow = screen.getByRole('row', {name: /alpha\.tsx/i});
    const unselectedGlyph = unselectedRow.querySelector('[data-testid="file-glyph"]');
    expect(unselectedGlyph).toHaveClass('text-text-secondary');
    expect(unselectedGlyph).not.toHaveAttribute('data-selected', 'true');

    rerender(
      <ResultGrid
        results={[file('alpha'), file('beta'), file('gamma')]}
        selectedId="gamma"
      />,
    );

    const previouslySelectedGlyph = screen.getByRole('row', {name: /beta\.tsx/i})
      .querySelector('[data-testid="file-glyph"]');
    expect(previouslySelectedGlyph).toHaveClass('text-text-secondary');

    const newlySelectedGlyph = screen.getByRole('row', {name: /gamma\.tsx/i})
      .querySelector('[data-testid="file-glyph"]');
    expect(newlySelectedGlyph).toHaveClass('text-accent');
  });
});
