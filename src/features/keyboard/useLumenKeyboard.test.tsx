import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createRef} from 'react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {BrowserWindowService} from '../../platform/window/browser-window-service';
import {DevelopmentComputerUseService as KeyboardComputerUseService} from '../../services/computer-use/development-computer-use-service';
import {MemorySearchService} from '../../services/search/memory-search-service';
import type {SearchResult} from '../../services/search/search.types';
import {SearchExperience} from '../launcher/SearchExperience';
import {useLauncherStore} from '../launcher/launcher.store';
import {usePreviewStore} from '../launcher/preview.store';
import {useQueryStore} from '../launcher/query.store';
import {useScopeStore} from '../launcher/scope.store';
import {useSelectionStore} from '../launcher/selection.store';
import {useSettingsStore} from '../settings/settings.store';
import {useLumenKeyboard} from './useLumenKeyboard';
import {ResultGrid} from '../results/ResultGrid';

function file(id: string): SearchResult {
  return {
    id,
    name: `${id}.tsx`,
    path: `C:\\Projects\\Lumen\\${id}.tsx`,
    kind: 'source',
    match: {source: 'filename', fragment: id},
    metadata: {extension: 'tsx', sizeBytes: 2048},
    availability: 'available',
  };
}

async function searchFor(
  service: MemorySearchService,
  user: ReturnType<typeof userEvent.setup>,
  query: string,
  results: readonly SearchResult[],
) {
  await user.type(screen.getByRole('searchbox', {name: 'Search files'}), query);
  await waitFor(() => expect(
    service.requests.some(({request}) => request.query === query),
  ).toBe(true));
  await act(() => service.resolve(query, results));
  await screen.findByRole('row', {name: new RegExp(results[0]?.name ?? '')});
}

afterEach(() => {
  useLauncherStore.getState().reset();
  usePreviewStore.getState().reset();
  useQueryStore.getState().reset();
  useScopeStore.getState().reset();
  useSelectionStore.getState().reset();
  useSettingsStore.getState().reset();
});

describe('Lumen keyboard coordination', () => {
  it('scrolls only the latest keyboard selection on the next frame without taking input focus and cancels on hide', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++next, callback); return next; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
    const scroll = vi.fn();
    const previous = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    const inputRef = createRef<HTMLInputElement>();
    const results = [file('a'), file('b'), file('c')];
    function Harness() {
      useLumenKeyboard({detailsOpen: false, inputRef, intent: 'search', isExpanded: true,
        results, selectedId: 'a', onCloseDetails: vi.fn(), onOpen: vi.fn(),
        onOpenContainingFolder: vi.fn(), onOpenSettings: vi.fn(), onRequestHide: vi.fn(),
        onSelect: (id) => useSelectionStore.getState().select(id), onShowDetails: vi.fn()});
      return <><input ref={inputRef} type="search" aria-label="Scroll query" /><ResultGrid reducedMotion results={results} selectedId="a" /></>;
    }
    try {
      const {container} = render(<Harness />);
      await act(async () => {});
      frames.clear();
      inputRef.current!.focus();
      fireEvent.keyDown(inputRef.current!, {key: 'ArrowDown'});
      fireEvent.keyDown(inputRef.current!, {key: 'ArrowDown'});
      expect(scroll).not.toHaveBeenCalled();
      act(() => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0); });
      expect(scroll).toHaveBeenCalledOnce();
      expect(scroll.mock.contexts[0]).toBe(container.querySelector('[data-result-id="c"]'));
      expect(inputRef.current).toHaveFocus();
      fireEvent.keyDown(inputRef.current!, {key: 'ArrowUp'});
      expect(frames.size).toBe(1);
      act(() => useLauncherStore.getState().hide());
      expect(frames.size).toBe(0);
      fireEvent.keyDown(inputRef.current!, {key: 'ArrowUp'});
      expect(frames.size).toBe(0);
    } finally { HTMLElement.prototype.scrollIntoView = previous; vi.unstubAllGlobals(); }
  });

  it('uses DOM order for Computer Use from idle through approval and running controls', async () => {
    const user = userEvent.setup();
    const service = new KeyboardComputerUseService();
    useLauncherStore.getState().setIntent('computer');
    useSettingsStore.setState((state) => ({
      computerUse: {...state.computerUse, cloudConsent: true},
    }));
    render(
      <SearchExperience
        computerUseService={service}
        service={new MemorySearchService()}
        windowService={new BrowserWindowService()}
      />,
    );

    const input = screen.getByRole('searchbox', {name: 'Describe a computer task'});
    await user.type(input, 'Review the support form');
    const run = await screen.findByRole('button', {name: 'Run in Edge'});
    await waitFor(() => expect(run).toBeEnabled());

    input.focus();
    await user.tab();
    expect(screen.getByRole('button', {name: 'Clear search'})).toHaveFocus();
    await user.tab();
    const target = screen.getByRole('button', {name: /Computer Use target/});
    expect(target).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('listbox')).toBeVisible();
    expect(screen.getByRole('option', {name: 'Fresh Microsoft Edge'})).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(target).toHaveFocus());
    expect(input).toHaveValue('Review the support form');
    await user.tab();
    expect(screen.getByRole('button', {name: 'Refresh targets'})).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('checkbox', {name: 'Request visible browser (Fast only)'})).toHaveFocus();
    await user.tab();
    expect(run).toHaveFocus();
    await user.keyboard('{Enter}');

    const approve = await screen.findByRole('button', {name: 'Approve once'});
    const deny = screen.getByRole('button', {name: 'Deny and stop'});
    const approvalStop = screen.getByRole('button', {name: 'Stop'});
    input.focus();
    await user.tab();
    await user.tab();
    expect(approve).toHaveFocus();
    await user.tab();
    expect(deny).toHaveFocus();
    await user.tab({shift: true});
    expect(approve).toHaveFocus();
    approvalStop.focus();
    await user.tab({shift: true});
    expect(deny).toHaveFocus();

    await user.click(approve);
    await waitFor(() => expect(screen.getByRole('button', {name: 'Stop'})).toBeVisible());
    input.focus();
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', {name: 'Stop'})).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('button', {name: 'Run in Edge'})).toBeVisible());
  });

  it('reaches Deny and stop by keyboard and returns to an idle Run in Edge action', async () => {
    const user = userEvent.setup();
    useLauncherStore.getState().setIntent('computer');
    useSettingsStore.setState((state) => ({
      computerUse: {...state.computerUse, cloudConsent: true},
    }));
    render(
      <SearchExperience
        computerUseService={new KeyboardComputerUseService()}
        service={new MemorySearchService()}
        windowService={new BrowserWindowService()}
      />,
    );

    const input = screen.getByRole('searchbox', {name: 'Describe a computer task'});
    await user.type(input, 'Review the support form');
    await user.click(await screen.findByRole('button', {name: 'Run in Edge'}));
    const deny = await screen.findByRole('button', {name: 'Deny and stop'});

    input.focus();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(deny).toHaveFocus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByRole('button', {name: 'Run in Edge'})).toBeVisible());
  });

  it('opens the selected file and hides after tactile confirmation', async () => {
    const user = userEvent.setup();
    const service = new MemorySearchService();
    const windowService = new BrowserWindowService();
    render(<SearchExperience service={service} windowService={windowService} />);

    await searchFor(service, user, 'alpha', [file('alpha'), file('beta')]);
    expect(useLauncherStore.getState().mode).toBe('expanded');
    await user.keyboard('{Tab}');
    expect(screen.getByRole('tab', {name: 'All'})).toHaveFocus();
    await user.keyboard('{Tab}');
    expect(screen.getByRole('row', {name: /alpha\.tsx/i})).toHaveFocus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(service.openedFiles).toEqual(['alpha']));
    await waitFor(() => expect(windowService.snapshot().visible).toBe(false));
  });

  it('moves stable selection with arrows and announces its context', async () => {
    const user = userEvent.setup();
    const service = new MemorySearchService();
    render(<SearchExperience service={service} windowService={new BrowserWindowService()} />);

    await searchFor(service, user, 'code', [file('alpha'), file('beta')]);
    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('row', {name: /beta\.tsx/i})).toHaveAttribute(
      'data-selected',
      'true',
    );
    expect(screen.getByTestId('search-announcement')).toHaveTextContent(
      /2 results.*beta\.tsx/i,
    );
  });

  it('opens the containing folder and the narrow details dialog from shortcuts', async () => {
    const user = userEvent.setup();
    const service = new MemorySearchService();
    render(<SearchExperience service={service} windowService={new BrowserWindowService()} />);

    await searchFor(service, user, 'alpha', [file('alpha')]);
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(service.openedFolders).toEqual(['alpha']);

    await user.keyboard('{Alt>}{Enter}{/Alt}');
    expect(await screen.findByRole('dialog', {name: 'File details'})).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', {name: 'File details'})).toBeNull();
    expect(screen.getByRole('searchbox', {name: 'Search files'})).toHaveFocus();
  });

  it('moves between keyboard regions and exposes global focus and settings shortcuts', async () => {
    const user = userEvent.setup();
    const service = new MemorySearchService();
    const windowService = new BrowserWindowService();
    const onOpenSettings = vi.fn();
    render(
      <SearchExperience
        service={service}
        windowService={windowService}
        onOpenSettings={onOpenSettings}
      />,
    );

    await searchFor(service, user, 'alpha', [file('alpha')]);
    await user.keyboard('{Tab}');
    expect(screen.getByRole('tab', {name: 'All'})).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(useScopeStore.getState().activeScope).toBe('files');

    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('searchbox', {name: 'Search files'})).toHaveFocus();

    await user.keyboard('{Control>},{/Control}');
    expect(onOpenSettings).toHaveBeenCalledOnce();
    await waitFor(() => expect(windowService.snapshot().mode).toBe('settings'));
  });
});
