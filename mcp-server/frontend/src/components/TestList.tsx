import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';
import { useGetTestsQuery, useDeleteTestMutation } from '../store/services/testsApi';
import { Search, Trash2, ChevronRight, Layers, Variable, Calendar, ShieldCheck } from 'lucide-react';

interface TestListProps {
  onOpenDetail: (name: string) => void;
}

export function TestList({ onOpenDetail }: TestListProps) {
  const dispatch = useAppDispatch();
  const selectedProjectId = useAppSelector(state => state.ui.selectedProjectId);
  const [search, setSearch] = useState('');

  const { data: tests = [], isLoading } = useGetTestsQuery(selectedProjectId);
  const [deleteTest] = useDeleteTestMutation();

  const handleDelete = async (name: string, event: React.MouseEvent) => {
    event.stopPropagation();
    if (!confirm(`Delete test "${name}" and all its steps?`)) return;
    try {
      await deleteTest(name).unwrap();
      dispatch(showToast({ message: 'Test deleted' }));
    } catch (err: any) {
      dispatch(showToast({ message: err.message || 'Delete failed', type: 'error' }));
    }
  };

  const filtered = tests.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    (t.description || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <section id="viewList" className="view active">
      <div className="search-bar" style={{ position: 'relative' }}>
        <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tests..."
          style={{ paddingLeft: '38px' }}
        />
      </div>
      <div id="testList" className="test-list">
        {isLoading ? (
          <p className="empty-state">Loading...</p>
        ) : filtered.length === 0 ? (
          <p className="empty-state">No tests yet. Create one to get started.</p>
        ) : (
          filtered.map(t => {
            const varCount = t.variables ? Object.keys(t.variables).length : 0;
            const hasAssertions = (t.steps || []).some(s => s?.command === 'assert');
            return (
              <div key={t.name} className="wf-card" onClick={() => onOpenDetail(t.name)}>
                <div className="wf-info">
                  <div className="wf-name">{t.name}</div>
                  <div className="wf-desc">{t.description || 'No description'}</div>
                </div>
                <div className="wf-meta">
                  <span className="wf-badge steps" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <Layers size={12} />
                    {t.step_count} steps
                  </span>
                  {varCount > 0 && <span className="wf-badge vars" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <Variable size={12} />
                    {varCount} vars
                  </span>}
                  {hasAssertions && <span className="wf-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'var(--accent-bg, #e0f2fe)', color: 'var(--accent, #0284c7)' }}>
                    <ShieldCheck size={12} />
                    assertions
                  </span>}
                  <span className="wf-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <Calendar size={12} />
                    {new Date(t.updated_at).toLocaleDateString()}
                  </span>
                  <button
                    className="wf-delete"
                    title="Delete"
                    onClick={(e) => handleDelete(t.name, e)}
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
}
