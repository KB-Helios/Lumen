import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {AppProviders} from '../../../app/AppProviders';
import {nativeAiService} from '../../../services/ai/native-ai-service';
import type {ProvisioningService, ProvisioningStatus} from '../../../services/ai/provisioning-service';
import {LocalAiPage} from './LocalAiPage';
import {useSettingsStore} from '../settings.store';

vi.mock('../../../services/ai/native-ai-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/ai/native-ai-service')>();
  return {
    ...actual,
    isNativeRuntime: () => true,
    nativeAiService: {
      ...actual.nativeAiService,
      localRuntimeHealth: vi.fn(),
      setLocalRuntimeMode: vi.fn(),
    },
  };
});

describe('LocalAiPage native refresh', () => {
  const provisioningStatus = (state: ProvisioningStatus['state']): ProvisioningStatus => ({
    profileId: 'local-core',
    label: 'Local core',
    version: '11.5.2',
    installedVersion: state === 'ready' ? '11.5.2' : null,
    state,
    phase: state === 'working' ? 'downloadingModels' : 'idle',
    downloadedBytes: state === 'working' ? 1_000 : 0,
    totalBytes: 4_000,
    requiredDiskBytes: 4_200_000_000,
    progress: state === 'working' ? 25 : state === 'ready' ? 100 : 0,
    canDownload: state === 'missing' || state === 'failed' || state === 'cancelled',
    canUpdate: state === 'updateAvailable',
    canCancel: state === 'working',
    detail: null,
    models: [
      {id: 'extra.Qwen3.5-4B-UD-Q4_K_XL.gguf', label: 'Qwen 3.5 4B', state: state === 'ready' ? 'ready' : 'missing'},
      {id: 'extra.nomic-embed-text-v1.Q4_K_S.gguf', label: 'Nomic Embed Text v1', state: state === 'ready' ? 'ready' : 'missing'},
    ],
  });

  const service = (status: ProvisioningStatus): ProvisioningService => ({
    status: vi.fn().mockResolvedValue(status),
    start: vi.fn().mockResolvedValue({...status, state: 'working', canDownload: false, canCancel: true}),
    cancel: vi.fn().mockResolvedValue({...status, state: 'cancelled', canDownload: true, canCancel: false}),
    subscribe: vi.fn().mockResolvedValue(() => undefined),
  });

  beforeEach(() => {
    useSettingsStore.getState().reset();
    vi.mocked(nativeAiService.setLocalRuntimeMode).mockReset();
    vi.mocked(nativeAiService.setLocalRuntimeMode).mockResolvedValue(undefined);
    vi.mocked(nativeAiService.localRuntimeHealth).mockReset();
    vi.mocked(nativeAiService.localRuntimeHealth).mockResolvedValue({
      profile: 'generic-local',
      state: 'ready',
      accelerator: 'CPU',
      answerModel: 'extra.Qwen3.5-4B-UD-Q4_K_XL.gguf',
      embeddingModel: 'extra.nomic-embed-text-v1.Q4_K_S.gguf',
      transcriptionModel: 'whisper',
      baseUrl: 'http://127.0.0.1:13305/v1',
      lemonade: {installed: true, version: '10.0', requiredVersion: '10.0', state: 'ready'},
      flm: {installed: true, version: '0.9.43', requiredVersion: '0.9.43', state: 'ready'},
      mistralRs: {installed: false, requiredVersion: '0.7', state: 'missing'},
    });
  });
  afterEach(() => useSettingsStore.getState().reset());

  it('shows safe retry guidance when mode application rejects despite already-loaded health', async () => {
    const user = userEvent.setup();
    vi.mocked(nativeAiService.setLocalRuntimeMode)
      .mockRejectedValue(new Error('busy fixture sk-private-key https://private.example subprocess output'));
    render(
      <AppProviders appearance={{mode: 'dark', transparency: 'disabled', effects: 'reduced', motion: 'reduced'}}>
        <LocalAiPage provisioningService={service(provisioningStatus('ready'))} />
      </AppProviders>,
    );
    await screen.findByText(/The loopback provider is ready/);
    await user.click(screen.getByRole('switch', {name: 'Keep local model warm'}));

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('The local runtime settings could not be applied. Wait for current preparation to finish, then retry.');
    expect(notice).not.toHaveTextContent(/sk-private-key|private\.example|subprocess output/);
    expect(useSettingsStore.getState().ai.keepLocalWarm).toBe(true);
    expect(nativeAiService.setLocalRuntimeMode).toHaveBeenCalledWith('auto', true);

    vi.mocked(nativeAiService.setLocalRuntimeMode).mockResolvedValue(undefined);
    await user.click(screen.getByRole('button', {name: 'Retry local runtime settings'}));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(nativeAiService.setLocalRuntimeMode).toHaveBeenCalledTimes(2);
  });

  it('does not replace a newer successful mode application with an old rejection', async () => {
    const user = userEvent.setup();
    let rejectOld!: (error: Error) => void;
    vi.mocked(nativeAiService.setLocalRuntimeMode)
      .mockImplementationOnce(() => new Promise<void>((_, reject) => {rejectOld = reject;}))
      .mockResolvedValue(undefined);
    render(
      <AppProviders appearance={{mode: 'dark', transparency: 'disabled', effects: 'reduced', motion: 'reduced'}}>
        <LocalAiPage provisioningService={service(provisioningStatus('ready'))} />
      </AppProviders>,
    );
    await screen.findByText(/The loopback provider is ready/);
    const toggle = screen.getByRole('switch', {name: 'Keep local model warm'});
    await user.click(toggle);
    await user.click(toggle);
    await act(async () => {rejectOld(new Error('obsolete busy fixture'));});

    expect(useSettingsStore.getState().ai.keepLocalWarm).toBe(false);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(nativeAiService.setLocalRuntimeMode).toHaveBeenLastCalledWith('auto', false);
  });

  it('handles a pending mode rejection after unmount without changing the runtime notice', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({localRuntimeError: null});
    let rejectMode!: (error: Error) => void;
    vi.mocked(nativeAiService.setLocalRuntimeMode)
      .mockImplementation(() => new Promise<void>((_, reject) => {rejectMode = reject;}));
    const {unmount} = render(
      <AppProviders appearance={{mode: 'dark', transparency: 'disabled', effects: 'reduced', motion: 'reduced'}}>
        <LocalAiPage provisioningService={service(provisioningStatus('ready'))} />
      </AppProviders>,
    );
    await screen.findByText(/The loopback provider is ready/);
    await user.click(screen.getByRole('switch', {name: 'Keep local model warm'}));
    unmount();
    await act(async () => {rejectMode(new Error('late busy fixture'));});

    expect(useSettingsStore.getState().localRuntimeError).toBeNull();
  });

  it('refreshes native health when a deterministic preview model is removed', async () => {
    const appearance = {
      mode: 'dark' as const,
      transparency: 'disabled' as const,
      effects: 'reduced' as const,
      motion: 'reduced' as const,
    };
    const {rerender} = render(
      <AppProviders appearance={appearance}>
        <LocalAiPage model={{hardware: 'cpu', state: 'ready'}} />
      </AppProviders>,
    );

    expect(nativeAiService.localRuntimeHealth).not.toHaveBeenCalled();

    rerender(
      <AppProviders appearance={appearance}>
        <LocalAiPage />
      </AppProviders>,
    );

    await waitFor(() => expect(nativeAiService.localRuntimeHealth).toHaveBeenCalledOnce());
  });

  it('never offers a simulated model download in the native app', async () => {
    vi.mocked(nativeAiService.localRuntimeHealth).mockRejectedValue(new Error('runtime unavailable'));

    render(
      <AppProviders appearance={{mode: 'dark', transparency: 'disabled', effects: 'reduced', motion: 'reduced'}}>
        <LocalAiPage />
      </AppProviders>,
    );

    expect(await screen.findByText('runtime unavailable')).toBeVisible();
    expect(screen.queryByRole('button', {name: /Download preview/})).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Retry runtime check'})).toBeEnabled();
  });

  it('starts only the closed local-core profile from a real Download action', async () => {
    const user = userEvent.setup();
    const provisioning = service(provisioningStatus('missing'));

    render(
      <AppProviders appearance={{mode: 'dark', transparency: 'disabled', effects: 'reduced', motion: 'reduced'}}>
        <LocalAiPage provisioningService={provisioning} />
      </AppProviders>,
    );

    await user.click(await screen.findByRole('button', {name: 'Download local core'}));
    expect(provisioning.start).toHaveBeenCalledWith('local-core');
    expect(screen.queryByRole('button', {name: /Download preview/})).not.toBeInTheDocument();
  });

  it('shows Cancel while native provisioning is active', async () => {
    const provisioning = service(provisioningStatus('working'));

    render(
      <AppProviders appearance={{mode: 'dark', transparency: 'disabled', effects: 'reduced', motion: 'reduced'}}>
        <LocalAiPage provisioningService={provisioning} />
      </AppProviders>,
    );

    expect(await screen.findByRole('button', {name: 'Cancel local core download'})).toBeEnabled();
    expect(screen.getByText('25%')).toBeVisible();
  });
});
