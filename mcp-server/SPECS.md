# IziTest Agent — Spécifications Fonctionnelles

## 1. Vue d'ensemble

IziTest Agent est un outil d'automatisation de navigateur piloté par IA. Il permet de contrôler Chrome en temps réel via des commandes en langage naturel, d'enregistrer et rejouer des tests E2E, et de générer du code de test exécutable.

**Utilisateurs cibles** : QA engineers, développeurs, product owners.

---

## 2. Extension Chrome

Contrôle le navigateur via WebSocket (ws://127.0.0.1:3466).

| Commande | Description |
|----------|-------------|
| `navigate` | Naviguer vers une URL, ouvrir un onglet/fenêtre avec viewport optionnel |
| `click` | Cliquer par sélecteur CSS, texte visible ou ref (@eX) |
| `fill` | Remplir un champ texte (avec option clear) |
| `select` | Sélectionner une option dans un `<select>` |
| `keyboard` | Envoyer des touches clavier avec modificateurs (ctrl, shift, alt, meta) |
| `scroll` | Scroller la page ou vers un élément |
| `wait` | Attendre un délai (ms) ou l'apparition d'un sélecteur |
| `snapshot` | Arbre d'accessibilité DOM avec refs, filtrage par purpose (fill/click/read) |
| `screenshot` | Capture d'écran pleine page (PNG base64) avec annotations optionnelles |
| `extract` | Extraire texte/attributs d'éléments (unitaire ou batch) |
| `execute_js` | Exécuter du JavaScript dans le contexte de la page |
| `get_tabs` | Lister les onglets ouverts |
| `get_page_info` | Infos page : titre, URL, compteurs (forms, links, inputs, buttons) |
| `get_cookies` | Récupérer les cookies par URL ou domaine |
| `close_tab` | Fermer un onglet |
| `replay_sequence` | Exécuter un batch de steps avec streaming debug |
| `detect_list_context` | Détecter si un élément est dans une liste/box |

**Principes clés** :
- Utilise le vrai Chrome (sessions, cookies, fingerprint intacts — zéro détection bot)
- Découverte d'éléments par arbre d'accessibilité (pas de locators pixel)
- Support multi-profils Chrome isolés

---

## 3. Enregistrement de tests

### Flow d'enregistrement
1. `start_recording(name, description, use_vrt, viewport)` → ouvre une fenêtre
2. L'agent exécute des actions navigateur → chaque action est auto-enregistrée comme step
3. `stop_recording()` → détection automatique de variables + sauvegarde

### Détection automatique de variables
- **Champs texte** : nom de variable dérivé du label/placeholder/aria du champ → `{{email}}`, `{{password}}`
- **Clicks sur listes/box** : classification LLM pour détecter le contexte de liste → variable de sélection (par index ou texte)
- **Selects** : détection automatique de combobox

### Nettoyage automatique
- Suppression des navigations dupliquées vers la même URL
- Suppression des waits en fin d'enregistrement

---

## 4. Exécution de tests

### Modes d'exécution
- **Normal** : exécution complète, résultats streamés en temps réel
- **Debug** : pause avant chaque step (ou aux breakpoints), contrôle step-by-step

### Paramètres d'exécution
- `variables` : override des valeurs par défaut (`{ email: "autre@mail.com" }`)
- `substitutions` : find/replace dans tous les params
- `start_step` : reprise à partir du step N (pour corriger un test échoué)
- `new_window` : ouvrir dans une nouvelle fenêtre
- `debug` + `breakpoints` : mode pas-à-pas

### Contrôles debug
- `step` : exécuter un seul step
- `resume` : reprendre jusqu'au prochain breakpoint
- `continue` : exécuter tous les steps restants
- `toggle_breakpoint` : ajouter/retirer un breakpoint
- `abort` : annuler l'exécution

### 13 types d'assertions
| Type | Description |
|------|-------------|
| `element_exists` | Le sélecteur existe dans le DOM |
| `element_not_exists` | Le sélecteur n'existe PAS |
| `element_visible` | L'élément est visible |
| `element_hidden` | L'élément est caché |
| `text_equals` | Texte de l'élément === attendu |
| `text_contains` | Texte de l'élément contient attendu |
| `attribute_equals` | Attribut de l'élément === attendu |
| `url_equals` | URL courante === attendue |
| `url_contains` | URL courante contient attendu |
| `title_equals` | Titre de la page === attendu |
| `title_contains` | Titre de la page contient attendu |
| `element_count` | Nombre d'éléments === attendu |
| `visual_match` | VRT : comparaison screenshot vs baseline |

### Visual Regression Testing (VRT)
- Capture de baseline à chaque step pendant l'enregistrement (si `use_vrt=true`)
- Comparaison pixel avec pixelmatch
- Screenshot de différence en cas d'échec

---

## 5. Gherkin / BDD

### Sérialisation
- Test steps → fichier `.feature` (Gherkin)
- Matching des steps contre les step definitions du projet
- Collapse automatique des séquences en steps composites

### Parsing
- Fichier `.feature` → test steps exécutables
- Résolution des phrases Gherkin via Cucumber Expressions
- Expansion des steps composites (1 phrase → N test steps)

### Step definitions
- **Par défaut** (17 built-in) : navigation, clicks, fill, waits, assertions
- **Custom** : créées par l'utilisateur ou l'agent, par projet
- **Composites** : une phrase Gherkin → plusieurs commandes navigateur

Exemple de step composite :
```
When I login with {string} and {string}
  → navigate /login
  → fill #username avec {0}
  → fill #password avec {1}
  → click #submit
```

---

## 6. Génération de code

### Frameworks supportés

**Playwright Plain** :
- Fichier unique `.spec.js`
- `@playwright/test` (test + expect)
- Variables injectées, viewport configuré

**Playwright Cucumber** :
- Bundle multi-fichiers :
  - `features/*.feature` (Gherkin)
  - `features/steps/default.steps.js` (step defs par défaut)
  - `features/steps/composite.steps.js` (composites du projet)
  - `features/support/world.js` (lifecycle browser Playwright)
  - `cucumber.js` (config)
  - `package.json` (dépendances)

---

## 7. Système d'agents

### Deux modes

**CLI** : spawne un processus externe (Claude Code, GitHub Copilot, Gemini CLI, Open Code)
- Communication via MCP (stdio ou SSE)
- L'agent a accès à tous les outils navigateur + test

**API** : appel direct à un LLM via Vercel AI SDK + OpenRouter
- Pas de subprocess, plus rapide
- Supporte tout modèle OpenRouter avec tool_use
- Tools : 15 outils navigateur + 10 outils test + 6 outils agent

### Agent Chat (conversationnel)
- L'utilisateur décrit un test en langage naturel
- L'agent propose le Gherkin basé sur le contexte projet
- L'utilisateur valide → l'agent crée le test + step definitions
- Historique de conversations persisté en BDD
- System prompt contextuel : specs projet, step definitions existantes, tests existants

### Outils agent partagés (CLI + API)
| Outil | Description |
|-------|-------------|
| `get_project_context` | Contexte complet du projet |
| `list_project_tests` | Liste des tests du projet |
| `create_test_from_gherkin` | Créer un test à partir de Gherkin |
| `create_step_definition` | Créer une step definition (simple ou composite) |
| `get_test_as_gherkin` | Sérialiser un test en Gherkin |
| `update_project_context` | Mettre à jour le contexte projet |

---

## 8. Gestion de projets

### Modèle projet
- `name`, `description` : identité
- `base_url` : URL de l'application testée
- `project_type` : frontend / backend / fullstack
- `context` : texte libre (specs, notes, URLs, features) — injecté dans le system prompt de l'agent

### Organisation
- Les tests sont assignés à un projet (ou "Unorganized")
- Les step definitions sont scopées par projet
- Les conversations sont liées à un projet

---

## 9. Interface frontend

### Vues principales
| Vue | Description |
|-----|-------------|
| **Liste des tests** | Vue par projet, recherche, suppression |
| **Détail test** | Steps, variables, assertions, exécution, Gherkin, codegen |
| **Chat** | Interface conversationnelle pour créer des tests avec l'agent |
| **Settings** | Configuration agent (mode CLI/API, clé API, modèle) |

### Composants clés
- **ProjectSelector** : gestion projets + contexte (specs, type, URL)
- **ChatPanel** : sidebar conversations + zone messages + suggestions
- **LiveExecutionModal** : streaming des résultats en temps réel
- **GherkinEditor** : éditeur avec coloration syntaxique
- **CodePanel** : visualisation du code généré (Playwright)

---

## 10. API REST

### Tests
- `GET/POST /api/tests` — CRUD tests
- `GET/PUT/DELETE /api/tests/:name` — Détail, update, suppression
- `POST/PUT/DELETE /api/tests/:name/steps` — Gestion des steps
- `PUT /api/tests/:name/steps-reorder` — Réordonnancement
- `GET/PUT /api/tests/:name/feature` — Gherkin (lecture/écriture)
- `GET /api/tests/:name/codegen` — Génération de code

### Exécution
- `POST /api/tests/:name/execute` — Lancer (streaming SSE)
- `GET /api/tests/:name/executions` — Historique
- `GET /api/executions/:id` — Détail exécution
- `POST /api/debug/:id/:action` — Contrôle debug

### Projets
- `GET/POST /api/projects` — Liste / création
- `GET/PUT/DELETE /api/projects/:id` — CRUD
- `GET/POST /api/projects/:id/step-definitions` — Step defs
- `PATCH/DELETE /api/step-definitions/:id` — Update/delete

### Agent
- `POST /api/agent/run` — Exécution agent (streaming SSE)
- `POST /api/agent/chat` — Chat conversationnel
- `GET /api/projects/:id/conversations` — Conversations
- `GET/DELETE /api/conversations/:id` — Détail / suppression

### Configuration
- `GET/PUT /api/settings/agent` — Config agent
- `GET /api/models` — Modèles OpenRouter disponibles

---

## 11. Base de données (SQLite)

| Table | Rôle |
|-------|------|
| `projects` | Projets (name, context, type, base_url) |
| `tests` | Tests (name, variables, viewport, project_id) |
| `test_steps` | Steps (command, params, locators, intent, variable, assertion) |
| `step_definitions` | Step defs Gherkin (pattern, command, params_template, steps_template) |
| `test_executions` | Exécutions (status, duration, assertions) |
| `execution_steps` | Résultats step-by-step |
| `conversations` | Conversations agent chat |
| `messages` | Messages (role, content, tool_calls, tool_results) |
| `settings` | Configuration clé-valeur |
