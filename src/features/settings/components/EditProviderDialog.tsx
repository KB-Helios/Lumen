import {useState, type ReactNode} from 'react';

import {Dialog, DialogTrigger, Heading, Modal, ModalOverlay} from 'react-aria-components';

import {LumenButton} from '../../../design-system/primitives/LumenButton';
import {LumenText} from '../../../design-system/primitives/LumenText';
import {providersApi} from '../../../services/api/providers';
import {toProviderErrorMessage} from '../../../services/providers/providers-service';
import {LumenTextField} from './SettingsControls';

export interface EditableProvider {
  app: string;
  id: string;
  name?: string;
  baseUrl: string;
  model: string;
}

export interface EditProviderDialogProps {
  api?: typeof providersApi;
  children?: ReactNode;
  provider: EditableProvider;
  triggerLabel?: string;
  onSaved?(): void;
}

export function EditProviderDialog({
  api = providersApi,
  children,
  provider,
  triggerLabel = 'Edit provider',
  onSaved,
}: EditProviderDialogProps) {
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(provider.model);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const reset = () => {
    setBaseUrl(provider.baseUrl);
    setApiKey('');
    setModel(provider.model);
    setError('');
    setPending(false);
  };

  const canSubmit = !pending && baseUrl.trim().length > 0 && model.trim().length > 0;

  const submit = async (close: () => void) => {
    if (!canSubmit) return;
    setPending(true);
    setError('');
    try {
      await api.update({
        app: provider.app,
        id: provider.id,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.length > 0 ? apiKey : undefined,
      });
      onSaved?.();
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
          <Dialog aria-label={`Edit ${provider.name ?? provider.id}`} className="grid gap-6 rounded-surface border border-border-strong bg-surface-raised p-6 text-text-primary shadow-surface outline-none">
            {({close}) => (
              <>
                <Heading slot="title">
                  <LumenText as="span" variant="bodyLarge" weight="semibold">
                    Edit {provider.name ?? provider.id}
                  </LumenText>
                </Heading>
                <div className="grid gap-4">
                  <label className="grid gap-1 font-sans text-sm text-text-secondary">
                    Base URL
                    <LumenTextField aria-label="Base URL" value={baseUrl} onChange={setBaseUrl} />
                  </label>
                  <label className="grid gap-1 font-sans text-sm text-text-secondary">
                    API key (leave empty to keep the stored key)
                    <LumenTextField aria-label="API key" placeholder="••••••" type="password" value={apiKey} onChange={setApiKey} />
                  </label>
                  <label className="grid gap-1 font-sans text-sm text-text-secondary">
                    Model
                    <LumenTextField aria-label="Model" value={model} onChange={setModel} />
                  </label>
                  {error ? <LumenText tone="secondary" variant="meta" role="alert">{error}</LumenText> : null}
                  <div className="flex justify-end gap-3">
                    <LumenButton size="small" variant="quiet" onPress={close}>
                      Cancel
                    </LumenButton>
                    <LumenButton size="small" variant="primary" isDisabled={!canSubmit} onPress={() => void submit(close)}>
                      {pending ? 'Saving…' : 'Save'}
                    </LumenButton>
                  </div>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
