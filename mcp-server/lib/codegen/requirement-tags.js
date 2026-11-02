// The requirements a test checks, as tags of the code generated from it — @REQ-12 in
// Playwright (`--grep @REQ-12`) and on the Cucumber feature (`--tags @REQ-12`): a report
// of the run tells which requirement passes. `test.requirements` comes from
// lib/requirements.js (requirementsOfTest), put on the test by the caller.

/** "@REQ-12" for each requirement of the test: a key, with no space in it. */
export function requirementTags(test) {
  return (test.requirements ?? []).map((requirement) => `@${String(requirement.key).replace(/\s+/g, '-')}`);
}
