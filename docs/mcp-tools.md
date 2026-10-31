# MCP Tools Reference 🛠️

IziTest Agent exposes two main categories of tools via the Model Context Protocol (MCP): **Browser Interaction** and **Test Automation (Recording/Replay)**.

## 1. Browser Interaction Tools

These tools are used for direct, real-time control of the browser.

| Tool | Description | Key Parameters |
| :--- | :--- | :--- |
| `list_profiles` | Lists all connected Chrome profiles. | - |
| `navigate` | Navigates to a URL. | `url`, `profile`, `tabId` |
| `snapshot` | Scans the DOM and returns interactive elements with UIDs (@eX). | `purposeFilter` (fill/click/read), `searchText` |
| `screenshot` | Takes an annotated screenshot with DOM mapping. | `annotate`, `purposeFilter`, `searchText` |
| `click` | Clicks an element. | `ref` (@eX), `selector`, `text` |
| `fill` | Fills an input/textarea/select. | `ref` (@eX), `selector`, `value`, `clear` |
| `extract` | Retrieves content (text, attributes) from the page. | `selector`, `attribute`, `multiple` |
| `get_tabs` | Lists all open tabs in the browser. | `profile` |
| `get_page_info` | Detailed info (title, URL, element counts). | `tabId`, `profile` |
| `scroll` | Scrolls the page or moves to an element. | `direction`, `amount`, `selector` |
| `wait` | Pauses for a duration or until an element appears. | `ms`, `selector` |
| `execute_js` | Runs arbitrary JavaScript in the page context. | `code` |
| `keyboard` | Sends a key press event. | `key`, `modifiers` |
| `get_cookies` | Retrieves cookies for a URL/domain. | `url`, `domain` |

### Recommended Workflow: The Element Discovery Protocol
To ensure high reliability, follow this sequence when interacting with elements:
1.  **Step 1**: Use `screenshot()`. It's the most robust way to find elements, even in complex SPAs.
2.  **Step 2**: If the element isn't in the mapping, use `snapshot(includeHidden=true, purposeFilter="...")`. Use `searchText` to narrow down the results.

---

## 2. Test Automation Tools (Recording & Replay)

These tools allow you to record sequences of actions and replay them autonomously.

| Tool | Description |
| :--- | :--- |
| `start_recording` | Starts recording a new test. All subsequent browser actions are auto-recorded. |
| `stop_recording` | Stops the recording and saves the test. Performs batch variable detection. |
| `list_tests` | Lists all saved tests and their variables. |
| `run_test` | Executes a saved test autonomously in the browser. Supports variable overrides. |
| `add_assertion` | Adds a check (e.g., "element exists") to a saved test. |
| `fix_test_step` | Updates a failed step with data from a manual action. |
| `delete_test` | Removes a saved test from the database. |
| `add_retroactive_vrt` | Adds a visual regression test assertion retroactively using a recorded baseline. |
| `get_test_as_code` | Returns a saved test as Playwright code to commit in the project under test (see below). |
| `create_business_step` | Groups a run of steps of a recorded test into one business Gherkin step (see below). |

### Export Playwright : `get_test_as_code`

Rend un test enregistré sous forme de fichiers Playwright, à versionner dans le projet testé. Ils
tournent avec Playwright seul, sans l'extension ni LLM, en CI comme en local.

| Paramètre | Type | Description |
| :--- | :--- | :--- |
| `test_name` | string | Nom du test (obligatoire) |
| `framework` | string | `playwright-plain` (défaut) : un `tests/<nom>.spec.js`, lancé par `npx playwright test`. `playwright-cucumber` : un projet autonome (`.feature`, step definitions, World, `cucumber.js` et son propre `package.json`) ; le test doit appartenir à un projet |

Rien n'est écrit sur le disque : les fichiers reviennent en texte (un titre avec le chemin, puis le
code), et l'agent les écrit lui-même. Le projet `playwright-cucumber` va dans un dossier à part
(ex. `e2e/`), jamais par-dessus le `package.json` du dépôt. Le tableau de bord sert le même code
sur `GET /api/tests/:name/codegen?framework=…`.

#### Identifiants générés à chaque chargement

Le rejeu d'IziTest essaie tous les locators enregistrés d'une étape ; le code Playwright n'en
garde qu'un. Un sélecteur bâti sur un identifiant que la page génère à chaque chargement (UUID
dans un `id` ou un `for`, `:r1:` de React, classes CSS-in-JS) y casserait au premier passage. En
`playwright-plain`, chaque étape prend donc le premier locator stable, dans cet ordre :

1. le sélecteur enregistré, s'il ne contient rien de généré (le code est alors celui d'avant) ;
2. un `data-testid`, puis un autre locator CSS sans rien de généré ;
3. pour un `<label>` : `page.locator('label', { hasText: … })`, le label lui-même (les cases à
   cocher stylées cachent souvent le vrai `<input>`) ;
4. pour un champ (`input`, `select`, `textarea`, ou une saisie) : `page.getByLabel(…)` ;
5. `page.getByPlaceholder(…)`, puis `page.getByText(…, { exact: true })` quand le texte visible
   est le nom accessible.

Sans alternative stable, le sélecteur d'origine reste, précédé d'un commentaire `// FIXME`. En
`playwright-cucumber`, le même choix vaut pour les étapes métier (ci-dessous) ; une étape restée
générique (`When I click on "…"`) écrit encore le sélecteur enregistré dans le `.feature`.

### Étapes métier : `create_business_step`

Regroupe une suite d'étapes d'un test enregistré en une seule phrase Gherkin métier, au lieu d'une
étape technique par clic :

```gherkin
# avant
When I click on "div.moreFilterBtn"
And I click on "label[for=\"…uuid…\"]"
And I click on "#seeAllResults"
# après
When je ne garde que les maisons avec jardin
```

La step definition est construite à partir des étapes enregistrées elles-mêmes, sélecteurs et
locators compris : rien n'est à recopier. L'export Cucumber de ce test, et de tout test qui contient
les mêmes étapes, affiche la phrase, et `features/steps/composite.steps.js` contient les actions
Playwright (avec les locators stables ci-dessus). Écrite à la main dans un autre scénario, la phrase
fonctionne aussi.

| Paramètre | Type | Description |
| :--- | :--- | :--- |
| `project_id` | number | Projet de la step definition. Un test sans projet y est rattaché |
| `test_name` | string | Test enregistré |
| `from_step`, `to_step` | number | Étapes à regrouper, numérotées à partir de 1, bornes comprises |
| `keyword` | string | `Given`, `When` ou `Then` |
| `pattern` | string | La phrase, en Cucumber expression. `( )` et `/` y ont un sens (texte optionnel, alternatives) : à éviter |
| `args` | array | Un par paramètre de la phrase (`{string}`, `{int}`…), dans l'ordre. `{ step, param }` prend toute la valeur enregistrée, `{ step, param, value }` seulement cette partie |

Exemple paramétré : la ville et le budget, pris dans l'URL de l'étape 1.

```javascript
create_business_step({
  project_id: 2, test_name: "recherche_bienici", from_step: 1, to_step: 1, keyword: "Given",
  pattern: "je cherche une maison à vendre à {string} pour {int} euros maximum",
  args: [{ step: 1, param: "url", value: "antony-92160" }, { step: 1, param: "url", value: "500000" }]
})
// → Given je cherche une maison à vendre à "antony-92160" pour 500000 euros maximum
```

À sélecteurs et paramètres égaux, une step definition du projet passe devant une step definition
par défaut (`I am on {string}`). Rejouée depuis Gherkin (`create_test_from_gherkin`), une étape
métier redonne ses étapes avec leurs locators.

### Variable Support
When saving a test (via `stop_recording`), IziTest Agent automatically identifies variables (e.g., input values or list selections). You can override these during `run_test`:

```javascript
run_test("my_test", { variables: { "user_email": "new@example.com" } })
```

### Paramètres de `run_test`

| Paramètre | Type | Description |
| :--- | :--- | :--- |
| `name` | string | Nom du test à exécuter (obligatoire) |
| `variables` | object | Remplace les placeholders `{{variable}}` par des valeurs personnalisées |
| `substitutions` | object | Remplacement textuel brut dans tous les paramètres (clé → valeur) |
| `start_step` | number | Reprendre l'exécution à une étape spécifique (1-indexed) |
| `new_window` | boolean | Si `true`, exécute dans une nouvelle fenêtre au lieu d'un nouvel onglet |

### Visual Regression Testing (VRT)

Pour activer le VRT lors de l'enregistrement :
```javascript
start_recording("mon_test", { use_vrt: true })
```

Puis ajoutez une assertion visuelle rétroactive :
```javascript
add_retroactive_vrt("mon_test", { step_order: 3, selector: "#header" })
```

| Paramètre | Type | Description |
| :--- | :--- | :--- |
| `test_name` | string | Nom du test |
| `step_order` | number | Position de l'étape de référence (1-indexed) |
| `selector` | string | (Optionnel) Sélecteur CSS pour cibler un élément spécifique |

---
[< Previous: Usage](usage.md) | [Next: Multi-Account Management >](multi-account.md)
