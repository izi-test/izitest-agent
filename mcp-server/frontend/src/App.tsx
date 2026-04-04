import { useState, useRef } from 'react';
import { AppProvider, useAppContext } from './context/AppContext';
import { WorkflowList, type WorkflowListRef } from './components/WorkflowList';
import { WorkflowDetail } from './components/WorkflowDetail';
import { Settings } from './components/Settings';
import { Toast } from './components/Toast';
import { ConfirmModal } from './components/ConfirmModal';
import { CreateWorkflowModal } from './components/CreateWorkflowModal';
import { Button } from './components/Button';
import { api } from './api';
import { SquarePlay, Plus, Settings as SettingsIcon } from 'lucide-react';

function MainApp() {
  const { view, setView, currentWorkflowName, setCurrentWorkflowName, showToast } = useAppContext();
  const listRef = useRef<WorkflowListRef>(null);

  const [confirmData, setConfirmData] = useState<{isOpen: boolean, message: string, onConfirm: () => void} | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const handleNewWorkflow = () => {
    setShowCreateModal(true);
  };

  const handleWorkflowCreated = (workflowName: string) => {
    showToast('Workflow created by AI agent');
    setShowCreateModal(false);
    setCurrentWorkflowName(workflowName);
    setView('Detail');
    setTimeout(() => listRef.current?.refresh(), 200);
  };

  const handleDeleteWorkflow = (name: string, onDeleted?: () => void) => {
    setConfirmData({
      isOpen: true,
      message: `Delete workflow "${name}" and all its steps?`,
      onConfirm: async () => {
        try {
          await api('DELETE', `/api/workflows/${encodeURIComponent(name)}`);
          showToast('Workflow deleted');
          if (onDeleted) onDeleted();
          setConfirmData(null);
          // If we were in detail view, go back to list
          if (view === 'Detail') setView('List');
          // If we are in list view, refresh
          setTimeout(() => {
            if (listRef.current) listRef.current.refresh();
          }, 100);
        } catch (err: any) {
          showToast(err.message, 'error');
        }
      }
    });
  };

  return (
    <>
      <header className="header">
        <div className="header-left" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <SquarePlay size={28} color="var(--accent)" />
          <h1>Browser Pilot</h1>
          <span className="version-badge">Workflows</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Button variant="primary" icon={Plus} onClick={handleNewWorkflow}>
            New Workflow
          </Button>
          <button className="header-icon-btn" onClick={() => setView('Settings')} title="Settings">
            <SettingsIcon size={20} />
          </button>
        </div>
      </header>

      <Toast />

      {view === 'List' && (
        <WorkflowList 
          ref={listRef}
          onOpenDetail={(name) => { setCurrentWorkflowName(name); setView('Detail'); }} 
          onRequestDelete={(name, refreshRef) => handleDeleteWorkflow(name, refreshRef)} 
        />
      )}

      {view === 'Detail' && currentWorkflowName && (
        <WorkflowDetail
          workflowName={currentWorkflowName}
          onBack={() => { setView('List'); setTimeout(() => listRef.current?.refresh(), 100); }}
          onRequestDeleteWorkflow={handleDeleteWorkflow}
          onNameChanged={(newName) => setCurrentWorkflowName(newName)}
        />
      )}

      {view === 'Settings' && (
        <Settings onBack={() => setView('List')} />
      )}

      {confirmData && (
        <ConfirmModal
          isOpen={confirmData.isOpen}
          message={confirmData.message}
          onConfirm={confirmData.onConfirm}
          onCancel={() => setConfirmData(null)}
        />
      )}

      <CreateWorkflowModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onWorkflowCreated={handleWorkflowCreated}
      />
    </>
  );
}

export default function App() {
  return (
    <AppProvider>
      <MainApp />
    </AppProvider>
  );
}
