# IziTest Agent 🎯

**Contrôle ton navigateur Chrome via Claude en langage naturel.**
Garde tes vraies sessions, cookies, fingerprint — zéro détection bot.

---

## Architecture

```
Toi (langage naturel)
  → Claude Desktop / Claude Code / plusieurs agents en parallèle
    → MCP Server partagé (SSE, port 3457) — une session par agent
      → WebSocket Bridge (port 3456)
        → Extension Chrome (par profil)
          → Ton vrai navigateur, une fenêtre par session
```

Plusieurs agents peuvent piloter le navigateur en même temps : chacun obtient sa propre
fenêtre, ses propres refs de snapshot et son propre enregistrement.
Voir [docs/parallel-sessions.md](docs/parallel-sessions.md).

Le Poste de pilotage peut suivre chaque agent en direct (flux MJPEG, une image par action,
relecture) sans le perturber. Voir [docs/live-view.md](docs/live-view.md).

## Installation

### 1. MCP Server

```bash
cd mcp-server
npm install
```

### 2. Extension Chrome

```bash
cd extension && npm install && npm run build
```

1. Ouvre Chrome → `chrome://extensions`
2. Active le **Mode développeur** (toggle en haut à droite)
3. Clique **Charger l'extension non empaquetée**
4. Sélectionne le dossier `extension/dist/` (c'est là qu'atterrissent le manifeste et les bundles)
5. L'icône IziTest Agent apparaît dans la barre — clique dessus pour configurer le profile ID

> Les rebuilds suivants (`npm run build`, ou `npm run watch`) **rechargent l'extension dans
> Chrome automatiquement** — plus besoin de revenir sur `chrome://extensions`.
> Voir [docs/parallel-sessions.md](docs/parallel-sessions.md#recharger-lextension-après-un-build).

### 3. Configuration Claude

IziTest Agent tourne comme **un serveur partagé** auquel tous les agents se connectent en
SSE. C'est ce qui permet de lancer plusieurs agents en parallèle sans qu'ils se gênent.

#### Option A : Claude Desktop

Ajoute dans `~/Library/Application Support/Claude/claude_desktop_config.json` :

```json
{
  "mcpServers": {
    "izitest-agent": {
      "type": "sse",
      "url": "http://127.0.0.1:3457/sse"
    }
  }
}
```

#### Option B : Claude Code

```bash
claude mcp add --transport sse izitest-agent http://127.0.0.1:3457/sse
```

> Le mode stdio (`node mcp-server/server.js --stdio`) reste disponible, mais **pour un seul
> agent à la fois** : il démarre son propre pont WebSocket, et deux agents en stdio se
> disputeraient le port 3456.

### 4. Lancement

```bash
# Démarre le serveur partagé s'il ne tourne pas déjà (sûr en parallèle)
cd mcp-server && npm run ensure

# Optionnel, pour multi-comptes : un Chrome par profil isolé
chmod +x scripts/launch-profile.sh
./scripts/launch-profile.sh compte-youtube-1
./scripts/launch-profile.sh compte-youtube-2
```

> `npm run ensure` ne démarre le serveur que s'il est absent, et plusieurs appels
> simultanés ne créent qu'une seule instance (verrou exclusif). Dans ce dépôt, un hook
> `SessionStart` l'appelle automatiquement au démarrage de Claude Code.
> Les scripts de profil sont pour lancer Chrome avec des profils isolés.

---

## Utilisation avec Claude

Une fois configuré, parle simplement à Claude :

### Navigation
> "Va sur youtube.com"
> "Ouvre un nouvel onglet sur twitter.com avec le profil compte-youtube-1"

### Interactions
> "Clique sur le bouton 'Se connecter'"
> "Remplis le champ de recherche avec 'military aircraft'"
> "Appuie sur Entrée"

### Extraction
> "Extrais les titres de toutes les vidéos sur la page"
> "Récupère le texte de l'élément .description"
> "Combien de liens il y a sur cette page ?"

### Multi-comptes
> "Liste les profils connectés"
> "Sur le profil compte-youtube-1, va sur youtube.com/studio"
> "Sur le profil compte-youtube-2, poste ce commentaire..."

### Screenshots
> "Fais un screenshot de la page actuelle"

### Avancé
> "Exécute ce JavaScript : document.querySelectorAll('.video-title').length"
> "Attends que l'élément .results apparaisse puis extrais son contenu"

---

## Tools MCP disponibles

| Tool | Description |
|------|-------------|
| `list_profiles` | Liste les profils Chrome connectés |
| `open_session` | Réclame une session isolée (sa propre fenêtre). Inutile en temps normal — chaque connexion MCP en a déjà une ; sert aux sous-agents qui partagent une connexion |
| `list_sessions` | Liste les sessions actives et la fenêtre de chacune |
| `close_session` | Ferme une session nommée et sa fenêtre |
| `navigate` | Navigue vers une URL |
| `snapshot` | Scanne la page et retourne tous les éléments interactifs avec des UIDs — iframes comprises, même d'un autre site ([docs/iframes.md](docs/iframes.md)) |
| `click` | Clique un élément (uid, sélecteur CSS ou texte) |
| `fill` | Remplit un champ de formulaire (uid ou sélecteur CSS) |
| `extract` | Extrait du contenu de la page |
| `screenshot` | Capture d'écran |
| `get_tabs` | Liste les onglets ouverts |
| `close_window` | Ferme la fenêtre de travail en fin de tâche — uniquement une fenêtre ouverte par IziTest Agent, jamais celles de l'utilisateur |
| `get_page_info` | Infos détaillées sur la page |
| `scroll` | Scroll haut/bas ou vers un élément |
| `wait` | Attend (temps ou apparition d'élément) |
| `execute_js` | Exécute du JavaScript arbitraire |
| `keyboard` | Envoie une touche clavier |
| `get_cookies` | Récupère les cookies |
| `network_requests` | Liste les requêtes réseau capturées (filtre par texte/méthode/type) |
| `network_response` | Récupère le corps d'une réponse (avec recherche JSONPath si JSON) |
| `network_search` | Cherche dans les réponses de plusieurs requêtes filtrées à la fois (utile pour GraphQL) |
| `act` | **Voie rapide (Jev)** : délègue une tâche courte (login, formulaire, recherche) — le serveur enchaîne snapshot → décision → action tout seul et rend la main en cas de doute |

| `bench_start` / `bench_stop` | Encadrent une tâche et comparent les runs (temps total, temps LLM de l'agent, temps outils, appels, texte renvoyé) — pour mesurer `act` contre `snapshot`/`click`/`fill` |

### Voie rapide avec `act` (Jev)

`act` confie une tâche bornée à [Jev](https://typesafe.ai/) (TypeSafe AI), un modèle de décision (~300 ms par décision)
appelé via OpenRouter. Un seul appel d'outil remplace toute la séquence `snapshot → click/fill → snapshot → …` :

```
act(goal: "Se connecter", inputs: { "email": "moi@exemple.fr", "mot de passe": "..." })
→ act: DONE after 3 action(s) in 1721ms
```

- **Clé requise** : variable d'environnement `OPENROUTER_API_KEY`, ou clé enregistrée dans Settings (mode API).
  Sans clé, `act` répond qu'il est indisponible et l'agent continue avec `snapshot`/`click`/`fill`.
- **`inputs` obligatoire pour tout ce qui se tape** : Jev ne génère pas de texte. Les valeurs vont uniquement au
  navigateur ; Jev ne voit que les clés, et les valeurs déjà saisies (mots de passe inclus) sont masquées dans ce qu'il reçoit.
- **Rend la main plutôt que deviner** : si Jev hésite, tourne en rond ou se dit bloqué, `act` s'arrête et renvoie
  les refs `@eX` candidates pour que l'agent termine avec `click`/`fill`.
- **Limites** : pas d'extraction de contenu, pas de canvas ni d'iframes cross-origin ; Jev juge la fin de tâche sur
  l'URL, le titre et les éléments interactifs seulement — à vérifier si le résultat compte.

### Workflow recommandé avec `snapshot`

```
1. snapshot → obtient la liste des éléments avec UIDs
2. click uid="5" → clique sur l'élément [5]
3. fill uid="12" value="hello" → remplit l'input [12]
```

Le snapshot retourne un format compact :
```
Page: YouTube
URL: https://www.youtube.com
Elements: 42

[1] link "Home" → https://www.youtube.com/
[2] input/text placeholder="Search"
[3] button "Search"
[4] link "Sign in" → https://accounts.google.com/...
[5] heading/1 "Recommended"
```

---

## Multi-comptes

Chaque profil Chrome est complètement isolé :
- Cookies / sessions séparés
- Historique séparé
- Extensions installées séparément

```bash
# Lance 3 profils différents
./scripts/launch-profile.sh youtube-main
./scripts/launch-profile.sh youtube-backup
./scripts/launch-profile.sh twitter-bot
```

Installe l'extension dans chaque profil et donne un nom unique.
Claude peut ensuite cibler un profil spécifique via le paramètre `profile`.

---

## Pourquoi c'est anti-détection

1. **Vrai navigateur** — pas de headless Chrome, pas de Puppeteer
2. **Vrai fingerprint** — le navigateur a ton vrai user agent, plugins, fonts, WebGL
3. **Vraies sessions** — tu te connectes manuellement une fois, les cookies persistent
4. **Pas d'injection CDP visible** — l'extension utilise les APIs Chrome officielles
5. **Timing humain** — les actions passent par `scrollIntoView` + events DOM naturels

---

## Sécurité

- Le WebSocket écoute uniquement sur `localhost` (127.0.0.1)
- Aucun port exposé sur le réseau
- Les cookies sont partiellement masqués dans les réponses (50 premiers caractères)
- Le JavaScript exécuté tourne dans le contexte de la page (sandboxé par Chrome)


