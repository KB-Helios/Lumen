import type {ApprovalRef, HarnessVersion, ImprovementEvent, ImprovementHealth, ImprovementSettings, ImprovementSnapshot, Preference, WorkflowAuthorization, WorkflowDefinition} from './improvement.types';
export interface ImprovementService {
  readonly simulated: boolean;
  readonly available: boolean;
  health(): Promise<ImprovementHealth>;
  snapshot(): Promise<ImprovementSnapshot>;
  candidateBase(candidateId: string): Promise<HarnessVersion>;
  setSettings(settings: ImprovementSettings): Promise<void>;
  prepare(): Promise<void>;
  analyze(onEvent: (event: ImprovementEvent) => void): Promise<void>;
  cancel(): Promise<void>;
  approve(approval: ApprovalRef): Promise<void>;
  reject(candidateId: string): Promise<void>;
  rollback(versionId: number): Promise<void>;
  clear(): Promise<void>;
  savePreference(preference: Preference): Promise<void>;
  workflows(): Promise<WorkflowDefinition[]>;
  authorizeWorkflow(workflowId: string, versionId: number): Promise<WorkflowAuthorization>;
  endWorkflow(runId: string, outcome: 'completed' | 'failed' | 'cancelled'): Promise<void>;
}
