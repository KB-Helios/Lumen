import {act, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AppProviders} from '../../app/AppProviders';
import {windowsAiService} from '../../services/windows-ai';
import {UnavailableWindowsAiService} from '../../services/windows-ai/unavailable-windows-ai-service';
import type {WindowsAiOperationResult} from '../../services/windows-ai/windows-ai.types';
import {WindowsAppContentControls} from './WindowsAiControls';
import {useWindowsAiStore} from './windows-ai.store';

afterEach(() => useWindowsAiStore.setState({snapshot: null, hydrated: false, busy: false, message: ''}));

async function renderContentControls() {
  const unavailable = await new UnavailableWindowsAiService().status();
  const snapshot = {...unavailable, host: {...unavailable.host, packageIdentity: true}};
  vi.spyOn(windowsAiService, 'status').mockResolvedValue(snapshot);
  useWindowsAiStore.setState({snapshot, hydrated: true, busy: false, message: ''});
  render(<AppProviders><WindowsAppContentControls /></AppProviders>);
}

describe('Windows public help deletion confirmation', () => {
  it.each(['failed result', 'rejected request'] as const)('keeps a %s pending and retryable until deletion succeeds', async (failure) => {
    let resolve!: (result: WindowsAiOperationResult) => void;
    let reject!: (error: Error) => void;
    const deletion = vi.spyOn(windowsAiService, 'deleteContent')
      .mockImplementationOnce(() => new Promise((complete, fail) => {resolve = complete; reject = fail;}))
      .mockResolvedValueOnce({ok: true, message: 'Help index deleted.'});
    await renderContentControls();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', {name: 'Delete help index'}));
    const dialog = screen.getByRole('dialog', {name: 'Delete the public help index?'});
    const confirm = within(dialog).getByRole('button', {name: 'Delete help index'});
    await user.click(confirm);
    expect(dialog).toBeVisible();
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole('button', {name: 'Cancel'})).toBeDisabled();
    await user.click(confirm);
    expect(deletion).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (failure === 'failed result') resolve({ok: false, message: 'Help deletion unavailable.'});
      else reject(new Error('Help deletion unavailable.'));
    });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/Try again/);
    expect(useWindowsAiStore.getState().message).toBe('Help deletion unavailable.');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Delete the public help index?'})).not.toBeInTheDocument());
    expect(deletion).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Help index deleted.')).toBeVisible();
  });

  it('retains confirmation when another operation owns the store, then permits retry', async () => {
    const deletion = vi.spyOn(windowsAiService, 'deleteContent').mockResolvedValue({ok: true, message: 'Help index deleted.'});
    await renderContentControls();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', {name: 'Delete help index'}));
    const dialog = screen.getByRole('dialog', {name: 'Delete the public help index?'});
    const confirm = within(dialog).getByRole('button', {name: 'Delete help index'});
    act(() => useWindowsAiStore.setState({busy: true}));
    await user.click(confirm);
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/Try again/);
    expect(deletion).not.toHaveBeenCalled();
    act(() => useWindowsAiStore.setState({busy: false}));
    await user.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Delete the public help index?'})).not.toBeInTheDocument());
    expect(deletion).toHaveBeenCalledTimes(1);
  });
});
