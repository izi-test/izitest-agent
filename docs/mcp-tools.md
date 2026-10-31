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
| `click` | Clicks an element. On a checkbox, radio or switch (or its label), returns the state it left (`checked`); with `checked`, sets that state and does not click when it is already so. | `ref` (@eX), `selector`, `text`, `checked` |
| `fill` | Fills an input/textarea/contenteditable. A date, time, colour or range input gets its value set instead of typed (see below). | `ref` (@eX), `selector`, `value`, `clear` |
| `extract` | Retrieves content (text, attributes) from the page. `attribute: "value"` on a field reads what it holds now. | `selector`, `attribute`, `multiple` |
| `get_tabs` | Lists all open tabs in the browser. | `profile` |
| `get_page_info` | Detailed info (title, URL, element counts). | `tabId`, `profile` |
| `scroll` | Scrolls the page or moves to an element. | `direction`, `amount`, `selector` |
| `wait` | Pauses for a duration or until an element appears. | `ms`, `selector` |
| `execute_js` | Runs arbitrary JavaScript in the page context. Recorded as a step while a test records — to only read the page, use `extract` or `snapshot`, which are not. | `code` |
| `keyboard` | Sends a key press event. | `key`, `modifiers` |
| `get_cookies` | Retrieves cookies for a URL/domain. | `url`, `domain` |

#### Champs particuliers

- **Date, heure, couleur, curseur** (`date`, `time`, `datetime-local`, `month`, `week`, `color`,
  `range`) : `fill` leur donne la valeur depuis la page, puis envoie `input` et `change`, comme
  Playwright. La frappe ne marchait pas : la date restait vide (ses segments suivent l'ordre de la
  langue du navigateur), la couleur ouvrait le sélecteur du système, le curseur allait où tombait le
  clic. Le format attendu est celui du HTML : `1990-05-12`, `09:30`, `#ff5500`, un nombre sur un pas du
  curseur. Une valeur que le champ refuserait (`12/05/1990`, `85` sur un pas de 10) est refusée avec
  le format attendu, et le champ garde sa valeur.
- **Texte éditable** (`contenteditable`) : listé comme `[textbox]` par la snapshot, avec son texte en
  `value="…"`, et rempli comme un champ.
- **Effacer avant de taper** : tout le texte est sélectionné, et la frappe le remplace. Retour arrière
  ne sert plus que pour une valeur vide : sur un champ de tags vide, il supprimait le dernier tag.
- **Nom d'un champ** : la valeur d'un champ n'est son nom que pour un bouton (`<input type="submit">`).
  Une couleur, un curseur, un champ prérempli sans label n'ont plus pour nom `#6c5ce7` ou `60`, qui
  changeaient au premier `fill`.
- **Case ou radio en `display: none`** derrière un label visible (les étoiles d'une note) : listée
  et manipulée par son label, avec sa valeur quand son nom ne la dit pas :
  `[radio] "★" value="4" [unchecked]`.

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
| `add_assertion` | Adds a check (e.g., "element exists", "text does not contain") to a saved test. A value the test typed in it is saved as its `{{variable}}`. `tabId` checks it in another tab, e.g. the one `run_test` ended on. |
| `fix_test_step` | Updates a failed step with data from a manual action. |
| `delete_test` | Removes a saved test from the database. |
| `add_retroactive_vrt` | Adds a visual regression test assertion retroactively using a recorded baseline. |
| `get_test_as_code` | Returns a saved test as Playwright code to commit in the project under test (see below). |
| `create_business_step` | Groups a run of steps of a recorded test into one business Gherkin step (see below). |
| `add_test_variable` | Turns a recorded value (e.g. a city inside a URL) into a `{{variable}}` of the test (see below). |

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
dans un `id` ou un `for`, `:r1:` de React, classes CSS-in-JS) y casserait au premier passage ; un
sélecteur positionnel (`#login-form > div:nth-of-type(3) > button:nth-of-type(1)`) tient tant que
la mise en page ne bouge pas. En `playwright-plain`, chaque étape prend donc le premier locator
solide, dans cet ordre :

1. le sélecteur enregistré, s'il ne contient ni rien de généré ni position (le code est alors
   celui d'avant) ;
2. un `data-testid`, puis un autre locator CSS du même genre — pas `input[name="interests"]` pour
   une case d'un groupe : toutes les cases le partagent ;
3. le rôle et le nom accessible que **Chrome** donne à l'élément, lus au clic dans son arbre
   d'accessibilité : `page.getByRole('button', { name, exact: true })` — le bouton « Sign in », pas le
   titre qui le dit aussi. C'est exactement ce que `getByRole` compare, là où le nom calculé par la
   snapshot peut différer (texte caché, `title` qui passe avant le contenu). Pour un clic enregistré
   avant, le rôle déduit de la balise (bouton, lien, liste déroulante, titre) et le nom de la snapshot.
   Un rôle et un nom présents plusieurs fois sur la page (le « Clear » du formulaire de connexion et
   celui du formulaire de contact) sont enregistrés avec l'endroit où ils sont : l'ancêtre le plus
   proche qui n'en contient qu'un (`data-testid`, ou un id écrit à la main), sinon leur rang —
   `page.getByTestId('login-form').getByRole('button', { name: 'Clear', exact: true })`, ou
   `….nth(1)`. Seul, `getByRole` échouait sur le mode strict de Playwright. Le rejeu d'IziTest
   cherche aussi dans cet ancêtre, et ne lance plus en parallèle le même nom lu seul (`aria`,
   texte), qui pouvait gagner la course et cliquer l'autre bouton ;
4. pour un `<label>` : `page.locator('label', { hasText: … })`, le label lui-même (les cases à
   cocher stylées cachent souvent le vrai `<input>`) ;
5. pour un champ (`input`, `select`, `textarea`, ou une saisie) : `page.getByLabel(…)` ;
6. `page.getByPlaceholder(…)`, puis `page.getByText(…, { exact: true })` quand le texte visible
   est le nom accessible ;
7. le sélecteur positionnel, faute de mieux.

Sans alternative stable, le sélecteur d'origine reste, précédé d'un commentaire `// FIXME`.

En `playwright-cucumber`, le même choix vaut pour les étapes métier (ci-dessous) et pour les étapes
génériques : le `.feature` exporté leur donne la cible retenue, sous forme de sélecteur Playwright que
`page.locator()` accepte tel quel :

```gherkin
When I click on 'role=button[name="Sign in"s]'
And I click on '[data-testid="login-form"] >> role=button[name="Clear"s]'
And I check 'label:has-text("Jardin")'
And I uncheck 'label:has(input[name="darkMode"])'
And I fill 'internal:label="E-mail"i' with "bob@corp"
And I select "Pro — 25 members ($29/mo)" in "#ws-plan"
```

L'onglet Gherkin du tableau de bord, lui, garde les sélecteurs enregistrés, dont le rejeu d'IziTest a
besoin. Un argument qui contient des guillemets doubles s'écrit entre guillemets simples.

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
| `args` | array | Un par paramètre de la phrase (`{string}`, `{int}`…), dans l'ordre. `{ step, param }` prend toute la valeur enregistrée, `{ step, param, value }` seulement cette partie, `{ variable }` une variable du test (voir plus bas) |

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

Une étape métier se reconnaît aussi dans un autre enregistrement des mêmes étapes, même si un
sélecteur y diffère parce qu'il est faible : un identifiant généré à chaque chargement (deux
enregistrements de Bien'ici donnent deux `label[for="<uuid>"]` différents) ou une position. L'élément
est alors reconnu à ce que les deux enregistrements ont en commun : le même `data-testid`, un même
locator CSS stable, ou la même balise avec le même nom accessible (`label` « Jardin »). Deux sélecteurs
stables qui diffèrent restent deux éléments, et l'attribut `name` d'une case cochée, commun à tout son
groupe, ne compte pas. Les autres paramètres (état coché, valeur saisie…) doivent toujours correspondre.
Une étape métier créée sans locators (avant `create_business_step`) demande toujours le sélecteur exact.

### Variable Support
When saving a test (via `stop_recording`), IziTest Agent automatically identifies variables (e.g., input values or list selections). You can override these during `run_test`:

```javascript
run_test("my_test", { variables: { "user_email": "new@example.com" } })
```

Une variable de saisie prend le nom du champ : son label (« Workspace name » → `workspace_name`),
sinon le nom envoyé par le formulaire (`displayName` → `display_name`), sinon son id
(`#inline-title` → `inline_title`, pas un id généré comme `#r1`), le placeholder en dernier. Un nom
accessible qui n'est que le placeholder (champ sans label) compte comme le placeholder : le champ
`name="country"` au placeholder « Start typing... » donne `{{country}}`.

Une option choisie dans un `<select>` (outil `select`) devient aussi une variable, de type `select`,
nommée de la même façon : `{{plan}}`. L'étape garde la `value` de l'option (`pro`), ce que le
formulaire envoie, et non son libellé (`Pro — 25 members ($29/mo)`) : une assertion sur la valeur
envoyée (`"plan": "pro"`) s'y lie seule, et un libellé reformulé ou traduit se rejoue encore. En
Playwright : ``selectOption('#ws-plan', `${VARS.plan}`)`` ; en Gherkin : `I select "<plan>" in "#ws-plan"`.
Un `select` par texte (phrase Gherkin relue) essaie la `value` des options avant une correspondance
partielle du libellé, comme `selectOption` de Playwright.

Un clic devient une variable de liste quand l'élément cliqué fait partie d'éléments semblables. Un LLM
en décide (clé OpenRouter, sinon la CLI `copilot`) ; sans LLM disponible, une règle prudente prend le
relais :

- pas de liste pour moins de 3 éléments, pour un élément sans texte (interrupteur nu, icône), ni pour
  des boutons d'action côte à côte (« Save » / « Discard » / « Delete ») ;
- des éléments à libellés distincts (critères, catégories) sont choisis **par texte**, sans le compteur
  final : `Jardin (44)` devient `Jardin`, qui retrouve `Jardin (62)` ailleurs ;
- un même bouton ou lien répété (« Add to cart » sur chaque produit) est choisi par position.

#### Déclarer une variable : `add_test_variable`

La détection ne couvre que ce qui est saisi (`fill`) ou choisi dans une liste : une ville ou un budget
dans une URL reste en dur. `add_test_variable` remplace une valeur enregistrée, ou une partie, par
`{{nom}}` ; la valeur enregistrée devient sa valeur par défaut.

```javascript
add_test_variable({ test_name: "recherche_bienici", step: 1, param: "url", value: "antony-92160", name: "ville" })
add_test_variable({ test_name: "recherche_bienici", step: 1, param: "url", value: "500000", name: "budget" })
// étape 1 : https://www.bienici.com/recherche/achat/{{ville}}/maisonvilla?prix-max={{budget}}
```

La variable apparaît alors partout :

- **Tableau de bord** : onglet Data ;
- **`run_test`** : `run_test("recherche_bienici", { variables: { ville: "massy-91300", budget: "600000" } })` ;
- **`playwright-plain`** : `VARS.ville`, `VARS.budget` ;
- **Étape métier** : `args: [{ variable: "ville" }, { variable: "budget" }]` en fait les paramètres
  de la phrase. Toute variable des étapes regroupées doit en avoir un : sinon le code généré taperait
  `{{ville}}` tel quel ;
- **Export Cucumber** : un `Scenario Outline`, avec `<ville>` dans les étapes et une ligne `Examples`
  des valeurs par défaut, à compléter d'autres lignes pour d'autres jeux de données :

```gherkin
Scenario Outline: recherche_bienici
  Given je cherche une maison à vendre à "<ville>" pour <budget> euros maximum
  When je ne garde que les maisons avec jardin

  Examples:
    | ville        | budget |
    | antony-92160 | 500000 |
```

Dans l'onglet Gherkin du tableau de bord, la phrase garde `"{{ville}}"` et `{{budget}}`, et s'enregistre
telle quelle, même là où la phrase attend un `{int}`.

#### Assertions et variables

Une assertion qui vérifie une valeur saisie dans le test doit suivre cette valeur : rejoué avec un autre
e-mail, le test doit vérifier cet e-mail, pas celui de l'enregistrement. `add_assertion` le fait seul :
toute valeur d'une variable de saisie (`text` ou `select`, 2 caractères au moins) présente dans
`expected` y est remplacée par sa variable, et la réponse l'indique :

```
Linked to {{email}}: saved as ""email": "{{email}}"", so a replay with other values checks those values.
```

La valeur est cherchée entière, jamais au milieu d'un mot : « Fra », tapé pour que l'autocomplétion
propose « France », ne lie pas `"country": "France"`. Sur l'onglet d'un rejeu (`tabId` rendu par
`run_test`), ce sont les valeurs saisies par ce rejeu qui sont cherchées, pas celles de
l'enregistrement : rejoué avec `date_of_birth: "1985-11-30"`, `"dob": "1985-11-30"` devient
`"dob": "{{date_of_birth}}"`.

Une valeur de 2 caractères n'est liée que si c'est un nombre ou un code (`25`, `FR`, `XL`) — un petit
mot en minuscules (`on`, `in`) se trouve dans n'importe quelle phrase — et seulement si elle n'apparaît
qu'une fois : sinon, la réponse le dit (`Not linked to {{volume}}: "25" is found 2 times…`).

Pour une assertion ajoutée avant, `add_test_variable` avec le nom d'une variable existante la réutilise
(sans `value`, ou avec sa valeur par défaut) :

```javascript
add_test_variable({ test_name: "izi_login", step: 7, param: "expected", name: "email" })
// "email": "jane.doe@example.com"  →  "email": "{{email}}"
```

Au rejeu, une valeur contenant un guillemet ou une barre oblique inverse (`Pa"ss\word`) est prise telle
quelle. Dans les `Examples` d'un Scenario Outline exporté, une valeur qui contient le guillemet
entourant sa colonne dans une étape (`d'abord` dans `'"reason": "<reason>"'`) y est échappée
(`d\\'abord`) : sinon la chaîne se fermait au milieu de la valeur, et l'étape restait sans définition.

#### Enregistrer depuis l'onglet Gherkin

Une phrase ne dit pas tout d'une étape : ni ses locators, ni son intention, ni sa variable de liste,
ni ce que seul l'enregistrement sait (case cliquée par son label, capture VRT). Enregistrer la feature
compare donc les phrases éditées à celles du test :

- une phrase **inchangée** garde ses étapes telles quelles — y compris une étape qu'aucune phrase ne
  décrit (`execute_js`, vérification visuelle), qui ne s'enregistrait pas du tout jusqu'ici ;
- une phrase **modifiée** est relue ; si sa commande et sa cible (sélecteur, URL) n'ont pas changé,
  elle garde les locators, l'intention et la variable de liste de l'étape qu'elle remplace (une
  variable de saisie, tant que son `{{nom}}` y figure encore) ;
- une phrase **ajoutée** est relue, une phrase **supprimée** disparaît ; les autres ne bougent pas.

Seules les phrases modifiées ou ajoutées doivent correspondre à une step definition : une erreur
cite leur ligne.

#### Types d'assertion à l'export

Chaque type d'assertion se rejoue, s'exporte en Playwright et a sa phrase Gherkin :

| Type | Playwright | Gherkin |
| :--- | :--- | :--- |
| `text_contains` / `text_not_contains` | `toContainText` / `not.toContainText` | `"…" should contain "…"` / `should not contain` |
| `text_equals` | `toHaveText` | `"…" should have text "…"` |
| `attribute_equals` | `toHaveAttribute` ; `toHaveValue` pour `value` | `the "href" of "…" should be "…"` |
| `element_count` | `toHaveCount` | `"…" should match 2 elements` |
| `element_exists` / `element_not_exists` | `.first().toBeAttached()` / `toHaveCount(0)` | `"…" should exist` / `I should not see "…"` |
| `element_visible` / `element_hidden` | `toBeVisible` / `toBeHidden` | `"…" should be visible` / `should be hidden` |
| `url_equals` / `url_contains` | `toHaveURL` | `the URL should be "…"` / `should contain` |
| `title_equals` / `title_contains` | `toHaveTitle` | `the title should be "…"` / `should contain` |

Pour `attribute_equals`, l'attribut `value` d'un champ est ce qu'il contient au moment du contrôle,
comme le lit `toHaveValue` : l'attribut HTML n'est que la valeur de départ (absent d'un champ rempli
par le test).

#### Cases à cocher

Un clic sur une case à cocher, un bouton radio ou un interrupteur (`role="switch"`), ou sur son
`<label>`, est enregistré avec l'état où il l'a laissée : `{ "selector": "…", "checked": true }`.
Rejouer un simple clic inverserait la case quel que soit son état : une case déjà cochée au départ
(préférence mémorisée, case cochée par défaut) finirait décochée, et le test passerait quand même.
Avec l'état enregistré :

- **`run_test`** ne clique pas si la case est déjà dans l'état voulu (« already checked: not
  clicked » dans le résultat de l'étape) ;
- **`playwright-plain`** et les étapes métier génèrent `.check()` ou `.uncheck()`, qui laissent la
  case dans l'état voulu, label compris : `page.locator('label', { hasText: 'Jardin' }).check()` ;
- **Gherkin** : `When I check "…"`, `When I uncheck "…"` ;
- **Variable** : `add_test_variable({ test_name, step, param: "checked", name: "jardin" })` fait de
  l'état une variable (`"true"` ou `"false"`) : `When I set "…" checked to "{{jardin}}"` dans
  l'onglet Gherkin, `setChecked(…)` dans le code généré.

Un interrupteur dessiné en CSS cache souvent la vraie case (`opacity: 0`, taille nulle) derrière son
`<label>`, avec son texte à côté (`<label class="toggle"><input …></label> Dark mode`). La snapshot le
liste quand même, nommé par ce texte (`[checkbox] "Dark mode" [checked]`) ; un clic sur sa ref va au
label, le résultat le signale (`viaLabel`) et le code généré passe aussi par lui :
`page.locator('label', { has: page.locator('input[name="darkMode"]') }).uncheck()`. Un `<label for>`
séparé de la case est noté aussi (`labelFor`, l'id de la case) : le code vise alors ce label,
`page.check('label[for="notif"]')`, ou le label par son texte si l'id est généré.

Une case cochée fait souvent aussi partie d'un groupe (les critères d'une recherche) : la détection
de variables en fait alors une variable de liste, qui choisit *quelle* case ; l'état reste celui
enregistré.

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
