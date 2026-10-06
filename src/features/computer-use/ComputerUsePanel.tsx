import {LumenUiIcon} from '../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../design-system/primitives/LumenButton';
import {LumenText} from '../../design-system/primitives/LumenText';
import {LumenCheckbox, LumenSelect} from '../settings/components/SettingsControls';
import type {ComputerUseController} from './useComputerUseController';

function phaseLabel(controller: ComputerUseController) {
  switch (controller.phase) {
    case 'starting': return 'Starting';
    case 'running': return 'Working';
    case 'approval': return 'Approval required';
    case 'completed': return 'Completed';
    case 'stopping': return 'Stopping';
    case 'stopped': return 'Stopped';
    case 'error': return 'Unavailable';
    default: return controller.health?.state === 'ready' ? 'Ready' : 'Setup required';
  }
}

export interface ComputerUsePanelProps {
  controller: ComputerUseController;
  draftTask: string;
  cloudConsent: boolean;
  onOpenSettings(): void;
  onStart(): void;
}

export function ComputerUsePanel({
  controller,
  draftTask,
  onOpenSettings,
  onStart,
}: ComputerUsePanelProps) {
  const active = ['starting', 'running', 'approval', 'stopping'].includes(controller.phase);
  const setupReady = controller.health?.state === 'ready' && !controller.refusal;
  const providerLabel = controller.provider === 'openai' ? 'OpenAI' : 'Gemini';
  const windowTarget = controller.target?.kind === 'window';
  const selectedTargetId = controller.target?.kind === 'window' ? controller.target.targetId : 'browser';
  const setupMessage = controller.refusal ?? (windowTarget ? 'Only the selected native window can receive input. Its identity is checked before each action.' : 'Every browser task uses a fresh Microsoft Edge context.');
  const targetOptions = [{id: 'browser', label: 'Fresh Microsoft Edge'}, ...(controller.targets ?? []).map((target) => ({id: target.targetId, label: `${target.title || target.processName}${target.available ? '' : ` · ${target.reason ?? 'Unavailable'}`}`}))];

  return (
    <section aria-label="Computer Use workspace" className="@container/computer-use grid h-full min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden border-t border-border-subtle [overflow-wrap:anywhere]">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-[8px] border-b border-border-subtle px-[16px] py-[10px]">
        <div className="flex min-w-0 flex-wrap items-center gap-x-[12px] gap-y-[4px]">
          <LumenUiIcon className="text-accent" name="computer" size="medium" />
          <LumenText weight="semibold">Computer Use</LumenText>
          <LumenText tone="tertiary" variant="meta">{providerLabel} · {controller.executionMode === 'background' ? 'Background' : 'Fast'}{controller.simulated ? ' · Simulated' : ''}</LumenText>
        </div>
        <LumenText aria-label={phaseLabel(controller)} className="max-w-full rounded-pill bg-surface-inset px-[10px] py-[4px] text-text-secondary" role="status" variant="caption">{phaseLabel(controller)}</LumenText>
      </header>
      <div className="grid min-h-0 min-w-0 content-start gap-[16px] overflow-y-auto p-[16px]" tabIndex={-1}>
        <div className="grid min-w-0 gap-[12px] rounded-control border border-border-subtle bg-surface-inset p-[16px]">
          <LumenText weight="medium">{windowTarget ? 'Selected Windows window' : 'Fresh browser session'}</LumenText>
          <LumenText tone="secondary" variant="meta">{setupMessage}</LumenText>
          <LumenText tone="tertiary" variant="caption">
            {controller.simulated ? 'This preview simulates progress and approvals. It sends no native input or provider requests.' : `Lumen sends task and selected-target observations to ${providerLabel} with your separate consent. Background refuses unsupported actions; Fast asks before foreground input.`}
          </LumenText>
          {!active ? <>
            <LumenSelect aria-label="Computer Use target" options={targetOptions} value={selectedTargetId} onChange={controller.selectTarget} />
            <LumenButton size="small" variant="quiet" onPress={() => void controller.refreshHealth()}>Refresh targets</LumenButton>
            {controller.target?.kind === 'browser' ? <LumenCheckbox isDisabled={controller.executionMode === 'background' && !controller.target.visible} isSelected={controller.target.visible ?? false} onChange={controller.setVisibleBrowser}>Request visible browser (Fast only)</LumenCheckbox> : null}
          </> : null}
        </div>
        {controller.task ? (
          <div className="grid min-w-0 gap-[12px] rounded-control border border-border-subtle bg-surface-inset p-[16px]">
            <LumenText tone="tertiary" variant="caption">Current task</LumenText>
            <p className="m-0 font-sans text-sm leading-relaxed text-text-primary">{controller.task}</p>
            {controller.currentUrl ? (
              <LumenText className="min-w-0 truncate" tone="tertiary" variant="caption">
                {controller.currentUrl}
              </LumenText>
            ) : null}
          </div>
        ) : null}
        {controller.reasoning ? (
          <div aria-live="polite" className="grid min-w-0 gap-[12px] rounded-control border border-border-subtle bg-surface-inset p-[16px]">
            <LumenText tone="tertiary" variant="caption">Agent update</LumenText>
            <LumenText tone="secondary">{controller.reasoning}</LumenText>
          </div>
        ) : null}
        {controller.approval ? (
          <div aria-label="Approve Computer Use action" className="grid min-w-0 gap-[16px] rounded-control border border-accent/40 bg-accent/10 p-[16px]" role="alertdialog">
            <LumenText weight="semibold">{controller.approval.scope === 'foreground' ? 'Allow one foreground action?' : controller.approval.scope === 'visibleBrowser' ? 'Allow visible browser launch?' : `${providerLabel} needs your approval`}</LumenText>
            <LumenText tone="secondary">{controller.approval.explanation}</LumenText>
            <div className="flex min-w-0 flex-wrap items-center gap-[8px]">
              <LumenButton variant="primary" onPress={() => void controller.approve()}>
                <LumenUiIcon name="success" size="small" /> Approve once
              </LumenButton>
              <LumenButton variant="quiet" onPress={() => void controller.deny()}>
                <LumenUiIcon name="close" size="small" /> Deny and stop
              </LumenButton>
            </div>
          </div>
        ) : null}
        {controller.summary ? (
          <div aria-live="polite" className="grid min-w-0 gap-[12px] rounded-control border border-border-subtle bg-surface-inset p-[16px]">
            <LumenText weight="medium">Task complete</LumenText>
            <LumenText tone="secondary">{controller.summary}</LumenText>
          </div>
        ) : null}
        {controller.error ? (
          <div className="grid min-w-0 gap-[12px] rounded-control border border-danger/40 bg-danger/10 p-[16px]" role="alert">
            <LumenText weight="medium">Computer Use could not continue</LumenText>
            <LumenText tone="secondary">{controller.error}</LumenText>
          </div>
        ) : null}
        {controller.activity.length > 0 ? (
          <ul aria-label="Computer Use activity" className="m-0 grid min-w-0 list-none gap-[8px] p-0">
            {controller.activity.map((item) => (
              <li key={item.id} className="flex min-w-0 items-center gap-[12px]">
                <span aria-hidden="true" className={['size-1.5 shrink-0 rounded-pill', item.tone === 'accent' ? 'bg-accent' : item.tone === 'success' ? 'bg-success' : 'bg-text-tertiary'].join(' ')} />
                <LumenText tone="secondary" variant="meta">{item.label}</LumenText>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <footer className="flex min-w-0 flex-wrap items-center justify-between gap-[8px] border-t border-border-subtle px-[16px] py-[10px]">
        <LumenText className="min-w-0 w-full @min-[32rem]/computer-use:w-auto" tone="tertiary" variant="caption">
          {controller.model ?? 'gemini-3.8-flash'} · {windowTarget ? 'Selected window' : controller.browser ?? 'Microsoft Edge'}
        </LumenText>
        <div className="flex min-w-0 flex-wrap items-center gap-[8px]">
          {!setupReady && !active ? (
            <LumenButton size="small" variant="quiet" onPress={onOpenSettings}>
              <LumenUiIcon name="settings" size="small" /> Open settings
            </LumenButton>
          ) : null}
          {active ? (
            <>
            <LumenButton size="small" variant="quiet" onPress={controller.stop}>
              <LumenUiIcon name="stop" size="small" /> Stop
            </LumenButton>
            <LumenButton size="small" variant="quiet" onPress={controller.takeOver}>Take Over</LumenButton>
            </>
          ) : (
            <LumenButton isDisabled={!setupReady || !draftTask.trim()} size="small" variant="primary" onPress={onStart}>
              <LumenUiIcon name="computer" size="small" /> {windowTarget ? 'Run in selected window' : 'Run in Edge'}
            </LumenButton>
          )}
        </div>
      </footer>
    </section>
  );
}
