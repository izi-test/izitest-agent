# Troubleshooting 🔧

Ce guide vous aide à résoudre les problèmes courants avec Browser Pilot.

---

## Problèmes de connexion

### "No profiles connected" / "Aucun profil connecté"

**Symptôme** : Claude répond qu'aucun profil n'est connecté.

**Causes possibles** :

1. **L'extension Chrome n'est pas installée**
   - Vérifiez que l'extension est chargée dans `chrome://extensions/`
   - Activez le "Mode développeur" en haut à droite
   - Cliquez sur "Charger l'extension non empaquetée" et sélectionnez le dossier `extension/`

2. **L'extension n'est pas connectée au serveur**
   - Cliquez sur l'icône Browser Pilot dans la barre Chrome
   - Vérifiez que le statut affiche "Connected" (vert)
   - Si "Disconnected", cliquez sur "Reconnect"

3. **Le serveur WebSocket ne tourne pas**
   - Vérifiez que rien n'utilise le port 3456 :
   ```bash
   lsof -i :3456
   ```
   - Si occupé, changez de port : `export WS_PORT=3458`

4. **Pare-feu / antivirus**
   - Assurez-vous que localhost (127.0.0.1) n'est pas bloqué
   - Les ports 3456 et 3457 doivent être accessibles en local

---

## Erreurs MCP

### "MCP server not found" / Claude ne voit pas les outils

**Symptôme** : Les outils Browser Pilot n'apparaissent pas dans Claude.

**Solutions** :

1. **Vérifiez la configuration Claude Desktop** :
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
   > **Important** : Le flag `--stdio` est obligatoire !

2. **Redémarrez Claude Desktop** après modification de la config

3. **Vérifiez les permissions** :
   ```bash
   ls -la /chemin/vers/browser-pilot/mcp-server/server.js
   ```

4. **Testez le serveur manuellement** :
   ```bash
   cd mcp-server
   node server.js --stdio
   ```
   Vous devriez voir le serveur démarrer sans erreur.

### "Command failed" / Les actions ne fonctionnent pas

**Symptôme** : Les commandes comme `navigate` ou `click` échouent.

**Vérifications** :

1. **Le navigateur est-il ouvert ?** Browser Pilot contrôle une instance Chrome existante
2. **Le bon profil est-il sélectionné ?** Utilisez `list_profiles` pour vérifier
3. **La page est-elle chargée ?** Attendez que la page charge avant d'interagir

---

## Problèmes avec les éléments

### "Element not found" / Élément introuvable

**Symptôme** : Claude ne trouve pas un élément qui semble visible.

**Solutions** :

1. **Utilisez le protocole de découverte** :
   - Commencez toujours par un `screenshot()` pour voir les éléments annotés
   - Utilisez les références `@eX` plutôt que les sélecteurs CSS

2. **Attendez le chargement** :
   ```
   "Attends que .mon-element apparaisse"
   ```

3. **Vérifiez les iframes** : Browser Pilot ne peut pas accéder aux éléments dans des iframes cross-origin

4. **Éléments dynamiques** : Utilisez `snapshot(includeHidden=true)` pour les menus déroulants, modals, etc.

### Les clics ne fonctionnent pas

**Symptôme** : Le click semble réussir mais rien ne se passe.

**Causes** :
- L'élément peut être recouvert par un overlay
- L'élément nécessite un clic spécifique (double-clic, clic droit)
- C'est un élément custom (React, Vue) qui nécessite un event spécifique

**Solutions** :
```javascript
// Utilisez execute_js pour un clic précis
"Exécute ce JavaScript : document.querySelector('.mon-bouton').dispatchEvent(new MouseEvent('click', {bubbles: true}))"
```

---

## Problèmes de tests enregistrés

### "Test not found"

**Symptôme** : Impossible de charger un test sauvegardé.

**Vérifications** :
```bash
# Vérifiez la base de données
ls -la mcp-server/data/
```

La base SQLite devrait exister. Si elle est corrompue, vous pouvez la recréer :
```bash
rm mcp-server/data/tests.db
cd mcp-server && node -e "require('./lib/db.js').initDatabase()"
```

### Le test échoue à une étape spécifique

**Symptôme** : Un test fonctionnait avant mais échoue maintenant.

**Causes courantes** :
- La structure du site a changé
- Un popup/cookie banner bloque l'interaction
- Le site charge plus lentement

**Solutions** :
1. Utilisez `fix_test_step` pour mettre à jour l'étape problématique
2. Ajoutez une étape `wait` avant l'étape qui échoue
3. Utilisez `add_assertion` pour vérifier l'état avant de continuer

---

## Problèmes de performance

### Les commandes sont lentes

**Causes** :
- Trop d'onglets ouverts
- Chrome surcharge
- Le site web est lent

**Optimisations** :
- Fermez les onglets inutiles
- Utilisez `snapshot(compact=true)` pour réduire la taille des données
- Limitez la profondeur avec `maxDepth` dans snapshot

---

## Diagnostics avancés

### Vérifier l'état du système

```bash
# 1. Vérifier le serveur WebSocket
curl http://127.0.0.1:3457/health

# 2. Vérifier les profils connectés
# Dans Claude : "Liste les profils connectés"

# 3. Vérifier les logs
# Dans le dossier mcp-server, consultez les erreurs dans la console
```

### Mode debug

Pour voir les communications en temps réel :

```bash
cd mcp-server
DEBUG=* node server.js --stdio
```

### Réinitialisation complète

Si tout semble bloqué :

```bash
# 1. Arrêtez Claude Desktop

# 2. Tuez les processus en cours
killall "Google Chrome"
pkill -f "browser-pilot"

# 3. Vérifiez les ports
lsof -i :3456,3457

# 4. Redémarrez Chrome avec le profil
./scripts/launch-profile.sh default

# 5. Réinstallez l'extension si nécessaire

# 6. Redémarrez Claude Desktop
```

---

## Obtenir de l'aide

Si le problème persiste :

1. **Collectez les informations** :
   - Version de Chrome (`chrome://version`)
   - Sortie de `curl http://127.0.0.1:3457/health`
   - Messages d'erreur exacts

2. **Vérifiez les logs** :
   - Console Claude Desktop (Help > Toggle Developer Tools)
   - Console du navigateur Chrome (F12)
   - Console du service worker de l'extension (`chrome://extensions/` > Service Worker)

3. **Testez minimal** :
   - Un seul profil
   - Une seule page simple (ex: example.com)
   - Une seule commande (`navigate`)

---
[< Previous: Security](file:///Library/Dev/browser-pilot/docs/security.md) | [Next: Usage >](file:///Library/Dev/browser-pilot/docs/usage.md)
