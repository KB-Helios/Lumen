import {useCallback, useEffect, useRef, useState} from 'react';
import type {ComputerUseService} from '../../services/computer-use/computer-use-service';
import {ComputerUseEventAdmission, computerUseEventSchema, unavailableComputerUseHealth, type ComputerUseEvent, type ComputerUseExecutionMode, type ComputerUseHealth, type ComputerUseProvider, type ComputerUseRequest, type ComputerUseStopReason, type ComputerUseTarget, type ComputerUseWindowTarget} from '../../services/computer-use/computer-use.types';

export type ComputerUsePhase = 'idle' | 'starting' | 'running' | 'approval' | 'stopping' | 'stopped' | 'completed' | 'error';
export interface ComputerUseActivity {id: number; label: string; tone: 'neutral' | 'accent' | 'success';}
export interface ComputerUseState {
  phase: ComputerUsePhase; health?: ComputerUseHealth; task?: string; taskId?: number; model?: string;
  provider?: ComputerUseProvider; executionMode?: ComputerUseExecutionMode; browser?: string; currentUrl?: string;
  reasoning?: string; summary?: string; error?: string; refusal?: string; simulated?: boolean;
  target?: ComputerUseTarget; targets?: readonly ComputerUseWindowTarget[];
  approval?: {id: string; explanation: string; scope?: 'safety' | 'foreground' | 'visibleBrowser'};
  activity: readonly ComputerUseActivity[];
}
export interface ComputerUseController extends ComputerUseState {
  refreshHealth(): Promise<void>; start(task: string): Promise<void>; approve(): Promise<void>; deny(): Promise<void>;
  stop(): void; takeOver(): void; selectTarget(targetId: string): void; setVisibleBrowser(visible: boolean): void;
}
interface ComputerUseOptions {
  model: string; initialUrl: string; cloudConsent: boolean; provider?: ComputerUseProvider; openaiModel?: string;
  executionMode?: ComputerUseExecutionMode; desktopControlConsent?: boolean; desktopCloudConsent?: boolean;
}
interface ActiveRun {request: ComputerUseRequest; abort: AbortController; stopRequested?: ComputerUseStopReason; stopPromise?: Promise<void>; streamError?: string; terminal: boolean; responses: Set<string>;}
function createTaskId() {
  const words = new Uint32Array(2); globalThis.crypto.getRandomValues(words);
  return (words[0] & 0x1f_ffff) * 0x1_0000_0000 + words[1] || 1;
}
function appendActivity(activity: readonly ComputerUseActivity[], label: string, tone: ComputerUseActivity['tone'] = 'neutral') {
  return [...activity, {id: (activity[activity.length - 1]?.id ?? 0) + 1, label, tone}].slice(-8);
}
function applyEvent(state: ComputerUseState, event: ComputerUseEvent): ComputerUseState {
  switch (event.type) {
    case 'started': return {...state, phase: 'running', model: event.model, provider: event.provider, executionMode: event.executionMode, browser: event.browser, activity: appendActivity(state.activity, 'Session started', 'accent')};
    case 'reasoning': return {...state, reasoning: event.text};
    case 'action': return {...state, activity: appendActivity(state.activity, event.action.replace(/_/g, ' ').replace(/\b\w/g, (value) => value.toUpperCase()))};
    case 'observation': return {...state, currentUrl: event.url, approval: undefined};
    case 'approvalRequired': return {...state, phase: 'approval', approval: {id: event.approvalId, explanation: event.explanation, scope: event.scope}, activity: appendActivity(state.activity, 'Waiting for your approval', 'accent')};
    case 'approvalResolved': return {...state, phase: event.approved ? 'running' : 'stopping', approval: undefined, error: undefined, activity: appendActivity(state.activity, event.approved ? 'Action approved once' : 'Action denied', event.approved ? 'success' : 'neutral')};
    case 'completed': return {...state, phase: 'completed', summary: event.summary, approval: undefined, activity: appendActivity(state.activity, 'Task completed', 'success')};
    case 'stopped': return {...state, phase: 'stopped', error: undefined, approval: undefined, reasoning: undefined, activity: appendActivity(state.activity, event.reason === 'takeOver' ? 'You took over' : event.reason === 'consentRevoked' ? 'Consent revoked; task stopped' : 'Task stopped')};
    case 'failed': return {...state, phase: 'error', error: event.message, approval: undefined};
  }
}
function refusalFor(health: ComputerUseHealth | undefined, target: ComputerUseTarget, targets: readonly ComputerUseWindowTarget[], options: ComputerUseOptions) {
  if (!health) return 'Checking Computer Use availability…';
  if (!health.nativeStop.available) return health.nativeStop.reason ?? 'Native Stop is unavailable.';
  const route = target.kind === 'browser' ? health.routes.browser : health.routes.desktop;
  if (!route.available) return route.reason ?? 'The selected execution route is unavailable.';
  if (target.kind === 'window') {
    const window = targets.find((item) => item.targetId === target.targetId);
    if (!window?.available) return window?.reason ?? 'Select a currently available native window.';
  }
  if (options.executionMode === 'background' && target.kind === 'browser' && target.visible) return 'Background mode cannot launch a visible browser.';
  const provider = options.provider ?? 'gemini';
  const model = provider === 'openai' ? options.openaiModel ?? 'gpt-6.1-sol' : options.model;
  const status = health.providers[provider];
  if (!status.credentialConfigured) return `Add a ${provider === 'openai' ? 'OpenAI' : 'Gemini'} API key in Computer Use settings.`;
  if (!status.available) return status.reason ?? 'The selected provider is unavailable.';
  if (!status.models.includes(model)) return `Saved model ${model} is unavailable for Computer Use. Select a reviewed model in settings.`;
  if (target.kind === 'browser' && !options.cloudConsent) return 'Review and grant browser cloud consent in Computer Use settings.';
  if (target.kind === 'window' && !options.desktopControlConsent) return 'Grant selected-window control consent in Computer Use settings.';
  if (target.kind === 'window' && !options.desktopCloudConsent) return 'Grant desktop cloud observations consent in Computer Use settings.';
}

export function useComputerUseController(service: ComputerUseService, options: ComputerUseOptions): ComputerUseController {
  const [state, setState] = useState<ComputerUseState>({phase: 'idle', activity: []});
  const [selectedTarget, setSelectedTarget] = useState('browser');
  const [visible, setVisible] = useState(false);
  const active = useRef<ActiveRun | null>(null);
  const responding = useRef<string | null>(null);
  const target: ComputerUseTarget = selectedTarget === 'browser' ? {kind: 'browser', initialUrl: options.initialUrl, visible} : {kind: 'window', targetId: selectedTarget};
  const targets = state.targets ?? [];
  const refusal = refusalFor(state.health, target, targets, options);
  const provider = options.provider ?? 'gemini';
  const model = provider === 'openai' ? options.openaiModel ?? 'gpt-6.1-sol' : options.model;
  const executionMode = options.executionMode ?? 'fast';
  const refreshHealth = useCallback(async () => {
    const [healthResult, targetsResult] = await Promise.allSettled([service.health(), service.targets()]);
    const health = healthResult.status === 'fulfilled' ? healthResult.value : unavailableComputerUseHealth(String(healthResult.reason));
    setState((current) => ({...current, health, targets: targetsResult.status === 'fulfilled' ? targetsResult.value : []}));
  }, [service]);
  const requestStop = useCallback((reason: ComputerUseStopReason) => {
    const run = active.current;
    if (!run || run.terminal || run.stopPromise) return;
    run.stopRequested = reason;
    setState((current) => ({...current, phase: 'stopping', approval: undefined, error: run.streamError}));
    run.stopPromise = service.stop(run.request.taskId, reason).then(() => {
      if (active.current !== run) return;
      run.terminal = true;
      active.current = null;
      setState((current) => ({...current, phase: 'stopped', error: run.streamError, approval: undefined, reasoning: undefined, activity: appendActivity(current.activity, reason === 'takeOver' ? 'You took over' : reason === 'consentRevoked' ? 'Consent revoked; task stopped' : 'Task stopped')}));
    }).catch((error: unknown) => {
      if (active.current !== run || run.terminal) return;
      run.stopPromise = undefined;
      setState((current) => ({...current, phase: 'stopping', error: `${run.streamError ? `${run.streamError} ` : ''}Stop has not been acknowledged: ${error instanceof Error ? error.message : String(error)}`}));
    });
  }, [service]);
  useEffect(() => {
    void refreshHealth();
    return () => {
      const run = active.current;
      if (run && !run.terminal) {
        active.current = null;
        void service.stop(run.request.taskId, 'stop').catch(() => undefined);
        run.abort.abort();
      }
    };
  }, [refreshHealth, service]);
  useEffect(() => {
    const run = active.current;
    if (!run || run.terminal) return;
    const revoked = run.request.target.kind === 'browser' ? !options.cloudConsent : !options.desktopControlConsent || !options.desktopCloudConsent;
    if (revoked) requestStop('consentRevoked');
  }, [options.cloudConsent, options.desktopControlConsent, options.desktopCloudConsent, requestStop]);

  const start = async (task: string) => {
    const normalizedTask = task.trim();
    if (active.current || !normalizedTask || refusal) return;
    if (Array.from(normalizedTask).length > 4_000) {setState((current) => ({...current, phase: 'error', error: 'Tasks are limited to 4,000 characters.'})); return;}
    const request: ComputerUseRequest = {taskId: createTaskId(), task: normalizedTask, provider, model, executionMode, target, cloudConsent: options.cloudConsent, desktopControlConsent: options.desktopControlConsent ?? false, desktopCloudConsent: options.desktopCloudConsent ?? false};
    const run: ActiveRun = {request, abort: new AbortController(), terminal: false, responses: new Set()};
    const admission = new ComputerUseEventAdmission(request);
    active.current = run;
    setState((current) => ({phase: 'starting', health: current.health, targets: current.targets, task: normalizedTask, taskId: request.taskId, model, provider, executionMode, activity: []}));
    const receive = (payload: ComputerUseEvent) => {
      const event = computerUseEventSchema.parse(payload);
      if (active.current !== run || run.terminal || !admission.admit(event)) return;
      if (run.stopRequested && event.type !== 'stopped') return;
      run.terminal = event.generation === 2;
      if (run.terminal) active.current = null;
      setState((current) => event.type === 'stopped' ? {...applyEvent(current, event), error: run.streamError} : applyEvent(current, event));
      if (event.type === 'approvalResolved' && !event.approved) requestStop('stop');
    };
    try {
      for await (const payload of service.stream(request, run.abort.signal, receive)) receive(payload);
    } catch (error) {
      if (active.current === run && !run.terminal) {
        run.streamError = error instanceof Error ? error.message : String(error);
        // A broken stream is not proof that native input admission is closed.
        if (!run.stopRequested) requestStop('stop');
        else setState((current) => ({...current, phase: 'stopping', error: current.error ?? run.streamError, approval: undefined}));
      }
    } finally {
      if (active.current === run && run.terminal) active.current = null;
      void refreshHealth();
    }
  };
  const respond = async (approved: boolean) => {
    const run = active.current;
    const approval = state.approval;
    if (!run || run.stopRequested || !approval || responding.current || run.responses.has(approval.id)) return;
    responding.current = approval.id;
    run.responses.add(approval.id);
    try {await service.respond(run.request.taskId, approval.id, approved);}
    catch (error) {
      run.responses.delete(approval.id);
      if (active.current === run && !run.stopRequested) setState((current) => ({...current, error: error instanceof Error ? error.message : String(error)}));
    } finally {responding.current = null;}
  };
  return {...state, target, targets, refusal, simulated: service.simulated, provider, model, executionMode, refreshHealth, start, approve: () => respond(true), deny: () => respond(false), stop: () => requestStop('stop'), takeOver: () => requestStop('takeOver'), selectTarget: (id) => {if (!active.current) setSelectedTarget(id);}, setVisibleBrowser: (value) => {if (!active.current) setVisible(value);}};
}
