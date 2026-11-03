import { useAppSelector } from './store/hooks';
import { useGetHeadlessQuery } from './store/services/settingsApi';

// Whether runs and campaigns started from the dashboard go to the Chrome without windows
// (mcp-server/lib/headless.js): the user asked for it (remembered), and it is installed.

export function useRunHeadless(): boolean {
  const wanted = useAppSelector((state) => state.ui.runHeadless);
  const { data: status } = useGetHeadlessQuery();
  return wanted && !!status?.installed;
}
