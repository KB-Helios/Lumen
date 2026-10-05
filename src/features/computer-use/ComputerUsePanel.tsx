import {LumenUiIcon} from '../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../design-system/primitives/LumenButton';
import {LumenText} from '../../design-system/primitives/LumenText';
import type {ComputerUseController} from './useComputerUseController';

function phaseLabel(controller: ComputerUseController) {
  switch (controller.phase) {
    case 'starting': return 'Starting Edge';
    case 'running': return 'Working';
    case 'approval': return 'Approval required';
    case 'completed': return 'Completed';
    case 'cancelled': return 'Stopped';
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
  cloudConsent,
  onOpenSettings,
  onStart,
}: ComputerUsePanelProps) {
  const active = controller.phase === 'starting' || controller.phase === 'running' || controller.phase === 'approval';
  const setupReady = controller.health?.state === 'ready'
    && controller.health.credentialConfigured
    && cloudConsent;
  const setupMessage = !controller.health
    ? 'Checking the local Computer Use worker…'
    : controller.health.state !== 'ready'
      ? controller.health.detail ?? 'The Computer Use worker is unavailable.'
      : !controller.health.credentialConfigured
        ? 'Add a Gemini API key in Computer Use settings.'
        : !cloudConsent
          ? 'Review and grant browser screenshot consent in Computer Use settings.'
          : 'A separate Microsoft Edge session will carry out this browser-only task.';

  return (
    <section aria-label="Computer Use workspace" className="@container/computer-use grid h-full min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden border-t border-border-subtle [overflow-wrap:anywhere]">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-[8px] border-b border-border-subtle px-[16px] py-[10px]">
        <div className="flex min-w-0 flex-wrap items-center gap-x-[12px] gap-y-[4px]">
          <LumenUiIcon className="text-accent" name="computer" size="medium" />
          <LumenText weight="semibold">Computer Use</LumenText>
          <LumenText tone="tertiary" variant="meta">Gemini · browser only</LumenText>
        </div>
        <LumenText aria-label={phaseLabel(controller)} className="max-w-full rounded-pill bg-surface-inset px-[10px] py-[4px] text-text-secondary" role="status" variant="caption">{phaseLabel(controller)}</LumenText>
      </header>
      <div className="grid min-h-0 min-w-0 content-start gap-[16px] overflow-y-auto p-[16px]" tabIndex={-1}>
        <div className="grid min-w-0 gap-[12px] rounded-control border border-border-subtle bg-surface-inset p-[16px]">
          <LumenText weight="medium">Protected browser session</LumenText>
          <LumenText tone="secondary" variant="meta">{setupMessage}</LumenText>
          <LumenText tone="tertiary" variant="caption">
            Lumen sends the task and browser screenshots to Gemini. File URLs and desktop control are blocked; sensitive actions pause here for approval.
          </LumenText>
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
            <LumenText weight="semibold">Gemini needs your approval</LumenText>
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
          {controller.model ?? 'gemini-3.6-flash'} · {controller.browser ?? 'Microsoft Edge'}
        </LumenText>
        <div className="flex min-w-0 flex-wrap items-center gap-[8px]">
          {!setupReady && !active ? (
            <LumenButton size="small" variant="quiet" onPress={onOpenSettings}>
              <LumenUiIcon name="settings" size="small" /> Open settings
            </LumenButton>
          ) : null}
          {active ? (
            <LumenButton size="small" variant="quiet" onPress={controller.stop}>
              <LumenUiIcon name="stop" size="small" /> Stop
            </LumenButton>
          ) : (
            <LumenButton isDisabled={!setupReady || !draftTask.trim()} size="small" variant="primary" onPress={onStart}>
              <LumenUiIcon name="computer" size="small" /> Run in Edge
            </LumenButton>
          )}
        </div>
      </footer>
    </section>
  );
}
