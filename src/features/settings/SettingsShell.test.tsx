import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {App} from '../../app/App';
import {LumenMotionProvider} from '../../design-system/MotionProvider';
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
  it('exposes only implemented pages in one persistent navigation rail', async () => {
    renderShell();

    const surface = screen.getByLabelText('Lumen settings');
    const header = screen.getByRole('banner');
    expect(screen.getByRole('navigation', {name: 'Settings'})).toBeVisible();
    expect(screen.getAllByRole('navigation', {name: 'Settings'})).toHaveLength(1);
    expect(screen.getByRole('main', {name: 'Settings content'})).toBeVisible();
    expect(screen.getAllByRole('main', {name: 'Settings content'})).toHaveLength(1);
    expect(screen.getAllByRole('tab')).toHaveLength(10);
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
