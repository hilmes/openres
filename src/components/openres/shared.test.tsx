import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Modal } from './shared';

it('keeps a saving dialog open when Escape or the close button is used', () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const close = vi.fn();
  const { rerender } = render(<Modal title="Save reservation" busy onClose={close}><p>Saving</p></Modal>);
  const cancel = new Event('cancel', { bubbles: false, cancelable: true });
  fireEvent(screen.getByRole('dialog'), cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled();
  expect(screen.getByRole('dialog')).toHaveAttribute('open');
  rerender(<Modal title="Save reservation" onClose={close}><p>Saved</p></Modal>);
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
});
