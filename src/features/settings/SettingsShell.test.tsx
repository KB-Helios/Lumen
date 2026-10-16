import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {App} from '../../app/App';
import {AppProviders} from '../../app/AppProviders';
import {LumenMotionProvider} from '../../design-system/MotionProvider';
import {galleryAuthApi, galleryProvidersService, galleryUsageApi} from '../gallery/workflow-fixtures';
import {ProvidersPage} from './pages/ProvidersPage';
import {SettingsShell} from './SettingsShell';
import {useSettingsStore} from './settings.store';

function renderShell(onClose = vi.fn()) {
  return render(
    <LumenMotionProvider reducedMotion>
      <SettingsShell onClose={onClose} />
    </LumenMotionProvider>,
  );
}

afterEach(() => {
  useSettingsStore.getState().reset();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe('SettingsShell', () => {
  it('reveals a restored provider trigger without applying the content policy to portals or navigation', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({activePage: 'providers', hydrated: true});
    render(
      <AppProviders appearance={{mode: 'dark', transparency: 'disabled', effects: 'reduced', motion: 'reduced'}}>
        <SettingsShell onClose={vi.fn()} pages={{providers: <ProvidersPage
          nativeRuntime providersService={galleryProvidersService('populated')}
          authApi={galleryAuthApi} usageApi={galleryUsageApi}
        />}} />
      </AppProviders>,
    );
    const trigger = await screen.findByRole('button', {name: 'Edit simulated-long-profile-name-for-responsive-layout'});
    await waitFor(() => expect(trigger).toBeEnabled());
    const reveal = vi.fn();
    Object.defineProperty(trigger, 'scrollIntoView', {value: reveal});
    const navigation = screen.getByRole('tab', {name: 'Providers'});
    const revealNavigation = vi.fn();
    Object.defineProperty(navigation, 'scrollIntoView', {value: revealNavigation});
    await user.click(trigger);
    const dialog = screen.getByRole('dialog');
    const save = within(dialog).getByRole('button', {name: 'Save'});
    const revealModal = vi.fn();
    Object.defineProperty(save, 'scrollIntoView', {value: revealModal});
    reveal.mockClear();
    save.focus();
    expect(save).toHaveFocus();
    expect(revealModal).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger.isConnected).toBe(true);
    expect(reveal).toHaveBeenCalledWith({block: 'nearest', inline: 'nearest', behavior: 'instant'});
    navigation.focus();
    expect(revealNavigation).not.toHaveBeenCalledWith({block: 'nearest', inline: 'nearest', behavior: 'instant'});
  });

  it('exposes only implemented pages in one persistent navigation rail', async () => {
    renderShell();

    const surface = screen.getByLabelText('Lumen settings');
    const header = screen.getByRole('banner');
    expect(screen.getByRole('navigation', {name: 'Settings'})).toBeVisible();
    expect(screen.getAllByRole('navigation', {name: 'Settings'})).toHaveLength(1);
    expect(screen.getByRole('main', {name: 'Settings content'})).toBeVisible();
    expect(screen.getAllByRole('main', {name: 'Settings content'})).toHaveLength(1);
    expect(screen.getAllByRole('tab')).toHaveLength(11);
    expect(screen.getByRole('tab', {name: 'Activity'})).toBeVisible();
    expect(screen.getByRole('tab', {name: 'General'})).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByRole('heading', {name: 'General'})).toBeVisible());
    expect(screen.getByTestId('settings-content')).toHaveClass('overflow-y-auto');
    expect(screen.getByTestId('settings-content')).not.toHaveAttribute('style');
    expect(header.parentElement).toBe(surface);
    expect(screen.getByRole('navigation', {name: 'Settings'}).parentElement?.parentElement?.parentElement).toBe(surface);
  });

  it('restores the operational activity route', async () => {
    useSettingsStore.setState({activePage: 'activity', hydrated: true});

    renderShell();

    expect(screen.getByRole('tab', {name: 'Activity'})).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByRole('heading', {name: 'Activity'})).toBeVisible());
  });

  it('keeps the close action visibly focusable', () => {
    renderShell();

    expect(screen.getByRole('button', {name: 'Close settings'})).toHaveAttribute(
      'data-settings-close-action',
      'true',
    );
  });

  it('changes pages with keyboard tab navigation and persists the route', async () => {
    const user = userEvent.setup();
    const view = renderShell();
    const appearance = screen.getByRole('tab', {name: 'Appearance'});

    appearance.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('heading', {name: 'Appearance'})).toBeVisible());
    expect(useSettingsStore.getState().activePage).toBe('appearance');

    view.unmount();
    renderShell();
    await waitFor(() => expect(screen.getByRole('heading', {name: 'Appearance'})).toBeVisible());
  });

  it('resets page scrolling without moving focus out of navigation', async () => {
    const user = userEvent.setup();
    renderShell();
    const content = screen.getByRole('main', {name: 'Settings content'});
    const general = screen.getByRole('tab', {name: 'General'});
    content.scrollTop = 240;
    general.focus();

    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('tab', {name: 'Appearance'})).toHaveFocus();
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(screen.getByRole('tabpanel', {name: 'Appearance'})).toBeVisible();
    expect(content.scrollTop).toBe(0);
  });

  it('closes with Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderShell(onClose);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens from search with Ctrl+Comma and restores search focus on Escape', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/?service=memory');
    render(<App />);

    expect(await screen.findByRole('searchbox')).toHaveFocus();
    await user.keyboard('{Control>},{/Control}');
    expect(await screen.findByRole('navigation', {name: 'Settings'})).toBeVisible();

    await user.keyboard('{Escape}');
    expect(await screen.findByRole('searchbox')).toHaveFocus();
  });
});
