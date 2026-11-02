import { useState, useEffect } from 'react';
import { Routes, Route, useNavigate, useLocation, useParams, Navigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from './store/hooks';
import { showToast, setSelectedProjectId } from './store/slices/uiSlice';
import { setActiveTab } from './store/slices/testDetailSlice';
import { TestList } from './components/TestList';
import { TestDetail } from './components/TestDetail';
import { Settings } from './components/Settings';
import { Toast } from './components/Toast';
import { ConfirmModal } from './components/ConfirmModal';
import { CreateTestModal } from './components/CreateTestModal';
import { ProjectSwitcher, ProjectSelector } from './components/ProjectSelector';
import { ChatPanel } from './components/ChatPanel';
import { Dashboard } from './components/Dashboard';
import { BugsPage } from './components/BugsPage';
import { RequirementsPage, RequirementPage } from './components/Requirements';
import { CampaignsPage, CampaignPage } from './components/Campaigns';
import { Button } from './components/Button';
import { useGetTestsQuery } from './store/services/testsApi';
import {
  Bug,
  ClipboardList,
  Layers,
  FlaskConical,
  Plus,
  MessageSquare,
  Settings as SettingsIcon,
  LayoutDashboard,
  BarChart3,
} from 'lucide-react';

function AppLayout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useAppDispatch();
  const selectedProjectId = useAppSelector(state => state.ui.selectedProjectId);
  const { data: tests = [] } = useGetTestsQuery(selectedProjectId);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [confirmData, setConfirmData] = useState<{isOpen: boolean, message: string, onConfirm: () => void} | null>(null);

  const handleNewTest = () => {
    setShowCreateModal(true);
  };

  const handleTestCreated = (testName: string, _projectId: number | null, mode: 'ai' | 'gherkin' = 'ai') => {
    dispatch(showToast({
      message: mode === 'gherkin' ? 'Test created from Gherkin' : 'Test created by AI agent',
    }));
    setShowCreateModal(false);
    dispatch(setActiveTab(mode === 'gherkin' ? 'gherkin' : 'steps'));
    navigate(`/tests/${encodeURIComponent(testName)}`);
  };

  const isChat = location.pathname === '/chat';
  const isSettings = location.pathname === '/settings';
  const showSidebar = !isChat && !isSettings;

  const isDashboard = location.pathname === '/';
  const isListActive = location.pathname === '/tests' || location.pathname.startsWith('/projects');
  const isChatActive = location.pathname === '/chat';

  return (
    <>
      <header className="header">
        <div className="header-left" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <FlaskConical size={28} color="var(--accent)" />
          <h1>IziTest Agent</h1>
          <span className="version-badge">Tests</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Button variant="primary" icon={Plus} onClick={handleNewTest}>
            New Test
          </Button>
          <button
            className={`header-icon-btn ${isChatActive ? 'active' : ''}`}
            onClick={() => navigate(isChatActive ? '/tests' : '/chat')}
            title="Chat with AI"
          >
            <MessageSquare size={20} />
          </button>
          <button className="header-icon-btn" onClick={() => navigate('/settings')} title="Settings">
            <SettingsIcon size={20} />
          </button>
        </div>
      </header>

      <Toast />

      <div className="app-layout">
        {showSidebar && (
          <aside className="sidebar">
            <div className="sidebar-top">
              <ProjectSwitcher />
            </div>

            <nav className="sidebar-nav">
              <div className="sidebar-nav__label">Menu</div>

              <button
                className={`sidebar-nav__item ${isDashboard ? 'active' : ''}`}
                onClick={() => navigate('/')}
              >
                <BarChart3 size={18} />
                <span>Dashboard</span>
              </button>

              <button
                className={`sidebar-nav__item ${isListActive ? 'active' : ''}`}
                onClick={() => navigate(selectedProjectId ? `/projects/${selectedProjectId}` : '/tests')}
              >
                <LayoutDashboard size={18} />
                <span>Tests</span>
                <span className="sidebar-nav__badge">{tests.length}</span>
              </button>

              <button
                className={`sidebar-nav__item ${location.pathname.startsWith('/requirements') ? 'active' : ''}`}
                onClick={() => navigate('/requirements')}
              >
                <ClipboardList size={18} />
                <span>Requirements</span>
              </button>

              <button
                className={`sidebar-nav__item ${location.pathname.startsWith('/campaigns') ? 'active' : ''}`}
                onClick={() => navigate('/campaigns')}
              >
                <Layers size={18} />
                <span>Campaigns</span>
              </button>

              <button
                className={`sidebar-nav__item ${location.pathname === '/bugs' ? 'active' : ''}`}
                onClick={() => navigate('/bugs')}
              >
                <Bug size={18} />
                <span>Bugs</span>
              </button>
            </nav>

            <div className="sidebar-bottom">
              <ProjectSelector />
            </div>
          </aside>
        )}

        <main className="main-content">
          {children}
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

export default function App() {
  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/tests" element={<TestListPage />} />
        <Route path="/projects/:projectId" element={<TestListPage />} />
        <Route path="/tests/:testName" element={<TestDetailPage />} />
        <Route path="/requirements" element={<RequirementsRoute />} />
        <Route path="/requirements/:key" element={<RequirementRoute />} />
        <Route path="/campaigns" element={<CampaignsRoute />} />
        <Route path="/campaigns/:id" element={<CampaignRoute />} />
        <Route path="/bugs" element={<BugsRoute />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  );
}

/* ── Route pages ── */

function TestListPage() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { projectId } = useParams();

  // Sync URL project param with Redux state
  useEffect(() => {
    const numericProjectId = projectId ? Number(projectId) : null;
    dispatch(setSelectedProjectId(numericProjectId));
  }, [projectId, dispatch]);

  return <TestList onOpenDetail={(name) => navigate(`/tests/${encodeURIComponent(name)}`)} />;
}

function TestDetailPage() {
  const navigate = useNavigate();
  const { testName } = useParams();
  const selectedProjectId = useAppSelector(state => state.ui.selectedProjectId);

  if (!testName) return <Navigate to="/" replace />;

  const backPath = selectedProjectId ? `/projects/${selectedProjectId}` : '/tests';

  return (
    <TestDetail
      testName={decodeURIComponent(testName)}
      onBack={() => navigate(backPath)}
    />
  );
}

function RequirementsRoute() {
  const navigate = useNavigate();
  return <RequirementsPage onOpen={(key) => navigate(`/requirements/${encodeURIComponent(key)}`)} />;
}

function RequirementRoute() {
  const navigate = useNavigate();
  const { key } = useParams();
  if (!key) return <Navigate to="/requirements" replace />;
  return (
    <RequirementPage
      requirementKey={decodeURIComponent(key)}
      onBack={() => navigate('/requirements')}
      onOpenTest={(name) => navigate(`/tests/${encodeURIComponent(name)}`)}
      onOpenCampaign={(id) => navigate(`/campaigns/${id}`)}
    />
  );
}

function CampaignsRoute() {
  const navigate = useNavigate();
  return <CampaignsPage onOpen={(id) => navigate(`/campaigns/${id}`)} />;
}

function CampaignRoute() {
  const navigate = useNavigate();
  const { id } = useParams();
  if (!id || !/^\d+$/.test(id)) return <Navigate to="/campaigns" replace />;
  return (
    <CampaignPage
      key={id}
      id={Number(id)}
      onBack={() => navigate('/campaigns')}
      onOpen={(next) => navigate(`/campaigns/${next}`)}
      onOpenTest={(name) => navigate(`/tests/${encodeURIComponent(name)}`)}
      onOpenRequirement={(key) => navigate(`/requirements/${encodeURIComponent(key)}`)}
    />
  );
}

function BugsRoute() {
  const navigate = useNavigate();
  return <BugsPage onOpenTest={(name) => navigate(`/tests/${encodeURIComponent(name)}`)} />;
}

function SettingsPage() {
  const navigate = useNavigate();
  return <Settings onBack={() => navigate('/tests')} />;
}

function ChatPage() {
  const navigate = useNavigate();
  return <ChatPanel onBack={() => navigate('/tests')} />;
}
