# Configuration ⚙️

Ce document décrit toutes les options de configuration disponibles pour Browser Pilot.

---

## Variables d'environnement

### Ports réseau

| Variable | Défaut | Description |
|----------|--------|-------------|
| `WS_PORT` | `3456` | Port WebSocket pour la communication avec l'extension Chrome |
| `MCP_PORT` | `3457` | Port HTTP/SSE pour le serveur MCP (mode non-stdio) |

**Exemple** :
```bash
export WS_PORT=3458
export MCP_PORT=3459
node mcp-server/server.js
```

---

## Configuration Claude Desktop

### Chemin du fichier de configuration

- **macOS** : `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** : `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux** : `~/.config/Claude/claude_desktop_config.json`

### Configuration minimale

```json
{
  "mcpServers": {
    "browser-pilot": {
      "command": "node",
      "args": [
        "/CHEMIN/ABSOLU/vers/browser-pilot/mcp-server/server.js",
        "--stdio"
      ]
    }
  }
}
```

### Configuration avec variables d'environnement

```json
{
  "mcpServers": {
    "browser-pilot": {
      "command": "bash",
      "args": [
        "-c",
        "export WS_PORT=3458 && export MCP_PORT=3459 && node /chemin/vers/browser-pilot/mcp-server/server.js --stdio"
      ]
    }
  }
}
```

---

## Modes de fonctionnement

### Mode stdio (recommandé pour Claude Desktop)

Communication via entrées/sorties standard. N'utilise pas de port réseau.

```bash
node server.js --stdio
```

**Avantages** :
- Plus sécurisé (pas de port exposé)
- Démarre à la demande avec Claude
- Recommandé pour Claude Desktop

### Mode SSE (Server-Sent Events)

Serveur HTTP autonome avec interface web.

```bash
node server.js
```

**Endpoints disponibles** :
- `http://127.0.0.1:3457/` - Interface web
- `http://127.0.0.1:3457/sse` - Endpoint SSE pour MCP
- `http://127.0.0.1:3457/messages` - Messages MCP
- `http://127.0.0.1:3457/health` - Vérification d'état
- `http://127.0.0.1:3457/api/*` - API REST

**Avantages** :
- Interface web visuelle
- API REST pour intégrations externes
- Permet de monitorer les profils connectés

---

## Configuration de l'extension Chrome

### Paramètres du popup

Cliquez sur l'icône Browser Pilot dans Chrome pour configurer :

| Paramètre | Description |
|-----------|-------------|
| **Profile ID** | Identifiant unique du profil (ex: `youtube-work`, `compte-pro`) |
| **Server URL** | URL du serveur WebSocket (défaut: `ws://127.0.0.1:3456`) |

### Modifier l'URL du serveur WebSocket

Si vous avez changé `WS_PORT` :
1. Cliquez sur l'icône Browser Pilot
2. Modifiez l'URL : `ws://127.0.0.1:VOTRE_PORT`
3. Cliquez sur "Reconnect"

---

## Dossiers de données

### Structure

```
browser-pilot/
├── mcp-server/
│   └── data/
│       ├── tests.db              # Base de données SQLite
│       ├── baselines/            # Screenshots de référence VRT
│       └── assertion-screenshots/# Screenshots d'assertions
└── scripts/
    └── launch-profile.sh

~/.browser-pilot/
└── profiles/
    ├── default/                  # Profil par défaut
    ├── youtube-work/            # Profil personnalisé
    └── ...
```

### Personnaliser le dossier des profils

Modifiez `scripts/launch-profile.sh` :

```bash
PROFILES_DIR="/chemin/personnalise/profiles"
```

---

## Options avancées

### Limite de caractères pour les snapshots

Dans `mcp-server/lib/tools/browser.js` :
- `MAX_SNAPSHOT_CHARS` : 30000 (par défaut)
- `MAX_MAPPING_CHARS` : 15000 (pour les screenshots)

### Timeout des commandes

Les commandes du navigateur ont un timeout implicite de 10 secondes pour l'attente d'éléments.

---

## Configuration Claude Code

### Ajouter le serveur MCP

```bash
claude mcp add browser-pilot node /chemin/vers/browser-pilot/mcp-server/server.js --stdio
```

### Voir les serveurs configurés

```bash
claude mcp list
```

### Supprimer le serveur

```bash
claude mcp remove browser-pilot
```

---

## Récapitulatif des fichiers de configuration

| Fichier | Usage |
|---------|-------|
| `claude_desktop_config.json` | Configuration Claude Desktop |
| `scripts/launch-profile.sh` | Lancement des profils Chrome |
| `mcp-server/data/tests.db` | Base de données des tests |
| `extension/dist/manifest.json` | Manifest de l'extension |
| `~/.browser-pilot/profiles/*` | Données Chrome des profils |

---
[< Previous: Architecture Details](file:///Library/Dev/browser-pilot/docs/architecture-details.md) | [Next: Security >](file:///Library/Dev/browser-pilot/docs/security.md)
