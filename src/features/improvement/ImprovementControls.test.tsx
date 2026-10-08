import {act, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AppProviders} from '../../app/AppProviders';
import {DevelopmentImprovementService} from '../../services/improvement/development-improvement-service';
import {UnavailableImprovementService} from '../../services/improvement/unavailable-improvement-service';
import {useImprovementStore} from './improvement.store';
import {ImprovementGatewayControls, ImprovementPrivacyControls} from './ImprovementControls';

afterEach(() => useImprovementStore.getState().reset());
describe('improvement management', () => {
  it('labels simulated data, disables stale approvals and supports rollback', async () => {
    const service = new DevelopmentImprovementService();
    const user = userEvent.setup();
    render(<AppProviders><ImprovementGatewayControls service={service} /></AppProviders>);
    expect(await screen.findByText(/Simulated development fixture/)).toBeVisible();
    expect(screen.getByRole('switch', {name: 'Enable continual improvement'})).not.toBeChecked();
    await user.click(screen.getByRole('switch', {name: 'Enable continual improvement'}));
    await user.click(screen.getByRole('button', {name: 'Prepare improvement runtime'}));
    await user.click(screen.getByRole('button', {name: 'Analyze improvement evidence'}));
    const review = await screen.findByRole('article', {name: 'Simulated clarification improvement'});
    await user.click(within(review).getByText('Review changes and measurements'));
    await user.click(await within(review).findByRole('button', {name: 'Approve Simulated clarification improvement'}));
    await waitFor(() => expect(screen.getByRole('button', {name: 'Approve Simulated find, answer and draft workflow'})).toBeDisabled());
    await user.click(screen.getByRole('button', {name: 'Roll back to version 0'}));
    expect(await screen.findByText('Active version 0')).toBeVisible();
  });
  it('explicit preference save is required and independent cloud consent is recorded', async () => {
    const service = new DevelopmentImprovementService();
    const user = userEvent.setup();
    render(<AppProviders><ImprovementPrivacyControls service={service} /></AppProviders>);
    await screen.findByRole('switch', {name: 'Improvement cloud consent'});
    await user.click(screen.getByRole('button', {name: /Answer language/}));
    await user.click(screen.getByRole('option', {name: 'English'}));
    expect((await service.snapshot()).activeVersion.preferences).toEqual([]);
    await user.click(screen.getByRole('button', {name: 'Save answer language preference'}));
    expect((await service.snapshot()).activeVersion.preferences).toEqual([{name: 'answerLanguage', value: 'en'}]);
    await user.click(screen.getByRole('switch', {name: 'Improvement cloud consent'}));
    expect((await service.snapshot()).settings.cloudConsent).toBe(true);
  });
  it('ordinary browser controls are honestly unavailable', async () => {
    render(<AppProviders><ImprovementGatewayControls service={new UnavailableImprovementService()} /></AppProviders>);
    expect(await screen.findByText('Improvement requires the native Windows runtime.')).toBeVisible();
    expect(screen.getByRole('switch', {name: 'Enable continual improvement'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Prepare improvement runtime'})).toBeDisabled();
  });
  it('keeps settings disabled until native settings and health finish loading', () => {
    const service = new DevelopmentImprovementService();
    vi.spyOn(service, 'health').mockReturnValue(new Promise(() => undefined));
    render(<AppProviders><ImprovementGatewayControls service={service} /></AppProviders>);
    expect(screen.getByRole('switch', {name: 'Enable continual improvement'})).toBeDisabled();
  });
  it('allows a prepared runtime to probe its model on first analysis', async () => {
    const service = new DevelopmentImprovementService();
    await service.setSettings({enabled: true, cloudConsent: false, routeMode: 'local', paused: false});
    vi.spyOn(service, 'health').mockResolvedValue({state: 'unavailable', version: '0.9.8', detail: 'Model compatibility has not been probed.', prepared: true, modelReady: false});
    render(<AppProviders><ImprovementGatewayControls service={service} /></AppProviders>);
    await waitFor(() => expect(screen.getByRole('button', {name: 'Analyze improvement evidence'})).toBeEnabled());
  });
  it('shows a stale candidate against its frozen original base, never the current active instructions', async () => {
    const service = new DevelopmentImprovementService();
    await service.setSettings({enabled: true, cloudConsent: false, routeMode: 'local', paused: false});
    await service.prepare();
    await service.analyze(() => undefined);
    await service.savePreference({name: 'answerLanguage', value: 'en'});
    const current = await service.snapshot();
    vi.spyOn(service, 'snapshot').mockResolvedValue({...current, activeVersion: {...current.activeVersion, answerInstructions: 'Current instructions must not be the old baseline'}});
    const user = userEvent.setup();
    render(<AppProviders><ImprovementGatewayControls service={service} /></AppProviders>);
    const review = await screen.findByRole('article', {name: 'Simulated clarification improvement'});
    await user.click(within(review).getByText('Review changes and measurements'));
    expect(await within(review).findByText('Comparing against version 0')).toBeVisible();
    expect(within(review).getByText(/Before:\s*\(empty\)/)).toBeVisible();
    expect(within(review).queryByText(/Current instructions must not/)).not.toBeInTheDocument();
    expect(within(review).getByRole('button', {name: 'Approve Simulated clarification improvement'})).toBeDisabled();
  });
  it('cannot approve while the base comparison is pending or unavailable', async () => {
    const service = new DevelopmentImprovementService();
    await service.setSettings({enabled: true, cloudConsent: false, routeMode: 'local', paused: false});
    await service.prepare();
    await service.analyze(() => undefined);
    let fail: ((error: Error) => void) | undefined;
    vi.spyOn(service, 'candidateBase').mockReturnValue(new Promise((_resolve, reject) => {fail = reject;}));
    const user = userEvent.setup();
    render(<AppProviders><ImprovementGatewayControls service={service} /></AppProviders>);
    const review = await screen.findByRole('article', {name: 'Simulated clarification improvement'});
    const approve = within(review).getByRole('button', {name: 'Approve Simulated clarification improvement'});
    expect(approve).toBeDisabled();
    await user.click(within(review).getByText('Review changes and measurements'));
    expect(await within(review).findByText('Loading original base comparison…')).toBeVisible();
    expect(approve).toBeDisabled();
    await act(async () => {fail!(new Error('Version data unavailable'));});
    expect(await within(review).findByText(/The original base comparison is unavailable/)).toBeVisible();
    expect(approve).toBeDisabled();
  });
});
