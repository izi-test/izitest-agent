import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './components/Layout';
import { Dashboard } from './components/Dashboard';
import { TestList } from './components/TestList';
import { RequirementsPage } from './components/Requirements';
import { CampaignsPage } from './components/Campaigns';
import { TestDetailRoute, RequirementRoute, CampaignRoute, ProjectRedirect } from './components/Routes';
import { BugsPage } from './components/BugsPage';
import { ElementsPage } from './components/ElementsPage';
import { ProjectsPage } from './components/ProjectsPage';
import { Settings } from './components/Settings';
import { ChatPanel } from './components/ChatPanel';

// The dashboard's pages, in the shell (Layout.tsx). A data router: it restores the scroll of a
// page gone back to, and holds a page with unsaved changes.

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'tests', element: <TestList /> },
      { path: 'tests/:testName', element: <TestDetailRoute /> },
      { path: 'requirements', element: <RequirementsPage /> },
      { path: 'requirements/:key', element: <RequirementRoute /> },
      { path: 'campaigns', element: <CampaignsPage /> },
      { path: 'campaigns/:id', element: <CampaignRoute /> },
      { path: 'bugs', element: <BugsPage /> },
      { path: 'elements', element: <ElementsPage /> },
      { path: 'projects', element: <ProjectsPage /> },
      // A project's tests used to be at /projects/:id.
      { path: 'projects/:projectId', element: <ProjectRedirect /> },
      { path: 'settings', element: <Settings /> },
      { path: 'chat', element: <ChatPanel /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
