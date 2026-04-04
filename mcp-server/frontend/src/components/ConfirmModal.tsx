import { Button } from './Button';

interface ConfirmModalProps {
  isOpen: boolean;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ isOpen, message, onConfirm, onCancel }: ConfirmModalProps) {
  if (!isOpen) return null;

  return (
    <div id="confirmModal" className="modal">
      <div className="modal-overlay" onClick={onCancel}></div>
      <div className="modal-content modal-sm">
        <div className="modal-header">
          <h3>Confirm Deletion</h3>
        </div>
        <div className="modal-body">
          <p id="confirmMsg">{message}</p>
        </div>
        <div className="modal-footer">
          <Button variant="cancel" onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm}>Delete</Button>
        </div>
      </div>
    </div>
  );
}
