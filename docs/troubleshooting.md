# Troubleshooting 🔧

Ce guide vous aide à résoudre les problèmes courants avec IziTest Agent.

---

## Problèmes de connexion

### "No profiles connected" / "Aucun profil connecté"

**Symptôme** : Claude répond qu'aucun profil n'est connecté.

**Causes possibles** :

0. **Chrome n'a pas le droit d'avoir des extensions** (poste d'entreprise)
   - Installez le navigateur sans fenêtre d'IziTest : *Settings → Headless browser → Install*
   - Sans Chrome avec l'extension, les agents y travaillent ; suivez-les dans la page *Live*

1. **L'extension Chrome n'est pas installée**
   - Vérifiez que l'extension est chargée dans `chrome://extensions/`
   - Activez le "Mode développeur" en haut à droite
   - Cliquez sur "Charger l'extension non empaquetée" et sélectionnez le dossier `extension/`

2. **L'extension n'est pas connectée au serveur**
   - Cliquez sur l'icône IziTest Agent dans la barre Chrome
   - Vérifiez que le statut affiche "Connected" (vert)
   - Si "Disconnected", cliquez sur "Reconnect"

3. **Le serveur WebSocket ne tourne pas**
   - Vérifiez que rien n'utilise le port 3466 :
   ```bash
   lsof -i :3466
   ```
   - Si occupé, changez de port : `export WS_PORT=3458`

4. **Pare-feu / antivirus**
   - Assurez-vous que localhost (127.0.0.1) n'est pas bloqué
   - Les ports 3466 et 3467 doivent être accessibles en local

---

## Erreurs MCP

### "MCP server not found" / Claude ne voit pas les outils

**Symptôme** : Les outils IziTest Agent n'apparaissent pas dans Claude.

**Solutions** :

1. **Vérifiez la configuration Claude Desktop** :
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
   > **Important** : Le flag `--stdio` est obligatoire !

2. **Redémarrez Claude Desktop** après modification de la config

3. **Vérifiez les permissions** :
   ```bash
   ls -la /chemin/vers/izitest-agent/mcp-server/server.js
   ```

4. **Testez le serveur manuellement** :
   ```bash
   cd mcp-server
   node server.js --stdio
   ```
   Vous devriez voir le serveur démarrer sans erreur.

### `self-signed certificate in certificate chain` à l'installation du navigateur sans fenêtre

Le réseau de l'entreprise inspecte HTTPS avec son propre certificat. Avec Node 22.15 / 23.8 ou plus
récent, IziTest fait confiance aux certificats du système. Sinon : `NODE_EXTRA_CA_CERTS` vers le
certificat racine de l'entreprise, ou un Chrome for Testing décompressé à la main et
`IZITEST_CHROME_PATH` ([installation](installation.md#5-replay-without-windows-optional)).

### Un clic « réussi » qui ne fait rien, puis l'étape suivante échoue

L'application affichait le bouton avant de savoir y répondre. Le rejeu attend maintenant qu'il soit
cliquable (rien par-dessus, immobile, actif) et reclique une fois si le premier clic n'a rien changé.
Un lien qui tient sur deux lignes (un nom long dans un tableau) est cliqué au milieu de sa première
ligne : le milieu de son cadre tombait entre les deux, sur la cellule autour.
Si l'étape échoue encore avec « Not clicked: … covered by … », augmentez le délai d'attente du projet.

### « Concurrent Sessions Exceeded »

L'application limite le nombre de sessions ouvertes par compte, et vider les cookies ne ferme pas une
session côté serveur. Terminez chaque test qui se connecte par une déconnexion : une étape métier
(« je me déconnecte de … ») ou des étapes dont l'intention le dit (« Se déconnecter », « Log out »).
Quand le test échoue avant elle, le rejeu la joue quand même, dans l'onglet du test, après le
diagnostic : le rapport montre ces étapes jouées après l'échec, et le verdict reste l'échec.

### « Access Denied » sur la page de connexion au rejeu

L'application refuse la page de connexion à qui a déjà une session. Dans le navigateur sans fenêtre,
chaque test part déconnecté : vérifiez que *Projects → Edit → Each test starts logged out* est coché.
Dans votre Chrome, rien n'est nettoyé : déconnectez-vous de l'application avant le rejeu.

### "Command failed" / Les actions ne fonctionnent pas

**Symptôme** : Les commandes comme `navigate` ou `click` échouent.

**Vérifications** :

1. **Le navigateur est-il ouvert ?** IziTest Agent contrôle une instance Chrome existante
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

3. **Vérifiez les iframes** : IziTest Agent ne peut pas accéder aux éléments dans des iframes cross-origin

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
1. Si l'erreur dit « not found within 10 s » et que la page met du temps à charger, augmentez le
   délai d'attente du projet : *Projects → Edit → Wait for an element* (10 s par défaut, jusqu'à
   120 s)
2. Utilisez `fix_test_step` pour mettre à jour l'étape problématique
3. Ajoutez une étape `wait` avant l'étape qui échoue
4. Utilisez `add_assertion` pour vérifier l'état avant de continuer

### « Cannot find context with specified id » dans une vérification

**Symptôme** : une vérification juste après un clic qui change de page échoue avec
`Error: Protocol error (Runtime.evaluate): {"code":-32000,"message":"Cannot find context with specified id"}`.

**Cause** : la connexion gardée pour l'onglet pointait encore vers la page d'avant. Depuis cette
version, `execute_js` (qui sert aussi aux vérifications) se reconnecte à la page et relance la
lecture, comme le font déjà les actions du rejeu. Reconstruisez l'extension
(`npm --prefix extension run build`) et, sans fenêtre, redémarrez le Chrome headless.

### Une étape sans locators échoue tout de suite (« Element not found », « is covered »)

Une étape enregistrée avec seulement un sélecteur ou un texte, sans locators, attend maintenant
comme les autres : jusqu'au délai du projet (10 s par défaut), tant que son élément n'est pas
encore là ou qu'un voile de chargement le couvre. Si elle échoue encore après ce délai, son
sélecteur ne correspond à rien sur la page : corrigez l'étape (`fix_test_step`, ou choisissez un
élément du projet dans l'éditeur d'étape).

### Un clic sur un lien de menu « réussit » mais la page ne change pas

Sur une page qui finit de se dessiner, le premier clic peut être perdu alors que le DOM bouge
encore. Pour un lien vers une autre page, le rejeu ne compte plus que l'ouverture de cette page
comme effet du clic. Sans elle, il reclique une fois.

Si l'étape passe quand même par « variable », le clic a été enregistré comme le choix d'un
élément de liste (variable `list_item`). Ce chemin ne fait pas ces contrôles. Pour un menu, ce
n'est pas une donnée du test : retirez la variable de l'étape pour qu'elle soit jouée par ses
locators. Les enregistrements faits depuis cette version ne font plus de variable d'un clic dans
un menu, une barre d'onglets ou un menu latéral : seuls les tests plus anciens en ont.

### Un clic part sur un autre élément qui porte le même texte

Les locators d'une étape cherchent tous en même temps. Un texte (« chocolat ») peut être sur la page
avant l'élément voulu (la liste de suggestions pas encore ouverte). Désormais, un locator moins
précis trouvé en premier attend jusqu'à 1 s un locator plus précis (CSS, test ID, attribut, nom
accessible) encore en recherche, et c'est lui qui est pris s'il arrive. Le rapport dit par quel
locator l'étape a été trouvée (« via css », « via text ») : un clic « via text » sur une étape qui a
un sélecteur précis mérite un coup d'œil.

### Une vérification de fin de test échoue alors qu'elle passait à l'enregistrement

Les vérifications sont toutes à la fin du test, après plusieurs actions. À l'enregistrement, l'agent
laissait à chaque page le temps de se charger ; au rejeu, les actions s'enchaînent, et une action
peut interrompre le chargement amené par la précédente (un onglet cliqué juste après un autre). La
capture de l'échec montre la page telle qu'elle était.

Placez chaque vérification juste après l'action dont elle vérifie le résultat (onglet *Steps* du
test, boutons *Move up* / *Move down*) : au rejeu, elle attend là que ce qu'elle vérifie apparaisse avant l'action
suivante. Les agents le font désormais pendant l'enregistrement.

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
curl http://127.0.0.1:3467/health

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
pkill -f "izitest-agent"

# 3. Vérifiez les ports
lsof -i :3466,3467

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
   - Sortie de `curl http://127.0.0.1:3467/health`
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
[< Previous: Security](security.md) | [Next: Usage >](usage.md)
