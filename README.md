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
      "args": ["/chemin/absolu/vers/browser-pilot/mcp-server/server.js"]
    }
  }
}
```

#### Option B : Claude Code

```bash
claude mcp add browser-pilot node /chemin/absolu/vers/browser-pilot/mcp-server/server.js
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




@e1 [banner]
  @e2 [link] "Navigation überspringen" href="#av-wlhf-skip-link-target"
  @e3 [link] "SeLoger Homepage" href="https://www.seloger.com/"
  @e4 [navigation] "Menu de navigation"
    @e5 [list]
      @e6 [listitem]
        @e7 [button] "Acheter" [expanded=false]
      @e8 [listitem]
        @e9 [button] "Louer" [expanded=false]
      @e10 [listitem]
        @e11 [button] "Construire" [expanded=false]
      @e12 [listitem]
        @e13 [button] "Bureaux & Commerces" [expanded=false]
      @e14 [listitem]
        @e15 [button] "Emprunter" [expanded=false]
      @e16 [listitem]
        @e17 [button] "Déménager" [expanded=false]
      @e18 [listitem]
        @e19 [button] "Vendre" [expanded=false]
  @e20 [link] "Déposer une annonce" href="https://www.seloger.com/dep..."
    @e21 [generic] "Déposer une annonce"
  @e22 [button] "Se connecter"
    @e23 [generic] "Se connecter"
  @e24 [generic]
@e25 [main]
  @e26 [img] "Vous avez les clés !" alt="Vous avez les clés !"
  @e27 [heading] "Vous avez les clés !" [level=1]
  @e28 [tablist]
    @e29 [presentation]
    @e30 [tab] "AcheterAcheter" [selected=true]
      @e31 [generic] "Acheter"
    @e32 [tab] "LouerLouer" [selected=false]
      @e33 [generic] "Louer"
    @e34 [tab] "EstimerEstimer" [selected=false]
      @e35 [generic] "Estimer"
  @e36 [tabpanel] "AcheterAcheter"
    @e37 [combobox] "Saisir le lieu ou le code postal" type="text" placeholder="Saisir le lieu ou le code postal" [expanded=false]
  @e38 [generic] "Nos services dédiés :"
  @e39 [button] "Estimer votre bien"
    @e40 [generic] "Estimer votre bien"
  @e41 [button] "Déposer une annonce"
    @e42 [generic] "Déposer une annonce"
  @e43 [button] "Carte des prix de l'immo"
    @e44 [generic] "Carte des prix de l'immo"
  @e45 [link] "Voir plus de biens" href="https://www.seloger.com/mon..."
  @e46 [region]
    @e47 [group] "1 sur 11"
      @e48 [link] "Maison à vendre - Montigny-le-Bretonneux - 399 000 € - 5 pièces, 4 chambres, ..." href="https://www.seloger.com/ann..."
      @e49 [generic] "Image principale"
        @e50 [group] "1 sur 10"
          @e51 [img] "Maison à vendre 399 000 € 5 pièces 4 chambres 100 m² 94 m² de terrain Le Plan..." alt="Maison à vendre 399 000 € 5 pièces 4 chambres 100 m² 94 m² de terrain Le Plan..."
      @e52 [generic] "D"
      @e53 [generic] "399000 €"
        @e54 [generic] "3 990 €/m²"
      @e55 [generic] "Maison à vendre"
      @e56 [generic] "5 pièces"
      @e57 [generic] "·"
      @e58 [generic] "4 chambres"
      @e59 [generic] "·"
      @e60 [generic] "100 m²"
      @e61 [generic] "·"
      @e62 [generic] "94 m² de terrain"
      @e63 [generic] "Le Plan de l'Église, Montigny-le-Bretonneux (78180)"
      @e64 [button] "Ajouter aux favoris"
      @e65 [link] "Maison à vendre - Massy - 469 000 € - 8 pièces, 5 chambres, 161,9 m², 365 m² ..." href="https://www.seloger.com/ann..."
      @e66 [generic] "Image principale"
        @e67 [group] "1 sur 16"
          @e68 [img] "Maison à vendre 469 000 € 8 pièces 5 chambres 161,9 m² 365 m² de terrain Mass..." alt="Maison à vendre 469 000 € 8 pièces 5 chambres 161,9 m² 365 m² de terrain Mass..."
      @e69 [generic] "D"
      @e70 [generic] "469000 €"
        @e71 [generic] "2 897 €/m²"
      @e72 [generic] "Maison à vendre"
      @e73 [generic] "8 pièces"
      @e74 [generic] "·"
      @e75 [generic] "5 chambres"
      @e76 [generic] "·"
      @e77 [generic] "161,9 m²"
      @e78 [generic] "·"
      @e79 [generic] "365 m² de terrain"
      @e80 [generic] "Massy (91300)"
      @e81 [button] "Ajouter aux favoris"
      @e82 [link] "Maison à vendre - Massy - 468 000 € - 5 pièces, 4 chambres, 106 m², 152 m² de..." href="https://www.seloger.com/ann..."
      @e83 [generic] "Image principale"
        @e84 [group] "1 sur 12"
          @e85 [img] "Maison à vendre 468 000 € 5 pièces 4 chambres 106 m² 152 m² de terrain Massy ..." alt="Maison à vendre 468 000 € 5 pièces 4 chambres 106 m² 152 m² de terrain Massy ..."
      @e86 [generic] "C"
      @e87 [generic] "468000 €"
        @e88 [generic] "4 415 €/m²"
      @e89 [generic] "Maison à vendre"
      @e90 [generic] "5 pièces"
      @e91 [generic] "·"
      @e92 [generic] "4 chambres"
      @e93 [generic] "·"
      @e94 [generic] "106 m²"
      @e95 [generic] "·"
      @e96 [generic] "152 m² de terrain"
      @e97 [generic] "Massy (91300)"
      @e98 [button] "Ajouter aux favoris"
      @e99 [link] "Maison à vendre - Wissous - 429 000 € - 6 pièces, 4 chambres, 129,3 m²" href="https://www.seloger.com/ann..."
      @e100 [generic] "Image principale"
        @e101 [group] "1 sur 14"
          @e102 [img] "Maison à vendre 429 000 € 6 pièces 4 chambres 129,3 m² Wissous 91320" alt="Maison à vendre 429 000 € 6 pièces 4 chambres 129,3 m² Wissous 91320"
      @e103 [generic] "D"
      @e104 [generic] "429000 €"
        @e105 [generic] "3 317 €/m²"
      @e106 [generic] "Maison à vendre"
      @e107 [generic] "6 pièces"
      @e108 [generic] "·"
      @e109 [generic] "4 chambres"
      @e110 [generic] "·"
      @e111 [generic] "129,3 m²"
      @e112 [generic] "Wissous (91320)"
      @e113 [button] "Ajouter aux favoris"
    @e114 [group] "2 sur 11"
      @e115 [link] "Maison à vendre - Palaiseau - 475 000 € - 7 pièces, 4 chambres, 111 m², 127 m..." href="https://www.seloger.com/ann..."
      @e116 [generic] "Image principale"
        @e117 [group] "1 sur 11"
          @e118 [img] "Maison à vendre 475 000 € 7 pièces 4 chambres 111 m² 127 m² de terrain Centre..." alt="Maison à vendre 475 000 € 7 pièces 4 chambres 111 m² 127 m² de terrain Centre..."
      @e119 [generic] "B"
      @e120 [generic] "475000 €"
        @e121 [generic] "4 279 €/m²"
      @e122 [generic] "Maison à vendre"
      @e123 [generic] "7 pièces"
      @e124 [generic] "·"
      @e125 [generic] "4 chambres"
      @e126 [generic] "·"
      @e127 [generic] "111 m²"
      @e128 [generic] "·"
      @e129 [generic] "127 m² de terrain"
      @e130 [generic] "Centre Sud, Palaiseau (91120)"
      @e131 [button] "Ajouter aux favoris"
    @e132 [button] "Précédent" [disabled]
    @e133 [button] "Suivant"
  @e134 [generic] "Vos tendances immo"
  @e135 [generic] "mars 2026"
  @e136 [button] "AntonyPrix immobilier par m²4 993 €5 358 €"
    @e137 [generic] "Antony"
    @e138 [generic] "Prix immobilier par m²"
    @e139 [generic] "4 993 €"
    @e140 [generic] "5 358 €"
  @e141 [button] "MarseillePrix immobilier par m²3 518 €4 667 €"
    @e142 [generic] "Marseille"
    @e143 [generic] "Prix immobilier par m²"
    @e144 [generic] "3 518 €"
    @e145 [generic] "4 667 €"
  @e146 [button] "Montigny-le-BretonneuxPrix immobilier par m²4 268 €4 170 €"
    @e147 [generic] "Montigny-le-Bretonneux"
    @e148 [generic] "Prix immobilier par m²"
    @e149 [generic] "4 268 €"
    @e150 [generic] "4 170 €"
  @e151 [button] "ToulousePrix immobilier par m²3 507 €4 077 €"
    @e152 [generic] "Toulouse"
    @e153 [generic] "Prix immobilier par m²"
    @e154 [generic] "3 507 €"
    @e155 [generic] "4 077 €"
  @e156 [button] "LillePrix immobilier par m²3 370 €3 493 €"
    @e157 [generic] "Lille"
    @e158 [generic] "Prix immobilier par m²"
    @e159 [generic] "3 370 €"
    @e160 [generic] "3 493 €"
  @e161 [img] "Découvrez les prix de l'immobilier en France" alt="Découvrez les prix de l'immobilier en France"
  @e162 [generic] "Restez informé !"
  @e163 [heading] "Découvrez les prix de l'immobilier en France" [level=2]
  @e164 [generic] "Utilisez la carte des prix de SeLoger pour obtenir facilement des information..."
  @e165 [link] "Explorer la carte des prix" href="/prix-de-l-immo/vente/pays/..."
    @e166 [generic] "Explorer la carte des prix"
  @e167 [img] "Vendez vous-même un bien immobilier sur SeLoger" alt="Vendez vous-même un bien immobilier sur SeLoger"
  @e168 [generic] "100% gratuit"
  @e169 [heading] "Vendez vous-même un bien immobilier sur SeLoger" [level=2]
  @e170 [generic] "Présentez votre bien et ses caractéristiques"
  @e171 [generic] "Définissez le prix de vente de votre maison ou appartement"
  @e172 [generic] "Mettez en avant ce qui le rend unique"
  @e173 [link] "Déposer une annonce" href="/depot-annonce/?m=homepage_..."
    @e174 [generic] "Déposer une annonce"
  @e175 [heading] "Nos meilleurs partenaires pour vos projets" [level=2]
  @e176 [region]
    @e177 [group] "1 sur 2"
      @e178 [img] "Le n°1 des courtiers immobiliers en ligne" alt="Le n°1 des courtiers immobiliers en ligne"
      @e179 [generic] "Le n°1 des courtiers immobiliers en ligne"
      @e180 [generic] "Pretto vous accompagne dans tous vos projets immobiliers, de la recherche de ..."
      @e181 [button] "Simulez votre prêt"
        @e182 [generic] "Simulez votre prêt"
      @e183 [img] "Vous déménagez ? Restez zen, Nextories s’occupe de tout" alt="Vous déménagez ? Restez zen, Nextories s’occupe de tout"
      @e184 [generic] "Vous déménagez ? Restez zen, Nextories s’occupe de tout"
      @e185 [generic] "Comparez les meilleurs déménageurs avec Nextories, la plateforme de référence..."
      @e186 [button] "Obtenez votre devis"
        @e187 [generic] "Obtenez votre devis"
      @e188 [img] "Réalisez vos projets avec Sofinco" alt="Réalisez vos projets avec Sofinco"
      @e189 [generic] "Réalisez vos projets avec Sofinco"
      @e190 [generic] "Rénover votre logement, redécorer, ou aménager votre intérieur ? Sofinco vous..."
      @e191 [button] "Simulez votre projet"
        @e192 [generic] "Simulez votre projet"
      @e193 [img] "Transformez votre maison avec la lumière naturelle" alt="Transformez votre maison avec la lumière naturelle"
      @e194 [generic] "Transformez votre maison avec la lumière naturelle"
      @e195 [generic] "Redécouvrez votre espace de vie : VELUX, la lumière naturelle et l’air frais ..."
      @e196 [button] "Découvrir"
        @e197 [generic] "Découvrir"
    @e198 [button] "Précédent" [disabled]
    @e199 [button] "Suivant"
  @e200 [img] "Parlons assurance de prêt, les experts Cardif vous accompagnent !" alt="Parlons assurance de prêt, les experts Cardif vous accompagnent !"
  @e201 [heading] "Parlons assurance de prêt, les experts Cardif vous accompagnent !" [level=2]
  @e202 [generic] "Les conseillers Cardif vous aident à choisir les garanties les mieux adaptées..."
  @e203 [link] "En savoir plus" href="https://edito.seloger.com/p..."
    @e204 [generic] "En savoir plus"
  @e205 [heading] "SeLoger vous soutient dans vos projets" [level=2]
  @e206 [list]
    @e207 [listitem]
      @e208 [link] "Guide de l’acheteurComment trouver le logement de vos rêves ? Définir votre b..." href="https://edito.seloger.com/c..."
        @e209 [generic] "Guide de l’acheteur"
        @e210 [generic] "Comment trouver le logement de vos rêves ? Définir votre budget ?"
        @e211 [generic] "Découvrir"
    @e212 [listitem]
      @e213 [link] "Guide du locataireComment trouver le logement de vos rêves ? Définir votre bu..." href="https://edito.seloger.com/c..."
        @e214 [generic] "Guide du locataire"
        @e215 [generic] "Comment trouver le logement de vos rêves ? Définir votre budget ?"
        @e216 [generic] "Découvrir"
    @e217 [listitem]
      @e218 [link] "Guide du vendeurConnaître les prix du marché, passer par un professionnel ou ..." href="https://edito.seloger.com/c..."
        @e219 [generic] "Guide du vendeur"
        @e220 [generic] "Connaître les prix du marché, passer par un professionnel ou non..."
        @e221 [generic] "Découvrir"
    @e222 [listitem]
      @e223 [link] "Checklist déménagementVous ne savez toujours pas par où commencer ?Découvrir" href="https://edito.seloger.com/c..."
        @e224 [generic] "Checklist déménagement"
        @e225 [generic] "Vous ne savez toujours pas par où commencer ?"
        @e226 [generic] "Découvrir"
  @e227 [generic] "Les dernières nouveautés"
  @e228 [link] "Tous les articles" href="https://edito.seloger.com/"
    @e229 [generic] "Tous les articles"
  @e230 [link] "news.title" href="https://edito.seloger.com/l..."
    @e231 [img] "news.title" alt="news.title"
  @e232 [generic] "Succession immobilière : 7 solutions concrètes pour protéger vos proches et é..."
  @e233 [link] "news.title" href="https://edito.seloger.com/t..."
    @e234 [img] "news.title" alt="news.title"
  @e235 [generic] "Manque de lumière chez vous ? Voici les erreurs déco qui assombrissent les pi..."
  @e236 [link] "news.title" href="https://edito.seloger.com/c..."
    @e237 [img] "news.title" alt="news.title"
  @e238 [generic] "Ces erreurs déco qui donnent envie de repartir… dès les premières secondes de..."
  @e239 [generic] "Les meilleures annonces partent vite. Soyez le premier sur le coup !"
  @e240 [generic] "Alertes personnalisées, estimation de votre bien, messagerie et plus encore !"
  @e241 [generic] "Scannez avec votre appareil pour télécharger notre application"
  @e242 [generic] "4,8 sur 5 sur l’App Store et Google Play"
  @e243 [link] "Bouton de téléchargement vers l'Apple Store" href="https://seloger.go.link?adj..."
  @e244 [link] "Bouton de téléchargement vers le Google Store" href="https://seloger.go.link?adj..."
  @e245 [img] "phone Image" alt="phone Image"
  @e246 [heading] "SeLoger, c'est aussi..." [level=2]
  @e247 [list]
    @e248 [listitem]
      @e249 [link] "SeLoger neuf logo" href="https://www.selogerneuf.com/"
    @e250 [listitem]
      @e251 [link] "SeLoger construire logo" href="https://www.seloger-constru..."
    @e252 [listitem]
      @e253 [link] "SeLoger bureaux & commerces logo" href="https://www.seloger-bureaux..."
    @e254 [listitem]
      @e255 [link] "Belles demeures logo" href="https://www.bellesdemeures...."
  @e256 [tablist]
    @e257 [presentation]
    @e258 [tab] "Par localitésPar localités" [selected=true]
      @e259 [generic] "Par localités"
    @e260 [tab] "Par types de bienPar types de bien" [selected=false]
      @e261 [generic] "Par types de bien"
    @e262 [tab] "Par commoditésPar commodités" [selected=false]
      @e263 [generic] "Par commodités"
    @e264 [tab] "Estimation & PrixEstimation & Prix" [selected=false]
      @e265 [generic] "Estimation & Prix"
  @e266 [tabpanel] "Par localitésPar localités"
    @e267 [link] "Tout l’immobilier" href="https://www.seloger.com/imm..."
      @e268 [generic] "Tout l’immobilier"
    @e269 [link] "L’immobilier par régions" href="https://www.seloger.com/imm..."
      @e270 [generic] "L’immobilier par régions"
    @e271 [link] "Immobilier par départements" href="https://www.seloger.com/imm..."
      @e272 [generic] "Immobilier par départements"
    @e273 [link] "Immobilier par villes" href="https://www.seloger.com/imm..."
      @e274 [generic] "Immobilier par villes"
  @e275 [link] "Aide & FAQ" href="https://aide.seloger.com/s/..."
    @e276 [generic] "Aide & FAQ"
@e277 [contentinfo]
  @e278 [navigation] "Navigation en bas de page"
    @e279 [generic] "L'entreprise"
    @e280 [list]
      @e281 [listitem]
        @e282 [link] "Qui sommes-nous ?" href="https://www.groupeseloger.com/"
      @e283 [listitem]
        @e284 [link] "Besoin d’aide ?" href="https://aide.seloger.com"
      @e285 [listitem]
        @e286 [link] "Nous recrutons" href="https://careers.smartrecrui..."
      @e287 [listitem]
        @e288 [link] "Notre espace presse" href="https://aviv-brand.seloger...."
    @e289 [generic] "Services pro"
    @e290 [list]
      @e291 [listitem]
        @e292 [link] "Tous nos services pro" href="https://pro.groupeseloger.com/"
      @e293 [listitem]
        @e294 [link] "Accès client" href="https://www.myselogerpro.com/"
    @e295 [generic] "À découvrir"
    @e296 [list]
      @e297 [listitem]
        @e298 [link] "Annuaire des professionnels" href="https://www.seloger.com/ann..."
      @e299 [listitem]
        @e300 [link] "Tout l'immobilier" href="https://www.seloger.com/imm..."
      @e301 [listitem]
        @e302 [link] "Toutes les villes" href="https://www.seloger.com/imm..."
      @e303 [listitem]
        @e304 [link] "Tous les départements" href="https://www.seloger.com/imm..."
      @e305 [listitem]
        @e306 [link] "Toutes les régions" href="https://www.seloger.com/imm..."
    @e307 [generic] "Apps"
    @e308 [list]
      @e309 [listitem]
        @e310 [link] "Découvrir l'application SeLoger" href="https://www.seloger.com/tel..."
      @e311 [listitem]
        @e312 [link] "Téléchargez notre application iPhone dans l'App Store." href="https://seloger.go.link/ggjzf"
      @e313 [listitem]
        @e314 [link] "Téléchargez notre application sur Google Play Store." href="https://seloger.go.link/fptbZ"
  @e315 [link] "AVIV logo" href="https://www.aviv-group.com/"
  @e316 [list]
    @e317 [listitem]
      @e318 [link] "Immowelt logo" href="https://www.immowelt.de/"
    @e319 [listitem]
      @e320 [link] "Immonet logo" href="https://www.immonet.de/"
    @e321 [listitem]
      @e322 [link] "Immoweb logo" href="https://www.immoweb.be/fr"
    @e323 [listitem]
      @e324 [link] "SeLoger logo" href="https://www.seloger.com/"
    @e325 [listitem]
      @e326 [link] "Meilleurs Agents logo" href="https://www.meilleursagents..."
    @e327 [listitem]
      @e328 [link] "Logic-immo logo" href="https://www.logic-immo.com/"
    @e329 [listitem]
      @e330 [link] "Yad2 logo" href="https://www.yad2.co.il/"
    @e331 [listitem]
      @e332 [link] "SeLoger construire logo" href="https://www.seloger-constru..."
    @e333 [listitem]
      @e334 [link] "SeLoger Neuf logo" href="https://www.selogerneuf.com..."
    @e335 [listitem]
      @e336 [link] "SeLoger bureaux & commerces logo" href="https://www.seloger-bureaux..."
    @e337 [listitem]
      @e338 [link] "Belles demeures logo" href="https://www.bellesdemeures...."
  @e339 [navigation] "Liens organisationnels"
    @e340 [list]
      @e341 [listitem]
        @e342 [link] "Mentions légales" href="https://www.seloger.com/men..."
      @e343 [listitem]
        @e344 [link] "Protection des données" href="https://www.seloger.com/CGU..."
      @e345 [listitem]
        @e346 [generic] "Cookies"
      @e347 [listitem]
        @e348 [link] "CGU" href="https://www.seloger.com/Con..."
      @e349 [listitem]
        @e350 [link] "Règlement sur les services numériques" href="https://www.seloger.com/reg..."
      @e351 [listitem]
        @e352 [link] "Fonctionnement du site" href="https://www.seloger.com/cla..."
      @e353 [listitem]
        @e354 [link] "Annonces immobilières" href="https://www.seloger.com/"
  @e355 [list]
    @e356 [listitem]
      @e357 [link] "Facebook" href="https://www.facebook.com/se..."
    @e358 [listitem]
      @e359 [link] "𝕏 (Twitter)" href="https://twitter.com/seloger"
    @e360 [listitem]
      @e361 [link] "Youtube" href="https://www.youtube.com/c/s..."
    @e362 [listitem]
      @e363 [link] "LinkedIn" href="https://fr.linkedin.com/com..."
    @e364 [listitem]
      @e365 [link] "Instagram" href="https://www.instagram.com/s..."
    @e366 [listitem]
      @e367 [link] "TikTok" href="https://www.tiktok.com/@sel..."
  @e368 [generic] "Digital Classifieds France SAS © 2026 - Tous droits réservés"