import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {AppProviders} from '../../app/AppProviders';
import type {AppearancePreferences} from '../../design-system/theme';
import {MemorySearchService} from '../../services/search/memory-search-service';
import type {SearchResult} from '../../services/search/search.types';
import {appearanceStore} from '../../state/appearance.store';
import type {AppearanceSettings} from '../../state/appearance.schema';
import {ExpandedWorkspace} from './ExpandedWorkspace';
import {useSelectionStore} from './selection.store';

const appearance: AppearancePreferences = {
  effects: 'full',
  mode: 'dark',
  motion: 'reduced',
  transparency: 'native',
};

const result: SearchResult = {
  id: 'release',
  name: 'release.md',
  path: 'C:\\Projects\\Lumen\\release.md',
  kind: 'document',
  match: {source: 'filename', fragment: 'release'},
  metadata: {extension: 'md'},
  availability: 'available',
};

function mockViewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const minimum = /min-width:\s*(\d+)px/.exec(query)?.[1];
    return {
      addEventListener: () => undefined,
      matches: minimum ? width >= Number(minimum) : false,
      media: query,
      removeEventListener: () => undefined,
    };
  });
}

function renderWorkspace(preview: AppearanceSettings['preview'], width: number, height = 320) {
  // The launcher can be narrower than its browser/window host (e.g. the gallery).
  mockViewport(1280);
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-workspace-content') ? {
      x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height,
      toJSON: () => ({}),
    } : measure.call(this);
  });
  appearanceStore.setState({preview});
  render(
    <AppProviders appearance={appearance}>
      <ExpandedWorkspace
        activeFilters={[]}
        announcement="1 result"
        error={null}
        lifecycle="ready"
        openingId={null}
        results={[result]}
        selectedId="release"
        service={new MemorySearchService()}
        onClearFilters={vi.fn()}
        onDetails={vi.fn()}
        onOpen={vi.fn()}
        onOpenContainingFolder={vi.fn()}
        onPin={vi.fn()}
        onRemoveFilter={vi.fn()}
        onSelectionChange={vi.fn()}
      />
    </AppProviders>,
  );
}

afterEach(() => {
  appearanceStore.setState({preview: 'automatic'});
  vi.unstubAllGlobals();
});

describe('ExpandedWorkspace preview policy', () => {
  it('keeps one answer motion container across streamed deltas and accepts Stop during entry', async () => {
    const stop = vi.fn();
    const props = {activeFilters: [], announcement: '', error: null, lifecycle: 'ready' as const,
      openingId: null, results: [], service: new MemorySearchService(), onClearFilters: vi.fn(),
      onDetails: vi.fn(), onOpen: vi.fn(), onOpenContainingFolder: vi.fn(), onPin: vi.fn(),
      onRemoveFilter: vi.fn(), onSelectionChange: vi.fn()};
    const answer = (text: string) => <section><span>{text}</span><button onClick={stop}>Stop answer</button></section>;
    const {container, rerender} = render(<ExpandedWorkspace {...props} answerPanel={answer('First')} />);
    const region = container.querySelector('[data-answer-motion]');
    expect(region).not.toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Stop answer'}));
    expect(stop).toHaveBeenCalledOnce();
    rerender(<ExpandedWorkspace {...props} answerPanel={answer('First second')} />);
    expect(container.querySelector('[data-answer-motion]')).toBe(region);
    rerender(<ExpandedWorkspace {...props} />);
    expect(region).toBeInTheDocument();
    await waitFor(() => expect(region).not.toBeInTheDocument());
  });
  it('updates action pin and kind availability with selection without rendering the workspace owner', () => {
    let renders = 0;
    const pinned = {...result, pinned: true, provenance: {fileHash: 'fixture', indexRevision: 1, extractionKind: 'text'}};
    const app = {...result, id: 'app', name: 'Application content', kind: 'app-content' as const};
    useSelectionStore.getState().select(pinned.id);
    const Owner = () => {renders += 1; return <ExpandedWorkspace activeFilters={[]} announcement="2 results" error={null} lifecycle="ready" openingId={null} results={[pinned, app]} service={new MemorySearchService()} onClearFilters={vi.fn()} onDetails={vi.fn()} onOpen={vi.fn()} onOpenContainingFolder={vi.fn()} onPin={vi.fn()} onRemoveFilter={vi.fn()} onSelectionChange={vi.fn()} />;};
    render(<AppProviders><Owner /></AppProviders>);
    expect(screen.getByRole('button', {name: 'Unpin selected result'})).toBeEnabled();
    const initialRenders = renders;
    act(() => useSelectionStore.getState().select(app.id));
    expect(screen.getByRole('button', {name: 'Pin selected result'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Open containing folder'})).toBeDisabled();
    expect(screen.getByLabelText('Result actions')).toHaveTextContent('Application content');
    expect(renders).toBe(initialRenders);
    act(() => useSelectionStore.getState().reset());
  });
  it.each([
    ['automatic', 720, false],
    ['automatic', 800, true],
    ['automatic', 960, true],
    ['always', 720, false],
    ['always', 800, true],
    ['always', 960, true],
    ['never', 720, false],
    ['never', 800, false],
    ['never', 960, false],
  ] as const)('%s at %d px mounts preview: %s', async (policy, width, expected) => {
    renderWorkspace(policy, width);

    if (expected) {
      expect(await screen.findByLabelText('File preview')).toBeInTheDocument();
    } else {
      expect(screen.queryByLabelText('File preview')).not.toBeInTheDocument();
    }
  });

  it('keeps a narrow launcher free of inline preview in a wide host', () => {
    renderWorkspace('always', 520);

    expect(screen.queryByLabelText('File preview')).not.toBeInTheDocument();
  });

  it.each(['automatic', 'always'] as const)('lets %s preview yield when results have too little height', (policy) => {
    renderWorkspace(policy, 960, 160);

    expect(screen.queryByLabelText('File preview')).not.toBeInTheDocument();
  });
});
