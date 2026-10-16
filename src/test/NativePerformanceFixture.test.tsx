import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BrowserWindowService} from '../platform/window/browser-window-service';
import {useLauncherStore} from '../features/launcher/launcher.store';
import {useQueryStore} from '../features/launcher/query.store';
import {NativePerformanceFixture, nativePerformanceWindow} from './NativePerformanceFixture';
import {requestWindowHide} from '../features/launcher/useLauncherPresentation';

const {invoke} = vi.hoisted(() => ({invoke: vi.fn(() => Promise.reject(new Error('Native service access forbidden')))}));
vi.mock('@tauri-apps/api/core', () => ({invoke}));

afterEach(() => {
  Reflect.deleteProperty(window, '__LUMEN_NATIVE_PERFORMANCE__');
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  useLauncherStore.getState().reset(); useQueryStore.getState().clear();
});

describe('offline native performance fixture', () => {
  it('refuses an entry that was not initialized by the native fixture bootstrap', () => {
    expect(() => render(<NativePerformanceFixture windowService={new BrowserWindowService()} />)).toThrow('Native performance fixture bootstrap required');
  });
  it('runs the real launcher query/selection without native settings, health or provider access', async () => {
    Object.defineProperty(window, '__LUMEN_NATIVE_PERFORMANCE__', {value: true, configurable: true});
    Object.defineProperty(window, '__TAURI_INTERNALS__', {value: {}, configurable: true});
    const user = userEvent.setup();
    render(<NativePerformanceFixture windowService={new BrowserWindowService()} />);
    const search = await screen.findByRole('searchbox', {name: 'Search files'});
    await user.type(search, 'report');
    expect(await screen.findByRole('grid', {name: 'Search results'})).toBeInTheDocument();
    await screen.findAllByRole('row');
    await user.keyboard('{ArrowDown}');
    expect(invoke).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelectorAll('[data-result-id][aria-selected="true"]')).toHaveLength(1));
    await user.clear(search);
    await user.type(search, 'unmatched fixture request');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('The answer runtime is not ready. Local search is still available.')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('preserves the query and caret through typed hide and diagnostics show', async () => {
    Object.defineProperty(window, '__LUMEN_NATIVE_PERFORMANCE__', {value: true, configurable: true});
    const windowService = nativePerformanceWindow as BrowserWindowService;
    const user = userEvent.setup();
    render(<NativePerformanceFixture />);
    const search = await screen.findByRole('searchbox', {name: 'Search files'}) as HTMLInputElement;
    await user.type(search, 'report');
    await screen.findAllByRole('row');
    search.setSelectionRange(2, 4);
    await act(async () => { expect(await requestWindowHide(windowService)).toBeTruthy(); });
    expect(useLauncherStore.getState().visible).toBe(false);
    expect(windowService.snapshot().visible).toBe(false);
    expect(search.value).toBe('report');
    expect([search.selectionStart, search.selectionEnd]).toEqual([2, 4]);
    await act(async () => { window.dispatchEvent(new CustomEvent('lumen:diagnostics-show-launcher')); });
    await waitFor(() => expect(useLauncherStore.getState().visible).toBe(true));
    expect(windowService.snapshot().visible).toBe(true);
    expect(search.value).toBe('report');
    expect([search.selectionStart, search.selectionEnd]).toEqual([2, 4]);
    expect(invoke).not.toHaveBeenCalled();
  });
});
