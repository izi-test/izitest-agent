import { useAppDispatch, useAppSelector } from '../store/hooks';
import { setRunHeadless } from '../store/slices/uiSlice';
import { useGetHeadlessQuery } from '../store/services/settingsApi';
import { useGo } from '../navigation';

/**
 * "Run headless": runs and campaigns started here go to the Chrome without windows, out of
 * sight. One choice for the whole dashboard, remembered. Not installed yet, it says where.
 */
export function HeadlessSwitch({ disabledReason }: { disabledReason?: string }) {
  const dispatch = useAppDispatch();
  const go = useGo();
  const wanted = useAppSelector((state) => state.ui.runHeadless);
  const { data: status } = useGetHeadlessQuery();
  const installed = !!status?.installed;
  const reason = !installed ? 'not installed' : disabledReason;

  return (
    <label className={`switch ${reason ? 'switch--disabled' : ''}`}>
      <input type="checkbox" checked={wanted && !reason} disabled={!!reason} onChange={(e) => dispatch(setRunHeadless(e.target.checked))} />
      <span className="switch__text">
        Headless — no window
        <span className="switch__hint">
          {!installed ? (
            <>Out of sight, in a Chrome of its own. <a href="#" onClick={(e) => { e.preventDefault(); go('/settings#headless'); }}>Install it in Settings</a>.</>
          ) : disabledReason ? disabledReason
            : status?.connected ? 'In the headless Chrome, which is running: your windows keep the focus.'
              : 'In a Chrome of its own, started for the run: your windows keep the focus.'}
        </span>
      </span>
    </label>
  );
}
