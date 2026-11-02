// Seed catalogue inserted into every new project.
// Every entry maps a Gherkin phrase to a izitest-agent command.
// Placeholders {0}, {1}, ... refer to the Cucumber expression parameters in order.

export const DEFAULT_STEP_DEFINITIONS = [
  // Navigation
  { keyword: 'Given', pattern: 'I am on {string}',       command: 'navigate', params_template: { url: '{0}' } },
  { keyword: 'When',  pattern: 'I navigate to {string}', command: 'navigate', params_template: { url: '{0}' } },

  // Interaction
  { keyword: 'When',  pattern: 'I click on {string}',             command: 'click',    params_template: { selector: '{0}' } },
  { keyword: 'When',  pattern: 'I fill {string} with {string}',   command: 'fill',     params_template: { selector: '{0}', value: '{1}' } },
  { keyword: 'When',  pattern: 'I select {string} in {string}',   command: 'select',   params_template: { value: '{0}', selector: '{1}' } },
  // A click recorded on a checkbox carries the state it left: these phrases set it.
  { keyword: 'When',  pattern: 'I check {string}',                command: 'click',    params_template: { selector: '{0}', checked: true } },
  { keyword: 'When',  pattern: 'I uncheck {string}',              command: 'click',    params_template: { selector: '{0}', checked: false } },
  { keyword: 'When',  pattern: 'I set {string} checked to {string}', command: 'click', params_template: { selector: '{0}', checked: '{1}' } },
  // One file; an upload of several has no phrase.
  { keyword: 'When',  pattern: 'I upload {string} to {string}',   command: 'upload',   params_template: { file: '{0}', selector: '{1}' } },
  { keyword: 'When',  pattern: 'I drag {string} to {string}',     command: 'drag',     params_template: { selector: '{0}', target: '{1}' } },
  { keyword: 'When',  pattern: 'I drag {string} to the {word} of {string}', command: 'drag', params_template: { selector: '{0}', position: '{1}', target: '{2}' } },
  { keyword: 'When',  pattern: 'I press {string}',                command: 'keyboard', params_template: { key: '{0}' } },
  { keyword: 'When',  pattern: 'I scroll to {string}',            command: 'scroll',   params_template: { selector: '{0}' } },

  // Waits
  { keyword: 'When',  pattern: 'I wait {int} seconds',   command: 'wait', params_template: { ms: '{0}000' } },
  { keyword: 'When',  pattern: 'I wait for {string}',    command: 'wait', params_template: { selector: '{0}' } },

  // Assertions
  { keyword: 'Then',  pattern: 'I should see {string}',                  command: 'assert', params_template: { type: 'text_contains', expected: '{0}' } },
  { keyword: 'Then',  pattern: 'I should not see {string}',              command: 'assert', params_template: { type: 'element_not_exists', selector: '{0}' } },
  { keyword: 'Then',  pattern: '{string} should be visible',             command: 'assert', params_template: { type: 'element_visible', selector: '{0}' } },
  { keyword: 'Then',  pattern: '{string} should contain {string}',       command: 'assert', params_template: { type: 'text_contains', selector: '{0}', expected: '{1}' } },
  { keyword: 'Then',  pattern: '{string} should not contain {string}',   command: 'assert', params_template: { type: 'text_not_contains', selector: '{0}', expected: '{1}' } },
  { keyword: 'Then',  pattern: 'the URL should be {string}',             command: 'assert', params_template: { type: 'url_equals', expected: '{0}' } },
  { keyword: 'Then',  pattern: 'the URL should contain {string}',        command: 'assert', params_template: { type: 'url_contains', expected: '{0}' } },
  { keyword: 'Then',  pattern: 'the title should be {string}',           command: 'assert', params_template: { type: 'title_equals', expected: '{0}' } },
  { keyword: 'Then',  pattern: 'the title should contain {string}',      command: 'assert', params_template: { type: 'title_contains', expected: '{0}' } },
  { keyword: 'Then',  pattern: '{string} should exist',                  command: 'assert', params_template: { type: 'element_exists', selector: '{0}' } },
  { keyword: 'Then',  pattern: '{string} should be hidden',              command: 'assert', params_template: { type: 'element_hidden', selector: '{0}' } },
  { keyword: 'Then',  pattern: '{string} should have text {string}',     command: 'assert', params_template: { type: 'text_equals', selector: '{0}', expected: '{1}' } },
  { keyword: 'Then',  pattern: 'the {string} of {string} should be {string}', command: 'assert', params_template: { type: 'attribute_equals', attribute: '{0}', selector: '{1}', expected: '{2}' } },
  { keyword: 'Then',  pattern: '{string} should match {int} elements',   command: 'assert', params_template: { type: 'element_count', selector: '{0}', expected: '{1}' } },
];
