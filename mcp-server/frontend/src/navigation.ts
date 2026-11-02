import { useCallback, useEffect, useRef } from 'react';
import { useBlocker, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from './store/hooks';
import { setSelectedProjectId } from './store/slices/uiSlice';
import { STORAGE_KEY, scopeFromSearch, sectionOf, withScope } from './scope';

// Where one is in the dashboard, kept so that it is found again: the project in scope, carried
// in the URL (?project=3, or ?project=all) and remembered for the next visit; the page a detail
// was opened from, to go back to it; a list's search and filters, in the URL too, so that the
// way back finds them as they were.

/**
 * Keeps the URL and the project in scope together: a URL that names none gets the current one,
 * a URL that names another one (back, a link pasted) brings it into scope; the choice is kept.
 */
export function useScopeSync() {
  const location = useLocation();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const scope = useAppSelector((state) => state.ui.selectedProjectId);

  useEffect(() => {
    const fromUrl = scopeFromSearch(location.search);
    if (fromUrl === undefined) {
      navigate(withScope(location.pathname + location.search, scope) + location.hash, { replace: true, state: location.state });
    } else if (fromUrl !== scope) {
      dispatch(setSelectedProjectId(fromUrl));
    }
    // Only a new URL decides: a change of scope always comes with one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search]);

  useEffect(() => {
    try {
      if (scope == null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(scope));
    } catch {
      // Private window: the choice lasts as long as the tab.
    }
  }, [scope]);
}

/** Brings a project into scope and stays on the section one is in (a detail goes to its list). */
export function useSwitchProject() {
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useAppDispatch();
  return useCallback((projectId: number | null, { replace = false }: { replace?: boolean } = {}) => {
    dispatch(setSelectedProjectId(projectId));
    navigate(withScope(sectionOf(location.pathname), projectId), { replace });
  }, [dispatch, navigate, location.pathname]);
}

type From = { path: string; label: string };

/**
 * Goes to a page of the dashboard in the project in scope. With `from`, the page opened can say
 * where it was opened from ("Back to campaign #6") and go back there.
 */
export function useGo() {
  const navigate = useNavigate();
  const location = useLocation();
  const scope = useAppSelector((state) => state.ui.selectedProjectId);
  return useCallback((path: string, { from, replace }: { from?: string; replace?: boolean } = {}) => {
    navigate(withScope(path, scope), {
      replace,
      state: from ? { from: { path: location.pathname + location.search, label: from } satisfies From } : undefined,
    });
  }, [navigate, location.pathname, location.search, scope]);
}

/** Where "Back" goes: the page this one was opened from, as it was, or else its list. */
export function useBack(fallback: string, fallbackLabel: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const scope = useAppSelector((state) => state.ui.selectedProjectId);
  const from = (location.state as { from?: From } | null)?.from;
  const go = useCallback(() => {
    // The page it came from is the one before in the history: going back finds it scrolled and filtered as it was.
    if (from && window.history.length > 1) navigate(-1);
    else navigate(withScope(fallback, scope));
  }, [from, navigate, fallback, scope]);
  return { label: from ? `Back to ${from.label}` : `Back to ${fallbackLabel}`, go, state: location.state };
}

/** A list's search or filter, kept in the URL: there again on the way back, and in a link. */
export function useUrlState(key: string, fallback = ''): [string, (value: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? fallback;
  const set = useCallback((next: string) => {
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next === fallback || next === '') updated.delete(key);
      else updated.set(key, next);
      return updated;
    }, { replace: true });
  }, [key, fallback, setParams]);
  return [value, set];
}

/**
 * Holds a page with unsaved changes: leaving it for another page asks first, closing or reloading
 * the tab too. `allow()` lets the next navigation through (a save that renames, then moves).
 */
export function useLeaveGuard(dirty: boolean) {
  const allowed = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (allowed.current) {
      allowed.current = false;
      return false;
    }
    return dirty && currentLocation.pathname !== nextLocation.pathname;
  });

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const allow = useCallback(() => { allowed.current = true; }, []);
  return { blocker, allow };
}

/**
 * Brings into scope the project of what a page shows (a test, a requirement, a campaign), when
 * another one is in scope: its breadcrumb, its list and the sidebar's counts are then its own.
 * Stays on the page; says so with `onSwitched`.
 */
export function useFollowProject(projectId: number | null | undefined, onSwitched?: (projectId: number | null) => void) {
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useAppDispatch();
  const scope = useAppSelector((state) => state.ui.selectedProjectId);
  useEffect(() => {
    // Unknown yet, or all projects in scope: nothing to follow.
    if (projectId === undefined || scope === null || projectId === scope) return;
    dispatch(setSelectedProjectId(projectId));
    navigate(withScope(location.pathname, projectId), { replace: true, state: location.state });
    onSwitched?.(projectId);
    // Followed once, when what the page shows is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
}
