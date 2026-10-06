import {act, render, renderHook, screen, waitFor} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {AppProviders} from '../../app/AppProviders';
import type {ComputerUseService} from '../../services/computer-use/computer-use-service';
import type {ComputerUseEvent, ComputerUseHealth, ComputerUseRequest, ComputerUseStopReason} from '../../services/computer-use/computer-use.types';
import {ComputerUsePanel} from './ComputerUsePanel';
import {useComputerUseController} from './useComputerUseController';

const options = {provider: 'gemini' as const, model: 'gemini-3.8-flash', openaiModel: 'gpt-6.1-sol', executionMode: 'fast' as const, initialUrl: 'https://example.com', cloudConsent: true, desktopControlConsent: false, desktopCloudConsent: false};
const ready: ComputerUseHealth = {
  state: 'ready', mode: 'python', browser: 'Microsoft Edge', credentialConfigured: true,
  nativeStop: {available: true}, routes: {browser: {available: true}, desktop: {available: true}, foreground: {available: true}},
  providers: {gemini: {available: true, credentialConfigured: true, models: ['gemini-3.8-flash']}, openai: {available: true, credentialConfigured: true, models: ['gpt-6.1-sol']}},
};

class NativeBoundaryFixture implements ComputerUseService {
  request?: ComputerUseRequest;
  stops: Array<{taskId: number; reason: ComputerUseStopReason}> = [];
  responses: Array<{taskId: number; approvalId: string; approved: boolean}> = [];
  private queue: ComputerUseEvent[] = [];
  private wake?: () => void;
  private stopped = false;
  acknowledge?: () => void;
  health = async () => ready;
  targets = async () => [{targetId: 'window-one', title: 'Notepad', processName: 'notepad.exe', available: true}];
  async *stream(request: ComputerUseRequest): AsyncIterable<ComputerUseEvent> {
    this.request = request;
    while (!this.stopped || this.queue.length) {
      if (!this.queue.length) await new Promise<void>((resolve) => {this.wake = resolve;});
      const event = this.queue.shift();
      if (event) yield event;
    }
  }
  send(event: Omit<ComputerUseEvent, 'taskId' | 'runId' | 'targetId'>) {
    this.queue.push({...event, taskId: this.request!.taskId, runId: 'fixture-run', targetId: 'edge-fixture'} as ComputerUseEvent);
    this.wake?.();
  }
  async stop(taskId: number, reason: ComputerUseStopReason) {
    this.stops.push({taskId, reason});
    await new Promise<void>((resolve) => {this.acknowledge = resolve;});
    this.stopped = true;
    this.wake?.();
  }
  async respond(taskId: number, approvalId: string, approved: boolean) {this.responses.push({taskId, approvalId, approved});}
}

describe('Computer Use safety controls', () => {
  it('keeps Stop pending during startup until native acknowledgment', async () => {
    const service = new NativeBoundaryFixture();
    const {result} = renderHook(() => useComputerUseController(service, options));
    await waitFor(() => expect(result.current.health).toBeDefined());
    act(() => {void result.current.start('Review form');});
    act(() => service.send({type: 'observation', generation: 1, snapshotId: 'snapshot-one'} as Omit<ComputerUseEvent, 'taskId' | 'runId' | 'targetId'>));
    await waitFor(() => expect(result.current.phase).toBe('starting'));
    act(() => result.current.stop());
    expect(result.current.phase).toBe('stopping');
    expect(service.stops).toEqual([{taskId: service.request!.taskId, reason: 'stop'}]);
    await act(async () => {service.acknowledge!();});
    await waitFor(() => expect(result.current.phase).toBe('stopped'));
  });
  it('does not resume after Take Over when an approval reply arrives late', async () => {
    const service = new NativeBoundaryFixture();
    const {result} = renderHook(() => useComputerUseController(service, options));
    await waitFor(() => expect(result.current.health).toBeDefined());
    act(() => {void result.current.start('Review form');});
    act(() => service.send({type: 'observation', generation: 1, snapshotId: 'snapshot-one'} as Omit<ComputerUseEvent, 'taskId' | 'runId' | 'targetId'>));
    act(() => service.send({type: 'approvalRequired', generation: 1, approvalId: 'approval-one', actionId: 'action-one', snapshotId: 'snapshot-one', scope: 'foreground', explanation: 'Allow one foreground action?'} as Omit<ComputerUseEvent, 'taskId' | 'runId' | 'targetId'>));
    await waitFor(() => expect(result.current.phase).toBe('approval'));
    act(() => result.current.takeOver());
    act(() => service.send({type: 'approvalResolved', generation: 1, approvalId: 'approval-one', approved: true} as Omit<ComputerUseEvent, 'taskId' | 'runId' | 'targetId'>));
    expect(result.current.phase).toBe('stopping');
    await act(async () => {service.acknowledge!();});
    expect(result.current.phase).toBe('stopped');
    expect(service.stops[0]?.reason).toBe('takeOver');
    expect(result.current.approval).toBeUndefined();
  });
  it('stops an active window task when either persisted desktop grant is revoked', async () => {
    const service = new NativeBoundaryFixture();
    const granted = {...options, desktopControlConsent: true, desktopCloudConsent: true};
    const {result, rerender} = renderHook(({config}) => useComputerUseController(service, config), {initialProps: {config: granted}});
    await waitFor(() => expect(result.current.health).toBeDefined());
    act(() => result.current.selectTarget('window-one'));
    act(() => {void result.current.start('Edit note');});
    rerender({config: {...granted, desktopCloudConsent: false}});
    await waitFor(() => expect(result.current.phase).toBe('stopping'));
    expect(service.stops[0]?.reason).toBe('consentRevoked');
    await act(async () => {service.acknowledge!();});
    expect(result.current.phase).toBe('stopped');
  });
  it('refuses desktop in missing native environments and visible Background before streaming', async () => {
    const service = new NativeBoundaryFixture();
    service.health = async () => ({...ready, routes: {...ready.routes, desktop: {available: false, reason: 'Native desktop unavailable'}}});
    const {result, rerender} = renderHook(({config}) => useComputerUseController(service, config), {initialProps: {config: {...options, executionMode: 'fast' as 'fast' | 'background'}}});
    await waitFor(() => expect(result.current.health).toBeDefined());
    act(() => result.current.selectTarget('window-one'));
    await act(async () => result.current.start('Edit note'));
    expect(service.request).toBeUndefined();
    expect(result.current.refusal).toBe('Native desktop unavailable');
    act(() => {result.current.selectTarget('browser'); result.current.setVisibleBrowser(true);});
    rerender({config: {...options, executionMode: 'background'}});
    await act(async () => result.current.start('Review form'));
    expect(service.request).toBeUndefined();
    expect(result.current.refusal).toMatch(/Background.*visible/i);
  });
  it('shows Stop and Take Over while stopping and labels deterministic mode simulated', async () => {
    const service = new NativeBoundaryFixture();
    const {result} = renderHook(() => useComputerUseController(service, options));
    await waitFor(() => expect(result.current.health).toBeDefined());
    render(<AppProviders><ComputerUsePanel cloudConsent controller={{...result.current, phase: 'stopping', simulated: true}} draftTask="Task" onOpenSettings={() => undefined} onStart={() => undefined} /></AppProviders>);
    expect(screen.getByRole('status', {name: 'Stopping'})).toBeVisible();
    expect(screen.getByRole('button', {name: /^Stop$/})).toBeVisible();
    expect(screen.getByRole('button', {name: 'Take Over'})).toBeVisible();
    expect(screen.getByText(/Simulated/)).toBeVisible();
  });
  it('sends one response per approval even when its native event is delayed', async () => {
    const service = new NativeBoundaryFixture();
    const {result} = renderHook(() => useComputerUseController(service, options));
    await waitFor(() => expect(result.current.health).toBeDefined());
    act(() => {void result.current.start('Review form');});
    act(() => {
      service.send({type: 'observation', generation: 1, snapshotId: 'snapshot-one'} as Omit<ComputerUseEvent, 'taskId' | 'runId' | 'targetId'>);
      service.send({type: 'approvalRequired', generation: 1, approvalId: 'approval-one', actionId: 'action-one', snapshotId: 'snapshot-one', scope: 'safety', explanation: 'Submit?'} as Omit<ComputerUseEvent, 'taskId' | 'runId' | 'targetId'>);
    });
    await waitFor(() => expect(result.current.phase).toBe('approval'));
    await act(async () => {await result.current.approve(); await result.current.approve();});
    expect(service.responses).toHaveLength(1);
  });
  it('accepts native shortcut Stop before startup and never publishes a late started event', async () => {
    const service = new NativeBoundaryFixture();
    const {result} = renderHook(() => useComputerUseController(service, options));
    await waitFor(() => expect(result.current.health).toBeDefined());
    act(() => {void result.current.start('Review form');});
    act(() => {
      service.send({type: 'stopped', generation: 2, reason: 'stop', uncertain: false} as Omit<ComputerUseEvent, 'taskId' | 'runId' | 'targetId'>);
      service.send({type: 'started', generation: 1, provider: 'gemini', model: 'gemini-3.8-flash', executionMode: 'fast', browser: 'Microsoft Edge'} as Omit<ComputerUseEvent, 'taskId' | 'runId' | 'targetId'>);
    });
    await waitFor(() => expect(result.current.phase).toBe('stopped'));
    expect(result.current.activity.map((item) => item.label)).not.toContain('Session started');
  });
  it('accepts 4,000 Unicode task characters without counting surrogate halves twice', async () => {
    const service = new NativeBoundaryFixture();
    const {result} = renderHook(() => useComputerUseController(service, options));
    await waitFor(() => expect(result.current.health).toBeDefined());
    act(() => {void result.current.start('🔎'.repeat(4_000));});
    expect(Array.from(service.request?.task ?? '')).toHaveLength(4_000);
  });
});
