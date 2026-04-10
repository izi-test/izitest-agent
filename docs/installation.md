# Installation Guide 🛠️

Setting up Browser Pilot involves three main steps: the MCP server, the Chrome extension, and the AI agent (Claude) configuration.

## Prerequisites

- **Chrome Browser** installed.
- **Node.js** (v18 or higher) installed.
- **Claude Desktop** or **Claude Code** installed.

---

## 1. Setup MCP Server

The MCP server acts as the bridge between Claude and the Chrome extension.

```bash
cd mcp-server
npm install
```

To test if the server starts correctly:
```bash
node server.js
```
*Note: The server will normally be started automatically by Claude.*

---

## 2. Install Chrome Extension

1.  Open Chrome and navigate to `chrome://extensions/`.
2.  Enable **Developer Mode** (toggle in the top-right corner).
3.  Click **Load unpacked**.
4.  Select the `extension/` directory from the root of this project.
5.  Click the Browser Pilot icon in your toolbar to ensure it's active.
6.  (Optional) Set a `Profile ID` in the extension popup to identify this instance.

---

## 3. Configure Claude

### Option A: Claude Desktop (UI)

Add the following to your configuration file:
- **Mac**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "browser-pilot": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/browser-pilot/mcp-server/server.js", "--stdio"]
    }
  }
}
```

> **Important** : Le flag `--stdio` est obligatoire pour Claude Desktop. Il active le mode "standard input/output" nécessaire pour la communication avec Claude.

### Option B: Claude Code (CLI)

Run the following command in your terminal:

```bash
claude mcp add browser-pilot node /ABSOLUTE/PATH/TO/browser-pilot/mcp-server/server.js --stdio
```

> **Note** : Claude Code détecte automatiquement le mode approprié, mais le flag `--stdio` est recommandé pour la cohérence.

---

## 4. Configuration des ports (optionnel)

Par défaut, Browser Pilot utilise les ports suivants :
- **3456** : WebSocket (communication avec l'extension Chrome)
- **3457** : Serveur MCP en mode SSE (Server-Sent Events)

Si ces ports sont déjà utilisés, vous pouvez les configurer via des variables d'environnement :

```bash
export WS_PORT=3458      # Port WebSocket personnalisé
export MCP_PORT=3459     # Port MCP SSE personnalisé
```

> **Note** : En mode `--stdio` (Claude Desktop), le port MCP_PORT n'est pas utilisé car la communication se fait via stdin/stdout.

---

## 5. Lancer le serveur (mode standalone)

Si vous souhaitez tester le serveur indépendamment de Claude :

```bash
cd mcp-server

# Mode stdio (comme avec Claude Desktop)
node server.js --stdio

# Mode SSE avec interface web
node server.js
```

En mode SSE, l'interface web est accessible à `http://127.0.0.1:3457`.

---

## 6. Vérification

1.  Restart Claude Desktop or Claude Code.
2.  In the chat, ask: `"List the connected browser profiles"`.
3.  If successful, Claude should respond with a list including the profile you just configured.

---
[< Previous: Introduction](file:///Library/Dev/browser-pilot/docs/introduction.md) | [Next: Configuration >](file:///Library/Dev/browser-pilot/docs/configuration.md)
