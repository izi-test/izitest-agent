// The project in scope, as the URL carries it (?project=3, or ?project=all) and as it is kept for
// the next visit. Without imports: the store reads it when it is created.

export const STORAGE_KEY = 'izitest.project';

/** The project a URL's query names: an id, null for all of them, undefined when it names none. */
export function scopeFromSearch(search: string): number | null | undefined {
  const value = new URLSearchParams(search).get('project');
  if (value === null) return undefined;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function storedScope(): number | null {
  try {
    const id = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/** The project in scope when the dashboard opens: the URL's, or the last one chosen. */
export function initialScope(): number | null {
  const fromUrl = scopeFromSearch(window.location.search);
  return fromUrl !== undefined ? fromUrl : storedScope();
}

/** A path with the project in scope in its query, unless it names one already. */
export function withScope(path: string, projectId: number | null): string {
  const [pathname, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  if (!params.has('project')) params.set('project', projectId == null ? 'all' : String(projectId));
  return `${pathname}?${params}`;
}

/** The list a page belongs to: a test's is Tests. Switching project from a detail goes there. */
export function sectionOf(pathname: string): string {
  const match = pathname.match(/^\/(tests|requirements|campaigns)\/.+/);
  return match ? `/${match[1]}` : pathname;
}
