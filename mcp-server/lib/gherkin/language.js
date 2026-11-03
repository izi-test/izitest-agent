// The language a project's tests are written in: its Gherkin keywords, the name the agents are
// told, and the line a .feature in it starts with. English is the default; French features
// start with "# language: fr", which Cucumber reads natively (Fonctionnalité, Scénario, Soit,
// Quand, Alors, Et).

export const LANGUAGES = {
  en: {
    name: 'English',
    header: '',
    feature: 'Feature', scenario: 'Scenario', outline: 'Scenario Outline', examples: 'Examples',
    Given: 'Given', When: 'When', Then: 'Then', And: 'And',
  },
  fr: {
    name: 'French',
    header: '# language: fr',
    feature: 'Fonctionnalité', scenario: 'Scénario', outline: 'Plan du scénario', examples: 'Exemples',
    Given: 'Soit', When: 'Quand', Then: 'Alors', And: 'Et',
  },
};

/** A project's language, known: 'en' or 'fr'. */
export const languageOf = (value) => (value === 'fr' ? 'fr' : 'en');

/** The words a .feature in `language` is written with. */
export const keywordsOf = (language) => LANGUAGES[languageOf(language)];

/**
 * A step's keyword as the definitions say it (Given, When, Then; And for what carries on the
 * one before), from the kind of keyword Cucumber read, whatever the language: Soit is Given.
 */
export function canonicalKeyword(keywordType, written) {
  switch (keywordType) {
    case 'Context': return 'Given';
    case 'Action': return 'When';
    case 'Outcome': return 'Then';
    case 'Conjunction': return 'And';
    default: return written === '*' ? '*' : written;
  }
}
