import { useState } from 'react';
import { Check, FolderKanban, MousePointerClick, Pencil, Search, Trash2, X } from 'lucide-react';
import { useAppSelector } from '../store/hooks';
import { useDeleteElementMutation, useGetElementsQuery, useGetProjectsQuery, useRenameElementMutation } from '../store/services/projectsApi';
import { useGo, useUrlState } from '../navigation';
import { Button } from './Button';
import { Card, EmptyState, KeyChip, PageHeader, Pill } from './ui';
import type { PageElement } from '../types';

// What the tests of the project in scope act on (mcp-server/lib/elements.js), page by page.
// Each element is known by its page, then its role and name — never by resemblance: the
// "Save" of two pages are two elements. Its name stands for it in the Gherkin; renamed here,
// it reads under its new name in every test. One no step acts on any more can be deleted.

const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? 'The request failed';

export function ElementsPage() {
  const scope = useAppSelector((state) => state.ui.selectedProjectId);
  const { data: projects = [] } = useGetProjectsQuery();
  const project = projects.find((p) => p.id === scope);
  const go = useGo();
  const [search, setSearch] = useUrlState('q');
  const { data: elements = [], isLoading } = useGetElementsQuery(scope ?? 0, { skip: scope == null });

  if (scope == null) {
    return (
      <>
        <PageHeader title="Elements" subtitle="What the tests of a project act on, page by page." />
        <Card>
          <EmptyState icon={FolderKanban} title="Choose a project" action={<Button variant="secondary" onClick={() => go('/projects')}>Projects</Button>}>
            Elements belong to a project: choose one in the sidebar.
          </EmptyState>
        </Card>
      </>
    );
  }

  const needle = search.trim().toLowerCase();
  const shown = elements.filter((e) => !needle || `${e.name} ${e.page} ${e.target}`.toLowerCase().includes(needle));
  const pages = [...new Set(shown.map((e) => e.page))];

  return (
    <>
      <PageHeader
        title="Elements"
        subtitle={`What the tests of ${project?.name ?? 'this project'} act on, page by page: each known by its page, its role and its name, never by resemblance. Its name stands for it in the Gherkin.`}
      />
      <div className="toolbar">
        <div className="search-field">
          <Search size={15} />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or page…" aria-label="Search elements" />
        </div>
        <span className="muted">{elements.length} element{elements.length === 1 ? '' : 's'} on {new Set(elements.map((e) => e.page)).size} page{new Set(elements.map((e) => e.page)).size === 1 ? '' : 's'}</span>
      </div>

      {isLoading ? (
        <Card><p className="empty-state">Loading…</p></Card>
      ) : elements.length === 0 ? (
        <Card>
          <EmptyState icon={MousePointerClick} title="No element yet">
            A step recorded from now on keeps the page it was done on, and the element it acts on is listed here. A test recorded
            before gets its elements at its next run.
          </EmptyState>
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState icon={Search} title="No element matches" action={<Button variant="secondary" onClick={() => setSearch('')}>Clear the search</Button>}>
            Try another name or page.
          </EmptyState>
        </Card>
      ) : (
        pages.map((page) => (
          <Card key={page} title={<span className="mono">{page}</span>} flush className="elements-page">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>On the page</th>
                    <th>Used by</th>
                    <th className="col-actions" />
                  </tr>
                </thead>
                <tbody>
                  {shown.filter((e) => e.page === page).map((element) => <ElementRow key={element.id} element={element} />)}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}
    </>
  );
}

function ElementRow({ element }: { element: PageElement }) {
  const go = useGo();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(element.name);
  const [rename, { isLoading: renaming, error: renameError, reset }] = useRenameElementMutation();
  const [remove, { isLoading: removing, error: removeError }] = useDeleteElementMutation();
  const steps = element.used_by.reduce((n, use) => n + use.steps.length, 0);

  const save = async () => {
    if (name.trim() === element.name) return setEditing(false);
    const done = await rename({ id: element.id, name }).unwrap().catch(() => null);
    if (done) setEditing(false);
  };
  const cancel = () => {
    setName(element.name);
    reset();
    setEditing(false);
  };

  return (
    <tr>
      <td>
        {editing ? (
          <div className="element-name-edit">
            <input
              autoFocus value={name} aria-label="Element name" disabled={renaming}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
            />
            <button className="icon-button" title="Save the name" aria-label="Save the name" disabled={renaming || !name.trim()} onClick={save}><Check size={15} /></button>
            <button className="icon-button" title="Cancel" aria-label="Cancel" onClick={cancel}><X size={15} /></button>
            {renameError && <span className="field__error">{errorOf(renameError)}</span>}
          </div>
        ) : (
          <div className="element-name">
            <span className="cell-title">{element.name}</span>
            <button className="icon-button" title="Rename" aria-label={`Rename ${element.name}`} onClick={() => setEditing(true)}><Pencil size={14} /></button>
          </div>
        )}
      </td>
      <td className="mono cell-muted">{element.target}</td>
      <td>
        {element.used_by.length ? (
          <div className="cell-chips">
            {element.used_by.map((use) => (
              <KeyChip key={use.test} title={`Step${use.steps.length === 1 ? '' : 's'} ${use.steps.join(', ')}`} onClick={() => go(`/tests/${encodeURIComponent(use.test)}`, { from: 'Elements' })}>
                {use.test}
              </KeyChip>
            ))}
            <span className="cell-muted">{steps} step{steps === 1 ? '' : 's'}</span>
          </div>
        ) : <Pill tone="slate">Unused</Pill>}
      </td>
      <td className="col-actions">
        {!element.used_by.length && (
          <button className="icon-button icon-button--danger" title="Delete" aria-label={`Delete ${element.name}`} disabled={removing} onClick={() => remove(element.id)}>
            <Trash2 size={15} />
          </button>
        )}
        {removeError && <span className="field__error">{errorOf(removeError)}</span>}
      </td>
    </tr>
  );
}
