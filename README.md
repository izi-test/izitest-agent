# Browser Pilot 🎯

**Contrôle ton navigateur Chrome via Claude en langage naturel.**
Garde tes vraies sessions, cookies, fingerprint — zéro détection bot.

---

## Architecture

```
Toi (langage naturel)
  → Claude Desktop / Claude Code
    → MCP Server (stdio)
      → WebSocket Bridge (port 3456)
        → Extension Chrome (par profil)
          → Ton vrai navigateur avec tes sessions
```

## Installation

### 1. MCP Server

```bash
cd mcp-server
npm install
```

### 2. Extension Chrome

1. Ouvre Chrome → `chrome://extensions`
2. Active le **Mode développeur** (toggle en haut à droite)
3. Clique **Charger l'extension non empaquetée**
4. Sélectionne le dossier `extension/`
5. L'icône Browser Pilot apparaît dans la barre — clique dessus pour configurer le profile ID

### 3. Configuration Claude

#### Option A : Claude Desktop

Ajoute dans `~/Library/Application Support/Claude/claude_desktop_config.json` :

```json
{
  "mcpServers": {
    "browser-pilot": {
      "command": "node",
      "args": ["/chemin/absolu/vers/browser-pilot/mcp-server/server.js", "--stdio"]
    }
  }
}
```

#### Option B : Claude Code

```bash
claude mcp add browser-pilot node /chemin/absolu/vers/browser-pilot/mcp-server/server.js --stdio
```

### 4. Lancement

```bash
# Terminal 1 : lance le serveur MCP (si test standalone)
cd mcp-server && node server.js

# Terminal 2 : lance un profil Chrome (optionnel, pour multi-comptes)
chmod +x scripts/launch-profile.sh
./scripts/launch-profile.sh compte-youtube-1
./scripts/launch-profile.sh compte-youtube-2
```

> Note : quand Claude utilise le MCP, le serveur se lance automatiquement.
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
| `navigate` | Navigue vers une URL |
| `snapshot` | Scanne la page et retourne tous les éléments interactifs avec des UIDs |
| `click` | Clique un élément (uid, sélecteur CSS ou texte) |
| `fill` | Remplit un champ de formulaire (uid ou sélecteur CSS) |
| `extract` | Extrait du contenu de la page |
| `screenshot` | Capture d'écran |
| `get_tabs` | Liste les onglets ouverts |
| `get_page_info` | Infos détaillées sur la page |
| `scroll` | Scroll haut/bas ou vers un élément |
| `wait` | Attend (temps ou apparition d'élément) |
| `execute_js` | Exécute du JavaScript arbitraire |
| `keyboard` | Envoie une touche clavier |
| `get_cookies` | Récupère les cookies |

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


