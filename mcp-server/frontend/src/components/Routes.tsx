import { Navigate, useParams } from 'react-router-dom';
import { TestDetail } from './TestDetail';
import { RequirementPage } from './Requirements';
import { CampaignPage } from './Campaigns';

// The pages of one item, from the route's parameters (App.tsx).

export function TestDetailRoute() {
  const { testName } = useParams();
  if (!testName) return <Navigate to="/tests" replace />;
  // Keyed by the test: another one opened starts afresh.
  return <TestDetail key={testName} testName={decodeURIComponent(testName)} />;
}

export function RequirementRoute() {
  const { key } = useParams();
  if (!key) return <Navigate to="/requirements" replace />;
  return <RequirementPage key={key} requirementKey={decodeURIComponent(key)} />;
}

export function CampaignRoute() {
  const { id } = useParams();
  if (!id || !/^\d+$/.test(id)) return <Navigate to="/campaigns" replace />;
  return <CampaignPage key={id} id={Number(id)} />;
}

export function ProjectRedirect() {
  const { projectId } = useParams();
  return <Navigate to={`/tests?project=${projectId}`} replace />;
}
