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
| `upload_file` | Gives files to a file input, as picking them in the file dialog would. The ref may be the input — often hidden — or its drop zone, label or "Upload" button (see below). | `files` (paths), `ref` (@eX), `selector` |
| `drag` | Drags an element and drops it on another, with the mouse: a sortable list, a card to another column. Works with `draggable="true"` (HTML5) and with pages that follow the mouse (see below). | `ref` / `selector`, `targetRef` / `target`, `position` (center, top, bottom, left, right) |
| `explore_app` | Explores a site on its own and reports its bugs (console errors, failed requests, broken links, accessibility), each with a test that reproduces it (see below). | `url`, `max_pages`, `interact`, `checks` |
| `check_page` | Runs the same checks on the page you are on; nothing is saved. | `checks`, `since_seconds` |
| `list_bugs` | Lists the bugs found, worst first, with their tests. | `status` |
| `extract` | Retrieves content (text, attributes) from the page. `attribute: "value"` on a field reads what it holds now. | `selector`, `attribute`, `multiple` |
| `get_tabs` | Lists all open tabs in the browser. | `profile` |
| `get_page_info` | Detailed info (title, URL, element counts). | `tabId`, `profile` |
| `scroll` | Scrolls the page or moves to an element. | `direction`, `amount`, `selector` |
| `wait` | Pauses for a duration or until an element appears. One of the two is needed: a `wait` with neither is refused, not recorded. | `ms`, `selector` |
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
- **Envoi de fichiers** (`upload_file`) : les fichiers sont lus sur la machine d'IziTest Agent (chemins
  absolus, ou relatifs à son dossier de travail ; 25 Mo au plus par étape), puis posés dans
  l'`<input type="file">` depuis la page, qui reçoit `input` et `change` comme après le sélecteur de
  fichiers. La voie de Chrome (`DOM.setFileInputFiles`) n'est pas prise : elle est refusée à une
  extension qui n'a pas l'accès aux URL de fichiers, désactivé par défaut. La ref peut être l'input
  — souvent caché, absent de la snapshot — ou ce qui l'entoure : la zone de dépôt qui le contient,
  son `<label>`, ou le bouton « Upload » posé à côté (le seul input de fichier de l'ancêtre le plus
  proche qui en a un). L'étape enregistrée est celle de l'input lui-même (`#avatar-input`), sur
  lequel le code généré pose les fichiers. Une zone de dépôt sans aucun input n'est pas gérée.
  Enregistré, un fichier devient une variable de type `file` (`{{avatar}}`), changeable par
  `run_test` ; en Playwright, `page.setInputFiles('#avatar-input', …)`, précédé d'un `// FIXME`
  quand le chemin est celui de la machine qui a enregistré — à copier dans le projet ; en Gherkin,
  `When I upload "<avatar>" to "#avatar-input"` (un seul fichier : plusieurs n'ont pas de phrase).
  Une assertion sur le nom affiché (`✓ avatar.png`) reste littérale : seul le chemin est variable.
- **Glisser-déposer** (`drag`) : la souris presse l'élément, va jusqu'à la cible en plusieurs
  mouvements, et relâche. Une page qui suit la souris (SortableJS en mode fallback, dnd-kit, jQuery UI)
  n'a besoin de rien d'autre. Un élément `draggable="true"` lance le glisser-déposer de Chrome, que
  des événements souris envoyés par CDP ne terminent jamais : il est intercepté
  (`Input.setInterceptDrags`) et mené jusqu'au dépôt par `Input.dispatchDragEvent` — la page reçoit
  les `dragenter`, `dragover`, `drop` et `dragend` de Chrome, `dataTransfer` compris, comme avec le
  `dragTo` de Playwright. Le résultat dit lequel a servi (`drag: "native"` ou `"mouse"`) et, dans
  `changes`, si l'élément glissé a bougé. `position` est l'endroit de la cible où il est déposé : son
  centre, ou à un quart de son haut, de son bas, de sa gauche ou de sa droite — dans une liste
  verticale, `top` le pose avant la cible, `bottom` après. Les deux doivent tenir ensemble à l'écran :
  `drag` ne fait pas défiler la page pendant qu'il tient l'élément.
  La snapshot liste ce qui se glisse, nommé par son texte : `[generic] "⠿ Cost Efficiency #5"
  [draggable]`, ou `[cursor=grab]` pour une page qui suit la souris (aussi avec
  `purposeFilter: "click"`). Un élément que rien ne nomme (ni test ID, ni id, ni nom) est enregistré
  par son `data-id`, `data-value` ou `data-key` s'il est seul à l'avoir — `div[data-value="cost"]` —
  plutôt que par sa position, que le tri change. La cible est gardée avec ses propres localisateurs
  (`params.targetLocators`), que le rejeu essaie comme ceux de l'élément glissé. En Playwright,
  `await page.locator(…).dragTo(page.locator(…))`, avec `targetPosition` calculé sur la boîte de la
  cible pour un bord ; en Gherkin, `When I drag "…" to "…"` et `When I drag "…" to the top of "…"`.
- **Clic par le texte** (`click({ text })`) : le texte visé est d'abord celui d'un contrôle visible —
  « Sign in » est le bouton, pas le titre du formulaire juste au-dessus, qui venait avant dans la page
  et prenait le clic (et la détection de listes de la fin d'enregistrement en faisait un « élément de
  liste »). À l'export, un tel clic va au rôle et au nom enregistrés (`getByRole`), sinon au texte
  (`getByText`) — il sortait en `page.click('')` ; en Gherkin, `When I click on the text "…"`.
- **Champ nommé par son label** (Gherkin, sans sélecteur) : `When I fill the field "Email" with "…"`,
  `When I select "…" in the field "Subject"`, `When I check the field "Remember me"` et `When I
  uncheck the field "…"` donnent à `fill`, `select` et `click` un `label` au lieu d'un `selector` :
  un scénario écrit sans avoir vu la page (`design_tests`) peut nommer un champ. L'extension le
  cherche comme `getByLabel(…, { exact: true })` de Playwright : son `aria-labelledby`, sinon son
  `aria-label`, sinon son `<label for>` ou le `<label>` qui l'entoure — le texte entier du label,
  espaces resserrés, casse comprise (`Phone *` pour `<label><span>Phone</span> <em>*</em>`) —, ou
  enfin son `placeholder`. Elle prend le premier qui se voit, dans l'ordre de la page (iframes de même
  origine comprises) : sur le Test Arena, « Email » est le champ du login, pas celui du formulaire de
  contact plus bas. Une case que la page dessine elle-même (l'input invisible, sans taille) est
  cliquée par son label. Un champ pas encore affiché est attendu 5 s ; un label introuvable échoue en
  citant les champs présents : `No field labelled "Courriel" (…). Fields on the page: "Email",
  "Password", …`. Ce qui est tapé devient une variable nommée d'après le label (`{{email}}`).
  L'export est décrit plus bas (*Champs nommés par leur label à l'export*).
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
| `start_recording` | Starts recording a new test. All subsequent browser actions are auto-recorded. `project_id`: the project the test is saved in, whose datasets it reads while recording (`{{users[1].email}}`); with `dataset`, it plays one — `{{email}}` types its row 1, and the test is bound to it (see Jeux de données). |
| `stop_recording` | Stops the recording and saves the test. Performs batch variable detection. |
| `list_tests` | Lists all saved tests and their variables. |
| `run_test` | Executes a saved test autonomously in the browser. Supports variable overrides. A failure is diagnosed on the spot, with a repair proposed when the test broke (see below). |
| `save_requirement` | Saves a requirement — from a request, written by hand, or an issue of a tool (a Jira story) — with its acceptance criteria (see below). |
| `import_requirements` | Imports requirements from a file — CSV, TSV, Excel, a Jira CSV export, JSON, Markdown —, a dry run first (see below). |
| `import_from_connector` | Reads requirements from a tool set in the dashboard (a connector: Jira, GitHub Issues) — a query, their keys, or again (`sync`) —, a dry run first (see below). |
| `send_coverage` | Tells a tool where each requirement imported from it stands — a campaign's, or those of their keys — as IziTest's comment on it (Jira), updated after; a dry run first (see below). |
| `design_tests` | Lays out how to design a requirement's tests: its criteria, its cases, the app, the project's Gherkin phrases, and the method — review, what is left unsaid, scenarios by test technique (see below). |
| `plan_tests` | Plans a requirement's test cases: per criterion, nominal, alternative, error, boundary — with their technique, priority and scenario in Gherkin; says which scenarios are ready and which have steps to record. |
| `link_test` | Links a saved test to a requirement: to a planned case, a criterion, or the whole requirement. |
| `get_requirement` / `list_requirements` | A requirement with its criteria, cases, tests and coverage; or all of them with their coverage. |
| `list_repairs` | Lists the repairs proposed for failed runs, and where each stands. |
| `verify_repair` | Replays the test with a proposed repair made, without saving it. |
| `resolve_repair` | Applies a repair to the saved test, or rejects it — on the user's word. |
| `run_campaign` | Replays a project's tests, a requirement's or a list together, for a version of the app, and answers with the report (see below). |
| `get_campaign` / `list_campaigns` / `stop_campaign` | A campaign's report; the campaigns, newest first; stop one that runs. |
| `send_results` | Sends a campaign's results to a tool (a connector: Xray, a Test Execution, each test linked to the stories it covers); a dry run first (see below). |
| `add_assertion` | Adds a check (e.g., "element exists", "text does not contain") to a saved test. A value the test typed in it is saved as its `{{variable}}`. `tabId` checks it in another tab, e.g. the one `run_test` ended on. On a test linked to a requirement, `non_conformity: true` saves the requirement's expected value even though the page does not show it. |
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

L'onglet Gherkin du tableau de bord, lui, nomme les éléments (ci-dessous) au lieu de donner leur
sélecteur ; une étape sans élément garde le sélecteur enregistré. Un argument qui contient des
guillemets doubles s'écrit entre guillemets simples.

### La langue des tests d'un projet

Chaque projet a une langue, `en` ou `fr`, choisie à sa création (« Tests written in », par défaut celle
du navigateur) et modifiable ensuite : c'est celle de ses tests, pas celle du tableau de bord.

- Son Gherkin est écrit dans cette langue : en français, la feature commence par `# language: fr` et ses
  mots-clés sont `Fonctionnalité`, `Scénario`, `Soit`, `Quand`, `Alors`, `Et`, que Cucumber lit
  nativement. Le parseur lit les mots-clés des deux langues.
- Ses phrases intégrées le sont aussi : `je suis sur {string}`, `je clique sur {string}`,
  `je remplis {string} avec {string}`, `{string} contient {string}`… les mêmes commandes, arguments
  dans le même ordre. Un projet passé en français reçoit les phrases françaises et garde les anglaises :
  ses tests se lisent en français, et ce qui a été écrit en anglais se relit toujours.
- L'export Cucumber suit : feature en français (`Plan du scénario`, `Exemples`), et
  `default.steps.js` avec les phrases françaises.
- Tout ce que l'IA écrit pour le projet est dans sa langue : les étapes métier qu'elle propose, les
  scénarios de `design_tests` (titres et étapes ; la revue des critères reste dans la langue de
  l'exigence), les intentions des étapes qu'elle enregistre, le Gherkin du chat.
  `get_project_context` renvoie la langue (`language`) et les phrases de cette langue.

### Les éléments d'un projet

Chaque étape qui agit sur un élément de la page (`click`, `fill`, `select`, `upload`, `drag`), et
chaque assertion qui vérifie un élément par son sélecteur, garde la page où elle a été faite : l'hôte et le chemin, sans la requête ni le fragment, chaque partie du chemin
qui contient un chiffre (un identifiant, un slug avec un identifiant) remplacée par `*` —
`notes.test/notes/*` pour la note 42 comme pour la 43. L'extension renvoie l'URL de la page avec le
résultat de chaque action (`pageUrl`), et une assertion lit celle de la page où elle est vérifiée
(`add_assertion`). Une étape enregistrée avant n'a pas de page : elle la reçoit à la prochaine exécution
de son test où elle réussit.

L'élément sur lequel agit une étape est connu par une **clé exacte**, jamais par ressemblance : sa page,
puis son rôle et son nom accessible (avec le conteneur qui le distingue quand la page en a plusieurs,
`button "Delete" in testid "note-3"`), à défaut son `data-testid`, le libellé d'un champ
(`field "E-mail"`), ou un sélecteur CSS stable — celui d'une assertion (`css #result-profile`). Le bouton « Save » de la page des notes et celui de la
page du profil sont deux éléments, même avec le même sélecteur ; le même « Save » enregistré par deux
tests n'en est qu'un. Une étape qui n'a que sa position pour se distinguer, ou dont un élément de liste
est choisi par une variable, n'a pas d'élément.

Chaque élément a un nom, unique dans son projet, pris de ce qu'une personne lit dessus (« Save
profile », « E-mail ») ; déjà pris, il reçoit sa page (« Save (profile) »). L'onglet Gherkin dit ce nom
à la place du sélecteur :

```gherkin
When I fill "E-mail" with "{{email}}"
And I click on "Sign in"
```

et le relit comme l'élément : une phrase qui nomme un élément du projet, là où va un sélecteur, agit
sur lui, avec le sélecteur, les locators et la page du dernier enregistrement qui l'a touché. C'est vrai
aussi d'un scénario écrit à la main (`create_test_from_gherkin`) et d'une assertion
(`Then "Profile result" should contain "Saved"`). Un nom qu'aucun élément ne porte reste un sélecteur.

L'agent qui écrit du Gherkin connaît ces noms : `get_project_context` liste les éléments du projet
(`elements` : nom, page, ce qu'ils sont), la méthode de `design_tests` les donne page par page avec les
phrases, et le chat du tableau de bord aussi. Un scénario conçu pour une exigence peut donc nommer les
éléments déjà enregistrés au lieu de deviner un sélecteur.

La page **Elements** du tableau de bord liste les éléments du projet, page par page, avec les tests qui
les utilisent. Un élément s'y renomme (son nouveau nom se lit dans le Gherkin de tous ses tests) ; un
élément qu'aucune étape n'utilise plus s'y supprime. Les étapes d'un test montrent le nom de leur
élément.

| Route | Rôle |
| :--- | :--- |
| `GET /api/projects/:id/elements` | Les éléments du projet, avec leur page, ce qu'ils sont, et les étapes qui les utilisent |
| `PATCH /api/elements/:id` | Renomme un élément (`{ name }`) ; 409 si un autre élément du projet a ce nom |
| `DELETE /api/elements/:id` | Supprime un élément qu'aucune étape n'utilise ; 409 sinon |

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

Les sous-étapes d'une étape métier gardent leur page. Quand l'enregistrement comparé a aussi la sienne,
chaque sous-étape doit agir sur le même élément (même clé, voir « Les éléments d'un projet »), quels que
soient les sélecteurs : les mêmes clics sur une autre page ne sont pas l'étape métier, même avec les
mêmes sélecteurs.

Sans page d'un côté, une étape métier se reconnaît aussi dans un autre enregistrement des mêmes étapes,
même si un sélecteur y diffère parce qu'il est faible : un identifiant généré à chaque chargement (deux
enregistrements de Bien'ici donnent deux `label[for="<uuid>"]` différents) ou une position. L'élément
est alors reconnu à ce que les deux enregistrements ont en commun : le même `data-testid`, un même
locator CSS stable, ou la même balise avec le même nom accessible (`label` « Jardin »). Deux sélecteurs
stables qui diffèrent restent deux éléments, et l'attribut `name` d'une case cochée, commun à tout son
groupe, ne compte pas. Les autres paramètres (état coché, valeur saisie…) doivent toujours correspondre.
Une étape métier créée sans locators (avant `create_business_step`) demande toujours le sélecteur exact.

### Étapes métier proposées par l'IA

Après la création d'un test par l'IA, l'agent réglé dans Settings propose ses étapes métier, en
arrière-plan ; l'onglet Gherkin du test les montre, et le bouton « Propose business steps » les demande
pour n'importe quel test d'un projet. Rien n'est créé sans l'accord de l'utilisateur : chaque
proposition s'accepte, avec sa phrase telle qu'il l'a laissée, ou s'écarte.

L'agent lit le test étape par étape, par le nom de ses éléments, avec ses variables et les étapes métier
que le projet a déjà ; ce qu'une étape métier regroupe déjà s'affiche comme elle et n'est pas proposé à
nouveau. Il propose des suites de 2 à 12 étapes consécutives qui font ensemble une chose qu'un
utilisateur veut dire (« j'enregistre mon profil avec le nom {string} … »), dans la langue des étapes
métier du projet, chaque valeur qui change d'un scénario à l'autre en paramètre. Chaque proposition est
vérifiée avant d'être montrée : elle ne coupe pas une phrase, ne chevauche ni une autre ni une étape
métier, sa phrase est nouvelle et sans `( )` ni `/`, et chaque variable des étapes regroupées a son
paramètre. Elle dit comment le test se lira, les phrases qu'elle remplace, et les autres tests du projet
qui se liront avec elle (les mêmes étapes, sur les mêmes éléments).

| Route | Rôle |
| :--- | :--- |
| `GET /api/tests/:name/business-steps` | Les propositions gardées pour le test, ou qu'elles sont en cours (`status` : `none`, `running`, `ready`, `failed`) |
| `POST /api/tests/:name/business-steps/propose` | Les demande à l'agent, en arrière-plan (202) ; une seule demande à la fois |
| `POST /api/tests/:name/business-steps/:id/accept` | Crée l'étape métier (`{ pattern }` : la phrase modifiée) ; 422 si elle ne convient pas |
| `DELETE /api/tests/:name/business-steps/:id` | Écarte une proposition ; sans `:id`, toutes |

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

#### Une assertion attend ce qu'elle vérifie

À l'exécution, une assertion est relue jusqu'à ce qu'elle passe, pendant 5 s au plus, comme
l'`expect` de Playwright. C'est utile quand la page est encore en route vers ce qu'elle vérifie : un
formulaire envoyé avec Entrée dont la page suivante se charge, un message affiché à la réponse d'une
requête.

- Une page qu'on ne peut pas lire pendant ce temps, parce qu'elle est en train d'être remplacée,
  est relue aussi.
- Une fois les 5 s écoulées, l'assertion échoue avec ce qu'elle a lu en dernier.
- Une comparaison de captures (VRT) et un oracle sont lus une seule fois.
- `IZITEST_ASSERT_TIMEOUT_MS` change ce délai ; `0` lit une seule fois.

#### Types d'assertion à l'export

Chaque type d'assertion se rejoue, s'exporte en Playwright et a sa phrase Gherkin :

| Type | Playwright | Gherkin |
| :--- | :--- | :--- |
| `text_contains` / `text_not_contains` | `toContainText` / `not.toContainText` | `"…" should contain "…"` / `should not contain` ; sans sélecteur, `I should see "…"` |
| `text_equals` | `toHaveText` | `"…" should have text "…"` |
| `attribute_equals` | `toHaveAttribute` ; `toHaveValue` pour `value` | `the "href" of "…" should be "…"` |
| `element_count` | `toHaveCount` | `"…" should match 2 elements` |
| `element_exists` / `element_not_exists` | `.first().toBeAttached()` / `toHaveCount(0)` | `"…" should exist` / `I should not see "…"` |
| `element_visible` / `element_hidden` | `toBeVisible` / `toBeHidden` | `"…" should be visible` / `should be hidden` |
| `url_equals` / `url_contains` | `toHaveURL` | `the URL should be "…"` / `should contain` |
| `title_equals` / `title_contains` | `toHaveTitle` | `the title should be "…"` / `should contain` |
| `no_console_errors` | erreurs collectées dès le début du test, puis `expect(…).toEqual([])` | `the page should log no error containing "…"` |
| `no_failed_requests` | réponses ≥ 400 et requêtes en échec collectées, puis `toEqual([])` | `no request to "…" should fail` |
| `link_ok` | `page.request.get(href)`, statut < 400 | `the link "…" should work` |
| `no_a11y_violations` | `@axe-core/playwright` : `new AxeBuilder({ page }).withRules([…])` | `the page should not break the accessibility rule "…"` |

Sans sélecteur (`I should see "…"`), `text_contains` vérifie tout le texte de la page, dans `body`, au
rejeu comme à l'export ; en échec, il en donne un extrait plutôt que la page entière.

Pour `attribute_equals`, l'attribut `value` d'un champ est ce qu'il contient au moment du contrôle,
comme le lit `toHaveValue` : l'attribut HTML n'est que la valeur de départ (absent d'un champ rempli
par le test).

#### Champs nommés par leur label à l'export

Les phrases qui nomment un champ par son label (voir *Champs particuliers*) se rejouent et
s'exportent sans sélecteur :

| Gherkin | Étape | Playwright |
| :--- | :--- | :--- |
| `When I fill the field "Email" with "…"` | `fill { label, value }` | `page.getByLabel('Email', { exact: true }).or(page.getByPlaceholder('Email', { exact: true })).locator('visible=true').first().fill(…)` |
| `When I select "…" in the field "Subject"` | `select { value, label }` | la même cible, `.selectOption(…)` |
| `When I check the field "Remember me"` / `I uncheck the field "…"` | `click { label, checked }` | `page.locator('label:text-is("Remember me")').or(page.getByLabel('Remember me', { exact: true })).locator('visible=true').first().check()` / `.uncheck()` |

Le code trouve le champ que trouve le rejeu : par son label ou son placeholder, le premier visible.
`getByLabel` seul échouait sur le mode strict de Playwright dès que deux champs portent le même
label (le login et le contact du Test Arena ont chacun un « Email »), et sur un doublon caché (le
champ de recherche du menu mobile). Une case passe par son `<label>` quand la page la dessine
elle-même : `check()` sur l'input invisible attend jusqu'au timeout, et sur le label, Playwright
lit l'état de la case qu'il nomme. En `playwright-cucumber`, le `.feature` garde les phrases telles
quelles et `default.steps.js` les définit avec deux fonctions qui font la même chose, `field()` et
`box()`. Une étape enregistrée avec un sélecteur le garde : le label ne sert qu'à une étape qui n'a
rien d'autre.

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
- **Gherkin** : `When I check "…"`, `When I uncheck "…"` ; sans sélecteur, par le label de la case :
  `When I check the field "Remember me"`, `When I uncheck the field "…"` ;
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

### Valeurs calculées

Une variable, ou une étape, peut contenir une expression entre `{{ }}`, calculée par le serveur à
chaque exécution (`lib/values.js`), une seule fois : la date saisie à l'étape 3 est celle que vérifie
l'assertion de l'étape 9, et la valeur retenue est enregistrée avec l'exécution.

| Écrit | Donne (le 3 novembre 2026, projet en français) |
| :--- | :--- |
| `{{today}}`, `{{tomorrow}}`, `{{yesterday}}` | `2026-11-03`, `2026-11-04`, `2026-11-02` |
| `{{today + 3 days \| dd/MM/yyyy}}` | `06/11/2026` (aussi `jours`, `weeks`/`semaines`, `months`/`mois`, `years`/`ans`) |
| `{{tomorrow \| EEEE d MMMM}}` | `mercredi 4 novembre` (noms dans la langue des tests du projet) |
| `{{now \| HH:mm}}`, `{{now + 30 minutes}}` | `14:05`, `2026-11-03 14:35` |
| `user-{{unique}}@example.com` | `user-lk7lajgdr@example.com` (le même jeton dans toute l'exécution) |
| `{{uuid}}`, `{{timestamp}}`, `{{random(1000, 9999)}}` | un UUID, l'heure en ms, un entier entre les bornes |
| `{{round(price * 1.2, 2)}}`, `{{price * qty \| 0,00}}` | un calcul avec d'autres variables, formaté |

Une variable peut en utiliser d'autres (`{{price * quantity}}`). Un `{{nom}}` qui n'est pas une variable
reste tel quel, comme avant ; une expression qui ne se calcule pas (`{{today + 3 dayz}}`) arrête
l'exécution avant le navigateur, en disant laquelle et pourquoi. Une valeur passée à `run_test` peut
être une expression elle aussi.

- **Dans l'onglet Data**, une valeur avec une expression montre ce qu'elle donnerait maintenant, ou
  l'erreur (`POST /api/values/preview`).
- **`add_test_variable`** prend `default_value` : la variable vaut alors l'expression au lieu de la
  valeur enregistrée (`user-{{unique}}@example.com` pour une inscription rejouable).
- **L'agent qui enregistre** est invité à le faire pour une date ou une valeur qui doit changer à
  chaque passage.
- **Le code exporté** calcule les valeurs avec le même fichier : `tests/izitest-values.js` pour
  Playwright, `features/support/values.js` pour Cucumber, où chaque step résout ses arguments
  (`this.values(...)`) et les colonnes de l'Outline gardent l'expression.


### Jeux de données

Un projet a des jeux de données (`lib/datasets.js`) : des tables de valeurs, déposées depuis un CSV
(`,` `;` ou tabulation), une liste JSON ou la première feuille d'un Excel `.xlsx`, leur première ligne
nommant les colonnes. Chaque colonne devient un nom de variable (`E-mail` → `e_mail`), chaque valeur un
texte ; le nom du jeu est celui du fichier (`users.csv` → `users`), et un fichier du même nom le remplace.
2 000 lignes au plus, 5 Mo.

- **Un test lié à un jeu** (onglet Data, ou `bind_dataset`) joue une ligne par exécution : ses colonnes
  sont des variables de l'exécution, par-dessus les valeurs par défaut du test (une valeur passée à
  l'exécution passe devant). Une exécution joue la première ligne, ou celle choisie (« Row » dans les
  options de Run, `run_test(row)`) ; l'exécution note laquelle.
- **Une campagne** joue toutes les lignes d'un test lié, chacune à part : `login [row 2]` dans les
  résultats, les rapports JUnit et HTML, les régressions. Une exigence voit son test échouer si une
  ligne échoue. « Run every row » dans les options de Run lance la campagne de ce seul test.
- **Une expression** lit une valeur d'un jeu du projet : `{{users[2].email}}`, lignes numérotées à
  partir de 1, dans n'importe quel test.
- **L'export** emporte les jeux utilisés : en Playwright, un test par ligne (`for … of
  DATASETS['users']`) ; en Cucumber, une ligne d'`Examples` par ligne du jeu, et
  `features/support/datasets.js` pour les expressions.
- **L'agent IA qui crée un test** (« Create Test with AI ») reçoit les jeux du projet dans sa consigne :
  colonnes, nombre de lignes, première ligne. Il prend une valeur d'un jeu plutôt que d'en inventer une.
  Pour une valeur, il tape `{{users[1].email}}`. Pour un test à jouer avec chaque ligne (« pour chaque
  utilisateur »), il passe `project_id` et `dataset: "users"` à `start_recording` et tape `{{email}}`,
  `{{password}}`. L'agent du chat, lui, les écrit dans le Gherkin, puis lie le test avec `bind_dataset`.
- **Pendant l'enregistrement**, `start_recording(project_id)` fait lire les jeux du projet :
  `{{users[2].email}}` tape la valeur de la ligne 2. Avec `dataset`, `{{email}}` tape celle de la ligne 1 du
  jeu ; la réponse de `start_recording` dit quoi taper, ou liste les jeux du projet sans `dataset`.
- **À `stop_recording`**, le test est rangé dans le projet et lié au jeu joué. Une valeur de la ligne 1,
  écrite `{{email}}` ou tapée telle quelle (3 caractères ou plus), devient la variable de sa colonne,
  sa valeur par défaut celle de la ligne 1. Un autre champ du même nom qu'une colonne prend un autre
  nom (`name_2`), pour que la ligne ne le remplace pas.
- **`add_assertion` sur un test lié** relie aussi l'attendu aux colonnes du jeu, même non tapées :
  « Welcome Bob », Bob étant le `name` de la ligne 1, est gardé « Welcome {{name}} » et vérifie « Ann »
  sur la ligne 2. Une colonne nommée dans l'attendu, reliée ainsi ou écrite `{{name}}` par l'agent, devient
  une variable du test (valeur de la ligne 1) : délié du jeu, le test vérifie encore la ligne 1.

| Route ou outil | Rôle |
| :--- | :--- |
| `GET /api/projects/:id/datasets` | Les jeux du projet : colonnes, nombre de lignes, tests liés |
| `POST /api/projects/:id/datasets` | Dépose un fichier (`filename`, `content` texte ou `content_base64` pour un Excel) ou des lignes (`name`, `rows`) |
| `GET /api/datasets/:id`, `DELETE /api/datasets/:id` | Un jeu avec ses lignes ; sa suppression (les tests liés jouent alors une seule fois) |
| `PUT /api/tests/:name/dataset` | Lie un test à un jeu (`{ dataset: id ou nom }`) ou le délie (`null`) |
| `save_dataset`, `bind_dataset` | Les mêmes, pour un agent (CSV en texte ou lignes) ; `get_project_context` liste les jeux, avec leur première ligne |
| `start_recording(project_id, dataset)` | Enregistre un test qui joue un jeu : `{{email}}` tape la ligne 1, le test est lié au jeu à `stop_recording` |

### Étapes serveur : garder une valeur, appeler une API

Deux sortes d'étapes s'exécutent sur le serveur, entre celles que joue le navigateur
(`lib/server-steps.js`) :

- **`capture`** garde une valeur comme variable pour les étapes suivantes, écrite `{{nom}}` : le texte,
  la valeur ou un attribut d'un élément, l'URL ou le titre de la page, une valeur de la dernière
  réponse d'API (`what: "response"`, `path: "data.items[0].id"`), ou une valeur de la réponse à une
  requête que la page a faite (`what: "request"`, `url: "/api/orders"`, `method`, `path: "id"`) — l'id
  qu'un clic sur « Acheter » a reçu sans l'afficher. Un motif (expression régulière) n'en garde qu'une
  partie, son premier groupe : `#(\d+)` garde `4521` de « Commande #4521 ».

  Pour une requête de la page, la capture prend la dernière dont l'URL contient `url`, faite depuis
  l'étape d'avant ; si la page ne l'a pas encore reçue, elle l'attend jusqu'à 10 s, sinon elle prend la
  dernière d'avant. L'extension écoute le réseau de chaque onglet qu'elle pilote dès qu'elle le prend
  en main.
- **`http`** appelle une API pour préparer les données (créer un utilisateur, une commande), avec les
  valeurs du test dans l'URL, les en-têtes et le corps. L'étape échoue sur un statut autre que 2xx, ou
  que `expect_status`. Sa réponse est lue par les captures qui suivent.

Un test qui en contient est joué par segments : le navigateur joue les étapes jusqu'à la prochaine
étape serveur, le serveur l'exécute, puis le segment suivant part dans le même onglet avec les valeurs
gardées. Les assertions, vérifiées à la fin, voient ces valeurs. Une étape serveur qui échoue arrête
l'exécution là. Le mode debug les exécute aussi, pas à pas. Les tests sans étape serveur sont joués
comme avant, en un seul envoi.

| Outil | Rôle |
| :--- | :--- |
| `capture_value` | Garde une valeur de la page, de la dernière réponse ou d'une requête de la page (`name`, `what`, `ref`/`selector`, `attribute`, `url`, `method`, `path`, `pattern`), enregistrée comme étape |
| `call_api` | Appelle une API depuis le serveur (`method`, `url`, `headers`, `body`, `expect_status`), enregistrée comme étape ; renvoie la réponse |

Pendant une session, `{{nom}}` dans une action (`fill`, `navigate`, `select`, `add_assertion`…) reçoit
tout de suite la valeur gardée, ou calculée, et l'étape enregistrée garde `{{nom}}`.

Les phrases Gherkin : `I store the text of {string} as {string}`, `I store the text of {string}
matching {string} as {string}`, `I store the value of {string} as {string}`, `I store the URL as
{string}`, `I store {string} of the response as {string}`, `I store {string} of the request to
{string} as {string}`, `I call {word} {string}`, `I call {word} {string} with {string}`. En français :
`je retiens le texte de {string} dans {string}`, `je retiens {string} de la requête vers {string} dans
{string}`, `j'appelle {word} {string} avec {string}`…

L'export suit : en Playwright, les valeurs gardées vont dans `VARS`, l'API passe par la fixture
`request`, et les réponses de la page sont gardées depuis le début du test (`ANSWERS`, lues par
`answerTo`) ; en Cucumber, par le World (`this.vars`, `this.call()`, `this.requestValue()`), et les
valeurs gardées ne sont pas des colonnes de l'Outline.

### Paramètres de `run_test`

| Paramètre | Type | Description |
| :--- | :--- | :--- |
| `name` | string | Nom du test à exécuter (obligatoire) |
| `variables` | object | Remplace les placeholders `{{variable}}` par des valeurs personnalisées |
| `substitutions` | object | Remplacement textuel brut dans tous les paramètres (clé → valeur) |
| `start_step` | number | Reprendre l'exécution à une étape spécifique (1-indexed) |
| `new_window` | boolean | Si `true`, exécute dans une nouvelle fenêtre au lieu d'un nouvel onglet |

### Exigences : de quoi un test est la preuve

Une exigence dit ce que l'appli doit faire : un titre, une description, ses **critères
d'acceptation** (un comportement observable chacun, avec son résultat attendu), et les **cas** qui
les testent. Le même objet, d'où qu'elle vienne :

| D'où | Comment |
| :--- | :--- |
| Une demande (un dev, en prompt) | l'agent la garde : `save_requirement(source: "prompt", title: la demande, criteria: ce qu'il en a compris)`, montre les critères et attend un accord avant de planifier. Dans le tableau de bord, « Create Test with AI » garde la demande comme exigence et y lie le test enregistré ; l'agent reçoit l'URL de base et le contexte du projet, et s'il s'arrête sans sauver le test (pas d'URL d'où partir), la fenêtre reste ouverte avec son dernier message. |
| Un fichier (un cahier de recette, un export) | `import_requirements(path)` ou le bouton **Import** de la page Requirements (voir plus bas). |
| Un outil branché (Jira, GitHub Issues) | `import_from_connector(connector, query)` ou l'onglet **From Jira**, **From GitHub Issues**… de l'import (voir les connecteurs plus bas), une fois l'outil réglé dans Settings. |
| Un outil sans connecteur (une page Notion) | l'agent la lit (par exemple avec le serveur MCP de l'outil) et la garde : `source` l'id d'un connecteur (`"jira"`) ou un nom de son choix (`"notion"`), sa clé (`SHOP-123`), son lien, ses critères tels qu'écrits. Gardée à nouveau sous la même clé, elle est mise à jour : la réponse dit si son contenu a changé, et un critère dont le texte n'a pas changé garde ses tests. |
| Un testeur | page **Requirements** du tableau de bord : écrire l'exigence et ses critères, demander des scénarios (« Propose scenarios »), planifier des cas, y lier des tests. |

Un cas est d'abord **planifié** (`plan_tests` : son titre, le critère qu'il vérifie, son type —
`nominal`, `alternative`, `error`, `boundary`), puis enregistré : `start_recording(requirement, case_id)`
— ou `create_test_from_gherkin(…, requirement, case_id)` — lie le test sauvé à ce cas. `link_test` lie
un test existant. Un test lié à l'exigence d'un projet rejoint ce projet s'il n'en a pas.

**La couverture** se lit des liens et du dernier rejeu de chaque test (pas des vérifications de
réparation ni des confirmations de bugs) : `not_covered` (un critère sans test), `failing` (un
test a échoué), `not_run` (un test jamais rejoué), `passing`.

**Le résultat attendu vient de l'exigence, pas de ce que l'appli affiche.** Si la page montre autre
chose, ce n'est pas une valeur à accepter : `add_assertion` refuse d'abord, comme toujours, puis —
quand l'élément est bien là et que l'agent passe `non_conformity: true` après avoir vérifié que les
étapes précédentes ont fait ce qu'elles devaient — l'enregistre en échec : le test signale la
non-conformité tant que l'appli ne la corrige pas. Au triage, l'échec d'une assertion d'un test lié
à une exigence est une **non-conformité** (`non_conformity`) : aucune réparation ne propose
d'attendre la valeur affichée ; un sélecteur cassé (`test_drift`) ou une page lente (`timing`) restent
l'affaire du test.

À l'export, les exigences d'un test deviennent des étiquettes : `test('…', { tag: ['@REQ-1'] }, …)`
en Playwright (`npx playwright test --grep @REQ-1`), `@REQ-1` sur la feature Cucumber
(`cucumber-js --tags @REQ-1`), avec un commentaire qui dit le critère vérifié.

#### Importer des exigences d'un fichier : `import_requirements`

Beaucoup de cahiers de recette vivent dans des tableurs. L'import lit :

- **un tableau** — CSV ou TSV (le séparateur `;` d'un Excel français est reconnu, comme l'encodage
  Windows-1252 d'un vieil Excel), ou Excel `.xlsx` (la feuille `sheet`, par défaut la première). Les
  colonnes se reconnaissent à leur nom, en anglais ou en français : clé (`Key`, `Réf.`, `ID Exigence`,
  `Issue key`), titre (`Title`, `Summary`, `Intitulé`), description, critères d'acceptation (`Acceptance
  criteria`, `Critères d'acceptation`, `Règles de gestion`, un champ personnalisé Jira), priorité
  (`Priorité`, `Criticité` : « Haute », « Majeure », « Highest », « P1 »…), lien. `columns` désigne une
  colonne que son nom ne trahit pas. Un critère par ligne dans une cellule, ou par ligne du tableau :
  une ligne sans clé ni titre complète l'exigence du dessus, des lignes de même clé (ou, sans clé, de
  même titre) n'en font qu'une. Une colonne de simples numéros (1, 2, 3) numérote les lignes : ce ne sont
  pas des clés. Un **export CSV de Jira** s'importe tel quel (source `jira`).
- **du JSON** — une liste d'exigences, `{ requirements: [...] }`, ou le résultat d'une recherche Jira
  (`{ issues: [{ key, fields: { summary, description, priority } }] }`).
- **du Markdown** — un titre par exigence (sa clé en tête : `## SHOP-12 — Titre`), les éléments de ses
  listes comme critères, une ligne `Priorité :` ou `Lien :`, le reste comme description. Le titre du
  document et ceux des chapitres (des titres sans liste à eux, au-dessus d'autres) n'en sont pas.

Sans colonne de critères, ceux qu'une description range sous « Acceptance criteria » ou « Critères
d'acceptation » (y compris le `h3.` et les listes `#` de Jira) en sont extraits.

Des critères écrits en **Gherkin** — `Given` / `When` / `Then` / `And` ou `Étant donné` / `Quand` /
`Alors` / `Et`, une étape par ligne, en liste ou non — donnent un critère par scénario : « Étant donné
que je suis sur mon profil, quand je coche « Profil public », alors … », précédé de son nom quand une
ligne `Scénario :` le donne. Une action ou un contexte après un `Alors` ouvre le scénario suivant ; des
lignes sans `Alors` (« Quand je clique sur A, B s'affiche ») restent des critères à part. C'est vrai
dans une cellule, un champ de critères Jira, une description ou du Markdown.

C'est d'abord un **essai** (`dry_run`, par défaut) : chaque exigence est dite nouvelle, modifiée ou
inchangée, rien n'est enregistré. Importée à nouveau, une exigence est mise à jour sous sa clé (ou son
titre) et ses critères inchangés gardent leurs tests ; une exigence modifiée qui a des tests liés est
signalée. Dans le tableau de bord, le bouton **Import** de la page Requirements prend un fichier (choisi
ou déposé) ou un texte collé, montre l'aperçu et la colonne de chaque champ (modifiable), puis importe
dans le projet choisi en tête du panneau : celui du tableau de bord par défaut ; avec « All projects », à
choisir (« No project » compris, mais exprès).

### Connecteurs : les outils d'où viennent les exigences, et où vont les résultats

Une exigence est un objet d'IziTest, d'où qu'elle vienne. Les outils d'une équipe — Jira, GitHub
Issues, demain Notion ou Linear — y sont branchés par des **connecteurs** (`lib/connectors`) : un
fichier par outil, qui déclare comment on l'atteint et ce qu'il sait faire. Trois rôles, un connecteur
en a un ou plusieurs :

| Rôle | Ce qu'il fait | Aujourd'hui |
| :--- | :--- | :--- |
| `requirements` | lit les exigences de l'outil : par une requête dans son langage, leurs clés, ou à nouveau (`sync`) pour voir ce qui a changé | Jira (JQL), GitHub Issues (la recherche de GitHub) |
| `coverage` | dit à l'outil où en est chaque exigence qui en vient : un commentaire d'IziTest, mis à jour ensuite | Jira |
| `results` | envoie les résultats d'une campagne, mis à jour s'ils l'ont déjà été | Xray (une Test Execution) |

Le reste est commun à tous, et fait une seule fois :
- **les réglages** : chaque connecteur a sa carte dans **Settings** (Jira, Xray, GitHub Issues…), faite de
  ses champs (une adresse, un compte, un jeton) ; un secret est gardé sur la machine et jamais réaffiché
  (masqué, et redonné masqué il garde celui enregistré) ; « Test the connection » dit si ça marche ; à
  défaut, des variables d'environnement en tiennent lieu (`JIRA_API_TOKEN`…). Un connecteur qui n'a besoin
  de rien (GitHub, pour un dépôt public) marche tel quel ;
- **la lecture** n'écrit rien dans l'outil : un essai d'abord (nouvelle, modifiée, inchangée), puis
  l'import ; l'exigence garde comme `source` l'id du connecteur (`jira`, `github`), sa clé et son lien ;
- **l'écriture** ne se fait que sur demande, après un essai qui montre ce qui serait envoyé ; ce qui a été
  envoyé (le commentaire d'une story, la Test Execution d'une campagne) est retenu
  (`connector_refs`) : renvoyé, il est mis à jour, pas répété.

| Route ou outil | Rôle |
| :--- | :--- |
| `GET /api/connectors` | Les connecteurs : ce que chacun fait, ses champs, ses réglages (secrets masqués) |
| `PUT /api/connectors/:id` | Ses réglages (`{ values }`) ; son premier champ vide les retire |
| `POST /api/connectors/:id/test` | Si ces réglages (ou ceux enregistrés) marchent |
| `GET /api/connectors/:id/scopes` | Par où commencer à lire : les projets d'un site Jira, chacun avec sa requête |
| `POST /api/connectors/:id/import` | `{ query \| keys \| sync, project_id, dry_run }` : les exigences lues, enregistrées hors essai |
| `POST /api/connectors/:id/coverage` | `{ keys \| campaign_id, dry_run }` : la couverture envoyée, hors essai |
| `POST /api/campaigns/:id/send/:connector` | `{ options, dry_run }` : les résultats d'une campagne envoyés, hors essai |
| `import_from_connector`, `send_coverage`, `send_results` | Les mêmes, pour un agent : leur description liste les connecteurs et ce qu'ils prennent |

#### Écrire un connecteur

Un connecteur est un objet exporté par un fichier de `lib/connectors/`, inscrit dans
`lib/connectors/index.js` (la liste des connecteurs, en tête). Rien d'autre à toucher : l'API, les outils
MCP, Settings, l'import et la page d'une campagne le prennent d'eux-mêmes.

```js
export const notion = {
  id: 'notion', name: 'Notion',                     // l'id devient la source de ses exigences
  description: 'Les pages d\'une base Notion, lues comme exigences.',
  settings: {
    fields: [{ name: 'token', label: 'Token', type: 'secret', env: 'NOTION_TOKEN' }],  // url | text | secret, optional
    hint: 'Où créer le jeton.', link: 'https://www.notion.so/my-integrations',
  },
  async test({ config, fetch }) { /* appelle l'outil */ return 'Reads as …'; },       // une phrase
  requirements: {
    item: 'page', items: 'pages', keys: 'abc123', reads: 'son titre, son texte, ses critères',
    query: { label: 'database id', placeholder: '…' },
    async read({ config, fetch }, { query, keys, known }) {                          // known : déjà importées (sync)
      return { records: [{ key, title, description, criteria: [], priority: 'medium', url }], warnings: [] };
    },
  },
  // coverage: { where, render(requirement, { campaign }) → { body, text }, async post(ctx, requirement, body, { ref }) → { ref, action, url } }
  // results:  { what, options, note, prepare(campaign, options, { ref }) → { target, items, payload }, async send(ctx, prepared, { ref }) → { ref, url } }
};
```

Le connecteur reçoit `fetch` (une doublure dans ses tests : voir `test/connectors.test.js`), ses réglages,
et ceux d'un autre (`configOf('jira')`, dont Xray tire l'adresse du site). Il ne touche ni à la base ni
aux réglages : les clés, les critères trouvés dans une description (« Acceptance criteria »), l'essai,
ce qui a été envoyé, c'est le cadre commun qui s'en charge.

#### Jira : ses stories en exigences (`import_from_connector`, connecteur `jira`)

Le site se règle dans le tableau de bord (**Settings → Jira**) : son adresse
(`https://votre-equipe.atlassian.net`), l'email du compte, et un jeton d'API de ce compte (créé sur
id.atlassian.com → Security → API tokens). Il est gardé sur la machine, et jamais réaffiché : le tableau de
bord le montre masqué. « Test the connection » dit sous quel compte IziTest lit. À défaut, `JIRA_BASE_URL`,
`JIRA_EMAIL` et `JIRA_API_TOKEN` en tiennent lieu. La lecture n'écrit rien dans Jira ; seuls les
commentaires de couverture (`send_coverage`, plus bas) y écrivent, et seulement quand on le demande.

`import_from_connector(connector: "jira")` lit, par l'API REST v3 de Jira Cloud (la recherche JQL « enhanced », page après page,
500 stories au plus) :
- les stories d'une requête JQL (`query`, `project = SHOP AND issuetype = Story ORDER BY key` : une requête
  bornée, Jira refuse les autres) ;
- ou celles de leurs clés (`keys`) — une clé que Jira ne connaît pas, ou que ce compte ne voit pas, est
  dite, les autres sont lues ;
- ou, `sync: true`, celles déjà importées de Jira (du projet, ou toutes) : pour voir lesquelles ont changé.

Chaque story devient une exigence (source `jira`) : sa clé, son résumé, sa description (le format riche
d'Atlassian, mis en texte), sa priorité, son lien. Ses critères d'acceptation viennent d'un champ à eux
(« Acceptance Criteria », un champ personnalisé) quand le site en a un, sinon de la liste sous
« Acceptance criteria » dans sa description. Comme pour un fichier : un essai d'abord, puis l'import ;
une story modifiée depuis, qui a des tests liés, est signalée. Dans le tableau de bord : **Requirements
→ Import → From Jira**, avec les projets du site pour partir d'une requête (« Where to start ») (choisir un projet propose ses
stories, `issuetype = Story` ; sans type Story, ses tickets sauf les sous-tâches), et « Check the
imported ones for changes ».

#### Dire à Jira où en est chaque story : `send_coverage` (connecteur `jira`)

`send_coverage(connector: "jira")` écrit sur chaque story, en commentaire, où elle en est dans IziTest : sa couverture
(`passing`, `failing`, `not run`, `not covered`), chacun de ses critères avec ses tests et leur dernier
résultat (`✓`, `✗`, `○` sans test), la campagne d'où ça vient, et quand. Pour les stories de `keys`, ou
celles que vérifient les tests d'une campagne (`campaign_id` : ses exigences importées de Jira, les
autres laissées de côté). **Un commentaire par story**, celui d'IziTest : envoyé à nouveau, il est mis à
jour, pas répété ; supprimé dans Jira entre-temps, un nouveau le remplace.

C'est d'abord un **essai** (`dry_run`, par défaut) qui montre chaque commentaire : l'agent le montre à
l'utilisateur et lui demande avant de rappeler avec `dry_run: false`. Une story que Jira refuse (supprimée,
ce compte n'y a pas droit) est dite, les autres sont commentées. Dans le tableau de bord : le rapport d'une
campagne, **Send the results → Tell the Jira stories…**, aperçu puis « Send N to Jira ».

#### GitHub Issues : ses tickets en exigences (connecteur `github`)

Un **dépôt public se lit sans rien régler** ; un jeton (**Settings → GitHub Issues**, à défaut
`GITHUB_TOKEN`) n'est utile que pour un dépôt privé, ou au-delà de 60 requêtes par heure.
`import_from_connector(connector: "github")` lit :
- les tickets d'une recherche GitHub (`query`, `repo:acme/shop is:open label:story` ; `is:issue` est ajouté,
  les pull requests laissées de côté ; 500 au plus) ;
- ou ceux de leurs clés (`keys`, `acme/shop#12`) — un ticket introuvable est dit, une pull request aussi ;
- ou, `sync: true`, ceux déjà importés, relus depuis leur lien.

Chaque ticket devient une exigence (source `github`) : sa clé (le nom du dépôt et son numéro, `SHOP-12`),
son titre, son texte, son lien, sa priorité d'après ses libellés (`priority: high`, `P1`…), et ses critères :
la liste sous « Acceptance criteria » dans son texte, sinon sa liste de tâches (`- [ ] …`). Rien n'est
écrit sur GitHub. Deux dépôts de même nom chez deux propriétaires donneraient les mêmes clés : en importer
un seul par projet IziTest.

#### Concevoir les tests d'une exigence : `design_tests`

Une seule méthode, quel que soit l'agent qui l'applique. IziTest ne raisonne pas : il expose
l'exigence, ses cas déjà là, l'appli (le projet, son adresse, ses notes) et les **phrases Gherkin du
projet** — en disant, pour chacune, quel argument est un sélecteur CSS, et lesquelles sont des étapes
métier ; les phrases qui nomment un champ par son label (`I fill the field "…" with "…"`, `I select
"…" in the field "…"`, `I check the field "…"`) n'en demandent aucun —, puis les règles :

1. **Revue de testabilité** : un critère se teste quand il dit ce qu'on fait et ce qu'on voit ensuite,
   avec ses valeurs. Un mot vague (« rapide », « simple »), un résultat absent, une valeur manquante :
   le critère est signalé, avec la question à poser à son auteur et une reformulation.
2. **Ce que l'exigence ne dit pas** mais que sa portée implique (un champ vide, une valeur hors
   limite) : des règles à ajouter, sauf celles qu'une autre exigence du projet dit déjà (l'agent les
   voit toutes, avec leurs critères). Pour chaque règle, deux informations, et la raison du niveau
   en une phrase :
   - **où elle va** : `this` (cette exigence), `other` (une autre exigence du projet, nommée par sa
     clé, dont c'est le sujet), ou `project` (tout le projet : la langue des messages, un formulaire
     envoyé deux fois). Une clé inconnue, ou celle de l'exigence elle-même, ramène la règle à `this` ;
   - **le niveau où un test la vérifie le mieux** : `e2e` (par les écrans de l'appli : un message, un
     bouton là ou pas, un parcours), `api` (par son API : une règle à essayer avec beaucoup de
     valeurs, un refus du serveur), ou `unit` (dans le code, par ses développeurs).

   Une règle s'écrit dans une exigence quel que soit son niveau. Le niveau dit où va son test, pas
   s'il faut la dire.
3. **Les scénarios**, critère par critère, avec une technique : `use_case` (chemin attendu et
   variantes), `equivalence_partitioning`, `boundary_values`, `decision_table`, `state_transition`,
   `error_guessing`. Un scénario vérifie un critère, avec des valeurs concrètes, et une priorité.
4. **Le résultat attendu vient de l'exigence.** Là où elle ne le dit pas, il n'y a pas de scénario à
   écrire : c'est une question.
5. **Les étapes en Gherkin**, avec les phrases du projet mot pour mot. Jamais de sélecteur deviné :
   les phrases qui n'en demandent pas (`I am on`, `I click on the text`, `I should see`) et les étapes
   métier d'abord ; une étape qu'aucune phrase ne couvre est écrite en clair.

Chaque scénario est résolu contre les phrases du projet : **prêt** quand toutes ses étapes le sont —
le test se crée tel quel (`create_test_from_gherkin(…, requirement, case_id)`) —, sinon ses étapes en
clair sont **à enregistrer** : un agent les suit dans le navigateur (`start_recording(requirement,
case_id)`).

- **En MCP**, l'agent du dev lit `design_tests(requirement)`, montre la revue et les scénarios à
  l'utilisateur, puis garde ce qu'il retient : `save_requirement` pour les critères reformulés ou
  ajoutés (sur l'autre exigence pour une règle `other`, sur une nouvelle exigence du projet pour une
  règle `project`), `plan_tests` pour les scénarios (`technique`, `priority`, `rationale`, `gherkin`).
- **Dans le tableau de bord**, « Propose scenarios » envoie la même méthode à l'agent réglé dans
  Settings (un modèle par l'API, ou un CLI lancé une fois avec `-p`, sans outils), qui répond en JSON.
  La proposition est gardée sur l'exigence. La revue s'affiche sous chaque critère concerné (avec
  « Use this wording »), et les scénarios sont à cocher, groupés par critère.

  Ce qui manque s'affiche sous les critères, chaque règle avec son niveau (End to end, API, Unit ·
  developers) et sa raison. Son bouton dépend de l'endroit où elle va :
  - **cette exigence** : « Add as a criterion », puis Save avec les autres critères ;
  - **une autre exigence** : « Add to DOLI-6 », qui l'ajoute à la fin de ses critères ;
  - **tout le projet** : « Create a requirement », qui crée une exigence du projet avec cette règle
    comme titre et comme critère.

  « Not needed » l'écarte. Placée ou écartée, la règle quitte la proposition
  (`POST /api/requirements/:ref/design/missing`, `{ text, dismiss }`). Une proposition faite avant
  ce classement garde ses règles comme règles de cette exigence, sans niveau. « Plan » en fait des cas planifiés, rattachés à leur critère par son
  texte. Si l'exigence change ensuite, la proposition est marquée comme faite pour une version
  antérieure.
- **Un cas planifié** se crée depuis son scénario (« Create » : le modal Gherkin, prérempli, lie le
  test au cas) ou s'enregistre (« Record » : l'agent reçoit les critères, le scénario à suivre, et la
  règle des non-conformités). « Scenario » ouvre son Gherkin : modifié, il est revérifié.

### Campagnes : `run_campaign`

Une campagne rejoue ensemble les tests d'un **projet**, d'une **exigence** (les tests qui y sont liés)
ou une **liste**, pour une **version** de l'appli (`version: "1.4.0"`, un commit). Chaque test tourne
dans sa propre fenêtre, fermée après, quelques-uns à la fois (`concurrency`, 3 par défaut, 6 au plus),
dans une session à la campagne : pas celle de l'agent qui l'a lancée. Un échec est diagnostiqué comme
au `run_test` ; ces rejeux comptent dans la couverture des exigences (déclencheur `campaign`).

Le rapport dit :
- ce qui est passé, ce qui a échoué et pourquoi (la cause du triage) ;
- **ce qui a régressé** (passait à la dernière campagne des mêmes tests, échoue maintenant) et ce qui a
  été corrigé ;
- **où en est chaque exigence**, critère par critère, d'après les rejeux de cette campagne : `passing`,
  `failing`, `not run` (un de ses tests n'a pas tourné ici), `no test` ;
- les **non-conformités** : à signaler, pas à « réparer » dans les tests.

`run_campaign` attend la fin (10 minutes au plus ; au-delà, `get_campaign(id)` la suit) et répond par le
rapport. Une liste de tests qui sont tous d'un même projet fait une campagne de ce projet : elle est
listée avec les siennes, et son JUnit classe ses tests sous le nom du projet. Dans le tableau de bord, la
page **Campaigns** lance une campagne (un projet, une exigence ou des tests choisis, une version,
combien à la fois), la suit en direct, l'arrête (les tests en cours finissent, les autres ne démarrent
pas), la relance, et en donne le **JUnit** et le **rapport HTML**. Une exigence a son bouton « Run its
tests » ; sur la page **Tests**, des tests cochés partent ensemble avec « Run as campaign ». L'onglet
**Campaigns** d'un test liste les campagnes où il a tourné et ce qu'il y a donné
(`GET /api/tests/:name/campaigns`).

Pour une CI ou un terminal, sur une machine où tourne le serveur (et le Chrome de l'extension) :

```bash
IZITEST_TOKEN=… node mcp-server/bin/campaign.js --project 3 --version 1.4.0 --junit reports/junit.xml --html reports/campaign.html
```

`--requirement REQ-12` ou `--tests a,b` à la place de `--project` ; `--concurrency`, `--name`.
`IZITEST_URL` donne le serveur (par défaut `http://127.0.0.1:3467`). Code de sortie : 0 si tout passe,
1 si un test échoue ou n'a pas tourné, 2 si la campagne n'a pas pu être lancée. Dans le JUnit, la cause
du triage est le `type` de chaque `failure`, et les exigences d'un test sont ses `property
name="requirement"`. Une campagne laissée en cours par un serveur arrêté est marquée `interrupted` au
redémarrage.

#### Rejouer sans fenêtre : le Chrome headless

Un rejeu ouvre sa fenêtre **sans lui donner le focus** : la fenêtre où l'on est le garde, et la page
rejouée se croit au premier plan quand même (focus émulé par le debugger, captures d'écran faites par
lui, qui dessine un onglet caché). Une campagne ouvre donc ses fenêtres sans en voler aucune.

Pour ne plus les voir du tout, un **Chrome sans fenêtre** : Chrome for Testing (le Chrome de Google
n'accepte plus d'extension chargée par la ligne de commande), installé une fois depuis le tableau de bord
(**Settings → Headless browser → Install**, ~150 Mo dans `~/.izitest/browsers`), lancé avec l'extension
du dépôt et un profil à lui (`~/.izitest/profiles/headless`). Il démarre au premier rejeu demandé
headless et s'arrête avec le serveur. Son extension s'annonce comme le profil **`headless`** : une
commande qui ne nomme pas de profil n'y va **jamais**, même s'il s'est connecté le premier (`list_profiles`
le signale) ; un agent ne s'en sert qu'en le nommant (`profile: "headless"`). Ses pages voient un Chrome
ordinaire (sans « HeadlessChrome » dans le user agent).

- **Tableau de bord** : l'option « Headless — no window » (menu du bouton Run d'un test, formulaire de
  campagne, Settings), une seule préférence retenue ; « Run as campaign » et « Run its tests » la
  suivent ; « Run again » refait comme la campagne d'origine. Pas en debug ni avec « Use Agent » : le
  premier se regarde pas à pas, le second répare dans le Chrome de l'utilisateur. La fenêtre d'un rejeu
  headless est fermée après.
- **MCP** : `run_campaign(…, headless: true)`.
- **CI** : `node mcp-server/bin/campaign.js --project 3 --headless`.
- **API** : `GET /api/headless` (installé, en cours d'installation, lancé, connecté), `POST
  /api/headless/install|start|stop` ; `headless: true` dans `POST /api/tests/:name/execute` et `POST
  /api/campaigns`.

Son profil est le sien : cookies, sessions et stockage ne sont pas ceux du Chrome de l'utilisateur. Un
test d'une appli derrière une connexion se connecte lui-même.

#### Envoyer une campagne à Xray : `send_results` (connecteur `xray`)

La clé d'API de Xray se règle dans le tableau de bord (**Settings → Xray**) : son client id et son secret,
créés dans Jira → Apps → Xray → API Keys (par un administrateur). Le secret est gardé sur la machine et
jamais réaffiché ; « Test the API key » vérifie que Xray la prend. À défaut, `XRAY_CLIENT_ID` et
`XRAY_CLIENT_SECRET` en tiennent lieu ; `XRAY_BASE_URL` désigne un Xray régional
(`https://eu.xray.cloud.getxray.app`).

`send_results(connector: "xray", id, options)` envoie les résultats d'une campagne terminée, par l'import JSON de Xray Cloud
(`/api/v2/import/execution`) :
- une **Test Execution** dans le projet Jira `options.project_key` — par défaut celui des stories que couvrent ses
  tests, quand elles sont toutes d'un même projet —, ajoutée au Test Plan `options.test_plan_key` s'il est donné ;
  son résumé est « IziTest — <campagne> (<version>) », sa description les totaux, les régressions, les
  non-conformités ;
- chaque test d'IziTest est un **test Generic** de Xray, créé au premier envoi puis retrouvé par sa
  définition `izitest:<nom>`, libellé `izitest`, **lié aux stories qu'il couvre** (ses exigences importées
  de Jira) : Xray en montre la couverture ;
- son résultat : `PASSED`, `FAILED` avec l'étape, l'erreur et le triage en commentaire, ou `TODO` s'il n'a
  pas tourné ; ses heures de début et de fin.

Envoyée à nouveau, la campagne **met à jour sa Test Execution** (sa clé est gardée) : ses résultats, pas
ses champs (Xray peut ne pas avoir le droit de réécrire ses dates, sur un projet « team-managed »), et
les mêmes tests, retrouvés par leur définition ; supprimée dans Jira entre-temps, une nouvelle est créée. C'est d'abord un **essai** (`dry_run`, par défaut) qui dit ce
qui serait envoyé : l'agent le montre et demande avant d'envoyer. Dans le tableau de bord : le rapport
d'une campagne, **Send the results → Send to Xray…** (le projet et le Test Plan, l'aperçu, puis l'envoi), et
la Test Execution une fois envoyée. Xray demande un projet où ses types de tickets (Test, Test Execution)
sont activés ; sur un projet « team-managed », passer d'abord par sa configuration Xray.

### Exploration autonome : `explore_app`

L'explorateur parcourt un site tout seul et rapporte ce qui ne va pas sans qu'aucune assertion
n'ait été écrite. Depuis `url`, il visite les pages du même site (même origine, en largeur, en
suivant leurs liens, `max_pages` au plus — 8 par défaut) et, sur chacune, contrôle :

| Contrôle | Ce qui est signalé |
| :--- | :--- |
| `console` | les erreurs que la page écrit dans la console, et les exceptions qu'elle lève (`Uncaught …`) |
| `network` | les requêtes répondues 4xx/5xx ou en échec (le favicon excepté) |
| `links` | les liens vers les pages du site qui ne répondent pas (demandés depuis la page, avec ses cookies ; les liens vers d'autres sites ne sont pas suivis : beaucoup refusent une requête qui n'est pas d'un navigateur) |
| `a11y` | les règles d'accessibilité enfreintes, par axe-core (WCAG 2.1 A/AA et bonnes pratiques), d'impact *serious* ou *critical* (`include_moderate` pour plus) |

Avec `interact` (par défaut), il clique aussi sur chaque contrôle inoffensif de la page — boutons,
onglets, menus, nommés — et regarde ce que chaque clic fait écrire ou échouer. Jamais ce qui
supprime, paie, commande, déconnecte, envoie, confirme ou annule (en français comme en anglais), ni
un lien (il est suivi, pas cliqué). La page est rechargée après un clic qui l'a changée. Aucun
formulaire n'est envoyé : pour explorer en profondeur (remplir, valider), l'agent connecté utilise
`check_page` sur la page où il est.

Chaque bug est gardé une fois (même type, même page, même clic, même message, requête, lien ou
règle) : une exploration suivante le compte à nouveau sans le dupliquer, un bug marqué corrigé et
revu est rouvert, un bug écarté reste écarté. Chaque nouveau bug reçoit un test qui le reproduit,
`bug_<id>_<type>` : la page, le clic qui l'a causé, une seconde, puis le contrôle qui échoue tant que
le bug est là — et passe le jour où il est corrigé. Ce test est rejoué aussitôt (`confirm`) : le bug
est marqué *reproduit* s'il échoue bien sur ce contrôle. L'exploration tourne dans sa propre fenêtre,
fermée à la fin, comme celles des tests rejoués. Compter de 2 à 10 s par page : Chrome ralentit une
page dans une fenêtre en arrière-plan.

Les quatre contrôles sont aussi des types d'assertion (`add_assertion`) : ajouté à un test qui
échoue dessus, un tel contrôle n'est pas refusé — le test reproduit alors le bug ; s'il passe, il en
protège. Un test de bug qui échoue est diagnostiqué `app_regression` : la page a toujours le bug.

Le tableau de bord a une page **Bugs** : lancer une exploration (URL, nombre de pages, clics ; l'URL de
base du projet pour commencer, et l'exploration est rattachée à ce projet), suivre la dernière, et la
liste des bugs du projet du tableau de bord, du plus grave au moins grave, filtrée par statut, type et
gravité, avec leur test et les actions *Fixed*, *Dismiss*, *Reopen*. API : `GET /api/bugs?status=&project_id=`,
`PUT /api/bugs/:id`, `GET|POST /api/explorations`.

### Triage et réparation d'un test qui échoue

Un échec est diagnostiqué au moment où il arrive, sur la page où il s'est produit (la fenêtre du
rejeu y reste), que le test soit lancé par `run_test` ou depuis le tableau de bord — pas en debug pas
à pas. Le diagnostic est déterministe — il n'appelle aucun modèle : l'agent connecté reste celui qui
raisonne sur les cas ambigus, avec les preuves qu'on lui donne. Il est gardé avec l'exécution, montré
dans la sortie de `run_test` (section `=== TRIAGE ===`), dans la fenêtre d'exécution et dans
l'historique du tableau de bord.

| Cause | Ce que ça veut dire | Réparation proposée |
| :--- | :--- | :--- |
| `test_drift` | Le test a cassé, pas forcément l'appli : aucun localisateur ne trouve plus l'élément, mais la page a un élément qui lui ressemble clairement (même nom ou nom proche, même rôle, même placeholder, même test ID), ou le texte qu'une assertion lit est ailleurs | `relocate` : l'étape pointe vers cet élément (sélecteur, localisateurs, rôle et nom) |
| `timing` | L'élément est là maintenant, sous un sélecteur de l'étape ; ou l'assertion passe 1,5 s plus tard | `wait` : une attente insérée avant l'étape |
| `changed_value` | Une assertion lit une autre valeur : régression, ou changement voulu (nouveau libellé) | `expect`, **à juger par une personne** : attendre la nouvelle valeur. Jamais pour la valeur d'une variable, ni pour un long texte lu par « contient » |
| `disabled` | L'élément est là mais désactivé | — |
| `app_regression` | L'élément a disparu, ou la valeur a changé, et la page signale une erreur (`role="alert"`, requête en 4xx/5xx) ; ou elle n'affiche pas la valeur que le test a saisie | — : à signaler, pas à « réparer » |
| `environment` | La page ne s'est pas chargée (erreur réseau, page servie en 5xx) | — |
| `unknown` | Rien de tout ça, ou plusieurs éléments ressemblent autant à celui cherché | — |

Les preuves accompagnent le diagnostic : l'adresse de la page, ses alertes, les requêtes en échec,
les meilleurs candidats avec leur score, et combien de fois le test est passé avant.

Une réparation n'est jamais appliquée toute seule. `verify_repair` (ou **Verify** dans l'historique)
rejoue le test avec elle, sans l'enregistrer, avec les variables et substitutions de l'exécution qui
a échoué : vérifiée si tout le test passe, assertions comprises. `resolve_repair` (**Apply** /
**Reject**) l'enregistre ou l'écarte ; une autre réparation encore ouverte pour la même étape est
alors remplacée (`superseded`). Une étape modifiée depuis la proposition n'est pas réparée à
l'aveugle (`stale`). Le même échec revu propose la même réparation : elle est réutilisée, pas
dupliquée. Les rejeux de vérification apparaissent dans l'historique avec le déclencheur `repair`.

Les étapes du rejeu sont numérotées comme dans le test : une assertion placée au milieu décalait
d'un cran toutes les étapes suivantes, et l'échec était signalé (et réparé) sur la mauvaise.

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
