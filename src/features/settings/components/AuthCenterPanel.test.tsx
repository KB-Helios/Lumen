import {act, render, screen, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';

import {AuthCenterPanel, type AuthCenterApi} from './AuthCenterPanel';

function stubApi() {
  return {
    oauthLinked: vi.fn<AuthCenterApi['oauthLinked']>(async () => false),
    oauthAuthUrl: vi.fn(async () => ({
      url: 'https://example.com/oauth/authorize',
      state: 'state-123',
      userCode: 'ABCD-1234',
    })),
    oauthPoll: vi.fn(async () => ({done: false})),
    oauthCancel: vi.fn(async () => true),
    importToken: vi.fn(async () => undefined),
  };
}

describe('auth center', () => {
  it('hides secret after save', async () => {
    const user = userEvent.setup();
    const api = stubApi();
    render(<AuthCenterPanel api={api} />);

    const secret = 'sk-secret-xyz-123';
    const tokenField = screen.getByLabelText('Access token for ChatGPT');
    await user.type(tokenField, secret);
    await user.click(screen.getByRole('button', {name: 'Save ChatGPT token'}));

    expect(api.importToken).toHaveBeenCalledWith('codex', secret);
    expect(tokenField).toHaveValue('');
    expect(screen.queryByText(secret)).toBeNull();
    expect(screen.queryByDisplayValue(secret)).toBeNull();
  });

  it('starts OAuth and cancels the session', async () => {
    const user = userEvent.setup();
    const api = stubApi();
    render(<AuthCenterPanel api={api} />);

    await user.click(screen.getByRole('button', {name: 'Sign in with ChatGPT'}));

    expect(api.oauthAuthUrl).toHaveBeenCalledWith('codex');
    expect(await screen.findByRole('link', {name: 'Open authorization page'})).toHaveAttribute(
      'href',
      'https://example.com/oauth/authorize',
    );
    expect(screen.getByText('ABCD-1234')).toBeVisible();

    await user.click(screen.getByRole('button', {name: 'Cancel sign-in'}));
    expect(api.oauthCancel).toHaveBeenCalledWith('state-123');
    expect(screen.queryByRole('link', {name: 'Open authorization page'})).toBeNull();
  });

  it('marks the provider signed in once polling completes', async () => {
    const user = userEvent.setup();
    const api = stubApi();
    api.oauthPoll.mockResolvedValue({done: true});
    render(<AuthCenterPanel api={api} pollIntervalMs={5} />);

    await user.click(screen.getByRole('button', {name: 'Sign in with ChatGPT'}));

    expect(await screen.findByText('Signed in')).toBeVisible();
    expect(api.oauthPoll).toHaveBeenCalledWith('state-123');
  });

  it('releases confirmed-absent sessions and permits a fresh sign-in after repeated false acknowledgements', async () => {
    const user = userEvent.setup();
    const api = stubApi();
    let phase: 'initial' | 'confirmed-absent' = 'initial';
    api.oauthCancel.mockImplementation(async () => {
      phase = 'confirmed-absent';
      return false;
    });
    api.oauthLinked.mockImplementation(async (provider) => provider === 'codex' && phase === 'confirmed-absent');
    api.oauthAuthUrl
      .mockResolvedValueOnce({url: 'https://example.com/oauth/first', state: 'state-123', userCode: 'FIRST'})
      .mockResolvedValueOnce({url: 'https://example.com/oauth/second', state: 'state-456', userCode: 'SECOND'});
    render(<AuthCenterPanel api={api} />);

    const chatgpt = within(screen.getByRole('button', {name: 'Sign in with ChatGPT'}).closest<HTMLElement>('.min-h-16')!);
    await user.click(screen.getByRole('button', {name: 'Sign in with ChatGPT'}));
    await user.click(screen.getByRole('button', {name: 'Cancel sign-in'}));

    expect(await screen.findByRole('button', {name: 'Sign in with ChatGPT'})).toBeVisible();
    expect(await chatgpt.findByText('Signed in')).toBeVisible();
    expect(screen.getAllByText('Not linked')).toHaveLength(2);
    expect(api.oauthLinked.mock.calls.filter(([linkedProvider]) => linkedProvider === 'codex')).toHaveLength(2);
    expect(api.oauthCancel).toHaveBeenNthCalledWith(1, 'state-123');

    await user.click(screen.getByRole('button', {name: 'Sign in with ChatGPT'}));
    expect(await screen.findByRole('link', {name: 'Open authorization page'})).toHaveAttribute(
      'href',
      'https://example.com/oauth/second',
    );
    await user.click(screen.getByRole('button', {name: 'Cancel sign-in'}));

    expect(await screen.findByRole('button', {name: 'Sign in with ChatGPT'})).toBeVisible();
    expect(chatgpt.getByText('Signed in')).toBeVisible();
    expect(api.oauthCancel).toHaveBeenNthCalledWith(2, 'state-456');
    expect(api.oauthCancel).toHaveBeenCalledTimes(2);
    expect(api.oauthAuthUrl).toHaveBeenCalledTimes(2);
  });

  it('retains unconfirmed cancellation ownership for retry', async () => {
    const user = userEvent.setup();
    const api = stubApi();
    api.oauthCancel.mockRejectedValueOnce(new Error('Cancel request failed'));
    render(<AuthCenterPanel api={api} />);

    await user.click(screen.getByRole('button', {name: 'Sign in with ChatGPT'}));
    await user.click(screen.getByRole('button', {name: 'Cancel sign-in'}));

    expect(await screen.findByRole('alert')).toHaveTextContent('Cancel request failed');
    expect(screen.getByRole('link', {name: 'Open authorization page'})).toBeVisible();
    expect(screen.queryByRole('button', {name: 'Sign in with ChatGPT'})).toBeNull();

    await user.click(screen.getByRole('button', {name: 'Cancel sign-in'}));
    expect(api.oauthCancel).toHaveBeenNthCalledWith(2, 'state-123');
    expect(screen.queryByRole('link', {name: 'Open authorization page'})).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores a pending poll after cancellation is requested', async () => {
    const user = userEvent.setup();
    const api = stubApi();
    let resolvePoll!: (value: {done: boolean}) => void;
    let resolveCancel!: (value: boolean) => void;
    api.oauthPoll.mockImplementation(() => new Promise((resolve) => { resolvePoll = resolve; }));
    api.oauthCancel.mockImplementation(() => new Promise((resolve) => { resolveCancel = resolve; }));
    render(<AuthCenterPanel api={api} pollIntervalMs={5} />);
    await user.click(screen.getByRole('button', {name: 'Sign in with ChatGPT'}));
    await vi.waitFor(() => expect(api.oauthPoll).toHaveBeenCalled());
    await user.click(screen.getByRole('button', {name: 'Cancel sign-in'}));
    await act(async () => { resolvePoll({done: true}); });

    expect(screen.queryByText('Signed in')).toBeNull();
    expect(screen.getByRole('button', {name: 'Cancel sign-in'})).toBeDisabled();
    await act(async () => { resolveCancel(false); });
    expect(screen.getByRole('button', {name: 'Sign in with ChatGPT'})).toBeEnabled();
    expect(screen.queryByText('Signed in')).toBeNull();
  });

  it('reports status as a boolean and never renders secrets', async () => {
    const api = stubApi();
    api.oauthLinked.mockImplementation(async (...args: unknown[]) => args[0] === 'xai');
    render(<AuthCenterPanel api={api} />);

    expect(await screen.findByText('Signed in')).toBeVisible();
    expect(screen.getAllByText('Not linked')).toHaveLength(2);
    expect(document.body.textContent).not.toContain('sk-');
  });
});
