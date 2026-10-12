import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';
import {AddProviderDialog} from './AddProviderDialog';
import {EditProviderDialog} from './EditProviderDialog';
import type {ProviderProfile, ProviderProfileInput} from '../../../services/providers/providers.types';

const profile: ProviderProfile = {app: 'codex', id: 'fixture', baseUrl: 'https://example.com', model: 'model', active: false, enabled: false};

describe('provider dialogs', () => {
  it('marks unsupported tools unavailable and requires an API key even for an OAuth preset', async () => {
    const user = userEvent.setup();
    render(<AddProviderDialog api={{add: vi.fn()}} />);
    await user.click(screen.getByRole('button', {name: 'Add provider'}));
    expect(screen.getByRole('button', {name: 'Use Grok CLI'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Use OpenAI Codex'}));
    expect(screen.getByRole('textbox', {name: 'Base URL'})).toHaveValue('https://api.openai.com/v1');
    expect(screen.getByRole('button', {name: 'Add'})).toBeDisabled();
    await user.type(screen.getByRole('textbox', {name: 'Model'}), 'test');
    expect(screen.getByRole('button', {name: 'Add'})).toBeDisabled();
  });

  it('keeps failed saves open, clears the entered secret, and permits a retry', async () => {
    const user = userEvent.setup();
    let saved: ProviderProfileInput | undefined;
    let fail = true;
    render(<EditProviderDialog provider={profile} api={{update: async (input) => {
      if (fail) { fail = false; throw new Error('Save failed'); }
      saved = input; return profile;
    }}} />);
    await user.click(screen.getByRole('button', {name: 'Edit provider'}));
    await user.type(screen.getByLabelText('API key', {exact: true}), 'temporary-secret');
    await user.click(screen.getByRole('button', {name: 'Save'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed');
    expect(screen.getByLabelText('API key', {exact: true})).toHaveValue('');
    await user.click(screen.getByRole('button', {name: 'Save'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(saved).toMatchObject({app: 'codex', id: 'fixture', apiKey: undefined});
  });

  it('does not allow dismissal or duplicate saves while a write is pending', async () => {
    const user = userEvent.setup();
    let finish!: (value: ProviderProfile) => void;
    let writes = 0;
    render(<EditProviderDialog provider={profile} api={{update: () => { writes++; return new Promise((resolve) => { finish = resolve; }); }}} />);
    await user.click(screen.getByRole('button', {name: 'Edit provider'}));
    await user.dblClick(screen.getByRole('button', {name: 'Save'}));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByRole('button', {name: 'Cancel'})).toBeDisabled();
    expect(writes).toBe(1);
    await act(async () => { finish(profile); });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
