import {useContext, useEffect, useRef, useState} from 'react';
import {LumenButton} from '../../design-system/primitives/LumenButton';
import {LumenText} from '../../design-system/primitives/LumenText';
import {improvementService} from '../../services/improvement';
import type {ImprovementService} from '../../services/improvement/improvement-service';
import {approvalFor, preferenceSchema, type HarnessVersion, type ImprovementCandidate} from '../../services/improvement/improvement.types';
import {DiagnosticItem} from '../diagnostics/DiagnosticItem';
import {ConfirmationDialog} from '../settings/components/ConfirmationDialog';
import {SettingRow} from '../settings/components/SettingRow';
import {SettingSection} from '../settings/components/SettingSection';
import {LumenSelect, LumenSwitch, LumenTextField} from '../settings/components/SettingsControls';
import {SettingsCallout} from '../settings/components/SettingsPage';
import {useSettingsStore} from '../settings/settings.store';
import {useImprovement, useImprovementStore} from './improvement.store';
import {WorkflowServicesContext} from './workflow-context';
import {runApprovedWorkflow, type WorkflowResult} from './workflow-runner';

type ControlsProps = {service?: ImprovementService};
function CandidateReview({candidate, service}: {candidate: ImprovementCandidate; service: ImprovementService}) {
  const {snapshot, busy, action} = useImprovementStore();
  const approval = approvalFor(candidate, snapshot.activeVersion.id);
  const [selected, setSelected] = useState(false);
  const [comparison, setComparison] = useState<{key: string; base: HarnessVersion | null; error: string}>({key: '', base: null, error: ''});
  const comparisonKey = `${candidate.id}:${candidate.hash}:${candidate.baseVersion}`;
  const comparisonReady = selected && comparison.key === comparisonKey && comparison.base?.id === candidate.baseVersion;
  const base = comparisonReady ? comparison.base : null;
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setComparison({key: comparisonKey, base: null, error: ''});
    void service.candidateBase(candidate.id).then((originalBase) => {
      if (originalBase.id !== candidate.baseVersion) throw new Error('The candidate base version does not match.');
      if (active) setComparison({key: comparisonKey, base: originalBase, error: ''});
    }).catch(() => {if (active) setComparison({key: comparisonKey, base: null, error: 'The original base comparison is unavailable. Refresh status and open this review again.'});});
    return () => {active = false;};
  }, [candidate.id, candidate.baseVersion, comparisonKey, selected, service]);
  const report = candidate.report;
  const approve = () => action(service, async () => {
    const latest = await service.snapshot();
    const current = latest.candidates.find((item) => item.id === candidate.id);
    const bound = current && approvalFor(current, latest.activeVersion.id);
    if (!comparisonReady || !approval || !bound || JSON.stringify(bound) !== JSON.stringify(approval)) throw new Error('This candidate changed. Refresh and review it again.');
    await service.approve(approval);
  });
  return <article className="grid min-w-0 gap-3 border-b border-border-subtle p-4 last:border-b-0" aria-label={candidate.summary}>
    <LumenText weight="medium">{candidate.summary}</LumenText>
    <LumenText tone="secondary" variant="meta">{candidate.status} · base version {candidate.baseVersion} · {candidate.kind}</LumenText>
    {candidate.baseVersion !== snapshot.activeVersion.id ? <SettingsCallout>Stale candidate: the active version changed.</SettingsCallout> : null}
    <details onToggle={(event) => setSelected(event.currentTarget.open)}><summary className="cursor-pointer text-sm text-text-secondary">Review changes and measurements</summary>
      {!base ? <LumenText tone="tertiary" variant="meta">{comparison.key === comparisonKey && comparison.error ? comparison.error : 'Loading original base comparison…'}</LumenText> : (
        <div className="grid min-w-0 gap-2 py-3">
          <LumenText variant="meta">Comparing against version {base.id}</LumenText>
          {(['answerInstructions', 'computerUseInstructions', 'toolHints'] as const).filter((field) => candidate.manifest[field] !== null).map((field) => <div key={field}><LumenText variant="meta">{field}</LumenText><pre className="whitespace-pre-wrap break-words rounded-control bg-surface-inset p-3 font-mono text-xs text-text-secondary">{`Before:\n${base[field] || '(empty)'}\n\nAfter:\n${candidate.manifest[field]}`}</pre></div>)}
          {candidate.kind === 'workflow' ? <pre className="whitespace-pre-wrap break-words rounded-control bg-surface-inset p-3 font-mono text-xs text-text-secondary">{`Before:\n${JSON.stringify(base.workflows, null, 2)}\n\nAfter:\n${JSON.stringify(candidate.manifest.workflows, null, 2)}`}</pre> : null}
        </div>
      )}
      {report ? <div className="min-w-0 overflow-x-auto py-3"><table className="w-full text-left text-xs text-text-secondary"><caption className="pb-2 text-left">{report.suiteVersion} · {report.complete ? 'Complete' : 'Incomplete'} · {report.passed ? 'Passed' : 'Failed'}{report.budgetExceeded ? ' · Budget exceeded' : ''}</caption><thead><tr><th>Case / set</th><th>Successes before → after</th><th>Latency ms before → after</th><th>Tokens in/out before → after</th></tr></thead><tbody>{report.cases.map((item) => <tr key={item.id}><td className="py-2 pr-3">{item.id} · {item.set}{item.safety ? ' · safety' : ''}</td><td className="pr-3">{item.baseline.successes}/{item.baseline.runs} → {item.candidate.successes}/{item.candidate.runs}</td><td className="pr-3">{item.baseline.latenciesMs.join(', ')} → {item.candidate.latenciesMs.join(', ')}</td><td>{item.baseline.inputTokens ?? 'unmetered'}/{item.baseline.outputTokens ?? 'unmetered'} → {item.candidate.inputTokens ?? 'unmetered'}/{item.candidate.outputTokens ?? 'unmetered'}</td></tr>)}</tbody></table>{report.reasons.map((reason, i) => <p key={i} className="text-xs text-text-secondary">{reason}</p>)}</div> : <LumenText tone="tertiary" variant="meta">No evaluation report available.</LumenText>}
    </details>
    {candidate.kind === 'workflow' ? <LumenText tone="tertiary" variant="meta">Approval publishes this bounded workflow. Computer Use only prepares a draft; execution still requires Run.</LumenText> : null}
    <div className="flex flex-wrap gap-2"><LumenButton aria-label={`Approve ${candidate.summary}`} isDisabled={busy || !approval || !comparisonReady} size="small" variant="primary" onPress={() => void approve()}>Approve</LumenButton><LumenButton aria-label={`Reject ${candidate.summary}`} isDisabled={busy || ['rejected', 'promoted', 'cancelled'].includes(candidate.status)} size="small" variant="quiet" onPress={() => void action(service, () => service.reject(candidate.id))}>Reject</LumenButton></div>
  </article>;
}
export function ImprovementGatewayControls({service = improvementService}: ControlsProps) {
  const {snapshot, health, busy, analyzing, message, action, analyze, cancel} = useImprovement(service);
  const settings = snapshot.settings;
  const canAnalyze = service.available && settings.enabled && !settings.paused && !snapshot.paused && health?.prepared && (settings.routeMode !== 'cloud' || settings.cloudConsent);
  return <>
    <SettingSection title="Continual improvement" description="Opt in to sanitized failure metadata and evaluated, reviewable harness changes. Fixed permissions and security rules remain native.">
      <SettingRow label="Enable continual improvement" description="Off by default. Uses the local improvement model unless you choose cloud."><LumenSwitch aria-label="Enable continual improvement" isDisabled={busy || !service.available || !health} isSelected={settings.enabled} onChange={(enabled) => void action(service, () => service.setSettings({...settings, enabled}))} /></SettingRow>
      <SettingRow label="Improvement model route" description="Cloud improvement requires its own consent in Privacy."><LumenSelect aria-label="Improvement model route" isDisabled={busy || !service.available || !health} value={settings.routeMode} options={[{id: 'local', label: 'Local'}, {id: 'cloud', label: 'Cloud'}]} onChange={(routeMode) => void action(service, () => service.setSettings({...settings, routeMode}))} /></SettingRow>
      <div className="grid gap-3 p-4"><LumenText weight="medium">Active version {snapshot.activeVersion.id}</LumenText><LumenText tone="secondary" variant="meta">{health?.state ?? 'Checking'} · Docker {health?.prepared ? 'prepared' : 'not prepared'} · Model {health?.modelReady ? 'ready' : 'not ready'}</LumenText>{health?.detail ? <SettingsCallout>{health.detail}</SettingsCallout> : null}{service.simulated ? <LumenText tone="tertiary" variant="meta">Simulated development data</LumenText> : null}<div className="flex flex-wrap gap-2"><LumenButton aria-label="Prepare improvement runtime" isDisabled={busy || analyzing || !settings.enabled || !service.available} size="small" onPress={() => void action(service, () => service.prepare())}>Prepare Docker runtime</LumenButton><LumenButton aria-label="Analyze improvement evidence" isDisabled={busy || analyzing || !canAnalyze} size="small" variant="primary" onPress={() => void analyze(service)}>Analyze</LumenButton><LumenButton aria-label="Cancel improvement analysis" isDisabled={busy || (!analyzing && !snapshot.job)} size="small" variant="quiet" onPress={() => void cancel(service)}>Cancel analysis</LumenButton><LumenButton aria-label="Refresh improvement status" isDisabled={busy} size="small" variant="quiet" onPress={() => void action(service, () => useImprovementStore.getState().refresh(service))}>Refresh</LumenButton></div>{snapshot.job ? <LumenText variant="meta">Analysis phase: {snapshot.job.phase}</LumenText> : null}{message ? <div role="status"><SettingsCallout>{message}</SettingsCallout></div> : null}
      {snapshot.activeVersion.id > 0 ? <div className="flex flex-wrap gap-2">{[...new Set([snapshot.activeVersion.parentId ?? 0, 0])].map((id) => <LumenButton key={id} aria-label={`Roll back to version ${id}`} isDisabled={busy || analyzing} size="small" variant="quiet" onPress={() => void action(service, () => service.rollback(id))}>Roll back to version {id}</LumenButton>)}</div> : null}</div>
    </SettingSection>
    <SettingSection title="Improvement candidates" description="Only complete passing evaluations for the current base can be approved.">{snapshot.candidates.length ? snapshot.candidates.map((candidate) => <CandidateReview key={candidate.id} candidate={candidate} service={service} />) : <div className="p-4"><LumenText tone="tertiary">No candidates.</LumenText></div>}</SettingSection>
    <ApprovedWorkflows service={service} />
  </>;
}
function ApprovedWorkflows({service}: {service: ImprovementService}) {
  const services = useContext(WorkflowServicesContext);
  const snapshot = useImprovementStore((s) => s.snapshot);
  const [task, setTask] = useState('');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<WorkflowResult | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const run = async (workflowId: string) => {
    if (!services || abort.current || !task.trim()) return;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true); setResult(null); setMessage('Authorizing approved workflow…');
    try {
      const ai = useSettingsStore.getState().ai;
      const output = await runApprovedWorkflow(service, workflowId, snapshot.activeVersion.id, task, services, controller.signal, {mode: ai.runtimeMode, cloudConsent: ai.cloudAnswerConsent}, setMessage);
      setResult(output); setMessage(output.draft ? 'Computer Use draft ready. Review target and consent, then use Run.' : 'Workflow completed.');
    } catch (error) {setMessage(error instanceof Error ? error.message : 'Workflow failed. Review before trying again.');}
    finally {abort.current = null; setRunning(false);}
  };
  if (!snapshot.activeVersion.workflows.length) return null;
  return <SettingSection title="Approved workflows" description="Each run captures this approved definition and version. Cancel stops remaining steps; Computer Use finishes with a draft."><div className="grid gap-3 p-4"><LumenTextField aria-label="Workflow task" value={task} onChange={setTask} placeholder="Describe the task" />{snapshot.activeVersion.workflows.map((w) => <div key={w.id} className="flex flex-wrap items-center gap-3"><LumenText>{w.name} · {w.steps.length} steps · version {snapshot.activeVersion.id}</LumenText><LumenButton aria-label={`Run workflow ${w.name}`} isDisabled={running || !services || !task.trim() || [...task].length > 4000 || !snapshot.settings.enabled || snapshot.paused} size="small" onPress={() => void run(w.id)}>Run workflow</LumenButton></div>)}{running ? <LumenButton size="small" variant="quiet" onPress={() => {abort.current?.abort(); setMessage('Cancelling workflow…');}}>Cancel workflow</LumenButton> : null}{message ? <div role="status"><SettingsCallout>{message}</SettingsCallout></div> : null}{result?.search ? <LumenText variant="meta">{result.search.total} search results</LumenText> : null}{result?.answer ? <p className="whitespace-pre-wrap text-sm text-text-secondary">{result.answer}</p> : null}</div></SettingSection>;
}
export function ImprovementActivityControls({service = improvementService}: ControlsProps) {
  const {snapshot, health, busy, action, message} = useImprovement(service);
  return <SettingSection title="Improvement activity"><SettingRow label="Pause continual improvement" description="Independent of indexing and enrichment activity."><LumenSwitch aria-label="Pause continual improvement" isDisabled={busy || !service.available || !health} isSelected={snapshot.settings.paused} onChange={(paused) => void action(service, () => service.setSettings({...snapshot.settings, paused}))} /></SettingRow>{message ? <SettingsCallout>{message}</SettingsCallout> : null}</SettingSection>;
}
export function ImprovementPrivacyControls({service = improvementService}: ControlsProps) {
  const {snapshot, health, busy, action, message} = useImprovement(service);
  const [language, setLanguage] = useState<'sv' | 'en' | 'system'>('system');
  const [verbosity, setVerbosity] = useState<'brief' | 'normal' | 'detailed'>('normal');
  const languageDirty = useRef(false);
  const verbosityDirty = useRef(false);
  useEffect(() => {for (const pref of snapshot.activeVersion.preferences) {if (pref.name === 'answerLanguage' && !languageDirty.current) setLanguage(pref.value); if (pref.name === 'answerVerbosity' && !verbosityDirty.current) setVerbosity(pref.value);}}, [snapshot.activeVersion.preferences]);
  return <SettingSection title="Improvement privacy" description="Learning stores allowlisted outcome metadata. Task text, paths, file contents, screenshots and credentials are excluded.">
    <SettingRow label="Improvement cloud consent" description="Allows sanitized improvement evidence and synthetic evaluation requests to the configured cloud provider. Independent of answers and Computer Use."><LumenSwitch aria-label="Improvement cloud consent" isDisabled={busy || !service.available || !health} isSelected={snapshot.settings.cloudConsent} onChange={(cloudConsent) => void action(service, () => service.setSettings({...snapshot.settings, cloudConsent}))} /></SettingRow>
    <SettingRow label="Answer language" description="Saved only when you explicitly press Save."><div className="flex flex-wrap gap-2"><LumenSelect aria-label="Answer language" isDisabled={busy || !service.available || !health} value={language} options={[{id: 'system', label: 'System'}, {id: 'sv', label: 'Swedish'}, {id: 'en', label: 'English'}]} onChange={(value) => {languageDirty.current = true; setLanguage(value);}} /><LumenButton aria-label="Save answer language preference" isDisabled={busy || !service.available || !health} size="small" onPress={() => void action(service, () => service.savePreference(preferenceSchema.parse({name: 'answerLanguage', value: language})))}>Save</LumenButton></div></SettingRow>
    <SettingRow label="Answer verbosity" description="Saved preferences are reviewable harness versions."><div className="flex flex-wrap gap-2"><LumenSelect aria-label="Answer verbosity" isDisabled={busy || !service.available || !health} value={verbosity} options={[{id: 'brief', label: 'Brief'}, {id: 'normal', label: 'Normal'}, {id: 'detailed', label: 'Detailed'}]} onChange={(value) => {verbosityDirty.current = true; setVerbosity(value);}} /><LumenButton aria-label="Save answer verbosity preference" isDisabled={busy || !service.available || !health} size="small" onPress={() => void action(service, () => service.savePreference(preferenceSchema.parse({name: 'answerVerbosity', value: verbosity})))}>Save</LumenButton></div></SettingRow>
    <SettingRow label="Delete all improvement data" description="Deletes traces, candidates, harness versions and explicit preferences, and disables improvement."><ConfirmationDialog title="Delete all improvement data?" description="This permanently removes improvement evidence, candidates, versions and preferences. Source files are unaffected." confirmLabel="Delete improvement data permanently" onConfirm={() => {void useImprovementStore.getState().clear(service).then((cleared) => {if (cleared) {languageDirty.current = false; verbosityDirty.current = false; setLanguage('system'); setVerbosity('normal');}});}}><LumenButton isDisabled={busy || !service.available || !health} size="small" variant="danger">Delete improvement data</LumenButton></ConfirmationDialog></SettingRow>
    {message ? <SettingsCallout>{message}</SettingsCallout> : null}
  </SettingSection>;
}
export function ImprovementDiagnostics({service = improvementService}: ControlsProps) {
  const {snapshot, health} = useImprovement(service);
  return <SettingSection title="Improvement diagnostics" description={service.simulated ? 'Simulated development metrics' : 'Sanitized runtime metrics'}><DiagnosticItem label="Improvement runtime">{health?.state ?? 'Checking'} · {health?.version ?? 'unknown'} · {health?.prepared ? 'prepared' : 'not prepared'} · {health?.modelReady ? 'model ready' : 'model not ready'}</DiagnosticItem><DiagnosticItem label="Improvement traces">{snapshot.traceCount}</DiagnosticItem><DiagnosticItem label="Harness version">{snapshot.activeVersion.id}</DiagnosticItem><DiagnosticItem label="Improvement job">{snapshot.job ? `${snapshot.job.id} · ${snapshot.job.phase}` : 'Idle'}</DiagnosticItem></SettingSection>;
}
