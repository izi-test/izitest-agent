# Iframes 🪟

IziTest Agent voit et pilote le contenu des iframes, y compris celles d'un autre site
(bannières de cookies tierces, champs de paiement, widgets intégrés).

## Ce qui marche

| | Même origine | Cross-origin |
|---|---|---|
| `snapshot` | ✅ contenu sous la ligne `[iframe]` | ✅ idem, iframes imbriquées comprises |
| `click` / `fill` par ref, sélecteur ou texte | ✅ | ✅ |
| `select` par ref ou sélecteur | ✅ | ✅ |
| `extract`, `wait` | ✅ | ✅ |
| Refus « covered by … » | ✅ dans la page et dans l'iframe | ✅ idem |
| `changes` du clic (dialogue apparu, etc.) | ✅ | ✅ préfixé `in iframe <adresse>:` |
| `screenshot` annoté | ✅ cadres placés sur l'iframe | ✅ idem |
| `execute_js` avec `frame` | ✅ | ✅ (sauf si la CSP de l'iframe interdit `eval`) |

Rien à faire côté agent : les refs `@eN` d'une iframe s'utilisent comme les autres, et un
sélecteur ou un texte est cherché dans la page, puis dans ses iframes.

La ligne `[iframe]` du snapshot affiche l'adresse de l'iframe (`src="…"`). `execute_js` vise
une iframe avec `frame` : sa ref (`frame: "@e4"`) ou un morceau de son adresse
(`frame: "account.idealo"`).

## Comment

- **Même origine** : le script de contenu de la page lit le document de l'iframe et ajoute
  son décalage (position, bordure, padding, imbrications) pour cliquer au bon endroit.
- **Cross-origin** : la page ne peut pas lire l'iframe. Le script de contenu y est injecté ;
  l'iframe fait son propre snapshot, numéroté à la suite de la page, fusionné sous sa ligne
  `[iframe]`. Comme une iframe ignore sa propre position, elle la demande à son parent par
  `postMessage` ; le parent répond aussi si un clic au point voulu atteindrait bien l'iframe
  (sinon : refus « covered by … »). On remonte ainsi jusqu'à la page.
- Le clic et la saisie partent toujours **au niveau de la page** : c'est le navigateur qui
  les achemine dans l'iframe, exactement comme pour un utilisateur (`isTrusted: true`).

## Limites

- **Rejouer un test enregistré dans une iframe** n'est pas pris en charge : l'étape garde un
  sélecteur valable dans l'iframe, et le moteur de replay cherche dans la page.
- Les iframes **invisibles** (pixels de suivi, 1×1) sont ignorées dans le snapshot.
- Une iframe où l'extension ne peut pas s'injecter (sandbox sans scripts, pages internes de
  Chrome) reste invisible.
- Le message de localisation passe par `postMessage` vers la page parente : ses propres
  scripts peuvent le voir passer (sans effet, comme pour les autres extensions qui en usent).
- reCAPTCHA est techniquement accessible, mais il est conçu pour détecter l'automatisation :
  ce n'est pas un cas d'usage, et rien ici ne cherche à le contourner.
