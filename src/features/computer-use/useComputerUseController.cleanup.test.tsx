import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {AppProviders} from '../../app/AppProviders';
import {TauriComputerUseService} from '../../services/computer-use/tauri-computer-use-service';
import type {ComputerUseHealth, ComputerUseRequest} from '../../services/computer-use/computer-use.types';
import {ComputerUsePanel} from './ComputerUsePanel';
import {useComputerUseController} from './useComputerUseController';

const tauri = vi.hoisted(() => ({channels: [] as Array<(payload: unknown) => void>, invoke: vi.fn()}));
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class Channel {constructor(onMessage: (payload: unknown) => void) {tauri.channels.push(onMessage);}},
  invoke: tauri.invoke,
}));

const options = {provider: 'gemini' as const, model: 'gemini-3.8-flash', openaiModel: 'gpt-6.1-sol', executionMode: 'fast' as const, initialUrl: 'https://example.com', cloudConsent: true, desktopControlConsent: false, desktopCloudConsent: false};
const health: ComputerUseHealth = {
  state: 'ready', mode: 'python', browser: 'Microsoft Edge', credentialConfigured: true,
  nativeStop: {available: true}, routes: {browser: {available: true}, desktop: {available: true}, foreground: {available: true}},
  providers: {gemini: {available: true, credentialConfigured: true, models: ['gemini-3.8-flash']}, openai: {available: true, credentialConfigured: true, models: ['gpt-6.1-sol']}},
};

function Workspace({service}: {service: TauriComputerUseService}) {
  const controller = useComputerUseController(service, options);
  return <AppProviders><ComputerUsePanel cloudConsent controller={controller} draftTask="Review form" onOpenSettings={() => undefined} onStart={() => void controller.start('Review form')} /></AppProviders>;
}

afterEach(() => {tauri.channels.length = 0; tauri.invoke.mockReset();});

describe('Computer Use stream cleanup acknowledgment', () => {
  it.each(['ipc', 'event'] as const)('preserves a rejected startup after cleanup is acknowledged by %s', async (acknowledgment) => {
    const user = userEvent.setup();
    let request: ComputerUseRequest | undefined;
    tauri.invoke.mockImplementation((command: string, args?: {request?: ComputerUseRequest}) => {
      if (command === 'computer_use_health') return Promise.resolve(health);
      if (command === 'computer_use_targets') return Promise.resolve([]);
      if (command === 'start_computer_use') {
        request = args!.request;
        return Promise.reject(new Error('Selected window is no longer available'));
      }
      if (command === 'stop_computer_use' && acknowledgment === 'event') return new Promise<void>(() => undefined);
      return Promise.resolve();
    });
    render(<Workspace service={new TauriComputerUseService()} />);
    const run = screen.getByRole('button', {name: 'Run in Edge'});
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    if (acknowledgment === 'event') {
      await waitFor(() => expect(screen.getByRole('status', {name: 'Stopping'})).toBeVisible());
      await act(async () => {tauri.channels[0]({taskId: request!.taskId, runId: 'native-run', targetId: 'edge-session', generation: 2, type: 'stopped', reason: 'stop', uncertain: false});});
    }
    await waitFor(() => expect(screen.getByRole('status', {name: 'Stopped'})).toBeVisible());
    expect(screen.getByRole('alert')).toHaveTextContent('Selected window is no longer available');
    expect(screen.getByRole('button', {name: 'Run in Edge'})).toBeEnabled();
  });

  it.each([true, false])('allows approval response %s to retry after rejected IPC', async (approved) => {
    const user = userEvent.setup();
    let request: ComputerUseRequest | undefined;
    let attempts = 0;
    tauri.invoke.mockImplementation((command: string, args?: {request?: ComputerUseRequest; approved?: boolean}) => {
      if (command === 'computer_use_health') return Promise.resolve(health);
      if (command === 'computer_use_targets') return Promise.resolve([]);
      if (command === 'start_computer_use') request = args!.request;
      if (command === 'respond_computer_use_approval') {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error('Approval IPC interrupted'));
        tauri.channels[0]({taskId: request!.taskId, runId: 'native-run', targetId: 'edge-session', generation: 1, type: 'approvalResolved', approvalId: 'approval-one', approved: args!.approved});
      }
      return Promise.resolve();
    });
    render(<Workspace service={new TauriComputerUseService()} />);
    const run = screen.getByRole('button', {name: 'Run in Edge'});
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    await act(async () => {
      tauri.channels[0]({taskId: request!.taskId, runId: 'native-run', targetId: 'edge-session', generation: 1, type: 'observation', snapshotId: 'snapshot-one'});
      tauri.channels[0]({taskId: request!.taskId, runId: 'native-run', targetId: 'edge-session', generation: 1, type: 'approvalRequired', approvalId: 'approval-one', actionId: 'action-one', snapshotId: 'snapshot-one', scope: 'safety', explanation: 'Submit?'});
    });
    const response = screen.getByRole('button', {name: approved ? 'Approve once' : 'Deny and stop'});
    await user.click(response);
    expect(screen.getByRole('alert')).toHaveTextContent('Approval IPC interrupted');
    expect(screen.getByRole('status', {name: 'Approval required'})).toBeVisible();
    await user.click(response);
    await waitFor(() => expect(screen.getByRole('status', {name: approved ? 'Working' : 'Stopped'})).toBeVisible());
    expect(attempts).toBe(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    {fault: 'malformed', retryPending: true}, {fault: 'interrupted', retryPending: true},
    {fault: 'malformed', retryPending: false}, {fault: 'interrupted', retryPending: false},
  ] as const)('recognizes native acknowledgment after $fault cleanup rejects with retryPending=$retryPending', async ({fault, retryPending}) => {
    const user = userEvent.setup();
    let request: ComputerUseRequest | undefined;
    let rejectStartup: ((error: Error) => void) | undefined;
    let stops = 0;
    tauri.invoke.mockImplementation((command: string, args?: {request?: ComputerUseRequest}) => {
      if (command === 'computer_use_health') return Promise.resolve(health);
      if (command === 'computer_use_targets') return Promise.resolve([]);
      if (command === 'start_computer_use') {
        request = args!.request;
        return new Promise<void>((_resolve, reject) => {rejectStartup = reject;});
      }
      if (command === 'stop_computer_use') {
        stops += 1;
        return stops === 1 || !retryPending ? Promise.reject(new Error('Cleanup Stop rejected')) : new Promise<void>(() => undefined);
      }
      return Promise.resolve();
    });
    render(<Workspace service={new TauriComputerUseService()} />);
    const run = screen.getByRole('button', {name: 'Run in Edge'});
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    await act(async () => {
      if (fault === 'malformed') tauri.channels[0]({type: 'invalidNativeEnvelope'});
      else rejectStartup!(new Error('Native stream interrupted'));
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Stop has not been acknowledged'));
    await user.click(screen.getByRole('button', {name: /^Stop$/}));
    await waitFor(() => expect(stops).toBe(2));
    expect(screen.getByRole('status', {name: 'Stopping'})).toBeVisible();
    await act(async () => {tauri.channels[0]({taskId: request!.taskId, runId: 'native-run', targetId: 'edge-session', generation: 2, type: 'stopped', reason: 'stop', uncertain: false});});
    await waitFor(() => expect(screen.getByRole('status', {name: 'Stopped'})).toBeVisible());
    expect(screen.getByRole('alert')).not.toBeEmptyDOMElement();
    expect(screen.getByRole('alert')).not.toHaveTextContent('Stop has not been acknowledged');
    expect(screen.getByRole('button', {name: 'Run in Edge'})).toBeEnabled();
  });

  it.each(['malformed', 'interrupted'] as const)('retains Stop and Take Over after a %s stream and rejected cleanup until a successful user retry', async (fault) => {
    const user = userEvent.setup();
    const requests: ComputerUseRequest[] = [];
    const stops: Array<{taskId: number; reason: string}> = [];
    let rejectStartup: ((error: Error) => void) | undefined;
    let acknowledgeRetry: (() => void) | undefined;
    tauri.invoke.mockImplementation((command: string, args?: {request?: ComputerUseRequest; taskId?: number; reason?: string}) => {
      if (command === 'computer_use_health') return Promise.resolve(health);
      if (command === 'computer_use_targets') return Promise.resolve([]);
      if (command === 'start_computer_use') {
        requests.push(args!.request!);
        return new Promise<void>((_resolve, reject) => {rejectStartup = reject;});
      }
      if (command === 'stop_computer_use') {
        stops.push({taskId: args!.taskId!, reason: args!.reason!});
        if (stops.length <= 2) return Promise.reject(new Error('Native Stop delivery failed'));
        return new Promise<void>((resolve) => {acknowledgeRetry = resolve;});
      }
      return Promise.resolve();
    });
    render(<Workspace service={new TauriComputerUseService()} />);
    const run = screen.getByRole('button', {name: 'Run in Edge'});
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    await act(async () => {
      if (fault === 'malformed') tauri.channels[0]({type: 'invalidNativeEnvelope'});
      else rejectStartup!(new Error('Native stream interrupted'));
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Stop has not been acknowledged'));
    await user.click(screen.getByRole('button', {name: /^Stop$/}));
    await waitFor(() => expect(stops).toHaveLength(2));
    expect(screen.getByRole('status', {name: 'Stopping'})).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Stop has not been acknowledged');
    expect(screen.getByRole('button', {name: /^Stop$/})).toBeVisible();
    expect(screen.getByRole('button', {name: 'Take Over'})).toBeVisible();
    expect(screen.queryByRole('button', {name: 'Run in Edge'})).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', {name: /^Stop$/}));
    await waitFor(() => expect(acknowledgeRetry).toBeDefined());
    expect(screen.getByRole('status', {name: 'Stopping'})).toBeVisible();
    expect(stops).toEqual(Array.from({length: 3}, () => ({taskId: requests[0].taskId, reason: 'stop'})));
    await act(async () => {acknowledgeRetry!();});
    await waitFor(() => expect(screen.getByRole('status', {name: 'Stopped'})).toBeVisible());
    expect(screen.getByRole('alert')).not.toBeEmptyDOMElement();
    expect(screen.getByRole('alert')).not.toHaveTextContent('Stop has not been acknowledged');
    expect(screen.queryByRole('button', {name: 'Take Over'})).not.toBeInTheDocument();

    tauri.channels[0]({taskId: requests[0].taskId, runId: 'late-run', targetId: 'late-target', generation: 1, type: 'started', provider: 'gemini', model: 'gemini-3.8-flash', executionMode: 'fast', browser: 'Microsoft Edge'});
    expect(screen.getByRole('status', {name: 'Stopped'})).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Run in Edge'}));
    await waitFor(() => expect(requests).toHaveLength(2));
    await user.click(screen.getByRole('button', {name: /^Stop$/}));
    await act(async () => {acknowledgeRetry!();});
  });

  it('keeps a malformed stream stopping while its second native Stop acknowledgment is delayed', async () => {
    const user = userEvent.setup();
    let stops = 0;
    let acknowledge: (() => void) | undefined;
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'computer_use_health') return Promise.resolve(health);
      if (command === 'computer_use_targets') return Promise.resolve([]);
      if (command === 'stop_computer_use') {
        stops += 1;
        if (stops === 1) return Promise.reject(new Error('Cleanup Stop rejected'));
        return new Promise<void>((resolve) => {acknowledge = resolve;});
      }
      return Promise.resolve();
    });
    render(<Workspace service={new TauriComputerUseService()} />);
    const run = screen.getByRole('button', {name: 'Run in Edge'});
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    await act(async () => {tauri.channels[0]({type: 'invalidNativeEnvelope'});});
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Stop has not been acknowledged'));
    await user.click(screen.getByRole('button', {name: /^Stop$/}));
    await waitFor(() => expect(stops).toBe(2));
    expect(screen.getByRole('status', {name: 'Stopping'})).toBeVisible();
    expect(screen.getByRole('alert')).not.toBeEmptyDOMElement();
    await user.click(screen.getByRole('button', {name: 'Take Over'}));
    expect(stops).toBe(2);
    expect(screen.getByRole('status', {name: 'Stopping'})).toBeVisible();
    await act(async () => {acknowledge!();});
    await waitFor(() => expect(screen.getByRole('status', {name: 'Stopped'})).toBeVisible());
    expect(screen.getByRole('alert')).not.toBeEmptyDOMElement();
  });

  it('accepts a native stopped event after Stop IPC rejects and clears the unacknowledged error', async () => {
    const user = userEvent.setup();
    let request: ComputerUseRequest | undefined;
    tauri.invoke.mockImplementation((command: string, args?: {request?: ComputerUseRequest}) => {
      if (command === 'computer_use_health') return Promise.resolve(health);
      if (command === 'computer_use_targets') return Promise.resolve([]);
      if (command === 'start_computer_use') request = args!.request;
      if (command === 'stop_computer_use') return Promise.reject(new Error('Native Stop delivery failed'));
      return Promise.resolve();
    });
    render(<Workspace service={new TauriComputerUseService()} />);
    const run = screen.getByRole('button', {name: 'Run in Edge'});
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    await user.click(screen.getByRole('button', {name: /^Stop$/}));
    expect(screen.getByRole('status', {name: 'Stopping'})).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Stop has not been acknowledged');
    await act(async () => {tauri.channels[0]({taskId: request!.taskId, runId: 'native-run', targetId: 'edge-session', generation: 2, type: 'stopped', reason: 'stop', uncertain: false});});
    await waitFor(() => expect(screen.getByRole('status', {name: 'Stopped'})).toBeVisible());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Run in Edge'})).toBeEnabled();
  });
});
