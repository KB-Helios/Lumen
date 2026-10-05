import {GatewayIcon} from '../../design-system/icons/lumen-icons';
import {LumenUiIcon, type LumenUiIconName} from '../../design-system/icons/LumenUiIcon';
import {LumenButton} from '../../design-system/primitives/LumenButton';
import {LumenText} from '../../design-system/primitives/LumenText';
import type {GatewayState} from './gateway.types';

const stateCopy: Record<GatewayState, {label: string; description: string; tone: 'success' | 'warning' | 'info'}> = {
  starting: {label: 'Starting', description: 'The local gateway is establishing provider routes.', tone: 'info'},
  restarting: {label: 'Restarting', description: 'Local search remains available while routes restart.', tone: 'info'},
  ready: {label: 'Ready', description: 'The checksum-pinned AgentGateway sidecar is running.', tone: 'success'},
  unavailable: {label: 'Unavailable', description: 'AI routes are unavailable; local search is unaffected.', tone: 'warning'},
};

export function GatewayStatusPanel({state, onRestart}: {state: GatewayState; onRestart(): void}) {
  const copy = stateCopy[state];
  const stateIcon: LumenUiIconName = copy.tone === 'success' ? 'success' : copy.tone === 'warning' ? 'error' : 'refresh';
  return (
    <section aria-label="AgentGateway status" className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-[16px] rounded-surface border border-border-subtle bg-surface-inset p-[16px] @min-[34rem]/settings:grid-cols-[auto_minmax(0,1fr)_auto]" data-testid={`gateway-${state}`}>
      <span aria-hidden="true" className="grid size-[48px] place-items-center rounded-control bg-surface-raised text-text-secondary"><GatewayIcon size={26} /></span>
      <div className="grid min-w-0 gap-1">
        <div aria-label={copy.label} className="flex min-w-0 items-center gap-[8px]" role="status">
          <LumenUiIcon name={stateIcon} size="small" />
          <LumenText weight="semibold">{copy.label}</LumenText>
        </div>
        <LumenText tone="tertiary" variant="meta">{copy.description}</LumenText>
      </div>
      <LumenButton aria-label="Restart AgentGateway" className="col-span-full justify-self-start @min-[34rem]/settings:col-auto" size="small" onPress={onRestart}>Restart</LumenButton>
    </section>
  );
}
