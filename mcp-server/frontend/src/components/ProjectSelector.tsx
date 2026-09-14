import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Folder, Plus, Edit2, Trash2, ChevronDown, FlaskConical } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { showToast, setSelectedProjectId } from '../store/slices/uiSlice';
import { useGetProjectsQuery, useCreateProjectMutation, useUpdateProjectMutation, useDeleteProjectMutation } from '../store/services/projectsApi';
import { useAssignToProjectMutation } from '../store/services/testsApi';

export function ProjectSwitcher() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const selectedProjectId = useAppSelector(state => state.ui.selectedProjectId);

  const { data: projects = [] } = useGetProjectsQuery();
  const [createProject] = useCreateProjectMutation();

  const [isOpen, setIsOpen] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedProject = projects.find(project => project.id === selectedProjectId);
  const displayName = selectedProject ? selectedProject.name : 'All Projects';

  const handleSelect = (projectId: number | null) => {
    dispatch(setSelectedProjectId(projectId));
    navigate('/');
    setIsOpen(false);
  };

  const handleCreateProject = async (data: { name: string; description: string; context: string; project_type: string; base_url: string }) => {
    try {
      const result = await createProject(data).unwrap();
      dispatch(showToast({ message: 'Project created' }));
      dispatch(setSelectedProjectId(result.id));
      navigate('/');
      setShowCreateModal(false);
    } catch (err: any) {
      dispatch(showToast({ message: err.message || 'Create failed', type: 'error' }));
    }
  };

  return (
    <>
      <div className="project-switcher" ref={dropdownRef}>
        <button
          className="project-switcher__trigger"
          onClick={() => setIsOpen(!isOpen)}
        >
          <div className="project-switcher__label">
            <FlaskConical size={16} className="project-switcher__icon" />
            <span className="project-switcher__name">{displayName}</span>
          </div>
          <ChevronDown size={14} className={`project-switcher__chevron ${isOpen ? 'open' : ''}`} />
        </button>

        {isOpen && (
          <div className="project-switcher__dropdown">
            <div
              className={`project-switcher__option ${selectedProjectId === null ? 'active' : ''}`}
              onClick={() => handleSelect(null)}
            >
              <FlaskConical size={14} />
              <span>All Projects</span>
            </div>

            <div className="project-switcher__divider" />

            {projects.map(project => (
              <div
                key={project.id}
                className={`project-switcher__option ${selectedProjectId === project.id ? 'active' : ''}`}
                onClick={() => handleSelect(project.id)}
              >
                <Folder size={14} />
                <span>{project.name}</span>
                <span className="project-switcher__count">{project.test_count ?? 0}</span>
              </div>
            ))}

            <div className="project-switcher__divider" />

            <div
              className="project-switcher__option project-switcher__option--action"
              onClick={() => { setIsOpen(false); setShowCreateModal(true); }}
            >
              <Plus size={14} />
              <span>New Project</span>
            </div>
          </div>
        )}
      </div>

      {showCreateModal && (
        <ProjectModal
          title="New Project"
          onClose={() => setShowCreateModal(false)}
          onSave={handleCreateProject}
        />
      )}
    </>
  );
}

/* Project context actions — edit/delete buttons shown in sidebar bottom when a project is selected */
export function ProjectSelector() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const selectedProjectId = useAppSelector(state => state.ui.selectedProjectId);

  const { data: projects = [] } = useGetProjectsQuery();
  const [updateProject] = useUpdateProjectMutation();
  const [deleteProjectMut] = useDeleteProjectMutation();

  const [editingProject, setEditingProject] = useState<{ id: number; name: string; description: string | null; context?: string; project_type?: string | null; base_url?: string | null } | null>(null);

  const handleUpdateProject = async (id: number, data: { name: string; description: string; context: string; project_type: string; base_url: string }) => {
    try {
      await updateProject({ id, ...data }).unwrap();
      dispatch(showToast({ message: 'Project updated' }));
      setEditingProject(null);
    } catch (err: any) {
      dispatch(showToast({ message: err.message || 'Update failed', type: 'error' }));
    }
  };

  const handleDeleteProject = async (id: number) => {
    if (!confirm('Delete this project? Tests will be moved to "All Projects".')) return;
    try {
      await deleteProjectMut(id).unwrap();
      dispatch(showToast({ message: 'Project deleted' }));
      if (selectedProjectId === id) {
        dispatch(setSelectedProjectId(null));
        navigate('/tests');
      }
    } catch (err: any) {
      dispatch(showToast({ message: err.message || 'Delete failed', type: 'error' }));
    }
  };

  const selectedProject = projects.find(project => project.id === selectedProjectId);

  return (
    <div className="project-selector">
      {selectedProject && (
        <div className="project-context-actions">
          <button
            className="project-context-btn"
            onClick={() => setEditingProject(selectedProject)}
            title="Edit project"
          >
            <Edit2 size={14} />
          </button>
          <button
            className="project-context-btn project-context-btn--danger"
            onClick={() => handleDeleteProject(selectedProject.id)}
            title="Delete project"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {editingProject && (
        <ProjectModal
          title="Edit Project"
          initialName={editingProject.name}
          initialDescription={editingProject.description || ''}
          initialContext={editingProject.context || ''}
          initialProjectType={editingProject.project_type || ''}
          initialBaseUrl={editingProject.base_url || ''}
          onClose={() => setEditingProject(null)}
          onSave={(data) => handleUpdateProject(editingProject.id, data)}
        />
      )}
    </div>
  );
}

interface ProjectModalProps {
  title: string;
  initialName?: string;
  initialDescription?: string;
  initialContext?: string;
  initialProjectType?: string;
  initialBaseUrl?: string;
  onClose: () => void;
  onSave: (data: { name: string; description: string; context: string; project_type: string; base_url: string }) => void;
}

function ProjectModal({ title, initialName = '', initialDescription = '', initialContext = '', initialProjectType = '', initialBaseUrl = '', onClose, onSave }: ProjectModalProps) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [context, setContext] = useState(initialContext);
  const [projectType, setProjectType] = useState(initialProjectType);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [error, setError] = useState('');

  const handleSave = () => {
    if (!name.trim()) {
      setError('Project name is required');
      return;
    }
    onSave({
      name: name.trim(),
      description: description.trim(),
      context: context.trim(),
      project_type: projectType,
      base_url: baseUrl.trim(),
    });
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-overlay" />
      <div className="modal-content modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="field-group">
            <label>Name</label>
            <input
              type="text"
              value={name}
              onChange={e => { setName(e.target.value); setError(''); }}
              placeholder="Project name"
              autoFocus
            />
          </div>
          <div className="field-group">
            <label>Description (optional)</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Brief description"
            />
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <div className="field-group" style={{ flex: 1 }}>
              <label>Base URL</label>
              <input
                type="text"
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                placeholder="https://my-app.com"
              />
            </div>
            <div className="field-group" style={{ width: '160px' }}>
              <label>Type</label>
              <select value={projectType} onChange={e => setProjectType(e.target.value)}>
                <option value="">--</option>
                <option value="frontend">Frontend</option>
                <option value="backend">Backend</option>
                <option value="fullstack">Fullstack</option>
              </select>
            </div>
          </div>
          <div className="field-group">
            <label>Project context</label>
            <textarea
              value={context}
              onChange={e => setContext(e.target.value)}
              placeholder="Describe your project here: specs, features, user flows, API endpoints, anything the AI should know to help you write tests..."
              rows={6}
              style={{ resize: 'vertical', minHeight: '100px' }}
            />
            <span className="field-hint">This text is sent to the AI agent as context when creating tests.</span>
          </div>
          {error && <div className="create-wf-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

// Project assignment dropdown for TestDetail
interface ProjectAssignProps {
  testName: string;
  currentProjectId: number | null;
  onAssign: (projectId: number | null) => void;
}

export function ProjectAssign({ testName, currentProjectId, onAssign }: ProjectAssignProps) {
  const dispatch = useAppDispatch();
  const { data: projects = [] } = useGetProjectsQuery();
  const [assignToProject] = useAssignToProjectMutation();
  const [isOpen, setIsOpen] = useState(false);

  const handleAssign = async (projectId: number | null) => {
    try {
      await assignToProject({ testName, projectId }).unwrap();
      onAssign(projectId);
      dispatch(showToast({ message: projectId ? 'Test moved to project' : 'Test removed from project' }));
    } catch (err: any) {
      dispatch(showToast({ message: err.message || 'Assign failed', type: 'error' }));
    }
    setIsOpen(false);
  };

  const currentProject = projects.find(p => p.id === currentProjectId);

  return (
    <div className="project-assign">
      <button className="project-assign-btn" onClick={() => setIsOpen(!isOpen)}>
        <Folder size={14} />
        {currentProject ? currentProject.name : 'No Project'}
        <ChevronDown size={14} />
      </button>

      {isOpen && (
        <div className="project-assign-dropdown">
          <div
            className={`project-assign-option ${currentProjectId === null ? 'active' : ''}`}
            onClick={() => handleAssign(null)}
          >
            No Project
          </div>
          {projects.map(project => (
            <div
              key={project.id}
              className={`project-assign-option ${currentProjectId === project.id ? 'active' : ''}`}
              onClick={() => handleAssign(project.id)}
            >
              {project.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
