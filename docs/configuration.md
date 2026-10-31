# Configuration ⚙️

Ce document décrit toutes les options de configuration disponibles pour IziTest Agent.

---

## Variables d'environnement

### Ports réseau

| Variable | Défaut | Description |
|----------|--------|-------------|
| `WS_PORT` | `3466` | Port WebSocket pour la communication avec l'extension Chrome |
| `MCP_PORT` | `3467` | Port HTTP/SSE pour le serveur MCP (mode non-stdio) |

**Exemple** :
```bash
export WS_PORT=3458
export MCP_PORT=3459
node mcp-server/server.js
```

### Accès et sécurité

| Variable | Défaut | Description |
|----------|--------|-------------|
| `MCP_HOST` | `127.0.0.1` | Interface d'écoute du serveur HTTP/SSE. Une interface autre que la boucle locale exige `IZITEST_TOKEN` |
| `IZITEST_TOKEN` | aucun | Jeton exigé sur toutes les routes (`Authorization: Bearer …` ou `?token=…`), sauf `/health` |
| `IZITEST_ALLOWED_ORIGINS` | aucune | Sans jeton : origines supplémentaires, séparées par des virgules, dont les pages peuvent lire les réponses du serveur (ex. un Poste de pilotage hébergé). Les pages locales passent toujours |

Voir [security.md](security.md).

### Vue en direct

| Variable | Défaut | Description |
|----------|--------|-------------|
| `IZITEST_LIVE` | activée | `off` coupe la vue en direct, sans possibilité de la rallumer avant le redémarrage |
| `IZITEST_LIVE_RECORD` | activé | `off` coupe l'enregistrement continu des sessions, sans possibilité de le rallumer avant le redémarrage |
| `IZITEST_LIVE_SESSION_MAX_FRAMES` | `300` | Images de flux gardées par session (les plus récentes ; les images d'action sont toutes gardées) |
| `IZITEST_LIVE_RECORD_INTERVAL_MS` | `1000` | Enregistrement continu coupé : écart entre deux images gardées pendant qu'un spectateur regarde |
| `IZITEST_LIVE_MAX_FRAMES` | `20000` | Nombre maximal d'images gardées (les plus anciennes partent d'abord) |
| `IZITEST_LIVE_DIR` | `mcp-server/data/live` | Dossier des images |

Voir [live-view.md](live-view.md).

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
    "izitest-agent": {
      "command": "node",
      "args": [
        "/CHEMIN/ABSOLU/vers/izitest-agent/mcp-server/server.js",
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
    "izitest-agent": {
      "command": "bash",
      "args": [
        "-c",
        "export WS_PORT=3458 && export MCP_PORT=3459 && node /chemin/vers/izitest-agent/mcp-server/server.js --stdio"
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
- `http://127.0.0.1:3467/` - Interface web
- `http://127.0.0.1:3467/sse` - Endpoint SSE pour MCP
- `http://127.0.0.1:3467/messages` - Messages MCP
- `http://127.0.0.1:3467/health` - Vérification d'état
- `http://127.0.0.1:3467/api/*` - API REST

**Avantages** :
- Interface web visuelle
- API REST pour intégrations externes
- Permet de monitorer les profils connectés

---

## Configuration de l'extension Chrome

### Paramètres du popup

Cliquez sur l'icône IziTest Agent dans Chrome pour configurer :

| Paramètre | Description |
|-----------|-------------|
| **Profile ID** | Identifiant unique du profil (ex: `youtube-work`, `compte-pro`) |
| **Server URL** | URL du serveur WebSocket (défaut: `ws://127.0.0.1:3466`) |

### Modifier l'URL du serveur WebSocket

Si vous avez changé `WS_PORT` :
1. Cliquez sur l'icône IziTest Agent
2. Modifiez l'URL : `ws://127.0.0.1:VOTRE_PORT`
3. Cliquez sur "Reconnect"

---

## Dossiers de données

### Structure

```
izitest-agent/
├── mcp-server/
│   └── data/
│       ├── tests.db              # Base de données SQLite
│       ├── baselines/            # Screenshots de référence VRT
│       └── assertion-screenshots/# Screenshots d'assertions
└── scripts/
    └── launch-profile.sh

~/.izitest/
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
claude mcp add izitest-agent node /chemin/vers/izitest-agent/mcp-server/server.js --stdio
```

### Voir les serveurs configurés

```bash
claude mcp list
```

### Supprimer le serveur

```bash
claude mcp remove izitest-agent
```

---

## Récapitulatif des fichiers de configuration

| Fichier | Usage |
|---------|-------|
| `claude_desktop_config.json` | Configuration Claude Desktop |
| `scripts/launch-profile.sh` | Lancement des profils Chrome |
| `mcp-server/data/tests.db` | Base de données des tests |
| `extension/dist/manifest.json` | Manifest de l'extension |
| `~/.izitest/profiles/*` | Données Chrome des profils |

---
[< Previous: Architecture Details](architecture-details.md) | [Next: Security >](security.md)
