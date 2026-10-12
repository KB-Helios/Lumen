import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, it, vi} from 'vitest';

import {LumenButton} from '../../../design-system/primitives/LumenButton';
import {ConfirmationDialog} from './ConfirmationDialog';

it('retains false operation results as retryable feedback inside the modal', async () => {
  const user = userEvent.setup();
  render(<ConfirmationDialog title="Save consent" description="Review." confirmLabel="Allow" onConfirm={async () => false}><LumenButton>Review consent</LumenButton></ConfirmationDialog>);
  await user.click(screen.getByRole('button', {name: 'Review consent'}));
  await user.click(screen.getByRole('button', {name: 'Allow'}));
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('The operation could not be completed. Try again.');
});

it('holds confirmation open while pending and lets a failed operation retry', async () => {
  const user = userEvent.setup();
  let reject!: (error: Error) => void;
  const onConfirm = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => {reject = fail;})).mockResolvedValue(undefined);
  render(<ConfirmationDialog title="Confirm operation" description="Apply it." confirmLabel="Apply" onConfirm={onConfirm}><LumenButton>Review</LumenButton></ConfirmationDialog>);
  await user.click(screen.getByRole('button', {name: 'Review'}));
  await user.click(screen.getByRole('button', {name: 'Apply'}));
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(screen.getByRole('button', {name: 'Apply'})).toBeDisabled();
  await act(async () => reject(new Error('Device unavailable')));
  expect(screen.getByRole('alert')).toHaveTextContent('Device unavailable');
  await user.click(screen.getByRole('button', {name: 'Apply'}));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('uses the semantic scrim utility for the confirmation overlay', async () => {
  const user = userEvent.setup();
  render(
    <ConfirmationDialog
      confirmLabel="Delete"
      description="This is destructive."
      title="Confirm deletion"
      onConfirm={vi.fn()}
    >
      <LumenButton>Open confirmation</LumenButton>
    </ConfirmationDialog>,
  );

  await user.click(screen.getByRole('button', {name: 'Open confirmation'}));

  const overlay = screen.getByRole('dialog', {name: 'Confirm deletion'}).parentElement?.parentElement;
  expect(overlay).toHaveClass('bg-scrim');
  expect(overlay).not.toHaveClass('bg-black/60');
});
