export async function api<T = any>(method: string, path: string, body?: any): Promise<T> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Project API helpers
export const projectApi = {
  list: () => api<{ projects: any[] }>('GET', '/api/projects'),
  get: (id: number) => api<{ project: any }>('GET', `/api/projects/${id}`),
  create: (name: string, description?: string) => api<{ id: number; name: string }>('POST', '/api/projects', { name, description }),
  update: (id: number, data: { name?: string; description?: string }) => api('PUT', `/api/projects/${id}`, data),
  delete: (id: number) => api('DELETE', `/api/projects/${id}`),
};

// Test API helpers with project support
export const testApi = {
  list: (projectId?: number | null) => {
    const query = projectId !== undefined ? `?project_id=${projectId}` : '';
    return api<{ tests: any[] }>('GET', `/api/tests${query}`);
  },
  assignToProject: (testName: string, projectId: number | null) =>
    api('PUT', `/api/tests/${encodeURIComponent(testName)}/project`, { project_id: projectId }),
};
