import {render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';

import {AppProviders} from '../../../app/AppProviders';
import type {ProvidersService} from '../../../services/providers/providers-service';
import {buildSections, ProvidersPage} from './ProvidersPage';

function stubService(overrides: Partial<ProvidersService> = {}): ProvidersService {
  return {
    health: vi.fn(async () => true),
    getConfig: vi.fn(async () => ({})),
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

  it('keeps switch actions disabled until Task 6 provider dialogs land', () => {
    renderPage();

    expect(screen.getByRole('button', {name: 'Switch claude'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Add opencode'})).toBeDisabled();
  });

  it('reports sidecar failures through a callout', async () => {
    renderPage(stubService({health: vi.fn(async () => { throw 'sidecar offline'; })}));

    expect(await screen.findByRole('alert')).toHaveTextContent('sidecar offline');
  });
});
