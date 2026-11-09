// Unit tests for projects (lib/projects.js) and the tools an agent finds or makes its project
// with (list_projects, create_project): before them, an agent testing a new app had no way to
// get a project but the REST API, with a token it went to read in the user's files. On a database
// of their own, thrown away after.
// Run with: node --test test/projects.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'projects-')), 'test.db');
const { initDatabase, db } = await import('../lib/db.js');
initDatabase();
const { listProjects, createProject } = await import('../lib/projects.js');
const { getToolMap } = await import('../lib/agent/tools.js');
const tools = getToolMap();

test('a project is made with its phrases in its language; a name taken says which project has it', () => {
  const notes = createProject({ name: ' Notes de frais ', base_url: 'http://127.0.0.1:5173', language: 'fr', project_type: 'fullstack' });
  assert.equal(notes.name, 'Notes de frais');
  assert.equal(notes.language, 'fr');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM step_definitions WHERE project_id = ?').get(notes.id).n > 0, 'its built-in phrases');
  assert.throws(() => createProject({ name: 'Notes de frais' }), (err) => err.code === 'PROJECT_EXISTS' && err.projectId === notes.id);
  assert.throws(() => createProject({ name: '  ' }), /name is required/);
  assert.throws(() => createProject({ name: 'X', project_type: 'mobile' }), /project_type is one of/);
});

test('the projects of an app: its base URL starts its URL, or they share the origin', () => {
  createProject({ name: 'Shop', base_url: 'https://shop.test/app/' });
  assert.deepEqual(listProjects({ url: 'http://127.0.0.1:5173/manager' }).map((p) => p.name), ['Notes de frais']);
  assert.deepEqual(listProjects({ url: 'https://shop.test/other' }).map((p) => p.name), ['Shop'], 'the same origin');
  assert.deepEqual(listProjects({ url: 'https://elsewhere.test/' }), []);
  assert.equal(listProjects().length, 2);
});

test('an agent finds its project, or makes one, with the MCP tools', () => {
  assert.match(tools.list_projects.handler({ url: 'http://localhost:9999/' }).text, /No project for http:\/\/localhost:9999\/\. create_project makes one/);
  const listed = tools.list_projects.handler({ url: 'http://127.0.0.1:5173/' }).data;
  assert.deepEqual(listed.map((p) => [p.name, p.base_url, p.language, p.test_count]), [['Notes de frais', 'http://127.0.0.1:5173', 'fr', 0]]);

  const made = tools.create_project.handler({ name: 'Blog', base_url: 'http://127.0.0.1:4000', language: 'en' });
  assert.match(made.text, /^Project #\d+ "Blog" created \(http:\/\/127\.0\.0\.1:4000, tests in en\)\. Its id is the project_id of start_recording/);
  assert.match(tools.create_project.handler({ name: 'Blog', base_url: 'http://127.0.0.1:4000' }).error, /already called "Blog": #\d+ — use it \(project_id \d+\)/);
  assert.match(tools.create_project.handler({ name: 'Admin', base_url: '127.0.0.1:5173' }).error, /base_url is the app's URL/);
  assert.match(tools.create_project.handler({ name: 'Notes v2', base_url: 'http://127.0.0.1:5173/v2' }).text, /Other project\(s\) of that app: #\d+ "Notes de frais" — use one of them if it is the same/);
});
