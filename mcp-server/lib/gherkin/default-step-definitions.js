// Seed catalogue inserted into every new project.
// Every entry maps a Gherkin phrase to a izitest-agent command.
// Placeholders {0}, {1}, ... refer to the Cucumber expression parameters in order.

export const DEFAULT_STEP_DEFINITIONS = [
  // Navigation
  { keyword: 'Given', pattern: 'I am on {string}',       command: 'navigate', params_template: { url: '{0}' } },
  { keyword: 'When',  pattern: 'I navigate to {string}', command: 'navigate', params_template: { url: '{0}' } },

  // Interaction
  { keyword: 'When',  pattern: 'I click on {string}',             command: 'click',    params_template: { selector: '{0}' } },
  // A click recorded by its text alone (click({ text })): no selector to name it by.
  { keyword: 'When',  pattern: 'I click on the text {string}',    command: 'click',    params_template: { text: '{0}' } },
  { keyword: 'When',  pattern: 'I fill {string} with {string}',   command: 'fill',     params_template: { selector: '{0}', value: '{1}' } },
  { keyword: 'When',  pattern: 'I select {string} in {string}',   command: 'select',   params_template: { value: '{0}', selector: '{1}' } },
  // A click recorded on a checkbox carries the state it left: these phrases set it.
  { keyword: 'When',  pattern: 'I check {string}',                command: 'click',    params_template: { selector: '{0}', checked: true } },
  { keyword: 'When',  pattern: 'I uncheck {string}',              command: 'click',    params_template: { selector: '{0}', checked: false } },
  { keyword: 'When',  pattern: 'I set {string} checked to {string}', command: 'click', params_template: { selector: '{0}', checked: '{1}' } },
  // A field named by the label a person reads next to it (or its placeholder): a scenario
  // written without seeing the page can name it, where it cannot know a CSS selector.
  { keyword: 'When',  pattern: 'I fill the field {string} with {string}', command: 'fill',   params_template: { label: '{0}', value: '{1}' } },
  { keyword: 'When',  pattern: 'I select {string} in the field {string}', command: 'select', params_template: { value: '{0}', label: '{1}' } },
  { keyword: 'When',  pattern: 'I check the field {string}',              command: 'click',  params_template: { label: '{0}', checked: true } },
  { keyword: 'When',  pattern: 'I uncheck the field {string}',            command: 'click',  params_template: { label: '{0}', checked: false } },
  // One file; an upload of several has no phrase.
  { keyword: 'When',  pattern: 'I upload {string} to {string}',   command: 'upload',   params_template: { file: '{0}', selector: '{1}' } },
  { keyword: 'When',  pattern: 'I drag {string} to {string}',     command: 'drag',     params_template: { selector: '{0}', target: '{1}' } },
  { keyword: 'When',  pattern: 'I drag {string} to the {word} of {string}', command: 'drag', params_template: { selector: '{0}', position: '{1}', target: '{2}' } },
  { keyword: 'When',  pattern: 'I press {string}',                command: 'keyboard', params_template: { key: '{0}' } },
  { keyword: 'When',  pattern: 'I scroll to {string}',            command: 'scroll',   params_template: { selector: '{0}' } },

  // Kept for the steps after, run on the server (lib/server-steps.js): a value of the page, an
  // API called to prepare data, a value of its answer. Used further on as {{name}}.
  { keyword: 'When',  pattern: 'I store the text of {string} as {string}',  command: 'capture', params_template: { selector: '{0}', what: 'text', name: '{1}' } },
  { keyword: 'When',  pattern: 'I store the text of {string} matching {string} as {string}', command: 'capture', params_template: { selector: '{0}', what: 'text', pattern: '{1}', name: '{2}' } },
  { keyword: 'When',  pattern: 'I store the value of {string} as {string}', command: 'capture', params_template: { selector: '{0}', what: 'value', name: '{1}' } },
  { keyword: 'When',  pattern: 'I store the URL as {string}',               command: 'capture', params_template: { what: 'url', name: '{0}' } },
  { keyword: 'When',  pattern: 'I store {string} of the response as {string}', command: 'capture', params_template: { what: 'response', path: '{0}', name: '{1}' } },
  { keyword: 'When',  pattern: 'I store {string} of the request to {string} as {string}', command: 'capture', params_template: { what: 'request', path: '{0}', url: '{1}', name: '{2}' } },
  { keyword: 'Given', pattern: 'I call {word} {string}',                    command: 'http',    params_template: { method: '{0}', url: '{1}' } },
  { keyword: 'Given', pattern: 'I call {word} {string} with {string}',      command: 'http',    params_template: { method: '{0}', url: '{1}', body: '{2}' } },

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
  // What the page does wrong on its own: the check a bug's test makes (lib/explore.js).
  { keyword: 'Then',  pattern: 'the page should log no error containing {string}', command: 'assert', params_template: { type: 'no_console_errors', expected: '{0}' } },
  { keyword: 'Then',  pattern: 'no request to {string} should fail',      command: 'assert', params_template: { type: 'no_failed_requests', expected: '{0}' } },
  { keyword: 'Then',  pattern: 'the link {string} should work',           command: 'assert', params_template: { type: 'link_ok', selector: '{0}' } },
  { keyword: 'Then',  pattern: 'the page should not break the accessibility rule {string}', command: 'assert', params_template: { type: 'no_a11y_violations', expected: '{0}' } },
];

// The same catalogue in French, phrase for phrase: the same commands and parameters, the
// arguments in the same order (the exported step code takes them positionally). A project
// written in French is seeded with it (step-definition-store.js).
const FRENCH_PATTERNS = {
  'I am on {string}': 'je suis sur {string}',
  'I navigate to {string}': 'je vais sur {string}',
  'I click on {string}': 'je clique sur {string}',
  'I click on the text {string}': 'je clique sur le texte {string}',
  'I fill {string} with {string}': 'je remplis {string} avec {string}',
  'I select {string} in {string}': 'je sélectionne {string} dans {string}',
  'I check {string}': 'je coche {string}',
  'I uncheck {string}': 'je décoche {string}',
  'I set {string} checked to {string}': 'je mets la case {string} à {string}',
  'I fill the field {string} with {string}': 'je remplis le champ {string} avec {string}',
  'I select {string} in the field {string}': 'je sélectionne {string} dans le champ {string}',
  'I check the field {string}': 'je coche le champ {string}',
  'I uncheck the field {string}': 'je décoche le champ {string}',
  'I upload {string} to {string}': 'je téléverse {string} dans {string}',
  'I drag {string} to {string}': 'je glisse {string} sur {string}',
  'I drag {string} to the {word} of {string}': 'je glisse {string} vers le côté {word} de {string}',
  'I press {string}': "j'appuie sur {string}",
  'I scroll to {string}': "je fais défiler jusqu'à {string}",
  'I store the text of {string} as {string}': 'je retiens le texte de {string} dans {string}',
  'I store the text of {string} matching {string} as {string}': 'je retiens le texte de {string} qui correspond à {string} dans {string}',
  'I store the value of {string} as {string}': 'je retiens la valeur de {string} dans {string}',
  'I store the URL as {string}': "je retiens l'URL dans {string}",
  'I store {string} of the response as {string}': 'je retiens {string} de la réponse dans {string}',
  'I store {string} of the request to {string} as {string}': 'je retiens {string} de la requête vers {string} dans {string}',
  'I call {word} {string}': "j'appelle {word} {string}",
  'I call {word} {string} with {string}': "j'appelle {word} {string} avec {string}",
  'I wait {int} seconds': "j'attends {int} secondes",
  'I wait for {string}': "j'attends {string}",
  'I should see {string}': 'je vois {string}',
  'I should not see {string}': 'je ne vois pas {string}',
  '{string} should be visible': '{string} est visible',
  '{string} should contain {string}': '{string} contient {string}',
  '{string} should not contain {string}': '{string} ne contient pas {string}',
  'the URL should be {string}': "l'URL est {string}",
  'the URL should contain {string}': "l'URL contient {string}",
  'the title should be {string}': 'le titre est {string}',
  'the title should contain {string}': 'le titre contient {string}',
  '{string} should exist': '{string} existe',
  '{string} should be hidden': '{string} est masqué',
  '{string} should have text {string}': '{string} a pour texte {string}',
  'the {string} of {string} should be {string}': "l'attribut {string} de {string} vaut {string}",
  '{string} should match {int} elements': '{string} correspond à {int} éléments',
  'the page should log no error containing {string}': "la console n'affiche aucune erreur contenant {string}",
  'no request to {string} should fail': "aucune requête vers {string} n'échoue",
  'the link {string} should work': 'le lien {string} fonctionne',
  'the page should not break the accessibility rule {string}': "la page respecte la règle d'accessibilité {string}",
};

/** An English phrase of the catalogue in `language`; as it is in English, or for a language without one. */
export function translatedPattern(pattern, language) {
  return language === 'fr' ? FRENCH_PATTERNS[pattern] ?? pattern : pattern;
}

/** The built-in catalogue in `language` ('en', 'fr'), each phrase marked with it. */
export function defaultStepDefinitions(language = 'en') {
  return DEFAULT_STEP_DEFINITIONS.map((def) => ({ ...def, pattern: translatedPattern(def.pattern, language), language: language === 'fr' ? 'fr' : 'en' }));
}
