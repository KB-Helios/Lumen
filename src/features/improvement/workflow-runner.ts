import type {AnswerService} from '../../services/answer/answer-service';
import type {AnswerRequest} from '../../services/answer/answer.types';
import type {SearchService} from '../../services/search/search-service';
import type {SearchResponse} from '../../services/search/search.types';
import {workflowSchema, type WorkflowDefinition} from '../../services/improvement/improvement.types';
import type {ImprovementService} from '../../services/improvement/improvement-service';

export interface WorkflowServices {search: SearchService; answer: AnswerService; draft(task: string): void | Promise<void>;}
export interface WorkflowResult {answer: string; search: SearchResponse | null; draft: boolean;}
let requestId = 1_000_000;
export async function runWorkflow(input: WorkflowDefinition, task: string, services: WorkflowServices, signal: AbortSignal, options: Pick<AnswerRequest, 'mode' | 'cloudConsent' | 'workflowRunId'>, onProgress?: (message: string) => void): Promise<WorkflowResult> {
  const workflow = structuredClone(workflowSchema.parse(input));
  if (!task.trim() || [...task].length > 4000) throw new Error('Enter a task of 1–4,000 characters.');
  const result: WorkflowResult = {answer: '', search: null, draft: false};
  const check = () => {if (signal.aborted) throw new Error('Workflow cancelled.');};
  for (const [index, step] of workflow.steps.entries()) {
    check();
    onProgress?.(`Step ${index + 1}/${workflow.steps.length}: ${step.kind}`);
    if (step.kind === 'search') {
      result.search = await services.search.search({requestId: ++requestId, query: task, scope: 'all', filters: [], limit: 100}, signal);
      check();
    } else if (step.kind === 'answer') {
      let completed = false;
      for await (const event of services.answer.stream({requestId: ++requestId, query: task, ...options}, signal)) {
        check();
        if (event.type === 'failed') throw new Error(event.message);
        if (event.type === 'cancelled') throw new Error('Workflow cancelled.');
        if (event.type === 'delta') result.answer += event.text;
        if (event.type === 'completed') completed = true;
      }
      check();
      if (!completed) throw new Error('Answer ended without verified completion. Review before trying again.');
    } else {
      check();
      await services.draft(task);
      result.draft = true;
    }
  }
  return result;
}

export async function runApprovedWorkflow(service: ImprovementService, workflowId: string, versionId: number, task: string, services: WorkflowServices, signal: AbortSignal, options: Pick<AnswerRequest, 'mode' | 'cloudConsent'>, onProgress?: (message: string) => void): Promise<WorkflowResult> {
  if (signal.aborted) throw new Error('Workflow cancelled.');
  const authorization = await service.authorizeWorkflow(workflowId, versionId);
  let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
  let result: WorkflowResult | null = null;
  let failure: unknown;
  try {
    if (authorization.versionId !== versionId || authorization.workflow.id !== workflowId) throw new Error('Workflow authorization changed. Review before trying again.');
    result = await runWorkflow(authorization.workflow, task, services, signal, {...options, workflowRunId: authorization.runId}, onProgress);
    outcome = 'completed';
  } catch (error) {outcome = signal.aborted ? 'cancelled' : 'failed'; failure = error;}
  finally {
    try {await service.endWorkflow(authorization.runId, outcome);}
    catch {failure = new Error('Workflow ended; native cleanup could not be confirmed. Review before trying again.');}
  }
  if (failure) throw failure;
  if (!result) throw new Error('Workflow ended without a result.');
  return result;
}
