import {afterEach, describe, expect, it, vi} from 'vitest';
import {computerUseEventSchema, computerUseRequestSchema, type ComputerUseRequest} from './computer-use.types';
import {TauriComputerUseService} from './tauri-computer-use-service';
const tauri = vi.hoisted(() => ({channels: [] as Array<(payload: unknown) => void>, invoke: vi.fn()}));
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class Channel {constructor(onMessage: (payload: unknown) => void) {tauri.channels.push(onMessage);}},
  invoke: tauri.invoke,
}));
const request: ComputerUseRequest = {
  taskId: 17, task: 'Find the Lumen repository', provider: 'gemini', model: 'gemini-3.8-flash',
  executionMode: 'fast', target: {kind: 'browser', initialUrl: 'https://example.com'},
  cloudConsent: true, desktopControlConsent: false, desktopCloudConsent: false,
};
const identity = {taskId: 17, runId: 'native-run', generation: 1, targetId: 'edge-session'};
const started = {...identity, type: 'started', provider: 'gemini', model: 'gemini-3.8-flash', executionMode: 'fast', browser: 'Microsoft Edge'};
afterEach(() => {tauri.channels.length = 0; tauri.invoke.mockReset();});
describe('native Computer Use boundary', () => {
  it('rejects identity-free, extra-field and wrong-generation events', () => {
    expect(computerUseEventSchema.safeParse({type: 'reasoning', text: 'Working'}).success).toBe(false);
    expect(computerUseEventSchema.safeParse({...started, credential: 'secret'}).success).toBe(false);
    expect(computerUseEventSchema.safeParse({...identity, type: 'stopped', reason: 'stop', uncertain: false}).success).toBe(false);
  });
  it('refuses a visible browser in Background before native launch', () => {
    expect(computerUseRequestSchema.safeParse({...request, executionMode: 'background', target: {...request.target, visible: true}}).success).toBe(false);
  });
  it('admits 4,000 Unicode task characters and refuses the next character', () => {
    expect(computerUseRequestSchema.safeParse({...request, task: '🔎'.repeat(4_000)}).success).toBe(true);
    expect(computerUseRequestSchema.safeParse({...request, task: '🔎'.repeat(4_001)}).success).toBe(false);
  });
  it('sends Stop immediately while startup is pending and ends on native acknowledgment', async () => {
    let rejectStartup: ((error: Error) => void) | undefined;
    let acknowledge: (() => void) | undefined;
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'start_computer_use') return new Promise<void>((_resolve, reject) => {rejectStartup = reject;});
      if (command === 'stop_computer_use') return new Promise<void>((resolve) => {acknowledge = resolve;});
      return Promise.resolve();
    });
    const abort = new AbortController();
    const pending = new TauriComputerUseService().stream(request, abort.signal)[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(rejectStartup).toBeTypeOf('function'));
    abort.abort();
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
    let ended = false;
    void pending.then(() => {ended = true;});
    await Promise.resolve();
    expect(ended).toBe(false);
    acknowledge!();
    await expect(pending).resolves.toEqual({done: true, value: undefined});
    rejectStartup!(new Error('startup fenced by tombstone'));
    expect(tauri.invoke).toHaveBeenCalledWith('stop_computer_use', {taskId: 17, reason: 'stop'});
  });
  it('discards foreign identities and replayed action IDs and admits one terminal', async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const iterator = new TauriComputerUseService().stream(request, new AbortController().signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    await vi.waitFor(() => expect(tauri.channels).toHaveLength(1));
    const send = tauri.channels[0];
    send({...started, taskId: 99}); send(started);
    await expect(first).resolves.toMatchObject({value: {type: 'started'}});
    send({...identity, type: 'action', actionId: 'one', action: 'invoke'});
    send({...identity, type: 'action', actionId: 'one', action: 'invoke'});
    send({...identity, runId: 'old-run', type: 'reasoning', text: 'stale'});
    send({...identity, generation: 2, type: 'completed', summary: 'Done'});
    send({...identity, generation: 2, type: 'failed', message: 'late', code: 'late'});
    await expect(iterator.next()).resolves.toMatchObject({value: {type: 'action', actionId: 'one'}});
    await expect(iterator.next()).resolves.toMatchObject({value: {type: 'completed'}});
    await expect(iterator.next()).resolves.toEqual({done: true, value: undefined});
  });
  it('fails closed and dispatches Stop on malformed native data', async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const pending = new TauriComputerUseService().stream(request, new AbortController().signal)[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(tauri.channels).toHaveLength(1));
    tauri.channels[0]({type: 'unknownNativeEvent'});
    await expect(pending).rejects.toThrow();
    expect(tauri.invoke).toHaveBeenCalledWith('stop_computer_use', {taskId: 17, reason: 'stop'});
  });
  it('keeps Stop acknowledgment authoritative when startup rejects before acknowledgment', async () => {
    let rejectStartup: ((error: Error) => void) | undefined;
    let acknowledge: (() => void) | undefined;
    tauri.invoke.mockImplementation((command: string) => command === 'start_computer_use'
      ? new Promise<void>((_resolve, reject) => {rejectStartup = reject;})
      : new Promise<void>((resolve) => {acknowledge = resolve;}));
    const abort = new AbortController();
    const pending = new TauriComputerUseService().stream(request, abort.signal)[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(rejectStartup).toBeDefined());
    abort.abort();
    rejectStartup!(new Error('startup fenced'));
    await Promise.resolve();
    await Promise.resolve();
    acknowledge!();
    await expect(pending).resolves.toEqual({done: true, value: undefined});
  });
  it('accepts startup visible-browser approval and ignores snapshot-stale approvals', async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const iterator = new TauriComputerUseService().stream({...request, target: {kind: 'browser', initialUrl: 'https://example.com', visible: true}}, new AbortController().signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    await vi.waitFor(() => expect(tauri.channels).toHaveLength(1));
    const send = tauri.channels[0];
    send({...identity, type: 'approvalRequired', approvalId: 'visible-once', actionId: 'launch', snapshotId: 'startup', scope: 'visibleBrowser', explanation: 'Show fresh Edge?'});
    await expect(first).resolves.toMatchObject({value: {type: 'approvalRequired', scope: 'visibleBrowser'}});
    send({...identity, type: 'observation', snapshotId: 'current-snapshot'});
    send({...identity, type: 'approvalRequired', approvalId: 'stale', actionId: 'old-action', snapshotId: 'old-snapshot', scope: 'foreground', explanation: 'Stale'});
    send({...identity, generation: 2, type: 'stopped', reason: 'stop', uncertain: false});
    await expect(iterator.next()).resolves.toMatchObject({value: {type: 'observation'}});
    await expect(iterator.next()).resolves.toMatchObject({value: {type: 'stopped'}});
    await expect(iterator.next()).resolves.toEqual({done: true, value: undefined});
  });
  it('does not expose an unrequested visible launch or a Background foreground approval', async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const iterator = new TauriComputerUseService().stream({...request, executionMode: 'background'}, new AbortController().signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    await vi.waitFor(() => expect(tauri.channels).toHaveLength(1));
    const send = tauri.channels[0];
    send({...identity, type: 'approvalRequired', approvalId: 'unrequested', actionId: 'launch', snapshotId: 'startup', scope: 'visibleBrowser', explanation: 'Visible launch'});
    send({...started, executionMode: 'background'});
    await expect(first).resolves.toMatchObject({value: {type: 'started'}});
    send({...identity, type: 'observation', snapshotId: 'current-snapshot'});
    send({...identity, type: 'approvalRequired', approvalId: 'foreground', actionId: 'action', snapshotId: 'current-snapshot', scope: 'foreground', explanation: 'Foreground input'});
    send({...identity, generation: 2, type: 'failed', message: 'Background input unavailable', code: 'backgroundUnavailable'});
    await expect(iterator.next()).resolves.toMatchObject({value: {type: 'observation'}});
    await expect(iterator.next()).resolves.toMatchObject({value: {type: 'failed', code: 'backgroundUnavailable'}});
    await expect(iterator.next()).resolves.toEqual({done: true, value: undefined});
  });
  it('finishes on the native stopped event even if Stop IPC remains pending', async () => {
    tauri.invoke.mockImplementation((command: string) => command === 'stop_computer_use' ? new Promise<void>(() => undefined) : Promise.resolve());
    const abort = new AbortController();
    const iterator = new TauriComputerUseService().stream(request, abort.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    await vi.waitFor(() => expect(tauri.channels).toHaveLength(1));
    abort.abort();
    tauri.channels[0]({...identity, generation: 2, type: 'stopped', reason: 'stop', uncertain: false});
    await expect(pending).resolves.toMatchObject({value: {type: 'stopped'}});
    await expect(iterator.next()).resolves.toEqual({done: true, value: undefined});
  }, 750);
  it('does not expose valid-looking progress after the native channel fails validation', async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const pending = new TauriComputerUseService().stream(request, new AbortController().signal)[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(tauri.channels).toHaveLength(1));
    tauri.channels[0]({type: 'malformed'});
    tauri.channels[0]({...identity, type: 'reasoning', text: 'Do not publish'});
    await expect(pending).rejects.toThrow();
  });
  it('reports a failed channel while retaining native acknowledgment of a delayed Stop IPC', async () => {
    tauri.invoke.mockImplementation((command: string) => command === 'stop_computer_use' ? new Promise<void>(() => undefined) : Promise.resolve());
    const onStopped = vi.fn();
    const pending = new TauriComputerUseService().stream(request, new AbortController().signal, onStopped)[Symbol.asyncIterator]().next();
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(tauri.channels).toHaveLength(1));
    tauri.channels[0]({type: 'malformed'});
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith('stop_computer_use', {taskId: 17, reason: 'stop'}));
    await rejected;
    tauri.channels[0]({...identity, generation: 2, type: 'stopped', reason: 'stop', uncertain: false});
    expect(onStopped).toHaveBeenCalledWith({...identity, generation: 2, type: 'stopped', reason: 'stop', uncertain: false});
  }, 750);
});
