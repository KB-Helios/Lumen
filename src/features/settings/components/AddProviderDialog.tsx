import {useState, type ReactNode} from 'react';

import {Dialog, DialogTrigger, Heading, Modal, ModalOverlay} from 'react-aria-components';

import {vendorPresets, type VendorPreset} from '../../../config/vendorPresets';
import {LumenButton} from '../../../design-system/primitives/LumenButton';
import {LumenText} from '../../../design-system/primitives/LumenText';
import {providersApi} from '../../../services/api/providers';
import {toProviderErrorMessage} from '../../../services/providers/providers-service';
import {LumenTextField} from './SettingsControls';

type AddStep = 'pick' | 'form';

export interface AddProviderDialogProps {
  api?: typeof providersApi;
  children?: ReactNode;
  triggerLabel?: string;
  onAdded?(id: string): void;
}

function newProviderId(preset: VendorPreset): string {
  return `${preset.vendor}-${Date.now().toString(36)}`;
}

export function AddProviderDialog({
  api = providersApi,
  children,
  triggerLabel = 'Add provider',
  onAdded,
}: AddProviderDialogProps) {
  const [step, setStep] = useState<AddStep>('pick');
  const [preset, setPreset] = useState<VendorPreset | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const reset = () => {
    setStep('pick');
    setPreset(null);
    setBaseUrl('');
    setApiKey('');
    setModel('');
    setError('');
    setPending(false);
  };

  const pick = (next: VendorPreset) => {
    setPreset(next);
    setBaseUrl(next.baseUrl);
    setModel(next.defaultModel);
    setApiKey('');
    setError('');
    setStep('form');
  };

  const canSubmit =
    preset !== null &&
    !pending &&
    baseUrl.trim().length > 0 &&
    model.trim().length > 0 &&
    (preset.requiresOAuth === true || apiKey.length > 0);

  const submit = async (close: () => void) => {
    if (preset === null || !canSubmit) return;
    setPending(true);
    setError('');
    try {
      const id = newProviderId(preset);
      await api.add({
        app: preset.app,
        id,
        baseUrl: baseUrl.trim(),
        apiKey,
        model: model.trim(),
      });
      onAdded?.(id);
      close();
    } catch (caught) {
      setError(toProviderErrorMessage(caught));
    } finally {
      // Never keep the secret in component state longer than the submit.
      setApiKey('');
      setPending(false);
    }
  };

  return (
    <DialogTrigger
      onOpenChange={(isOpen) => {
        if (isOpen) reset();
      }}
    >
      {children ?? <LumenButton size="small">{triggerLabel}</LumenButton>}
      <ModalOverlay className="fixed inset-0 z-30 grid place-items-center bg-scrim p-8" isDismissable>
        <Modal className="w-full max-w-[480px] outline-none">
          <Dialog aria-label="Add provider" className="grid gap-6 rounded-surface border border-border-strong bg-surface-raised p-6 text-text-primary shadow-surface outline-none">
            {({close}) => (
              <>
                <Heading slot="title">
                  <LumenText as="span" variant="bodyLarge" weight="semibold">
                    {step === 'pick' ? 'Add provider' : `Add ${preset?.name ?? 'provider'}`}
                  </LumenText>
                </Heading>
                {step === 'pick' ? (
                  <div className="grid max-h-[320px] gap-2 overflow-y-auto" role="group" aria-label="Vendor presets">
                    {vendorPresets.map((candidate) => (
                      <LumenButton
                        key={candidate.vendor}
                        aria-label={`Use ${candidate.name}`}
                        size="small"
                        variant="subtle"
                        onPress={() => pick(candidate)}
                      >
                        <span className="flex w-full items-center justify-between gap-4">
                          <span>{candidate.name}</span>
                          <LumenText tone="tertiary" variant="meta">{candidate.defaultModel}</LumenText>
                        </span>
                      </LumenButton>
                    ))}
                  </div>
                ) : (
                  <div className="grid gap-4">
                    {preset?.requiresOAuth === true ? (
                      <LumenText tone="secondary" variant="meta">
                        Uses OAuth sign-in; an API key is optional.
                      </LumenText>
                    ) : null}
                    <label className="grid gap-1 font-sans text-sm text-text-secondary">
                      Base URL
                      <LumenTextField aria-label="Base URL" placeholder={preset?.baseUrl ?? ''} value={baseUrl} onChange={setBaseUrl} />
                    </label>
                    <label className="grid gap-1 font-sans text-sm text-text-secondary">
                      API key ({preset?.apiKeyField ?? 'key'})
                      <LumenTextField aria-label="API key" placeholder="sk-..." type="password" value={apiKey} onChange={setApiKey} />
                    </label>
                    <label className="grid gap-1 font-sans text-sm text-text-secondary">
                      Model
                      <LumenTextField aria-label="Model" placeholder={preset?.defaultModel ?? ''} value={model} onChange={setModel} />
                    </label>
                    {error ? <LumenText tone="secondary" variant="meta" role="alert">{error}</LumenText> : null}
                    <div className="flex justify-between gap-3">
                      <LumenButton size="small" variant="quiet" onPress={() => setStep('pick')}>
                        Back
                      </LumenButton>
                      <LumenButton size="small" variant="primary" isDisabled={!canSubmit} onPress={() => void submit(close)}>
                        {pending ? 'Adding…' : 'Add'}
                      </LumenButton>
                    </div>
                  </div>
                )}
                {step === 'pick' ? (
                  <div className="flex justify-end gap-3">
                    <LumenButton size="small" variant="quiet" onPress={close}>
                      Cancel
                    </LumenButton>
                  </div>
                ) : null}
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
