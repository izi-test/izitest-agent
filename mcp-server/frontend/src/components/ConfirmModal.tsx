import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './Button';
import { Dialog } from './ui';

interface ConfirmModalProps {
  isOpen: boolean;
  message: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  title?: string;
  confirmLabel?: string;
  /** A deletion is red; anything else (leaving a page) blue. */
  tone?: 'danger' | 'primary';
  confirmDisabled?: boolean;
  children?: ReactNode;
}

export function ConfirmModal({
  isOpen, message, onConfirm, onCancel, title = 'Confirm deletion', confirmLabel = 'Delete', tone = 'danger', confirmDisabled, children,
}: ConfirmModalProps) {
  if (!isOpen) return null;

  return (
    <Dialog
      title={title} onClose={onCancel} width={480}
      icon={<span className={`dialog__icon dialog__icon--${tone}`}><AlertTriangle size={18} /></span>}
      footer={(
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} className={tone === 'danger' ? 'btn--danger-solid' : ''} onClick={onConfirm} disabled={confirmDisabled} autoFocus>
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <div className="confirm-message">{message}</div>
      {children}
    </Dialog>
  );
}
