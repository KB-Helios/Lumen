import {LumenButton} from '../../design-system/primitives/LumenButton';
import {LumenText} from '../../design-system/primitives/LumenText';
import {canUseWindowsAiFeature} from '../../services/windows-ai/windows-ai.types';
import {useQueryStore} from '../launcher/query.store';
import {LumenSelect} from '../settings/components/SettingsControls';
import {useWindowsAiStore} from './windows-ai.store';

export function WindowsAgentPicker({selected, busy, message, onChange, onRun}: {selected: string; busy: boolean; message: string; onChange(id: string): void; onRun(): void}) {
  const snapshot = useWindowsAiStore((state) => state.snapshot);
  const task = useQueryStore((state) => state.committed);
  if (!snapshot?.preferences.agentsEnabled || !snapshot.agents.length) return null;
  const agent = snapshot.agents.find((agent) => agent.id === selected);
  const ready = canUseWindowsAiFeature(snapshot.features.find((item) => item.id === 'agentInvocation'));
  return <section aria-label="Windows agent selection" className="grid gap-3 border-t border-border-subtle p-5">
    <LumenSelect aria-label="Agent application" isDisabled={busy} value={selected} options={[{id: '', label: 'Lumen browser agent'}, ...snapshot.agents.map((agent) => ({id: agent.id, label: agent.displayName}))]} onChange={onChange} />
    {agent ? <>
      <LumenText weight="medium">{agent.displayName}</LumenText>
      <LumenText tone="secondary" variant="meta">{agent.description}</LumenText>
      <LumenText tone="tertiary" variant="caption">Run sends the draft prompt to this installed application. That application controls execution and its own data policy.</LumenText>
      <LumenButton aria-label="Run selected Windows agent" isDisabled={busy || !ready || !task.trim() || task.trim().length > 4000} size="small" onPress={onRun}>{busy ? 'Sending prompt' : 'Run agent'}</LumenButton>
      <LumenText role="status" tone="secondary" variant="meta">{message || (!ready ? 'The agent invocation API is unavailable.' : 'Review the draft before running.')}</LumenText>
    </> : null}
  </section>;
}
