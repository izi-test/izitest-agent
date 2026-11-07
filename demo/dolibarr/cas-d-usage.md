# Dolibarr : cas d'usage pour éprouver IziTest

Le but n'est pas de tester Dolibarr. C'est de voir, sur une vraie application de gestion, ce qu'IziTest fait bien, ce qu'il fait mal et ce qui lui manque. On le voit au moment d'écrire les tests, puis quand l'application change de version.

Chaque cas indique **ce qu'il met à l'épreuve dans IziTest**. Une règle marquée *(à vérifier)* est ce qu'on attend de Dolibarr sans l'avoir encore vu faire. Le premier enregistrement la confirmera ou la corrigera.

Un test crée ce dont il a besoin (un tiers, un produit, une pièce) plutôt que de compter sur une pièce de démo : les données changent d'un passage à l'autre.

Dans IziTest, chaque cas est une exigence du projet Dolibarr, avec ses critères d'acceptation : le cas 1 est DOLI-1, et ainsi de suite jusqu'à DOLI-10.

## Niveau moyen

### 1. Créer un client
Un tiers client avec son adresse, son pays et ses conditions de règlement. Un nom manquant est refusé avec un message.

À l'épreuve : un long formulaire, des listes avec recherche (pays, conditions), un message d'erreur. Un jeu de données de plusieurs clients (particulier, entreprise, client étranger).

### 2. Une proposition commerciale, de la création à la validation
On crée une proposition pour un client, on ajoute une ligne d'un produit existant et une ligne libre, puis on valide.
- En brouillon, la référence est provisoire (PROV…). À la validation, elle devient PRaamm-nnnn.
- Les totaux HT, TVA et TTC suivent les lignes.

À l'épreuve : des lignes ajoutées dans un tableau qui se recharge, une confirmation dans une fenêtre modale, une référence qu'on ne connaît qu'après coup (la garder pour la suite du test), des montants calculés.

### 3. Retrouver une pièce
Filtrer la liste des factures par client, par statut et par date ; trier ; changer de page.

À l'épreuve : les filtres de tableau, les champs de date, une liste dont le contenu dépend des données, des vérifications qui ne cassent pas quand une facture s'ajoute.

### 4. Un produit et son prix
Un produit avec un prix HT et un taux de TVA. Le prix TTC est calculé. Un service se distingue d'un produit.

À l'épreuve : des valeurs calculées, un jeu de données de prix et de taux (20 %, 10 %, 5,5 %, 2,1 %) avec le TTC attendu.

## Niveau complexe

### 5. Du devis à la facture payée
Le parcours complet, sur plusieurs pages :
1. Une proposition est validée, puis signée.
2. Elle devient une commande, puis une facture.
3. Un premier paiement partiel : la facture est « commencée ».
4. Le solde : elle est « payée ».

La référence et le montant suivent d'une pièce à l'autre.

À l'épreuve : un long test qui garde des valeurs d'une page à l'autre, des changements de statut, des boutons qui n'apparaissent qu'à un statut donné. Et si une étape au milieu casse : la réparation.

### 6. Remises et arrondis
- Un client a une remise par défaut : ses nouvelles lignes la reçoivent *(à vérifier : où elle se règle et quand elle s'applique)*.
- Une remise sur une ligne s'ajoute à celle-ci.
- Les totaux tombent juste avec la TVA à 5,5 % et des quantités ou prix qui obligent à arrondir.

À l'épreuve : un jeu de données de quantités, prix, remises et taux avec les totaux attendus. C'est le cas typique des règles métier qu'on vérifie par des valeurs, pas par un parcours.

### 7. Conditions de règlement et date d'échéance
La date limite de règlement d'une facture se calcule depuis sa date et ses conditions : « A réception », « 30 jours », « 30 jours fin de mois », « 60 jours fin de mois ».

À l'épreuve : des dates calculées. Il faut une date de facture fixe dans le test, sinon le résultat attendu change chaque jour. Un jeu de données des conditions avec l'échéance attendue.

### 8. Corriger une facture
Une facture validée se corrige par un avoir, partiel ou total. On regarde ensuite :
- le reste à payer de la facture d'origine ;
- le lien entre les deux pièces ;
- la numérotation AVaamm-nnnn.

Une facture de remplacement n'est possible que si la facture n'est pas payée *(à vérifier)*.

À l'épreuve : des règles qui dépendent de l'état d'une autre pièce, des options proposées ou non selon cet état.

### 9. Acompte
Sur une commande, on fait une facture d'acompte de 30 %. Puis la facture finale déduit l'acompte *(à vérifier : comment il apparaît sur la facture finale)*.

À l'épreuve : un montant calculé à partir d'une autre pièce, un parcours en deux temps.

### 10. Le document PDF
On génère le PDF d'une facture validée, puis on vérifie qu'il contient :
- le client et la référence ;
- les lignes et les totaux ;
- l'échéance et les mentions de bas de page.

À l'épreuve : **ce qu'IziTest ne sait pas faire aujourd'hui.** Il ne récupère pas un fichier téléchargé et ne lit pas le contenu d'un PDF. Ce cas sert à décrire précisément ce qu'il faudrait. C'est la vérification principale d'un projet d'éditique.

## Maintenance : la montée de version

Une fois les cas 1 à 9 écrits et stables en 23.0.4 :
1. On passe en 24.0.2 (voir [README.md](README.md)) : les données restent, l'application change.
2. On relance la même campagne.
3. Pour chaque test cassé, on note la cause : changement d'écran, changement de règle, ou fausse alerte. Et ce que la réparation a fait seule.

## Mesures

À noter pour chaque cas, au fil de l'eau.

| Moment | Mesure |
|---|---|
| Écrire le test | Temps pour avoir un test qui passe ; nombre d'interventions humaines ; ce qu'on a dû expliquer à l'agent |
| Le rejouer | Passe en headless ? Sur 3 passages de suite, combien d'échecs sans changement de l'application ? |
| Après la montée de version | Tests cassés ; parmi eux, réparés seuls, réparés avec de l'aide, à réécrire ; fausses alertes |
| Couverture | Règles de chaque cas couvertes par une vérification, et celles qu'on n'a pas su vérifier |

## Ce que la démo ne couvre pas

- **Les droits des utilisateurs** : tout le monde est l'administrateur, pour que personne n'ait à saisir de mot de passe.
- **Les envois d'e-mails** : rien n'est configuré pour envoyer.
