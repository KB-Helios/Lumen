import {Channel, invoke} from '@tauri-apps/api/core';
import type {ComputerUseService, ComputerUseStoppedEvent} from './computer-use-service';
import {ComputerUseEventAdmission, computerUseEventSchema, computerUseHealthSchema, computerUseRequestSchema, computerUseTargetsSchema, type ComputerUseEvent, type ComputerUseRequest, type ComputerUseStopReason} from './computer-use.types';

interface ActiveStream {requestStop(): void; acknowledgeStop(): void; stopped: Promise<void>;}

export class TauriComputerUseService implements ComputerUseService {
  private readonly streams = new Map<number, ActiveStream>();
  private readonly stopping = new Map<number, Promise<void>>();
  async health() {return computerUseHealthSchema.parse(await invoke('computer_use_health'));}
  async targets() {return computerUseTargetsSchema.parse(await invoke('computer_use_targets'));}
  stop(taskId: number, reason: ComputerUseStopReason) {
    const existing = this.stopping.get(taskId);
    if (existing) return existing;
    this.streams.get(taskId)?.requestStop();
    // Native records a tombstone even if start has not reached its gate yet.
    const nativeStop = invoke<void>('stop_computer_use', {taskId, reason});
    const stopped = this.streams.get(taskId)?.stopped;
    const acknowledgment = stopped ? Promise.race([nativeStop, stopped]) : nativeStop;
    const stopping = acknowledgment.then(() => {
      this.streams.get(taskId)?.acknowledgeStop();
    });
    this.stopping.set(taskId, stopping);
    void stopping.finally(() => {if (this.stopping.get(taskId) === stopping) this.stopping.delete(taskId);}).catch(() => undefined);
    return stopping;
  }

  async *stream(payload: ComputerUseRequest, signal: AbortSignal, onStopped?: (event: ComputerUseStoppedEvent) => void): AsyncIterable<ComputerUseEvent> {
    const request = computerUseRequestSchema.parse(payload);
    const admission = new ComputerUseEventAdmission(request);
    const queued: ComputerUseEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let terminal = false;
    let stopAcknowledged = false;
    let stopRequested = false;
    let failure: unknown;
    let cancellation: Promise<void> | undefined;
    let acknowledgeNativeStopped: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {acknowledgeNativeStopped = resolve;});
    const notify = () => {wake?.(); wake = undefined;};
    const activeStream: ActiveStream = {stopped, requestStop: () => {stopRequested = true; queued.length = 0;}, acknowledgeStop: () => {
      stopAcknowledged = true; finished = true; if (!terminal) queued.length = 0; notify();
      if (this.streams.get(request.taskId) === activeStream) this.streams.delete(request.taskId);
    }};
    this.streams.set(request.taskId, activeStream);
    const channel = new Channel<unknown>((nativePayload) => {
      if (terminal || stopAcknowledged) return;
      try {
        const event = computerUseEventSchema.parse(nativePayload);
        if ((stopRequested || failure) && event.type !== 'stopped') return;
        if (!admission.admit(event)) return;
        queued.push(event);
        terminal = event.generation === 2;
        if (event.type === 'stopped') {
          acknowledgeNativeStopped?.(); this.stopping.delete(request.taskId);
          // A damaged generator may already have ended. Its run still needs
          // this validated terminal acknowledgment independently of Stop IPC.
          onStopped?.(event);
          if (this.streams.get(request.taskId) === activeStream) this.streams.delete(request.taskId);
        }
        finished ||= terminal;
      } catch (error) {failure = error; finished = true; queued.length = 0;}
      notify();
    });
    // Do not await startup. Stop is independent of startup/provider/worker I/O.
    void invoke<void>('start_computer_use', {request, onEvent: channel}).catch((error: unknown) => {
      if (!stopAcknowledged && !terminal) {failure = error; if (!stopRequested) {finished = true; notify();}}
    });
    const cancel = () => {
      cancellation ??= this.stop(request.taskId, 'stop').catch((error: unknown) => {failure = error; finished = true; notify();});
    };
    signal.addEventListener('abort', cancel, {once: true});
    if (signal.aborted) cancel();
    try {
      while (!finished || queued.length) {
        if (!queued.length) {await new Promise<void>((resolve) => {wake = resolve;}); continue;}
        yield queued.shift()!;
      }
      // A successful Stop acknowledgment supersedes startup failure.
      if (failure && !stopAcknowledged) throw failure instanceof Error ? failure : new Error(String(failure));
    } finally {
      signal.removeEventListener('abort', cancel);
      if (!terminal && !stopAcknowledged) cancel();
      if (!terminal && !stopAcknowledged) await cancellation;
      // A failed generator is still subscribed to the authoritative native
      // acknowledgment. Keep it available to a retry until native has stopped.
      if ((terminal || stopAcknowledged) && this.streams.get(request.taskId) === activeStream) this.streams.delete(request.taskId);
    }
  }
  respond(taskId: number, approvalId: string, approved: boolean) {
    return invoke<void>('respond_computer_use_approval', {taskId, approvalId, approved});
  }
}
