# Vue en direct 📺

Voir depuis le Poste de pilotage ce que fait un agent dans son onglet, en direct et étape par
étape, sans le perturber.

## Routes

Toutes exigent le même jeton que le reste (`?token=…` ou `Authorization: Bearer …`). Elles
sont en lecture seule : GET uniquement, sauf le réglage.

| Route | Réponse |
|---|---|
| `GET /live/sessions` | Les sessions actives : `name`, `client` (nom et version annoncés par le client MCP), `windowId`, `tabs` (`tabId`, `url`, `title`, `active`, `viewers`, `recording`, `popup`), `lastAction` (`tool`, `at`, `endedAt`, `status`, `frameId`), `recording` (onglets enregistrés) |
| `GET /live/tabs/{tabId}/stream?fps=10` | Flux MJPEG (`multipart/x-mixed-replace`), utilisable tel quel dans un `<img src>` |
| `GET /live/frames/{frameId}.jpg` | Une image conservée |
| `GET /live/tabs/{tabId}/recording` | Les images de l'onglet depuis le début de sa session (JSON, avec `src` de chaque image) |
| `GET /live/tabs/{tabId}/recording?format=mjpeg&speed=4` | La même chose rejouée en MJPEG, au rythme d'origine (×`speed`, pauses coupées à 2 s) |
| `GET /live/settings` · `PUT /live/settings {"enabled": false}` | Le réglage qui coupe tout |
| `PUT /live/settings {"continuousRecording": false}` | Coupe seulement l'enregistrement continu |

## Le flux

- Une image à chaque changement d'écran, au plus `fps` par seconde (1 à 30, 10 par défaut),
  en JPEG qualité 60, 1280 px de large au plus.
- La première image arrive tout de suite, même si la page ne bouge pas.
- Au plus **2 spectateurs par onglet** : le troisième reçoit un `429`.
- Le flux s'arrête dès que le dernier spectateur se déconnecte.
- Un spectateur trop lent saute des images, mais reçoit toujours la dernière, celle qui montre
  l'écran actuel.
- Seuls les onglets des agents sont visibles : fenêtres ouvertes par IziTest Agent et popups
  ouvertes depuis elles. Un onglet de l'utilisateur répond `403`.

**Onglet en arrière-plan.** Chrome ne peint plus un onglet caché (autre onglet au premier
plan, fenêtre réduite ou recouverte), et le screencast se tait. L'extension capture alors
l'onglet au rythme demandé et n'envoie que les images qui diffèrent de la précédente. Le flux
continue donc sans rien mettre au premier plan.

## Dans le tableau de bord

Le tableau de bord montre ce flux à deux endroits.

- **Créer un test avec l'agent IA** : la fenêtre s'élargit dès que l'agent démarre. Le
  navigateur est à gauche, le journal de l'agent à droite. Le formulaire se replie en une
  ligne qui rappelle la demande ; il revient si l'agent échoue ou est arrêté, pour réessayer.
- **Exécuter un test** : le panneau des étapes s'élargit, avec le navigateur à côté. C'est la
  seule façon de voir une exécution headless.

À la fin, la dernière image reste affichée.

Le serveur dit quel onglet montrer dans le flux d'événements de la course, et le redit si
l'onglet change :

```json
{ "type": "live", "tabId": 123 }
```

- **Pour l'agent CLI** : il se connecte au serveur MCP avec l'identifiant de sa course
  (`/sse?run=run-…`). Les sessions qu'il ouvre portent cet identifiant, et le serveur suit
  l'onglet de celle qu'il a utilisée en dernier (`followRun` dans `lib/live.js`).
- **Pour l'agent interne du tableau de bord** : il reçoit l'identifiant directement.
- **Pour un test** : dès qu'une étape renvoie l'onglet où elle s'est jouée.

Le tableau de bord lit le flux avec `fetch`, pas avec un `<img>`, pour pouvoir dire pourquoi
il est refusé (vue en direct coupée, trop de spectateurs). En développement, le proxy de Vite
transmet `/live` en ajoutant le jeton, comme pour `/api`. Il compte comme l'un des
2 spectateurs de l'onglet.

## Une image par action

Après chaque `navigate`, `click`, `fill`, `select`, `keyboard` et `act`, l'image de l'onglet
est gardée une fois la page stabilisée (100 ms sans changement du DOM, 300 ms au plus). Son
identifiant revient dans le résultat :

```json
{ "success": true, "tag": "button", "changes": ["…"], "frameId": "mv9kgok0-33292a14c0a1" }
```

- Si l'action échoue, l'identifiant termine le message d'erreur : `… (frameId: mv9kgok0-…)`.
- `act` donne un `frameId` par étape et un dernier pour la page telle qu'il la laisse.
- Cela coûte environ 80 ms par action.

Ces images sont prises que quelqu'un regarde ou non : aucune étape ne manque.

## Enregistrement continu

Tant qu'une session a sa fenêtre de travail ouverte, son onglet est enregistré, même sans
spectateur.

- **Quoi** : une image à chaque changement d'écran, au plus 2 par seconde, en JPEG qualité 50,
  1280 px de large au plus. La dernière image d'une rafale est toujours gardée.
- **Rangement** : dans `/live/tabs/{tabId}/recording` avec `kind: "stream"`, mêlées aux images
  d'action.
- **Quels onglets** : l'onglet de travail de la session, l'onglet au premier plan de sa fenêtre
  (celui qu'un clic a ouvert, par exemple) et celui des popups ouvertes depuis elle. Pas les
  onglets de l'utilisateur.
- **Démarrage et arrêt** : l'enregistrement commence dès la première action, et la liste est
  revue toutes les 3 s. Il s'arrête quand la fenêtre se ferme ou que la session se termine ;
  ses images restent.
- **Limite par session** : les 300 images de flux les plus récentes
  (`IZITEST_LIVE_SESSION_MAX_FRAMES`), plus **toutes** les images d'action, qui ne sont
  jamais retirées par cette limite.
- **Coût** :
  - onglet visible : le screencast n'envoie rien tant que la page ne bouge pas ;
  - onglet caché : l'extension demande chaque demi-seconde à la page si quelque chose a
    changé (DOM, défilement, saisie, redimensionnement), et ne capture que dans ce cas, ou au
    plus toutes les 5 s (canvas, animations CSS) ;
  - les images identiques à la précédente ne sont pas gardées.
- **Avec un spectateur** : le même screencast sert les deux, en qualité 60 pour le spectateur ;
  la copie enregistrée est réencodée en qualité 50.

Quand l'enregistrement continu est coupé, un onglet regardé garde encore une image du flux par
seconde (`IZITEST_LIVE_RECORD_INTERVAL_MS`), comme avant.

Les images sont gardées **24 h** dans `mcp-server/data/live/` (20 000 au plus,
`IZITEST_LIVE_MAX_FRAMES`). L'enregistrement d'une session reste consultable 24 h après
sa fin.

## Lecture seule

- Tout passe par le protocole DevTools, sur la session de débogage que l'agent utilise déjà :
  `Page.startScreencast` et `Page.captureScreenshot`. Aucun onglet n'est activé, aucune
  fenêtre ne passe au premier plan ni ne change de propriétaire.
  (L'outil `screenshot`, lui, utilise `captureVisibleTab`, qui doit activer l'onglet.)
- Rien n'est dessiné sur la page : pas de cadre, pas de bandeau.
- Aucun snapshot n'est fait : les refs `@eX` de l'agent ne bougent pas.
- La seule chose posée dans l'onglet est un `MutationObserver` dans le monde isolé de
  l'extension, pour savoir quand la page est stable. La page ne le voit pas.

## Couper

- `PUT /live/settings {"enabled": false}` : arrête tous les flux, ne prend plus d'image
  après les actions, et toutes les routes `/live/*` répondent `503`. Le réglage est gardé en
  base et survit à un redémarrage. `{"enabled": true}` rallume.
- `IZITEST_LIVE=off` dans l'environnement du serveur : coupé, et impossible à
  rallumer sans redémarrer.
- `PUT /live/settings {"continuousRecording": false}` : coupe seulement l'enregistrement
  continu. Le flux en direct et les images d'action continuent. Le réglage est gardé en base.
  `IZITEST_LIVE_RECORD=off` le verrouille jusqu'au redémarrage.

Les images déjà gardées ne sont pas effacées ; elles disparaissent au bout de 24 h.

## CORS

Le Poste de pilotage tourne sur une autre origine. Avec un jeton, les GET sous `/live/`
répondent donc `Access-Control-Allow-Origin: *`. Ils exigent toujours le jeton et ne
modifient rien. Les autres routes gardent leur politique.

Sans jeton, seules les pages locales et les origines de `IZITEST_ALLOWED_ORIGINS` peuvent
lire `/live/` : ces images montrent les onglets de l'utilisateur, et n'importe quel site
ouvert dans le Chrome piloté pourrait sinon les lire. Un Poste de pilotage hébergé ailleurs
doit être ajouté à cette liste (`IZITEST_ALLOWED_ORIGINS=https://pilotage.example.com`).
Un `<img src>` sur le flux MJPEG, qui n'envoie pas d'`Origin`, s'affiche toujours. Voir
[security.md](security.md).

## Limites

- Les actions de l'agent autonome du tableau de bord (`agent-executor`) ne laissent pas encore
  d'image ; seuls les outils MCP le font.
- `scroll` ne laisse pas d'image (il n'est pas dans la liste demandée) ; le flux le montre.
- Le flux d'un onglet caché coûte une capture par période (`1/fps`) tant que quelqu'un
  regarde. Le screencast d'un onglet visible ne coûte rien quand la page ne bouge pas.
- Sur un onglet caché, un changement purement visuel (vidéo, canvas, animation CSS) n'est vu
  qu'à la capture de sécurité, toutes les 5 s.
- Après un redémarrage de l'extension, le flux reprend de lui-même dans les 5 s.
