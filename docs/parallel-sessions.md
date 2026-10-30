# Sessions parallèles 🧵

Plusieurs agents peuvent piloter le navigateur **en même temps**, chacun dans sa propre
fenêtre Chrome, sans se marcher dessus.

## Le principe

**Une connexion MCP = une session = une fenêtre.**

Une session possède, à elle seule :

| Ce qui est isolé | Pourquoi ça compte |
|---|---|
| L'onglet de travail | Chaque commande est épinglée à l'onglet de la session. Un `click` sans `tabId` ne peut plus atterrir dans la fenêtre d'un autre agent. |
| La carte de refs (`@eX`) | Le `snapshot` de l'agent B n'écrase plus celui de l'agent A — qui, sinon, cliquait silencieusement sur le mauvais élément. |
| L'enregistrement en cours | Deux agents peuvent enregistrer deux tests simultanément sans que les steps s'entrelacent. |
| L'historique d'actions (`act_N`) | `fix_test_step` ne voit que les actions de sa propre session. |

Il n'y a **rien à faire** pour en profiter : chaque agent qui se connecte au serveur
obtient sa session automatiquement, et sa fenêtre s'ouvre au premier `navigate()`.

### `navigate()` d'abord, toujours

Une session **sans fenêtre refuse d'agir**. Un `snapshot` ou un `execute_js` avant le
premier `navigate()` échoue avec :

> This session has no window of its own yet, so there is no tab to act on. Call navigate()
> first — it opens one — or pass an explicit tabId to work in a tab that already exists.

Il n'y a volontairement **aucun repli sur l'onglet au premier plan** : cet onglet est soit
le travail d'un autre agent, soit la page que l'utilisateur est en train de lire. La
renvoyer à un agent divulguerait ce que l'utilisateur a sous les yeux.

Pour agir délibérément dans un onglet existant, passe un `tabId` explicite. `get_tabs()`
les liste avec le **propriétaire** de chacun :

| `owner` | Signification |
|---|---|
| ton id de session | ta fenêtre de travail |
| un autre id de session | un autre agent y travaille — n'y touche pas |
| `user` | un onglet de l'utilisateur — n'agis pas dessus sans qu'on te le demande |

### Les popups ouvertes par une page

Une fenêtre qu'une page de la session ouvre elle-même (`window.open`, « Continuer avec
Google ») **appartient à la session**. `click` renvoie son `newTabId`, avec lequel on la pilote,
et `get_tabs()` l'affiche avec le même `owner`, plus un champ `openedFrom` qui donne la fenêtre
de travail d'origine. Les commandes sans `tabId` restent dans la fenêtre de travail : elles ne
basculent jamais dans la popup.

- `close_window({ tabId: <onglet de la popup> })` ferme **seulement la popup**.
- `close_window()` ferme la fenêtre de travail **et les popups qu'elle a ouvertes**.

Une popup ouverte depuis une fenêtre de l'utilisateur reste à l'utilisateur. Après un rechargement
de l'extension, le serveur ne restitue que les fenêtres de travail : une popup encore ouverte
redevient `user` et se ferme à la main.

## Le cas particulier : plusieurs agents sur une seule connexion

Les sous-agents (`Task` dans Claude Code, par exemple) parlent tous à travers la connexion
MCP de leur parent. Pour eux, « une connexion = une session » ne suffit pas : ils
partageraient une seule fenêtre.

Chaque sous-agent choisit alors un nom de session distinct et le passe à chaque appel :

```js
open_session({ session: "recherche-A" })          // optionnel, informatif
navigate({ url: "https://exemple.fr", session: "recherche-A" })
snapshot({ purposeFilter: "click", session: "recherche-A" })
click({ ref: "@e5", session: "recherche-A" })
close_session({ name: "recherche-A" })            // ferme sa fenêtre
```

Un autre sous-agent fait la même chose avec `session: "recherche-B"` : deux fenêtres, deux
jeux de refs, aucune interférence.

### Outils de session

| Outil | Rôle |
|---|---|
| `open_session` | Réclame une session (ou décrit celle dans laquelle on se trouve déjà). |
| `list_sessions` | Liste les sessions actives et la fenêtre de chacune — pratique pour vérifier l'isolation. |
| `close_session` | Ferme une session nommée et sa fenêtre. |

Quand un agent se déconnecte, l'état de sa session est libéré mais **sa fenêtre reste
ouverte** : une reconnexion SSE arrive avec un nouvel identifiant, donc fermer
automatiquement détruirait une fenêtre de travail au moindre incident réseau. C'est
`close_window` (ou `close_session` pour une session nommée) qui ferme, explicitement, en
fin de tâche. Le serveur log les fenêtres laissées ouvertes.

## Le serveur est unique et partagé

IziTest Agent n'a qu'**un** pont WebSocket vers Chrome (port 3456) et **un** endpoint MCP
(port 3457). Un deuxième serveur ne peut pas fonctionner : il refuse de démarrer sur un
port déjà pris, plutôt que de tuer celui qui tourne.

Les agents ne démarrent donc jamais le serveur directement. Ils passent par :

```bash
node mcp-server/bin/ensure-server.js
```

qui démarre le serveur **seulement s'il n'est pas déjà là**, et qui est sûr quand plusieurs
processus l'appellent au même instant : un verrou exclusif désigne un seul démarreur, les
autres attendent que `/health` réponde. Les logs partent dans `mcp-server/data/server.log`.

Dans ce dépôt, un hook `SessionStart` (`.claude/settings.json`) l'appelle automatiquement.

Les clients se connectent ensuite en SSE :

```json
{
  "mcpServers": {
    "izitest-agent": { "type": "sse", "url": "http://127.0.0.1:3457/sse" }
  }
}
```

> **Le mode stdio (`server.js --stdio`) reste réservé à un agent unique.** Il démarre son
> propre pont WebSocket, donc deux agents en stdio se disputeraient le port 3456. Pour du
> parallèle, c'est SSE.

### `MCP_HOST` ajoute une interface, il n'en retire pas

Le serveur écoute **toujours** sur loopback. `MCP_HOST` ajoute une interface
supplémentaire (LAN, Tailscale) ; il ne remplace plus loopback.

Sans ça, `MCP_HOST=100.x.y.z` rendait le serveur injoignable depuis sa propre machine :
ni le tableau de bord, ni `.mcp.json`, ni le rechargement de l'extension ne pouvaient
l'atteindre. Ajouter loopback n'élargit rien — c'est la posture par défaut, accessible
seulement depuis la machine qui fait déjà tourner le navigateur piloté.

### Avec un jeton

Dès que `MCP_HOST` sort de la machine, `IZITEST_TOKEN` est obligatoire, et il est
exigé **sur les deux interfaces** (loopback comprise). Deux conséquences locales :

- `.mcp.json` doit porter l'en-tête — sans jamais écrire le secret dans le fichier :

  ```json
  "headers": { "Authorization": "Bearer ${IZITEST_TOKEN:-}" }
  ```

- `npm run build` dans `extension/` lit le même jeton depuis l'environnement pour pouvoir
  recharger l'extension.

Il faut donc que `IZITEST_TOKEN` soit exporté dans le shell où tournent Claude Code
et les builds — la même valeur que celle passée au serveur. Sinon le build affiche
« requires a token and IZITEST_TOKEN is not set in this shell » et l'outil MCP
répond 403.

## Recharger l'extension après un build

`npm run build` (et chaque rebuild de `npm run watch`) **recharge l'extension dans Chrome
tout seul** : le serveur pousse la demande sur le WebSocket qu'il tient déjà, et
l'extension s'auto-redémarre via `chrome.runtime.reload()`. Plus besoin de passer par
`chrome://extensions`.

```bash
cd extension && npm run build
# → Build complete!
# → [IziTest] Extension reloaded in Chrome (1 profile).
```

Le rechargement est **vérifié, pas supposé** : une extension rechargée lâche sa socket et
se réenregistre, et c'est ce réenregistrement que le serveur attend avant de répondre.
Une extension qui tourne sur une build antérieure à ce mécanisme ignore simplement le
message — le build le dit, au lieu d'annoncer un succès qui n'a pas eu lieu.

> **Amorçage** : le tout premier rechargement après l'arrivée de cette fonctionnalité doit
> se faire **à la main** dans `chrome://extensions`, puisque l'extension chargée ne connaît
> pas encore le message. Une seule fois ; ensuite elle se recharge seule.

Si le serveur n'est pas lancé, ou qu'aucune extension n'est connectée, le build affiche
quoi faire et **n'échoue jamais**. `IZITEST_NO_RELOAD=1` désactive le mécanisme.

Un redémarrage de l'extension vide `chrome.storage.session`, donc elle oublie quelle
fenêtre appartient à quelle session. Le serveur, lui, s'en souvient : dès que l'extension
se reconnecte, il lui **réattribue** les fenêtres de ses sessions (`restore_owned_windows`).
Sans ça, `close_window` refuserait ces fenêtres et la résolution d'onglet cesserait d'être
cloisonnée après chaque rebuild.

> Le rechargement coupe le WebSocket : une commande en vol est perdue. Évite donc de
> rebuilder pendant qu'un agent travaille.
>
> L'endpoint qui déclenche tout ça, `POST /api/dev/reload-extension`, suit le même régime
> que le reste de `/api/` : loopback par défaut, jeton requis dès que `MCP_HOST` sort de
> la machine.

## Voir ce que l'extension raconte

La console du service worker n'est visible qu'en ouvrant ses DevTools à la main, ce qui
rend un run de test aveugle à ce que l'extension signale. Elle renvoie donc tout ce qui
atterrirait dans la liste « Erreurs » de `chrome://extensions` au serveur :

```bash
curl -X DELETE http://127.0.0.1:3457/api/dev/extension-errors   # avant le run
curl        http://127.0.0.1:3457/api/dev/extension-errors      # après
```

Un run peut ainsi affirmer qu'il n'a produit **aucune** erreur d'extension, au lieu de
l'espérer. Les entrées de type `dead-tab` sont des rejets bénins (un onglet fermé entre
temps) : ils sont signalés ici mais tenus hors de la liste d'erreurs de Chrome.

## Ce qui n'est *pas* isolé

Les sessions partagent **le même profil Chrome**, donc les mêmes cookies et les mêmes
connexions. Deux sessions ne peuvent pas être authentifiées sur deux comptes différents du
même site.

Pour ça, il faut de vrais profils Chrome séparés — voir [multi-account.md](multi-account.md)
— et passer `profile: "<id>"` en plus de `session`.

## Vérifier que ça marche

```bash
cd mcp-server && npm test   # isolation, 5 sessions concurrentes, refus de l'onglet au premier plan
cd extension  && npm test   # registre des fenêtres sous concurrence, résolution d'onglet
```

En conditions réelles : lance deux agents, puis demande à l'un d'eux `list_sessions()`.
Deux lignes avec deux `window=` différents, c'est gagné.
