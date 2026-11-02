import { Link, Outlet, ScrollRestoration, useLocation, useMatch } from 'react-router-dom';
import {
  Bug, ChevronRight, ClipboardList, FlaskConical, FolderKanban, Layers, LayoutDashboard, MessageSquare, Plus, Settings as SettingsIcon,
} from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { setCreateTestOpen, showToast } from '../store/slices/uiSlice';
import { setActiveTab } from '../store/slices/testDetailSlice';
import { useGetProjectsQuery } from '../store/services/projectsApi';
import { useGetTestsQuery } from '../store/services/testsApi';
import { useGetRequirementsQuery } from '../store/services/requirementsApi';
import { useGetCampaignsQuery } from '../store/services/campaignsApi';
import { useGetBugsQuery } from '../store/services/bugsApi';
import { useGo, useScopeSync } from '../navigation';
import { withScope } from '../scope';
import { ProjectSwitcher } from './ProjectSelector';
import { CreateTestModal } from './CreateTestModal';
import { Toast } from './Toast';
import { Button } from './Button';

// The shell around every page: the sidebar — the project in scope, the sections with their
// counts, Projects, the chat and the settings —, the top bar with where one is (project ›
// section › item) and the new test button, and the page.

const SECTIONS: Record<string, string> = {
  tests: 'Tests', requirements: 'Requirements', campaigns: 'Campaigns', bugs: 'Bugs', projects: 'Projects', settings: 'Settings', chat: 'Chat',
};
/** The sections that are not of a project. */
const UNSCOPED = new Set(['projects', 'settings']);

export function AppLayout() {
  useScopeSync();
  const dispatch = useAppDispatch();
  const go = useGo();
  const creating = useAppSelector((state) => state.ui.createTestOpen);
  const setCreating = (open: boolean) => dispatch(setCreateTestOpen(open));

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <header className="topbar">
          <Breadcrumb />
          <div className="topbar__actions">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New test</Button>
          </div>
        </header>
        <main className="app-content">
          <Outlet />
        </main>
      </div>
      <Toast />
      <CreateTestModal
        isOpen={creating}
        onClose={() => setCreating(false)}
        onTestCreated={(testName, _projectId, mode = 'ai') => {
          dispatch(showToast({ message: mode === 'gherkin' ? 'Test created from Gherkin' : 'Test created by the AI agent' }));
          setCreating(false);
          dispatch(setActiveTab(mode === 'gherkin' ? 'gherkin' : 'steps'));
          go(`/tests/${encodeURIComponent(testName)}`);
        }}
      />
      {/* Back finds a page scrolled where it was left; a new page starts at its top. */}
      <ScrollRestoration />
    </div>
  );
}

function Sidebar() {
  const scope = useAppSelector((state) => state.ui.selectedProjectId);
  const location = useLocation();
  const { data: tests = [] } = useGetTestsQuery(scope ?? undefined);
  const { data: requirements = [] } = useGetRequirementsQuery(scope);
  const { data: campaigns = [] } = useGetCampaignsQuery(scope);
  const { data: bugs = [] } = useGetBugsQuery({ status: 'open', projectId: scope });
  const section = location.pathname.split('/')[1] ?? '';

  const item = (to: string, Icon: typeof Bug, label: string, count?: number, danger = false) => {
    const key = to.split('/')[1] ?? '';
    const active = key === section;
    return (
      <Link to={withScope(to, scope)} className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
        <Icon size={18} />
        <span className="nav-item__label">{label}</span>
        {count !== undefined && count > 0 && <span className={`nav-item__count ${danger ? 'nav-item__count--danger' : ''}`}>{count}</span>}
      </Link>
    );
  };

  return (
    <aside className="sidebar">
      <Link to={withScope('/', scope)} className="brand">
        <span className="brand__mark"><FlaskConical size={18} /></span>
        <span className="brand__name">IziTest</span>
        <span className="brand__tag">Agent</span>
      </Link>
      <ProjectSwitcher />
      <nav className="nav">
        {item('/', LayoutDashboard, 'Dashboard')}
        {item('/tests', FlaskConical, 'Tests', tests.length)}
        {item('/requirements', ClipboardList, 'Requirements', requirements.length)}
        {item('/campaigns', Layers, 'Campaigns', campaigns.length)}
        {item('/bugs', Bug, 'Bugs', bugs.length, true)}
        <div className="nav__divider" />
        {item('/projects', FolderKanban, 'Projects')}
      </nav>
      <nav className="nav nav--bottom">
        {item('/chat', MessageSquare, 'Chat with AI')}
        {item('/settings', SettingsIcon, 'Settings')}
      </nav>
    </aside>
  );
}

/** Where one is: the project (or all of them), the section, the item. */
function Breadcrumb() {
  const scope = useAppSelector((state) => state.ui.selectedProjectId);
  const { data: projects = [] } = useGetProjectsQuery();
  const location = useLocation();
  const test = useMatch('/tests/:testName');
  const requirement = useMatch('/requirements/:key');
  const campaign = useMatch('/campaigns/:id');
  const section = location.pathname.split('/')[1] ?? '';
  const project = projects.find((p) => p.id === scope);

  const crumbs: Array<{ label: string; to?: string }> = [];
  if (!UNSCOPED.has(section)) crumbs.push({ label: project?.name ?? 'All projects', to: '/' });
  if (section) crumbs.push({ label: SECTIONS[section] ?? section, to: `/${section}` });
  else crumbs.push({ label: 'Dashboard' });
  const item = test ? decodeURIComponent(test.params.testName ?? '') : requirement ? decodeURIComponent(requirement.params.key ?? '') : campaign ? `#${campaign.params.id}` : null;
  if (item) crumbs.push({ label: item });

  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      {crumbs.map((crumb, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={i} className="breadcrumb__item">
            {i > 0 && <ChevronRight size={14} className="breadcrumb__sep" />}
            {last || !crumb.to
              ? <span className={last ? 'breadcrumb__current' : ''} aria-current={last ? 'page' : undefined}>{crumb.label}</span>
              : <Link to={withScope(crumb.to, scope)}>{crumb.label}</Link>}
          </span>
        );
      })}
    </nav>
  );
}
