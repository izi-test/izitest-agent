import { useAppContext } from '../context/AppContext';

export function Toast() {
  const { toastMsg, toastType } = useAppContext();
  
  if (!toastMsg) {
    return <div id="toast" className="toast hidden"></div>;
  }
  
  return (
    <div id="toast" className={`toast ${toastType}`}>
      {toastMsg}
    </div>
  );
}
