import {describe, expect, it, vi} from 'vitest';
import {runApprovedWorkflow, runWorkflow} from './workflow-runner';
import type {ImprovementService} from '../../services/improvement/improvement-service';
import type {SearchService} from '../../services/search/search-service';
import type {AnswerService} from '../../services/answer/answer-service';

const workflow = {id: 'w', name: 'Find and answer', steps: [{kind: 'search' as const}, {kind: 'answer' as const}, {kind: 'computerUseDraft' as const}]};
describe('bounded approved workflows', () => {
  it('calls existing services and produces a draft without starting Computer Use', async () => {
    const calls: string[] = [];
    const search = {search: async () => {calls.push('search'); return {requestId: 1, groups: [], elapsedMs: 0, total: 0};}} as unknown as SearchService;
    const answer: AnswerService = {async *stream() {calls.push('answer'); yield {type: 'delta', text: 'Visible answer'}; yield {type: 'completed', provider: 'local', model: 'local', route: 'local'};}};
    const result = await runWorkflow(workflow, 'Find report', {search, answer, draft: (task) => {calls.push(`draft:${task}`);}}, new AbortController().signal, {mode: 'local', cloudConsent: false});
    expect(calls).toEqual(['search', 'answer', 'draft:Find report']);
    expect(result.answer).toBe('Visible answer');
    expect(result.draft).toBe(true);
  });
  it('does not advance after cancellation or an uncertain answer termination', async () => {
    const abort = new AbortController();
    const draft = vi.fn();
    const search = {search: async () => {abort.abort(); return {requestId: 1, groups: [], elapsedMs: 0, total: 0};}} as unknown as SearchService;
    const answer: AnswerService = {async *stream() {yield {type: 'delta', text: 'partial'};}};
    await expect(runWorkflow(workflow, 'Task', {search, answer, draft}, abort.signal, {mode: 'local', cloudConsent: false})).rejects.toThrow('cancelled');
    await expect(runWorkflow({...workflow, steps: workflow.steps.slice(1)}, 'Task', {search, answer, draft}, new AbortController().signal, {mode: 'local', cloudConsent: false})).rejects.toThrow('completion');
    expect(draft).not.toHaveBeenCalled();
  });
  it('captures native authorization and releases it with the real completion outcome', async () => {
    const requests: unknown[] = [];
    const end = vi.fn();
    const service = {authorizeWorkflow: async () => ({runId: 'run-one', versionId: 4, workflow: {...workflow, steps: [{kind: 'answer'}]}}), endWorkflow: end} as unknown as ImprovementService;
    const answer: AnswerService = {async *stream(request) {requests.push(request); yield {type: 'completed', provider: 'local', model: 'local', route: 'local'};}};
    await runApprovedWorkflow(service, 'w', 4, 'Task', {search: {} as SearchService, answer, draft: () => undefined}, new AbortController().signal, {mode: 'local', cloudConsent: false});
    expect(requests).toEqual([expect.objectContaining({workflowRunId: 'run-one', query: 'Task'})]);
    expect(end).toHaveBeenCalledWith('run-one', 'completed');
  });
  it('releases cancelled authorization and never starts a pending step', async () => {
    const controller = new AbortController();
    const end = vi.fn();
    const answer = {stream: vi.fn()} as unknown as AnswerService;
    const service = {authorizeWorkflow: async () => {controller.abort(); return {runId: 'cancelled-run', versionId: 4, workflow};}, endWorkflow: end} as unknown as ImprovementService;
    await expect(runApprovedWorkflow(service, 'w', 4, 'Task', {search: {} as SearchService, answer, draft: () => undefined}, controller.signal, {mode: 'local', cloudConsent: false})).rejects.toThrow('cancelled');
    expect(end).toHaveBeenCalledWith('cancelled-run', 'cancelled');
    expect(answer.stream).not.toHaveBeenCalled();
  });
  it('bounds Unicode tasks at 4,000 characters before drafting', async () => {
    const draft = vi.fn();
    const draftOnly = {...workflow, steps: [{kind: 'computerUseDraft' as const}]};
    const services = {search: {} as SearchService, answer: {} as AnswerService, draft};
    await expect(runWorkflow(draftOnly, '🔎'.repeat(4000), services, new AbortController().signal, {mode: 'local', cloudConsent: false})).resolves.toMatchObject({draft: true});
    await expect(runWorkflow(draftOnly, '🔎'.repeat(4001), services, new AbortController().signal, {mode: 'local', cloudConsent: false})).rejects.toThrow('4,000');
    expect(draft).toHaveBeenCalledOnce();
  });
});
