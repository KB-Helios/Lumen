import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AppProviders} from '../../../app/AppProviders';
import {nativeAiService} from '../../../services/ai/native-ai-service';
import {TauriComputerUseService} from '../../../services/computer-use/tauri-computer-use-service';
import {unavailableComputerUseHealth} from '../../../services/computer-use/computer-use.types';
import {useSettingsStore} from '../settings.store';
import {ComputerUsePage} from './ComputerUsePage';

afterEach(() => {Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); useSettingsStore.getState().reset(); localStorage.clear();});
describe('Computer Use settings controls', () => {
  it('grants desktop control and cloud observations in separate confirmations', async () => {
    const user = userEvent.setup();
    render(<AppProviders><ComputerUsePage /></AppProviders>);
    await user.click(screen.getByRole('button', {name: 'Review desktop control consent'}));
    await user.click(screen.getByRole('button', {name: 'Allow selected-window control'}));
    await waitFor(() => expect(useSettingsStore.getState().computerUse.desktopControlConsent).toBe(true));
    expect(useSettingsStore.getState().computerUse.desktopCloudConsent).toBe(false);
    expect(useSettingsStore.getState().computerUse.cloudConsent).toBe(false);
    await user.click(screen.getByRole('button', {name: 'Review desktop cloud consent'}));
    await user.click(screen.getByRole('button', {name: 'Allow desktop observations'}));
    await waitFor(() => expect(useSettingsStore.getState().computerUse.desktopCloudConsent).toBe(true));
    expect(useSettingsStore.getState().ai.cloudAnswerConsent).toBe(false);
  });
  it('keeps provider-specific saved models when switching providers', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState((state) => ({computerUse: {...state.computerUse, model: 'saved-unsupported-model'}}));
    render(<AppProviders><ComputerUsePage /></AppProviders>);
    expect(screen.getByText(/Saved model saved-unsupported-model is unavailable/)).toBeVisible();
    await user.click(screen.getByRole('button', {name: /Computer Use provider/}));
    await user.click(screen.getByRole('option', {name: 'OpenAI'}));
    expect(useSettingsStore.getState().computerUse.provider).toBe('openai');
    expect(useSettingsStore.getState().computerUse.model).toBe('saved-unsupported-model');
    expect(useSettingsStore.getState().computerUse.openaiModel).toBe('gpt-6.1-sol');
  });
  it('uses existing credential management for the selected OpenAI provider', async () => {
    const user = userEvent.setup();
    Reflect.defineProperty(window, '__TAURI_INTERNALS__', {configurable: true, value: {}});
    useSettingsStore.setState((state) => ({computerUse: {...state.computerUse, provider: 'openai'}}));
    vi.spyOn(TauriComputerUseService.prototype, 'health').mockResolvedValue(unavailableComputerUseHealth());
    const save = vi.spyOn(nativeAiService, 'saveCredential').mockResolvedValue();
    const remove = vi.spyOn(nativeAiService, 'deleteCredential').mockResolvedValue();
    render(<AppProviders><ComputerUsePage /></AppProviders>);
    const input = screen.getByLabelText('OpenAI API key');
    await user.type(input, 'boundary-fixture-key');
    await user.click(screen.getByRole('button', {name: 'Save OpenAI key'}));
    await waitFor(() => expect(screen.getByText('OpenAI API key saved in Windows Credential Manager.')).toBeVisible());
    expect(save).toHaveBeenCalledWith('openai', 'boundary-fixture-key');
    expect(input).toHaveValue('');
    await user.click(screen.getByRole('button', {name: 'Delete OpenAI key'}));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('openai'));
  });
});
