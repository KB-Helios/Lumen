import type {
  ComputerUseEvent,
  ComputerUseHealth,
  ComputerUseRequest,
  ComputerUseStopReason,
  ComputerUseWindowTarget,
} from './computer-use.types';

export type ComputerUseStoppedEvent = Extract<ComputerUseEvent, {type: 'stopped'}>;

export interface ComputerUseService {
  readonly simulated?: boolean;
  health(): Promise<ComputerUseHealth>;
  targets(): Promise<ComputerUseWindowTarget[]>;
  stream(request: ComputerUseRequest, signal: AbortSignal, onStopped?: (event: ComputerUseStoppedEvent) => void): AsyncIterable<ComputerUseEvent>;
  respond(taskId: number, approvalId: string, approved: boolean): Promise<void>;
  stop(taskId: number, reason: ComputerUseStopReason): Promise<void>;
}
