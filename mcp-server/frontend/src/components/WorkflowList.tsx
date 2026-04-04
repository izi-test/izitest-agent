import { useEffect, useState, useImperativeHandle, forwardRef } from 'react';
import { api } from '../api';
import type { Workflow } from '../types';
import { useAppContext } from '../context/AppContext';
import { Search, Trash2, ChevronRight, Layers, Variable, Calendar } from 'lucide-react';

export interface WorkflowListRef {
  refresh: () => Promise<void>;
}

interface WorkflowListProps {
  onOpenDetail: (name: string) => void;
  onRequestDelete: (name: string, refreshAfter: () => void) => void;
}

export const WorkflowList = forwardRef<WorkflowListRef, WorkflowListProps>(({ onOpenDetail, onRequestDelete }, ref) => {
  const { showToast } = useAppContext();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const loadWorkflows = async () => {
    try {
      const data = await api('GET', '/api/workflows');
      setWorkflows(data.workflows);
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWorkflows();
  }, []);

  useImperativeHandle(ref, () => ({
    refresh: loadWorkflows
  }));

  const filtered = workflows.filter(wf => 
    wf.name.toLowerCase().includes(search.toLowerCase()) || 
    (wf.description || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <section id="viewList" className="view active">
      <div className="search-bar" style={{ position: 'relative' }}>
        <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
        <input 
          type="text" 
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search workflows..." 
          style={{ paddingLeft: '38px' }}
        />
      </div>
      <div id="workflowList" className="workflow-list">
        {loading ? (
          <p className="empty-state">Loading...</p>
        ) : filtered.length === 0 ? (
          <p className="empty-state">No workflows yet. Create one to get started.</p>
        ) : (
          filtered.map(wf => {
            const varCount = wf.variables ? Object.keys(wf.variables).length : 0;
            return (
              <div key={wf.name} className="wf-card" onClick={() => onOpenDetail(wf.name)}>
                <div className="wf-info">
                  <div className="wf-name">{wf.name}</div>
                  <div className="wf-desc">{wf.description || 'No description'}</div>
                </div>
                <div className="wf-meta">
                  <span className="wf-badge steps" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <Layers size={12} />
                    {wf.step_count} steps
                  </span>
                  {varCount > 0 && <span className="wf-badge vars" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <Variable size={12} />
                    {varCount} vars
                  </span>}
                  <span className="wf-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <Calendar size={12} />
                    {new Date(wf.updated_at).toLocaleDateString()}
                  </span>
                  <button 
                    className="wf-delete" 
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestDelete(wf.name, loadWorkflows);
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                  <ChevronRight size={18} className="wf-arrow" style={{ color: 'var(--text-muted)' }} />
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
});
