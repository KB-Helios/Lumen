import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it} from 'vitest';

import {AppProviders} from '../../app/AppProviders';
import {VisualStateGallery} from './VisualStateGallery';
import {galleryScenarios} from './scenarios';
import {requiredScenarioIds} from './gallery.types';
import {settingsPageIds} from '../settings/settings.schema';
import {settingsPages} from '../settings/SettingsNav';

const finalLauncherScenarioIds = [
  'ai-waiting',
  'ai-streaming',
  'ai-complete',
  'ai-failure-local-results',
  'empty-local-with-answer',
  'computer-use-approval',
  'constrained-work-area',
] as const;

describe('VisualStateGallery', () => {
  it.each([
    ['computer-use-unavailable', 'Setup required', 'Simulated native executor unavailable.'],
    ['computer-use-denied', 'Stopped', 'Simulated session denied'],
    ['computer-use-target-lost', 'Unavailable', 'Simulated selected window was lost; select a fresh target.'],
    ['computer-use-cancelled', 'Stopped', 'Simulated session cancelled'],
    ['computer-use-error', 'Unavailable', 'Simulated executor error; the session stopped.'],
  ])('renders the actual simulated %s state without an approval prompt', async (id, status, detail) => {
    window.history.replaceState({}, '', `/?gallery=1&scenario=${id}&capture=1`);
    render(<AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}><VisualStateGallery /></AppProviders>);
    expect(await screen.findByRole('status', {name: status})).toBeVisible();
    expect(screen.getByText(detail)).toBeVisible();
    expect(screen.getByText(/This preview simulates progress and approvals/)).toBeVisible();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    if (id === 'computer-use-unavailable') expect(screen.getByRole('button', {name: 'Run in Edge'})).toBeDisabled();
  });

  it.each([
    ['providers-populated', 'simulated-long-profile-name-for-responsive-layout'],
    ['providers-empty', 'No saved profiles'],
    ['providers-error', 'Simulated profile load failed. Retry remains available.'],
    ['providers-unavailable', 'Sidecar unavailable'],
  ])('renders the production provider %s state with its simulated boundary', async (id, detail) => {
    window.history.replaceState({}, '', `/?gallery=1&scenario=${id}&capture=1`);
    render(<AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}><VisualStateGallery /></AppProviders>);
    const matching = await screen.findAllByText(detail);
    await waitFor(() => expect(matching[0]).toBeVisible());
    expect(screen.getByText(/No credentials or tool configuration are accessed/)).toBeVisible();
  });

  it('covers every full settings shell and every actual onboarding scene', () => {
    expect(galleryScenarios.filter((item) => item.surface.kind === 'settings-shell').map((item) => item.surface.kind === 'settings-shell' ? item.surface.page : null)).toEqual([...settingsPageIds]);
    expect(galleryScenarios.filter((item) => item.surface.kind === 'onboarding').map((item) => item.surface.kind === 'onboarding' ? item.surface.step : null)).toEqual([0, 1, 2, 3]);
    for (const id of ['providers-populated', 'providers-empty', 'providers-error', 'providers-unavailable', 'providers-add', 'providers-edit', 'providers-remove', 'ai-cancelled', 'ai-retry', 'local-runtime-provisioning', 'local-runtime-error', 'local-runtime-cancelled', 'computer-use-unavailable', 'computer-use-denied', 'computer-use-target-lost', 'computer-use-cancelled', 'computer-use-error']) {
      expect(galleryScenarios.map((item) => item.id)).toContain(id);
    }
  });

  it.each(settingsPages)('renders the production $label shell for its own scenario', async ({id, label}) => {
    window.history.replaceState({}, '', `/?gallery=1&scenario=settings-${id}&capture=1`);
    render(<AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}><VisualStateGallery /></AppProviders>);
    expect(await screen.findByRole('tabpanel', {name: label})).toBeVisible();
    await waitFor(() => expect(screen.getByRole('heading', {name: label})).toBeVisible());
  });

  it('keeps the simulated provider edit dialog and restores its production trigger focus', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/?gallery=1&scenario=providers-edit&capture=1');
    render(<AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}><VisualStateGallery /></AppProviders>);
    expect(await screen.findByRole('dialog')).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', {name: /^Edit simulated-long/})).toHaveFocus());
    expect(screen.getByText(/Simulated development fixture/)).toBeVisible();
  });

  it('cancels simulated provisioning through the production Cancel action', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/?gallery=1&scenario=local-runtime-provisioning&capture=1');
    render(<AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}><VisualStateGallery /></AppProviders>);
    await user.click(await screen.findByRole('button', {name: 'Cancel local core download'}));
    expect(await screen.findByRole('button', {name: 'Download local core'})).toBeEnabled();
    expect(screen.queryByRole('button', {name: 'Cancel local core download'})).not.toBeInTheDocument();
  });

  it.each(['error', 'cancelled'])('renders the simulated local runtime %s state with a usable retry download', async (state) => {
    window.history.replaceState({}, '', `/?gallery=1&scenario=local-runtime-${state}&capture=1`);
    render(<AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}><VisualStateGallery /></AppProviders>);
    expect(await screen.findByRole('button', {name: 'Download local core'})).toBeEnabled();
    expect(screen.getByText(`Simulated development provisioning ${state}.`)).toBeVisible();
    expect(screen.getByText(/No download or native runtime request runs/)).toBeVisible();
  });

  it('retains the simulated cancelled answer with a reachable Retry action', async () => {
    window.history.replaceState({}, '', '/?gallery=1&scenario=ai-cancelled&capture=1');
    render(<AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}><VisualStateGallery /></AppProviders>);
    expect(await screen.findByRole('button', {name: 'Retry answer'})).toBeEnabled();
    expect(screen.getByTestId('answer-region')).toHaveTextContent('Simulated partial answer retained after cancellation.');
  });

  it('retries the simulated failed answer without replacing its stable region', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/?gallery=1&scenario=ai-retry&capture=1');
    render(<AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}><VisualStateGallery /></AppProviders>);
    const region = await screen.findByTestId('answer-region');
    await user.click(screen.getByRole('button', {name: 'Retry answer'}));
    expect(screen.getByTestId('answer-region')).toBe(region);
    expect(screen.getByRole('button', {name: 'Stop answer'})).toBeVisible();
  });

  it('contains every required deterministic scenario exactly once', () => {
    expect(new Set(galleryScenarios.map((item) => item.id))).toEqual(new Set(requiredScenarioIds));
    expect(galleryScenarios).toHaveLength(requiredScenarioIds.length);
  });

  it('includes deterministic states for answer lifecycle, approval, and constrained layout', () => {
    const ids = new Set(galleryScenarios.map((item) => item.id));

    for (const id of finalLauncherScenarioIds) {
      expect(ids).toContain(id);
    }
  });

  it('renders the focused collapsed launcher only for its focused scenario', () => {
    window.history.replaceState({}, '', '/?gallery=1&scenario=collapsed-idle&capture=1');
    const idle = render(
      <AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}>
        <VisualStateGallery />
      </AppProviders>,
    );

    expect(screen.getByRole('searchbox', {name: 'Search files'})).not.toHaveFocus();
    idle.unmount();

    window.history.replaceState({}, '', '/?gallery=1&scenario=collapsed-focused&capture=1');
    render(
      <AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}>
        <VisualStateGallery />
      </AppProviders>,
    );

    expect(screen.getByRole('searchbox', {name: 'Search files'})).toHaveFocus();
  });

  it('renders grouped results from a distinct deterministic fixture', async () => {
    window.history.replaceState({}, '', '/?gallery=1&scenario=expanded-results&capture=1');
    const expanded = render(
      <AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}>
        <VisualStateGallery />
      </AppProviders>,
    );

    await waitFor(() => expect(screen.getByRole('grid', {name: 'Search results'})).toHaveAttribute('aria-rowcount', '6'));
    expanded.unmount();

    window.history.replaceState({}, '', '/?gallery=1&scenario=grouped-results&capture=1');
    render(
      <AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}>
        <VisualStateGallery />
      </AppProviders>,
    );

    await waitFor(() => expect(screen.getByRole('grid', {name: 'Search results'})).toHaveAttribute('aria-rowcount', '3'));
  });

  it('renders production activity state inside the gallery surface', () => {
    window.history.replaceState({}, '', '/?gallery=1&scenario=activity-gaming');
    render(
      <AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}>
        <VisualStateGallery />
      </AppProviders>,
    );

    expect(screen.getByRole('region', {name: 'Lumen visual state gallery'})).toHaveAttribute('data-gallery-scenario', 'activity-gaming');
    expect(screen.getByTestId('activity-gaming')).toBeVisible();
  });

  it('stops the deterministic streaming answer when the gallery control is clicked', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/?gallery=1&scenario=ai-streaming&capture=1');
    render(
      <AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}>
        <VisualStateGallery />
      </AppProviders>,
    );

    await user.click(await screen.findByRole('button', {name: 'Stop answer'}));

    expect(screen.getByText('Stopped')).toBeVisible();
    expect(screen.queryByRole('button', {name: 'Stop answer'})).not.toBeInTheDocument();
  });

  it('applies deterministic approve and deny transitions without leaving the gallery seam', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/?gallery=1&scenario=computer-use-approval&capture=1');
    const approved = render(
      <AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}>
        <VisualStateGallery />
      </AppProviders>,
    );

    await user.click(await screen.findByRole('button', {name: 'Approve once'}));
    expect(screen.getByRole('status', {name: 'Working'})).toBeVisible();
    expect(screen.getByText('Approved once in the deterministic gallery session')).toBeVisible();
    expect(screen.queryByRole('alertdialog', {name: 'Approve Computer Use action'})).not.toBeInTheDocument();
    approved.unmount();

    const denied = render(
      <AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}>
        <VisualStateGallery />
      </AppProviders>,
    );
    await user.click(await screen.findByRole('button', {name: 'Deny and stop'}));
    expect(screen.getByRole('status', {name: 'Stopped'})).toBeVisible();
    expect(screen.getByText('Denied and stopped in the deterministic gallery session')).toBeVisible();
    denied.unmount();
  });

  it('exposes each registry category on its scenario option for evidence generators', () => {
    window.history.replaceState({}, '', '/?gallery=1&scenario=computer-use-approval');
    render(
      <AppProviders appearance={{mode: 'dark', transparency: 'native', effects: 'full', motion: 'reduced'}}>
        <VisualStateGallery />
      </AppProviders>,
    );

    expect(screen.getByRole('option', {name: 'Computer Use approval'})).toHaveAttribute('data-category', 'Computer Use');
    expect(screen.getByRole('option', {name: 'AI failure with local results'})).toHaveAttribute('data-category', 'Resilience');
  });
});
