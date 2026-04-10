import { useState, useEffect, useRef } from 'react';
import { Folder, Plus, MoreVertical, Edit2, Trash2, FolderOpen, ChevronDown, ChevronRight } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { showToast, setSelectedProjectId } from '../store/slices/uiSlice';
import { useGetProjectsQuery, useCreateProjectMutation, useUpdateProjectMutation, useDeleteProjectMutation } from '../store/services/projectsApi';
import { useGetTestsQuery, useAssignToProjectMutation } from '../store/services/testsApi';

export function ProjectSelector() {
  const dispatch = useAppDispatch();
  const selectedProjectId = useAppSelector(state => state.ui.selectedProjectId);

  const { data: projects = [] } = useGetProjectsQuery();
  const { data: unorganizedTests = [] } = useGetTestsQuery(null);
  const [createProject] = useCreateProjectMutation();
  const [updateProject] = useUpdateProjectMutation();
  const [deleteProjectMut] = useDeleteProjectMutation();

  const [isExpanded, setIsExpanded] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingProject, setEditingProject] = useState<{ id: number; name: string; description: string | null } | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenFor(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCreateProject = async (name: string, description: string) => {
    try {
      await createProject({ name, description }).unwrap();
      dispatch(showToast({ message: 'Project created' }));
      setShowCreateModal(false);
    } catch (err: any) {
      dispatch(showToast({ message: err.message || 'Create failed', type: 'error' }));
    }
  };

  const handleUpdateProject = async (id: number, name: string, description: string) => {
    try {
      await updateProject({ id, name, description }).unwrap();
      dispatch(showToast({ message: 'Project updated' }));
      setEditingProject(null);
    } catch (err: any) {
      dispatch(showToast({ message: err.message || 'Update failed', type: 'error' }));
    }
  };

  const handleDeleteProject = async (id: number) => {
    if (!confirm('Delete this project? Tests will be moved to "Unorganized".')) return;
    try {
      await deleteProjectMut(id).unwrap();
      dispatch(showToast({ message: 'Project deleted' }));
      if (selectedProjectId === id) {
        dispatch(setSelectedProjectId(null));
      }
    } catch (err: any) {
      dispatch(showToast({ message: err.message || 'Delete failed', type: 'error' }));
    }
  };


  return (
    <div className="project-selector">
      <div className="project-selector-header" onClick={() => setIsExpanded(!isExpanded)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span style={{ fontWeight: 600, fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Projects
          </span>
        </div>
        <button
          className="project-add-btn"
          onClick={(e) => { e.stopPropagation(); setShowCreateModal(true); }}
          title="New Project"
        >
          <Plus size={14} />
        </button>
      </div>

      {isExpanded && (
        <div className="project-list">
          <div
            className={`project-item ${selectedProjectId === null ? 'active' : ''}`}
            onClick={() => dispatch(setSelectedProjectId(null))}
          >
            <FolderOpen size={16} className="project-icon" />
            <span className="project-name">Unorganized</span>
            <span className="project-count">{unorganizedTests.length}</span>
          </div>

          {projects.map(project => (
            <div
              key={project.id}
              className={`project-item ${selectedProjectId === project.id ? 'active' : ''}`}
              onClick={() => dispatch(setSelectedProjectId(project.id))}
            >
              <Folder size={16} className="project-icon" />
              <span className="project-name">{project.name}</span>
              <span className="project-count">{project.test_count ?? 0}</span>

              <button
                className="project-menu-btn"
                onClick={(e) => { e.stopPropagation(); setMenuOpenFor(menuOpenFor === project.id ? null : project.id); }}
              >
                <MoreVertical size={14} />
              </button>

              {menuOpenFor === project.id && (
                <div className="project-menu" ref={menuRef}>
                  <button
                    className="project-menu-item"
                    onClick={(e) => { e.stopPropagation(); setEditingProject(project); setMenuOpenFor(null); }}
                  >
                    <Edit2 size={14} />
                    Edit
                  </button>
                  <button
                    className="project-menu-item danger"
                    onClick={(e) => { e.stopPropagation(); handleDeleteProject(project.id); setMenuOpenFor(null); }}
                  >
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showCreateModal && (
        <ProjectModal
          title="New Project"
          onClose={() => setShowCreateModal(false)}
          onSave={handleCreateProject}
        />
      )}

      {editingProject && (
        <ProjectModal
          title="Edit Project"
          initialName={editingProject.name}
          initialDescription={editingProject.description || ''}
          onClose={() => setEditingProject(null)}
          onSave={(name, desc) => handleUpdateProject(editingProject.id, name, desc)}
        />
      )}
    </div>
  );
}

interface ProjectModalProps {
  title: string;
  initialName?: string;
  initialDescription?: string;
  onClose: () => void;
  onSave: (name: string, description: string) => void;
}

function ProjectModal({ title, initialName = '', initialDescription = '', onClose, onSave }: ProjectModalProps) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState('');

  const handleSave = () => {
    if (!name.trim()) {
      setError('Project name is required');
      return;
    }
    onSave(name.trim(), description.trim());
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-overlay" />
      <div className="modal-content" onClick={e => e.stopPropagation()}>
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
