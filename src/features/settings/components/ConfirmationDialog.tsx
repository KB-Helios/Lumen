import {useRef, useState, type ReactNode} from 'react';

import {Dialog, DialogTrigger, Heading, Modal, ModalOverlay} from 'react-aria-components';

import {LumenButton, type LumenButtonVariant} from '../../../design-system/primitives/LumenButton';
import {LumenText} from '../../../design-system/primitives/LumenText';

export interface ConfirmationDialogProps {
  cancelLabel?: string;
  children: ReactNode;
  confirmLabel: string;
  confirmVariant?: LumenButtonVariant;
  description: string;
  title: string;
  onConfirm(): void | boolean | Promise<void | boolean>;
}

export function ConfirmationDialog({cancelLabel = 'Cancel', children, confirmLabel, confirmVariant = 'danger', description, title, onConfirm}: ConfirmationDialogProps) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const confirm = async (close: () => void) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      if (await onConfirm() === false) throw new Error('The operation could not be completed. Try again.');
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The operation could not be completed. Try again.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <DialogTrigger onOpenChange={() => {if (!pending.current) setError('');}}>
      {children}
      <ModalOverlay className="lumen-preview-overlay fixed inset-0 z-30 grid min-h-0 place-items-center overflow-y-auto bg-scrim p-[16px]" isDismissable={!busy} isKeyboardDismissDisabled={busy}>
        <Modal className="lumen-preview-modal min-h-0 min-w-0 w-full max-w-[430px] max-h-full overflow-y-auto outline-none">
          <Dialog aria-label={title} className="grid min-w-0 gap-[20px] rounded-surface border border-border-strong bg-surface-raised p-[20px] text-text-primary shadow-surface outline-none [overflow-wrap:anywhere]">
            {({close}) => (
              <>
                <Heading slot="title"><LumenText as="span" variant="bodyLarge" weight="semibold">{title}</LumenText></Heading>
                <LumenText tone="secondary">{description}</LumenText>
                {error ? <LumenText role="alert" tone="secondary">{error}</LumenText> : null}
                <div className="flex min-w-0 flex-wrap justify-end gap-[8px]">
                  <LumenButton isDisabled={busy} size="small" variant="quiet" onPress={close}>{cancelLabel}</LumenButton>
                  <LumenButton
                    size="small"
                    variant={confirmVariant}
                    isDisabled={busy}
                    onPress={() => void confirm(close)}
                  >
                    {confirmLabel}
                  </LumenButton>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
