import {act, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, expect, it, vi} from 'vitest';
import {AppProviders} from '../../../app/AppProviders';
import {nativeAiService} from '../../../services/ai/native-ai-service';
import {providerRegistryService} from '../../../services/ai/provider-registry-service';
import {mcpService} from '../../../services/ai/mcp-service';
import {createActivityService} from '../../../services/activity/activity-service';
import {useSettingsStore} from '../settings.store';
import {ActivityPage} from './ActivityPage';
import {AgentGatewayPage} from './AgentGatewayPage';

const defaultUpdateActivity = useSettingsStore.getState().updateActivity;
afterEach(() => {useSettingsStore.setState({updateActivity: defaultUpdateActivity}); useSettingsStore.getState().reset(); localStorage.clear();});

it('does not restore an obsolete Activity policy after a newer setting replaces it', async () => {
  const user = userEvent.setup();
  const service = createActivityService();
  const apply = vi.spyOn(service, 'setPolicy');
  let finish!: (saved: boolean) => void;
  useSettingsStore.setState({updateActivity: () => new Promise<boolean>((resolve) => {finish = resolve;})});
  render(<AppProviders><ActivityPage activityService={service} nativeRuntime /></AppProviders>);
  await user.click(screen.getByRole('switch', {name: 'Detect games automatically'}));
  act(() => useSettingsStore.setState((state) => ({activity: {...state.activity, pauseOnBattery: false}})));
  await act(async () => finish(false));
  expect(apply).toHaveBeenCalledOnce();
  expect(useSettingsStore.getState().activity.pauseOnBattery).toBe(false);
});

it('holds Activity mutations while policy is pending and catches picker rejection', async () => {
  const user = userEvent.setup();
  const service = createActivityService();
  let finish!: () => void;
  vi.spyOn(service, 'setPolicy').mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {finish = resolve;});
    return service.status();
  });
  vi.spyOn(service, 'chooseExecutable').mockRejectedValueOnce(new Error('Picker denied'));
  render(<AppProviders><ActivityPage activityService={service} nativeRuntime /></AppProviders>);
  await user.click(screen.getByRole('switch', {name: 'Detect games automatically'}));
  expect(screen.getByRole('button', {name: 'Pause indexing'})).toBeDisabled();
  expect(screen.getByRole('button', {name: 'Choose application executable'})).toBeDisabled();
  await act(async () => finish());
  await user.click(screen.getByRole('button', {name: 'Choose application executable'}));
  expect(await screen.findByText('Picker denied')).toBeVisible();
  expect(screen.getByRole('button', {name: 'Choose application executable'})).toBeEnabled();
});

it('bounds enrichment Pause to one pending operation and shows rejected results', async () => {
  const user = userEvent.setup();
  vi.spyOn(nativeAiService, 'gatewayHealth').mockResolvedValue({state: 'ready', version: 'fixture', detail: 'fixture', interactivePort: 1, enrichmentPort: 2, adminPort: 3, cloudCredentialConfigured: false});
  vi.spyOn(nativeAiService, 'enrichmentHealth').mockResolvedValue({state: 'ready', paused: false, detail: 'fixture', controlPort: 1, actorPort: 2});
  vi.spyOn(providerRegistryService, 'list').mockResolvedValue({providers: [], models: [], routes: []});
  vi.spyOn(mcpService, 'list').mockResolvedValue({services: [], permissions: []});
  let reject!: (error: Error) => void;
  vi.spyOn(nativeAiService, 'pauseEnrichment').mockImplementationOnce(() => new Promise((_, fail) => {reject = fail;}));
  render(<AppProviders><AgentGatewayPage nativeRuntime /></AppProviders>);
  await user.click(await screen.findByRole('button', {name: 'Pause'}));
  expect(screen.getByRole('button', {name: 'Pause'})).toBeDisabled();
  expect(screen.getByRole('button', {name: 'Restart AgentGateway'})).toBeDisabled();
  await act(async () => reject(new Error('Worker unavailable')));
  expect(await screen.findByText('Worker unavailable')).toBeVisible();
  expect(screen.getByRole('button', {name: 'Pause'})).toBeEnabled();
});
