import type {ReactNode} from 'react';

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
  onConfirm(): void;
}

export function ConfirmationDialog({cancelLabel = 'Cancel', children, confirmLabel, confirmVariant = 'danger', description, title, onConfirm}: ConfirmationDialogProps) {
  return (
    <DialogTrigger>
      {children}
      <ModalOverlay className="lumen-preview-overlay fixed inset-0 z-30 grid min-h-0 place-items-center overflow-y-auto bg-scrim p-[16px]" isDismissable>
        <Modal className="lumen-preview-modal min-h-0 min-w-0 w-full max-w-[430px] max-h-full overflow-y-auto outline-none">
          <Dialog aria-label={title} className="grid min-w-0 gap-[20px] rounded-surface border border-border-strong bg-surface-raised p-[20px] text-text-primary shadow-surface outline-none [overflow-wrap:anywhere]">
            {({close}) => (
              <>
                <Heading slot="title"><LumenText as="span" variant="bodyLarge" weight="semibold">{title}</LumenText></Heading>
                <LumenText tone="secondary">{description}</LumenText>
                <div className="flex min-w-0 flex-wrap justify-end gap-[8px]">
                  <LumenButton size="small" variant="quiet" onPress={close}>{cancelLabel}</LumenButton>
                  <LumenButton
                    size="small"
                    variant={confirmVariant}
                    onPress={() => {
                      onConfirm();
                      close();
                    }}
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
