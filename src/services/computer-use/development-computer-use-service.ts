import type {ComputerUseService} from './computer-use-service';
import type {ComputerUseEvent, ComputerUseHealth, ComputerUseRequest, ComputerUseStopReason} from './computer-use.types';

interface SimulatedRun {approvalId: string; respond(approved: boolean): void; stop(reason: ComputerUseStopReason): void;}
/** Explicitly simulated DEV-only adapter for deterministic keyboard acceptance. */
export class DevelopmentComputerUseService implements ComputerUseService {
  readonly simulated = true;
  private readonly runs = new Map<number, SimulatedRun>();
  async health(): Promise<ComputerUseHealth> {
    const available = {available: true};
    return {state: 'ready', mode: 'python', browser: 'Microsoft Edge', credentialConfigured: true, detail: 'Simulated Computer Use; no native input or provider requests.', nativeStop: available,
      routes: {browser: available, desktop: {available: false, reason: 'Native desktop unavailable in the simulated preview.'}, foreground: {available: false, reason: 'Foreground input requires the native app.'}},
      providers: {gemini: {...available, credentialConfigured: true, models: ['gemini-3.8-flash']}, openai: {...available, credentialConfigured: true, models: ['gpt-6.1-sol']}},
    };
  }
  async targets() {return [];}
  async *stream(request: ComputerUseRequest, signal: AbortSignal): AsyncIterable<ComputerUseEvent> {
    if (request.target.kind !== 'browser') throw new Error('Native desktop unavailable in the simulated preview.');
    const identity = {taskId: request.taskId, runId: `simulated-${request.taskId}`, targetId: `simulated-edge-${request.taskId}`, generation: 1 as const};
    const approvalId = `simulated-approval-${request.taskId}`;
    const queue: ComputerUseEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    const send = (event: ComputerUseEvent) => {queue.push(event); wake?.(); wake = undefined;};
    const stop = (reason: ComputerUseStopReason) => {
      if (finished) return;
      finished = true;
      send({...identity, generation: 2, type: 'stopped', reason, uncertain: false});
    };
    this.runs.set(request.taskId, {approvalId, stop, respond: (approved) => {
      send({...identity, type: 'approvalResolved', approvalId, approved});
      if (!approved) stop('stop');
    }});
    const abort = () => stop('stop');
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) stop('stop');
    try {
      if (!finished) {
        yield {...identity, type: 'started', provider: request.provider, model: request.model, executionMode: request.executionMode, browser: 'Microsoft Edge'};
        yield {...identity, type: 'observation', snapshotId: 'simulated-snapshot', url: request.target.initialUrl};
        yield {...identity, type: 'approvalRequired', approvalId, actionId: 'simulated-action', snapshotId: 'simulated-snapshot', scope: 'safety', explanation: 'Submit the simulated browser form?'};
      }
      while (!finished || queue.length) {
        if (!queue.length) {await new Promise<void>((resolve) => {wake = resolve;}); continue;}
        yield queue.shift()!;
      }
    } finally {signal.removeEventListener('abort', abort); this.runs.delete(request.taskId);}
  }
  async respond(taskId: number, approvalId: string, approved: boolean) {
    const pending = this.runs.get(taskId);
    if (!pending || pending.approvalId !== approvalId) throw new Error('The simulated approval is no longer pending.');
    pending.respond(approved);
  }
  async stop(taskId: number, reason: ComputerUseStopReason) {this.runs.get(taskId)?.stop(reason);}
}
