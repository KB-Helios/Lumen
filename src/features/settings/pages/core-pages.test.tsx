import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {AppProviders} from '../../../app/AppProviders';
import {BrowserWindowService} from '../../../platform/window/browser-window-service';
import {defaultAppearanceSettings} from '../../../state/appearance.schema';
import {appearanceStore} from '../../../state/appearance.store';
import {nativeAiService} from '../../../services/ai/native-ai-service';
import type {RootSelectionService} from '../../onboarding/root-selection-service';
import {useSettingsStore} from '../settings.store';
import {AppearancePage} from './AppearancePage';
import {ComputerUsePage} from './ComputerUsePage';
import {GeneralPage} from './GeneralPage';
import {IndexedRootsPage} from './IndexedRootsPage';
import {SearchPage} from './SearchPage';
import {SettingSection} from '../components/SettingSection';

class DeferredRootService implements RootSelectionService {
  private resolveSelection?: (path: string | null) => void;

  chooseRoot(): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolveSelection = resolve;
    });
  }

  resolve(path: string | null) {
    this.resolveSelection?.(path);
  }
}

function renderWithProviders(children: React.ReactNode) {
  return render(<AppProviders>{children}</AppProviders>);
}

const defaultSetRoots = useSettingsStore.getState().setRoots;
const defaultUpdateGeneral = useSettingsStore.getState().updateGeneral;

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  useSettingsStore.setState({setRoots: defaultSetRoots});
  useSettingsStore.setState({updateGeneral: defaultUpdateGeneral});
  useSettingsStore.getState().reset();
  appearanceStore.setState({
    ...defaultAppearanceSettings,
    hydrationStatus: 'ready',
    persistenceStatus: 'idle',
    persistenceError: null,
  });
  localStorage.clear();
});

describe('core settings pages', () => {
  it('keeps setting sections as semantic groups rather than nested material surfaces', () => {
    renderWithProviders(
      <SettingSection description="A quiet semantic group." title="Presentation contract">
        <span>Control</span>
      </SettingSection>,
    );

    const section = screen.getByRole('region', {name: 'Presentation contract'});
    expect(section).toHaveAttribute('data-setting-section', 'true');
    expect(section.querySelector('[data-material]')).not.toBeInTheDocument();
  });

  it('switches to opaque mode immediately when transparency is disabled', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppearancePage />);

    await user.click(screen.getByRole('switch', {name: 'Use transparency'}));

    await waitFor(() => expect(screen.getByRole('application', {name: 'Lumen'})).toHaveAttribute(
      'data-transparency',
      'disabled',
    ));
  });

  it('records a valid global shortcut from the General page', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralPage />);

    await user.click(screen.getByRole('button', {name: 'Global shortcut'}));
    await user.keyboard('{Control>}{Shift>}l{/Shift}{/Control}');

    expect(screen.getByRole('button', {name: 'Global shortcut'})).toHaveTextContent('Ctrl + Shift + L');
    expect(useSettingsStore.getState().general.shortcut).toBe('Ctrl + Shift + L');
  });

  it('applies Windows lifecycle settings before persisting them', async () => {
    const user = userEvent.setup();
    const runtimeService = {
      setLaunchAtStartup: vi.fn(async () => undefined),
      setMonitorBehavior: vi.fn(async () => undefined),
      setCloseBehavior: vi.fn(async () => undefined),
      setHistoryEnabled: vi.fn(async () => undefined),
    };
    renderWithProviders(<GeneralPage runtimeService={runtimeService} />);

    await user.click(screen.getByRole('switch', {name: 'Launch at startup'}));
    await user.click(screen.getByRole('button', {name: /Monitor behavior/}));
    await user.click(screen.getByRole('option', {name: 'Primary monitor'}));
    await user.click(screen.getByRole('button', {name: /Launcher close behavior/}));
    await user.click(screen.getByRole('option', {name: 'Quit Lumen'}));
    await user.click(screen.getByRole('switch', {name: 'Search history'}));

    await waitFor(() => expect(runtimeService.setLaunchAtStartup).toHaveBeenCalledWith(true));
    expect(runtimeService.setMonitorBehavior).toHaveBeenCalledWith('primary');
    expect(runtimeService.setCloseBehavior).toHaveBeenCalledWith('quit');
    expect(runtimeService.setHistoryEnabled).toHaveBeenCalledWith(false);
    expect(useSettingsStore.getState().general).toMatchObject({
      launchAtStartup: true,
      monitorBehavior: 'primary',
      closeBehavior: 'quit',
      historyEnabled: false,
    });
  });

  it('keeps the applied lifecycle setting when Windows rejects a change', async () => {
    const user = userEvent.setup();
    const runtimeService = {
      setLaunchAtStartup: vi.fn(async () => {
        throw new Error('startup registration denied');
      }),
      setMonitorBehavior: vi.fn(async () => undefined),
      setCloseBehavior: vi.fn(async () => undefined),
      setHistoryEnabled: vi.fn(async () => undefined),
    };
    renderWithProviders(<GeneralPage runtimeService={runtimeService} />);

    await user.click(screen.getByRole('switch', {name: 'Launch at startup'}));

    expect(await screen.findByRole('alert')).toHaveTextContent('startup registration denied');
    expect(useSettingsStore.getState().general.launchAtStartup).toBe(false);
  });

  it('rolls Windows back when lifecycle persistence fails', async () => {
    const user = userEvent.setup();
    const runtimeService = {
      setLaunchAtStartup: vi.fn(async () => undefined),
      setMonitorBehavior: vi.fn(async () => undefined),
      setCloseBehavior: vi.fn(async () => undefined),
      setHistoryEnabled: vi.fn(async () => undefined),
    };
    useSettingsStore.setState({updateGeneral: vi.fn(async () => false)});
    renderWithProviders(<GeneralPage runtimeService={runtimeService} />);

    await user.click(screen.getByRole('switch', {name: 'Launch at startup'}));

    await waitFor(() => expect(runtimeService.setLaunchAtStartup).toHaveBeenNthCalledWith(2, false));
    expect(useSettingsStore.getState().general.launchAtStartup).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('applied but could not be saved');
  });

  it('restores the registered shortcut when persistence fails', async () => {
    const user = userEvent.setup();
    const windowService = new BrowserWindowService();
    const setShortcut = vi.spyOn(windowService, 'setShortcut');
    useSettingsStore.setState({updateGeneral: vi.fn(async () => false)});
    renderWithProviders(<GeneralPage windowService={windowService} />);

    await user.click(screen.getByRole('button', {name: 'Global shortcut'}));
    await user.keyboard('{Control>}{Shift>}l{/Shift}{/Control}');

    await waitFor(() => expect(setShortcut).toHaveBeenNthCalledWith(2, 'Alt + Space'));
    expect(useSettingsStore.getState().general.shortcut).toBe('Alt + Space');
  });

  it('adds, pauses, and removes an indexed root with confirmation', async () => {
    const user = userEvent.setup();
    const rootService = new DeferredRootService();
    renderWithProviders(<IndexedRootsPage rootService={rootService} />);

    await user.click(screen.getByRole('button', {name: 'Add root'}));
    await act(async () => rootService.resolve('C:\\Projects'));
    expect(await screen.findByText('C:\\Projects')).toBeVisible();

    await user.click(screen.getByRole('button', {name: 'Pause C:\\Projects'}));
    expect(screen.getByText('Paused')).toBeVisible();

    await user.click(screen.getByRole('button', {name: 'Remove C:\\Projects'}));
    expect(screen.getByRole('dialog', {name: 'Remove indexed root'})).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Remove root permanently'}));
    expect(screen.queryByText('C:\\Projects')).not.toBeInTheDocument();
  });

  it('rejects parent traversal in an exclusion pattern', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({
      roots: [{
        id: 'projects',
        path: 'C:\\Projects',
        paused: false,
        exclusions: [],
        includeHidden: false,
        maxFileSizeMb: 256,
        status: 'ready',
      }],
    });
    renderWithProviders(<IndexedRootsPage />);

    await user.type(screen.getByRole('textbox', {name: 'Exclusion pattern for C:\\Projects'}), '..\\Secrets');
    await user.click(screen.getByRole('button', {name: 'Add exclusion for C:\\Projects'}));

    expect(screen.getByRole('alert')).toHaveTextContent('relative to this root');
  });

  it('reports native synchronization failures after an indexed root changes', async () => {
    const user = userEvent.setup();
    Reflect.defineProperty(window, '__TAURI_INTERNALS__', {configurable: true, value: {}});
    vi.spyOn(nativeAiService, 'indexStatus').mockResolvedValue({
      phase: 'ready',
      indexedItems: 1,
      generation: 1,
      pendingItems: 0,
      queuedEnrichment: 0,
      skippedItems: 0,
      message: 'Index ready.',
    });
    vi.spyOn(nativeAiService, 'synchronizeRoots').mockRejectedValue(new Error('native index offline'));
    const setRoots = vi.fn(async () => true);
    useSettingsStore.setState({
      roots: [{
        id: 'projects',
        path: 'C:\\Projects',
        paused: false,
        exclusions: [],
        includeHidden: false,
        maxFileSizeMb: 256,
        status: 'ready',
      }],
      setRoots,
    });
    renderWithProviders(<IndexedRootsPage />);

    await user.click(screen.getByRole('button', {name: 'Pause C:\\Projects'}));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Index synchronization failed: native index offline',
    );
    expect(setRoots).toHaveBeenCalledOnce();
    expect(nativeAiService.synchronizeRoots).toHaveBeenCalledWith([]);
  });

  it('shows only ranking controls that affect production search', () => {
    renderWithProviders(<SearchPage />);

    expect(screen.getByRole('slider', {name: 'Filename priority'})).toBeEnabled();
    expect(screen.getByLabelText('Recency preference')).toBeEnabled();
    expect(screen.queryByRole('switch', {name: 'Semantic search'})).not.toBeInTheDocument();
    expect(screen.getByRole('switch', {name: 'Reranking'})).toBeEnabled();
    expect(screen.getByRole('switch', {name: 'Pinned items'})).toBeEnabled();
  });

  it('enables native semantic, reranking, Recent, and Related controls only when available', async () => {
    const semanticService = {
      status: vi.fn(async () => ({
        vectorAvailable: true,
        semanticAvailable: true,
        relatedAvailable: true,
        indexedChunks: 42,
        pendingJobs: 0,
        reason: null,
      })),
    };
    renderWithProviders(<SearchPage semanticService={semanticService} />);

    expect(await screen.findByRole('switch', {name: 'Semantic search'})).toBeEnabled();
    expect(screen.getByRole('switch', {name: 'Reranking'})).toBeEnabled();
    expect(screen.getByRole('switch', {name: 'Pinned items'})).toBeEnabled();
    expect(screen.getByRole('checkbox', {name: 'Recent'})).toBeEnabled();
    expect(screen.getByRole('checkbox', {name: 'Related'})).toBeEnabled();
    expect(screen.getByText('42 embedded chunks')).toBeVisible();
  });

  it('records Computer Use cloud consent separately from answer consent', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ComputerUsePage />);

    await user.click(screen.getByRole('button', {name: 'Review Computer Use consent'}));
    await user.click(screen.getByRole('button', {name: 'Allow Computer Use'}));

    expect(useSettingsStore.getState().computerUse.cloudConsent).toBe(true);
    expect(useSettingsStore.getState().ai.cloudAnswerConsent).toBe(false);
    expect(screen.getByText('Consent granted')).toBeVisible();
  });

  it('rejects embedded credentials in a Computer Use start page', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ComputerUsePage />);

    const startPage = screen.getByRole('textbox', {name: 'Computer Use start page'});
    await user.clear(startPage);
    await user.type(startPage, 'https://user:secret@example.com');
    await user.click(screen.getByRole('button', {name: 'Save'}));

    expect(screen.getByText('The start page must be an absolute HTTP or HTTPS URL.')).toBeVisible();
    expect(useSettingsStore.getState().computerUse.initialUrl).toBe('https://www.google.com');
  });

  it('reflects a Computer Use start page loaded after the page mounts', () => {
    renderWithProviders(<ComputerUsePage />);

    act(() => useSettingsStore.setState((state) => ({
      computerUse: {...state.computerUse, initialUrl: 'https://intranet.example.com/start'},
    })));

    expect(screen.getByRole('textbox', {name: 'Computer Use start page'})).toHaveValue(
      'https://intranet.example.com/start',
    );
  });
});
