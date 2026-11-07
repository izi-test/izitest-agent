# Piloter le navigateur avec les outils MCP 🕹️

*Le parcours complet, de l'exigence à la campagne, est dans [usage.md](usage.md). Cette page détaille comment un agent pilote le navigateur avec les outils de base.*

Une fois IziTest Agent configuré, vous pouvez interagir avec votre navigateur via Claude en utilisant le langage naturel ou les outils MCP directement.

---

## Protocole de découverte d'éléments

Pour interagir de manière fiable avec les éléments d'une page, suivez toujours ce protocole :

### Étape 1 : Screenshot (toujours commencer ici)

Le screenshot annoté capture TOUS les éléments visibles, y compris ceux qui peuvent être masqués mais interactifs dans les SPAs (Instagram, Twitter, etc.).

```
"Fais un screenshot de la page"
```

Le résultat contient :
- Une image avec les éléments encadrés
- Une liste `@e1`, `@e2`, `@e3`... correspondant aux éléments interactifs

### Étape 2 : Utiliser les références `@eX`

Si vous voyez l'élément souhaité dans le mapping :
```
"Clique sur @e5"
"Remplis @e12 avec 'mon texte'"
```

### Étape 3 : Snapshot (fallback)

Si l'élément n'est pas visible dans le screenshot (élément hors écran, chargé dynamiquement) :
```
"Fais un snapshot avec purposeFilter='fill' et searchText='email'"
```

Options utiles pour `snapshot` :
- `purposeFilter="fill"` → champs de saisie uniquement
- `purposeFilter="click"` → boutons/liens uniquement  
- `purposeFilter="read"` → tous les éléments
- `searchText="motclé"` → filtre par texte (insensible à la casse)
- `includeHidden=true` → inclut les éléments masqués

---

## Navigation de base

```
"Va sur youtube.com"
"Ouvre twitter.com dans un nouvel onglet avec le profil compte-pro"
"Liste les onglets ouverts"
"Ferme l'onglet 3"
```

### Avec un profil spécifique

```
"Sur le profil youtube-work, va sur youtube.com/studio"
"Utilise le profil compte-personnel pour cliquer sur 'Se connecter'"
```

---

## Interactions avancées

### Formulaires

```
"Remplis le champ email avec 'test@example.com'"
"Coche la case 'J'accepte les conditions'"
"Sélectionne 'France' dans le menu déroulant"
"Appuie sur Entrée"
"Appuie sur Tab pour passer au champ suivant"
```

### Scroll

```
"Scroll vers le bas de 500 pixels"
"Scroll jusqu'à l'élément #results"
"Scroll vers le haut"
```

### Attente

```
"Attends 2 secondes"
"Attends que l'élément .loading disparaisse"
"Attends que #results apparaisse (max 10s)"
```

---

## Extraction de données

```
"Extrais le texte de tous les h1 sur la page"
"Récupère les href de tous les liens dans .nav"
"Combien d'éléments ont la classe 'video-title' ?"
"Exécute ce JavaScript : document.querySelectorAll('.price').map(e => e.textContent)"
```

---

## JavaScript arbitraire

Pour des interactions complexes :

```
"Exécute ce code JavaScript :"
```

```javascript
// Exemples d'utilisation
window.scrollTo(0, document.body.scrollHeight);  // Scroll en bas
document.querySelector('#accept-cookies').click(); // Accepter cookies
localStorage.getItem('user_id');                   // Lire localStorage
```

---

## Cookies et authentification

```
"Récupère les cookies pour youtube.com"
"Vérifie si le cookie 'session_id' existe"
"Liste tous les cookies du domaine .google.com"
```

> **Note** : Pour des raisons de sécurité, les valeurs des cookies sont tronquées à 50 caractères dans les réponses.

---

## Workflows complets

### Exemple : Recherche YouTube

```
1. "Va sur youtube.com"
2. "Fais un screenshot"
3. "Remplis @e2 (le champ de recherche) avec 'tutoriel python'"
4. "Clique sur @e3 (le bouton recherche)"
5. "Attends que #results apparaisse"
6. "Extrais les titres des vidéos : .video-title"
```

### Exemple : Connexion à un site

```
1. "Va sur exemple.com/login"
2. "Fais un snapshot avec purposeFilter='fill'"
3. "Remplis @e1 avec 'monemail@example.com'"
4. "Remplis @e2 avec 'monmotdepasse'"
5. "Clique sur @e3 (Se connecter)"
6. "Attends que .dashboard apparaisse"
7. "Fais un screenshot pour vérifier"
```

---

## Raccourcis utiles

| Action | Commande équivalente |
|--------|---------------------|
| Screenshot + mapping | `screenshot(annotate=true)` |
| Voir tous les éléments interactifs | `snapshot(purposeFilter="read")` |
| Trouver un champ spécifique | `snapshot(purposeFilter="fill", searchText="email")` |
| Trouver un bouton | `snapshot(purposeFilter="click", searchText="connexion")` |
| Info page complète | `get_page_info()` |

---

## Conseils et bonnes pratiques

1. **Toujours commencer par un screenshot** avant d'interagir avec une page inconnue
2. **Utilisez les `@eX`** plutôt que les sélecteurs CSS quand possible (plus stable)
3. **Précisez le profil** si vous utilisez plusieurs comptes
4. **Attendez les chargements** : les pages modernes chargent du contenu dynamiquement
5. **Vérifiez visuellement** avec des screenshots après des actions critiques

---
[< Previous: Troubleshooting](troubleshooting.md) | [Next: MCP Tools Reference >](mcp-tools.md)
