import { useState } from 'react';
import { useAppDispatch, useAppSelector } from './store/hooks';
import { setView, setSelectedProjectId, showToast, navigateToDetail, navigateToList } from './store/slices/uiSlice';
import { TestList } from './components/TestList';
import { TestDetail } from './components/TestDetail';
import { Settings } from './components/Settings';
import { Toast } from './components/Toast';
import { ConfirmModal } from './components/ConfirmModal';
import { CreateTestModal } from './components/CreateTestModal';
import { ProjectSelector } from './components/ProjectSelector';
import { Button } from './components/Button';
import { FlaskConical, Plus, Settings as SettingsIcon } from 'lucide-react';

export default function App() {
  const dispatch = useAppDispatch();
  const { view, currentTestName, selectedProjectId } = useAppSelector(state => state.ui);


  const [showCreateModal, setShowCreateModal] = useState(false);
  const [confirmData, setConfirmData] = useState<{isOpen: boolean, message: string, onConfirm: () => void} | null>(null);

  const handleNewTest = () => {
    setShowCreateModal(true);
  };

  const handleTestCreated = (testName: string, projectId: number | null) => {
    dispatch(showToast({ message: 'Test created by AI agent' }));
    setShowCreateModal(false);
    if (projectId !== undefined && projectId !== selectedProjectId) {
      dispatch(setSelectedProjectId(projectId));
    }
    dispatch(navigateToDetail(testName));
  };



  return (
    <>
      <header className="header">
        <div className="header-left" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <FlaskConical size={28} color="var(--accent)" />
          <h1>Browser Pilot</h1>
          <span className="version-badge">Tests</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Button variant="primary" icon={Plus} onClick={handleNewTest}>
            New Test
          </Button>
          <button className="header-icon-btn" onClick={() => dispatch(setView('Settings'))} title="Settings">
            <SettingsIcon size={20} />
          </button>
        </div>
      </header>

      <Toast />

      <div className="app-layout">
        {view === 'List' && (
          <aside className="sidebar">
            <ProjectSelector />
          </aside>
        )}

        <main className="main-content">
          {view === 'List' && (
            <TestList
              onOpenDetail={(name) => dispatch(navigateToDetail(name))}
            />
          )}

          {view === 'Detail' && currentTestName && (
            <TestDetail
              testName={currentTestName}
              onBack={() => dispatch(navigateToList())}
            />
          )}

          {view === 'Settings' && (
            <Settings onBack={() => dispatch(setView('List'))} />
          )}
        </main>
      </div>

      {confirmData && (
        <ConfirmModal
          isOpen={confirmData.isOpen}
          message={confirmData.message}
          onConfirm={confirmData.onConfirm}
          onCancel={() => setConfirmData(null)}
        />
      )}

      <CreateTestModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onTestCreated={handleTestCreated}
      />
    </>
  );
}
