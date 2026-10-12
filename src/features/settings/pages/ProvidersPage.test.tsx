import {act, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';

import {AppProviders} from '../../../app/AppProviders';
import type {ProvidersService} from '../../../services/providers/providers-service';
import {buildSections, ProvidersPage} from './ProvidersPage';
import type {ProviderProfile} from '../../../services/providers/providers.types';

function stubService(overrides: Partial<ProvidersService> = {}): ProvidersService {
  return {
    health: vi.fn(async () => true),
    getConfig: vi.fn(async () => ({})),
    list: vi.fn(async () => []),
    add: vi.fn(),
    update: vi.fn(),
    activate: vi.fn(),
    switchProvider: vi.fn(async () => []),
    removeFromLive: vi.fn(async () => false),
    ...overrides,
  };
}

function renderPage(service: ProvidersService = stubService()) {
  return render(
    <AppProviders appearance={{mode: 'dark', transparency: 'disabled', effects: 'reduced', motion: 'reduced'}}>
      <ProvidersPage nativeRuntime providersService={service} />
    </AppProviders>,
  );
}

describe('providers page', () => {
  it('groups switch vs additive', () => {
    expect(buildSections([])).toEqual({switchApps: [], additiveApps: []});
  });

  it('splits exclusive switch apps from additive apps', () => {
    expect(buildSections(['claude', 'codex', 'gemini', 'opencode', 'openclaw', 'unknown'])).toEqual({
      switchApps: ['claude', 'codex', 'gemini'],
      additiveApps: ['opencode', 'openclaw', 'unknown'],
    });
  });

  it('renders switch and additive sections with a provider list', async () => {
    renderPage();

    expect(screen.getByTestId('provider-list')).toBeVisible();
    expect(screen.getByRole('region', {name: 'Switch'})).toBeVisible();
    expect(screen.getByRole('region', {name: 'Additive'})).toBeVisible();
    expect(await screen.findByText('Sidecar ready')).toBeVisible();
  });

  it('finishes checking when native provider management is unavailable', () => {
    render(<ProvidersPage nativeRuntime={false} />);
    expect(screen.getByText('Sidecar unavailable')).toBeVisible();
    expect(screen.queryByText('Checking sidecar')).not.toBeInTheDocument();
  });

  it('reports sidecar failures through a callout', async () => {
    renderPage(stubService({health: vi.fn(async () => { throw 'sidecar offline'; })}));

    expect(await screen.findByText('sidecar offline')).toBeVisible();
  });

  it('activates and removes each of the five saved target profiles', async () => {
    const user = userEvent.setup();
    let profiles: ProviderProfile[] = (['claude', 'codex', 'gemini', 'opencode', 'openclaw'] as const).map((app) => ({app, id: `${app}-fixture`, baseUrl: 'https://fixture.example', model: 'fixture', active: false, enabled: false}));
    const service = stubService({
      list: async () => profiles,
      activate: async (app, id) => {
        profiles = profiles.map((profile) => profile.app === app && profile.id === id ? {...profile, active: true, enabled: true} : profile);
        return profiles.find((profile) => profile.id === id)!;
      },
      removeFromLive: async (_app, id) => {
        profiles = profiles.map((profile) => profile.id === id ? {...profile, active: false, enabled: false} : profile);
        return true;
      },
    });
    renderPage(service);
    for (const app of ['claude', 'codex', 'gemini', 'opencode', 'openclaw']) {
      const action = app === 'opencode' || app === 'openclaw' ? 'Enable' : 'Switch';
      const button = await screen.findByRole('button', {name: `${action} ${app}-fixture`});
      await waitFor(() => expect(button).toBeEnabled());
      await user.click(button);
      expect(await screen.findByText('Active')).toBeVisible();
      const remove = screen.getByRole('button', {name: `Remove ${app}-fixture from live`});
      await waitFor(() => expect(remove).toBeEnabled());
      await user.click(remove);
      await user.click(within(screen.getByRole('dialog')).getByRole('button', {name: 'Remove from live'}));
      await waitFor(() => expect(screen.queryByText('Active')).not.toBeInTheDocument());
      expect(screen.getByText(`${app}-fixture`)).toBeVisible();
    }
  });

  it('prevents duplicate activation and shows a retryable error without changing active state', async () => {
    const user = userEvent.setup();
    let fail!: (error: Error) => void;
    let writes = 0;
    renderPage(stubService({list: async () => [{app: 'claude', id: 'fixture', baseUrl: 'https://fixture.example', model: 'fixture', active: false, enabled: false}], activate: () => {
      writes++; return new Promise((_resolve, reject) => { fail = reject; });
    }}));
    const button = await screen.findByRole('button', {name: 'Switch fixture'});
    await waitFor(() => expect(button).toBeEnabled());
    await user.dblClick(button);
    expect(button).toBeDisabled(); expect(writes).toBe(1);
    await act(async () => { fail(new Error('Provider activation failed')); });
    expect(await screen.findByText('Provider activation failed')).toBeVisible();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it('ignores a stale list response after changing services', async () => {
    let finish!: (profiles: ProviderProfile[]) => void;
    const oldService = stubService({list: () => new Promise((resolve) => { finish = resolve; })});
    const nextService = stubService({list: async () => [{app: 'claude', id: 'new-profile', baseUrl: 'https://fixture.example', model: 'fixture', active: false, enabled: false}]});
    const view = render(<ProvidersPage nativeRuntime providersService={oldService} />);
    view.rerender(<ProvidersPage nativeRuntime providersService={nextService} />);
    expect(await screen.findByText('new-profile')).toBeVisible();
    await act(async () => { finish([{app: 'claude', id: 'old-profile', baseUrl: 'https://fixture.example', model: 'fixture', active: false, enabled: false}]); });
    expect(screen.queryByText('old-profile')).not.toBeInTheDocument();
    expect(screen.getByText('new-profile')).toBeVisible();
  });
});
