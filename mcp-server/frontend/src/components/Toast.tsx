import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { clearToast } from '../store/slices/uiSlice';

export function Toast() {
  const dispatch = useAppDispatch();
  const { message, type } = useAppSelector(state => state.ui.toast);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => dispatch(clearToast()), 2500);
      return () => clearTimeout(timer);
    }
  }, [message, dispatch]);

  if (!message) return null;

  return (
    <div className={`toast ${type}`}>
      {message}
    </div>
  );
}
