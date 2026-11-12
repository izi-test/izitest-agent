# IziTest face aux processus de test ISTQB et REQB

Ce document compare ce que décrivent les syllabus de certification avec ce que fait IziTest
aujourd'hui. Il sert à décider quoi ajouter pour que l'outil convienne aux métiers du test sans
profil technique : responsable de test, test manager, test lead, testeur fonctionnel.

**Le parti pris.** IziTest reste un outil agentique. Le testeur fonctionnel visé ici est une
personne qui automatise ses tests sans écrire de code : elle décrit ou valide le scénario, l'agent
l'exécute. Faire dérouler les tests à la main n'est pas un objectif.

**Ce qui est comparé**

- **ISTQB CTFL v4.0**, « Testeur certifié Niveau Fondation », version française du CFTL (en
  vigueur depuis mai 2023). C'est le syllabus de référence pour le processus de test.
- **REQB CPRE Niveau Fondation v1.3**, version française (GASQ, 2011), pour l'ingénierie des
  exigences. Le REQB n'est plus délivré sous ce nom : la certification actuelle est le CPRE de
  l'IREB (Niveau Fondation v3.x). Les notions retenues ici (critères qualité, traçabilité, gestion
  du changement) y figurent aussi, mais ce syllabus n'a pas été comparé ligne à ligne.
- **IziTest** tel qu'il est sur la branche `main` (commit `2bb5411`), d'après le code et la
  documentation.

**Comment lire les tableaux**

| Verdict | Sens |
|---|---|
| ● Couvert | IziTest fait ce que décrit le syllabus. |
| ◐ Partiel | Une partie existe ; la colonne « Ce qui manque » dit laquelle n'existe pas. |
| ○ Absent | Rien n'existe. |
| — Hors périmètre | Rien n'existe, et ce n'est pas le rôle de l'outil. |

## En bref

Sur 44 points comparés : 15 couverts, 15 partiels, 9 absents, 5 hors périmètre.

- **Le modèle colle.** IziTest suit la même chaîne que l'ISTQB : base de test (l'exigence),
  condition de test (le critère d'acceptation), cas de test, script, résultat, défaut. La
  traçabilité demandée par les deux syllabus est le cœur de l'outil.
- **Le travail du testeur est couvert, et sans code** : analyse, conception, implémentation,
  exécution, tests de confirmation et de régression. Le testeur décrit ou valide le scénario ;
  l'agent l'enregistre, puis le test se rejoue seul.
- **Le travail du test manager ne l'est qu'à moitié** : planification, pilotage, clôture et
  gestion des risques. L'outil montre l'état des tests, il ne le compare à aucun objectif.
- **Trois obstacles restent pour les profils non techniques** : une installation en ligne de
  commande, pas de comptes ni de rôles, une interface en anglais, sans le vocabulaire ISTQB, où
  retoucher un test demande du JSON ou un sélecteur CSS.

## 1. Le processus de test (CTFL v4.0, § 1.4)

Les sept activités du processus de test, puis la traçabilité et les rôles.

| Activité (réf.) | Ce que décrit le syllabus | Ce que fait IziTest | Verdict | Ce qui manque |
|---|---|---|---|---|
| Planification des tests (1.4.1, 5.1.1) | Un plan de test : périmètre, objectifs, approche, risques, critères d'entrée et de sortie, calendrier, budget. | Une campagne porte un nom, une version, un commit, la sélection des tests, des étapes ordonnées et le nombre d'exécutions en parallèle. | ◐ Partiel | Le plan de test lui-même : objectifs, critères d'entrée et de sortie, calendrier. |
| Pilotage et contrôle (1.4.1, 5.3) | Comparer l'avancement au plan, suivre des métriques, décider des corrections. | Tableau de bord : nombre de tests et d'exécutions, taux de réussite, durée moyenne, couverture des exigences, tests instables, bugs ouverts. Chaque campagne se compare à la précédente. | ◐ Partiel | L'écart à un objectif : on voit l'état, pas si l'on est en avance ou en retard. |
| Analyse de test (1.4.1, 4.5.2) | Étudier la base de test, y signaler les défauts, définir et prioriser les conditions de test. | Import des exigences (Jira, GitHub, fichier, saisie). Revue de chaque critère d'acceptation : un test peut-il trancher ? Sinon, la question à poser à l'auteur et une reformulation. Liste de ce que l'exigence ne dit pas. | ● Couvert | Le risque n'entre pas dans la priorisation. |
| Conception des tests (1.4.1, 4.2) | Dériver des cas de test avec des techniques de test ; identifier les données et l'environnement nécessaires. | Pour chaque exigence, des cas proposés avec leur technique, leur type (nominal, alternatif, erreur, limite), leur priorité, leur raison et leur scénario Gherkin. Une personne coche ceux à garder. | ● Couvert | — |
| Implémentation des tests (1.4.1) | Procédures de test ou scripts automatisés, suites, données de test, ordre d'exécution, environnement. | Un agent enregistre le test dans le navigateur à partir du scénario. Étapes métier réutilisables, jeux de données (une exécution par ligne), secrets chiffrés, étapes de campagne ordonnées. | ● Couvert | Retoucher un test à la main (corriger une étape, ajouter une vérification) demande du JSON ou un sélecteur CSS. |
| Exécution automatisée (1.4.1) | Exécuter, comparer l'obtenu à l'attendu, tenir les logs, analyser les anomalies, rapporter les défauts. | Rejeu sans IA, dans Chrome ou sans fenêtre, en parallèle, visible en direct, pas à pas pour déboguer. Historique de chaque exécution. Chaque échec reçoit un diagnostic : régression, non-conformité à l'exigence, test en retard sur son exigence, environnement, test à réparer. Un bug est ouvert quand l'échec vient de l'application. | ● Couvert | — |
| Exécution manuelle (1.4.1) | Un testeur déroule un cas de test pas à pas et note le résultat. | Rien, par choix. Le testeur décrit ou valide le scénario ; l'agent l'exécute dans le navigateur et l'enregistre ; le test se rejoue ensuite seul. | — Hors périmètre | Voulu : IziTest reste agentique. Les campagnes manuelles restent dans l'outil de gestion des tests de l'équipe (Xray, par exemple), où IziTest envoie déjà ses résultats. |
| Clôture des tests (1.4.1, 5.3.2) | Rapport de clôture, leçons apprises, archivage du testware, demandes de changement. | Rapport de campagne (HTML, JUnit), résultats envoyés à Xray, couverture écrite sur les tickets Jira. | ◐ Partiel | Un rapport de clôture face aux critères de sortie ; les leçons apprises. |
| Traçabilité (1.4.4) | Relier la base de test, les conditions de test, les cas, les résultats et les défauts. | Exigence, critère, cas, test, exécution, bug, campagne (avec version et commit) sont reliés. Quand l'exigence change, ses tests sont signalés. | ● Couvert | Les risques ne font pas partie de la chaîne. |
| Rôles (1.4.5) | Le test manager planifie, pilote et clôture. Le testeur analyse, conçoit, implémente et exécute. | Pas de comptes : un seul jeton d'accès pour tout le monde. | ○ Absent | Des comptes, des rôles, et la trace de qui a fait quoi. |

## 2. Les autres chapitres du CTFL v4.0

| Sujet (réf.) | Ce que décrit le syllabus | Ce que fait IziTest | Verdict | Ce qui manque |
|---|---|---|---|---|
| Test statique et revues (3.1, 3.2) | Relire les exigences et les cas de test avant de tester : planification, revue individuelle, discussion, correction ; rôles d'auteur, de réviseur, de modérateur. | L'IA relit les critères d'acceptation. Une personne valide les cas en les cochant. | ◐ Partiel | La revue entre personnes : commentaires, réviseur, état « relu » ou « approuvé ». |
| Test moteur du développement, shift left (2.1.3, 2.1.5, 4.5.3) | Écrire les tests d'acceptation à partir des critères, avant ou pendant le développement (ATDD, BDD). | Les scénarios Given/When/Then sont écrits depuis les critères dès que l'exigence existe. L'exigence est relue avant tout test. | ● Couvert | — |
| DevOps (2.1.4) | Des tests automatisés dans la chaîne de livraison, pour un retour rapide. | Campagne lancée en ligne de commande, sans fenêtre, avec code de sortie et rapport JUnit. Sélection des seuls tests que touche un commit. | ● Couvert | — |
| Niveaux de test (2.2.1) | Composant, intégration, système, intégration de systèmes, acceptation. | Tests système et d'acceptation, de bout en bout par l'interface, et appels d'API. La revue indique à quel niveau tester une règle (bout en bout, API, unitaire). | ◐ Partiel | Voulu : les niveaux composant et intégration restent aux développeurs. |
| Types de test (2.2.2) | Fonctionnel, non fonctionnel (performance, sécurité, utilisabilité…), boîte noire, boîte blanche. | Fonctionnel en boîte noire. Non fonctionnel : accessibilité et régression visuelle. | ◐ Partiel | Performance et sécurité. |
| Test de confirmation et de régression (2.2.3) | Vérifier qu'un défaut corrigé l'est bien ; vérifier qu'un changement n'a rien cassé. | Un bug passe à « corrigé » quand son test repasse sans avoir été modifié. Une campagne rejoue tout, ou seulement les tests que touche un changement. | ● Couvert | — |
| Test de maintenance (2.3) | Analyser l'impact d'un changement sur les tests existants. | Un test en retard sur son exigence est signalé. Une réparation est proposée, puis vérifiée par un rejeu. | ● Couvert | — |
| Techniques boîte noire (4.2) | Partitions d'équivalence, valeurs limites, tables de décision, transitions d'état. | Les quatre, plus le cas d'utilisation. | ● Couvert | — |
| Techniques boîte blanche (4.3) | Couverture des instructions et des branches du code. | Rien. | — Hors périmètre | Relève des tests unitaires des développeurs. |
| Techniques basées sur l'expérience (4.4) | Estimation d'erreurs ; test exploratoire par sessions, avec une charte ; checklists. | Estimation d'erreurs à la conception. Exploration automatique de l'application : erreurs de console, requêtes en échec, liens morts, accessibilité. Chaque bug trouvé reçoit un test qui le reproduit. | ◐ Partiel | Une exploration guidée par une charte que le testeur écrit (l'exploration ne reçoit aujourd'hui qu'une adresse de départ) ; les checklists personnalisées. |
| Critères d'entrée et de sortie (5.1.3) | Les conditions pour commencer, et pour déclarer les tests terminés : couverture atteinte, défauts non résolus, cas en échec. | Un seul critère, implicite : la ligne de commande rend 0 quand tous les tests passent. | ○ Absent | Des seuils choisis par campagne, et un verdict calculé. |
| Estimation (5.1.4) | Estimer l'effort de test. | Rien. La durée de chaque exécution passée est connue. | ○ Absent | Au moins la durée prévue d'une campagne. |
| Priorisation des cas de test (5.1.5) | Ordonner l'exécution selon le risque, la couverture ou les exigences. | Priorité haute, moyenne ou basse sur l'exigence et sur le cas. Étapes de campagne ordonnées à la main. | ◐ Partiel | L'ordre d'exécution ne découle ni de la priorité ni du risque. |
| Gestion des risques (5.2) | Identifier les risques produit, évaluer leur probabilité et leur impact, tester davantage ce qui est risqué, suivre le risque résiduel. | Rien. | ○ Absent | Un niveau de risque par exigence, qui guide la conception, l'ordre d'exécution et le rapport. |
| Métriques (5.3.1) | Avancement, qualité du produit, défauts, risque, couverture, coût. | Avancement des tests, couverture des exigences, bugs ouverts par sévérité, tests instables. | ◐ Partiel | La tendance des défauts dans le temps ; le risque résiduel. |
| Rapports de test (5.3.2, 5.3.3) | Un rapport d'avancement périodique et un rapport de clôture, adaptés à leurs destinataires. | Tableau de bord, rapport HTML par campagne, couverture en commentaire sur les tickets Jira. | ◐ Partiel | Un rapport d'avancement sur une période et un rapport de clôture, lisibles sans ouvrir l'outil. |
| Gestion de configuration (5.4) | Identifier et versionner le testware ; poser des bases de référence ; pouvoir revenir à un état antérieur. | La campagne garde la version et le commit testés. L'exigence garde une empreinte de son contenu. | ◐ Partiel | L'historique des versions d'un test et d'une exigence. |
| Gestion des défauts (5.5) | Un rapport de défaut : identifiant, titre, date, auteur, contexte, étapes pour reproduire, attendu et obtenu, sévérité, priorité, statut (ouvert, différé, dupliqué, en attente de test de confirmation, fermé, rejeté). | Page Bugs : identifiant, titre, type, sévérité, dates, nombre d'occurrences, attendu et obtenu, critères concernés, test qui reproduit, campagne. Statuts : ouvert, corrigé, écarté. Ouverture et correction automatiques. | ◐ Partiel | Priorité, responsable, défaut signalé par une personne, statuts intermédiaires, envoi vers Jira. |

## 3. L'ingénierie des exigences (REQB CPRE v1.3)

| Sujet (réf.) | Ce que décrit le syllabus | Ce que fait IziTest | Verdict | Ce qui manque |
|---|---|---|---|---|
| Identification des exigences (ch. 5) | Trouver les parties prenantes et recueillir leurs besoins (entretiens, ateliers…). | IziTest part d'exigences déjà écrites, importées ou saisies. | — Hors périmètre | — |
| Exigences fonctionnelles et non fonctionnelles (5.5) | Classer chaque exigence. | Pas de type sur l'exigence. | ○ Absent | Un champ « type ». |
| Spécification (ch. 6) | Décrire l'exigence : description, user story, critères. | Clé, titre, description, critères d'acceptation, source et lien vers l'origine. | ● Couvert | — |
| Critères qualité d'une exigence (1.1.3, 6.4) | Correcte, faisable, utile, priorisée, non ambiguë, vérifiable, unique, indépendante de la conception. La spécification est complète, cohérente, modifiable, traçable. | La revue vérifie « vérifiable », « non ambiguë » et « complète » (ce que l'exigence ne dit pas), en tenant compte des autres exigences du projet. « Priorisée » et « traçable » tiennent aux champs et aux liens. | ◐ Partiel | « Cohérente » (conflits entre exigences), « unique », « modifiable » (historique des changements). |
| Priorité et criticité (1.1.7, 7.5) | La priorité dit l'importance ou l'urgence. La criticité dit le dommage en cas de défaillance. | Priorité haute, moyenne ou basse. | ◐ Partiel | La criticité, qui rejoint le risque produit de l'ISTQB. |
| Analyse et modélisation (7.1 à 7.3) | Modèles UML et SysML. | Rien. | — Hors périmètre | — |
| Estimation des coûts (7.4) | Estimer le coût de réalisation d'une exigence. | Rien. | — Hors périmètre | — |
| Accord sur les exigences (7.6) | Les parties prenantes approuvent et signent les exigences avant la réalisation. | Rien. | ○ Absent | Un état « approuvée », avec qui et quand. |
| Traçabilité (8.1) | Dans les deux sens, de la source aux cas de test. Elle sert l'analyse d'impact, l'analyse de couverture et la preuve d'implémentation. | De l'origine (ticket Jira, issue GitHub) aux tests, aux résultats et aux bugs. Couverture par version. Tests signalés quand l'exigence change. | ● Couvert | Les liens entre exigences (traçabilité horizontale). |
| Gestion du changement (8.2) | Demande de changement, analyse d'impact, décision. | Un nouvel import dit quelles exigences ont changé. La conception et les tests concernés sont signalés. | ◐ Partiel | On sait qu'une exigence a changé, pas ce qui a changé ni qui l'a décidé. |
| Cycle de vie d'une exigence (8.2.5) | Des états : nouveau, pour revue, approuvé, implémenté, testé, déployé… | Pas d'état enregistré. Seul l'état de test est calculé : non couverte, non exécutée, réussie, en échec. | ○ Absent | Un état de l'exigence. |
| Distinguer défaut et changement (8.2.6) | Un défaut est un écart à l'exigence. Un changement modifie l'exigence. | Le diagnostic sépare la non-conformité (l'application ne fait pas ce que dit l'exigence), la régression, et le test en retard sur une exigence qui a changé. | ● Couvert | — |
| Testabilité et critères d'acceptation (9.3) | Chaque exigence mène à au moins un critère d'acceptation mesurable. La couverture fonctionnelle se mesure. | C'est le cœur du modèle : critères relus pour leur testabilité, couverture mesurée critère par critère. | ● Couvert | — |
| Métriques de qualité des exigences (9.4) | Mesurer la qualité des exigences. | Rien d'affiché, alors que la revue produit déjà les données. | ○ Absent | La part des critères non testables ; les questions en attente de réponse. |
| Rôles et parties prenantes (ch. 4) | Qui écrit, qui valide, qui est consulté. | Rien : ni auteur ni responsable sur l'exigence. | ○ Absent | Rejoint les comptes et les rôles. |
| Outils (ch. 10) | Outils de gestion des exigences. | Connecteurs Jira, GitHub et Xray : IziTest lit les exigences là où elles vivent. | ● Couvert | — |

## 4. Est-ce que ça colle ?

**Oui pour le modèle.** Le CTFL écrit que les critères d'acceptation peuvent être vus comme les
conditions de test (§ 4.5.2). Le REQB écrit que chaque exigence doit mener à au moins un critère
d'acceptation, base du test d'acceptation (§ 9.3). IziTest est construit exactement ainsi. Un
testeur certifié retrouve ses notions ; seuls les mots à l'écran diffèrent.

**Oui pour le rôle de testeur, et sans code.** Le CTFL confie au testeur l'analyse, la conception,
l'implémentation et l'exécution (§ 1.4.5). Ce sont les quatre activités les mieux couvertes, et
le testeur n'y écrit aucun code. Sur une exigence, *Propose scenarios* propose les cas et *Plan*
garde ceux qu'il coche. *Record* fait enregistrer le cas par l'agent dans le navigateur. Sans
exigence, *New test* part d'une description en quelques phrases. L'agent demande ce qui lui manque
(un compte, une donnée) et le testeur suit son navigateur en direct. IziTest ne fait pas dérouler
les tests à la main, et c'est voulu.

**Pas encore pour le rôle de test manager.** Le CTFL lui confie la planification, le pilotage et
la clôture. IziTest lui donne un tableau de bord et des rapports de campagne, mais ni plan, ni
critères de sortie, ni risques. Il peut constater, pas décider avec l'outil.

**IziTest va plus loin que les syllabus sur trois points** : le diagnostic automatique de chaque
échec, la réparation des tests, et le bug qui s'ouvre puis se corrige seul avec son test de
confirmation. Ce sont ses arguments face aux outils de gestion des tests classiques.

**Trois obstacles que les syllabus ne traitent pas** séparent encore le testeur fonctionnel d'une
automatisation sans aide technique :

- **L'installation.** Il faut Node.js, git, deux commandes dans un terminal et une extension
  Chrome chargée en mode développeur.
- **Le réglage de l'agent.** La page *Settings* demande de choisir un agent en ligne de commande,
  ou de fournir une clé OpenRouter et un modèle.
- **La retouche d'un test.** *Add step* demande une commande (`click`, `fill`…), des paramètres
  et des localisateurs en JSON. *Add assertion* demande un sélecteur CSS. Le test se lit déjà en
  clair : chaque étape affiche son intention, et l'onglet *Gherkin* donne le scénario.

## 5. Les manques, par ordre de priorité

L'ordre tient compte du public visé. La taille est une estimation. Les manques 2, 3, 7 et 8 sont
retenus (décision du 11 novembre 2026). Deux points sont reportés tant que le projet n'est pas
validé : l'installation sans terminal du manque 1 (IziTest reste un serveur à installer) et le
manque 5.

**État au 11 novembre 2026 : les manques 2, 3, 7 et 8 sont réalisés.**

| # | Ce qui existe maintenant | Ce qui reste |
|---|---|---|
| 2 | Plan de test sur la campagne (objectif, périmètre, quatre critères de sortie), verdict critère par critère, rapport de clôture (texte, HTML), code de sortie de la ligne de commande selon le verdict. | Pas de plan au niveau du projet ou de la version, au-dessus des campagnes. |
| 3 | Probabilité et impact par exigence, niveau de risque ; plus de cas conçus pour un risque haut, tests les plus risqués joués en premier, risque résiduel dans les rapports. | Pas de registre des risques projet (CTFL 5.2.1) : seul le risque produit est tenu. |
| 7 | Priorité, responsable, statuts « à retester », « différé », « dupliqué » ; bug signalé par une personne, reproduit par l'agent qui en garde le test ; envoi vers Jira avec aperçu. | Le statut du ticket Jira n'est pas relu : la synchronisation va d'IziTest vers Jira seulement. |
| 8 | Page *Reports* et page HTML à imprimer : avancement sur une période, obstacles, métriques, risque résiduel, suite prévue, tendance des bugs. Le rapport d'une campagne avec plan sert de rapport de clôture. | Pas d'envoi programmé du rapport (par e-mail, chaque semaine). |

### Priorité 1 : sans cela, ces métiers ne peuvent pas adopter l'outil

| # | Manque | Pour qui | Réf. | À ajouter | Taille |
|---|---|---|---|---|---|
| 1 | Automatiser sans code, sans aide technique | Testeur fonctionnel | Hors syllabus | Trois chantiers indépendants. **Installer sans terminal** : un installeur, et l'extension distribuée par le Chrome Web Store. **Un agent prêt à l'emploi** : réglé une fois pour l'équipe, pas par chaque testeur. **Retoucher un test en mots courants** : dire à l'agent quoi changer (« vérifie aussi le total TTC ») ou désigner l'élément d'un clic dans la page, au lieu d'écrire du JSON ou un sélecteur CSS. | Grande |
| 2 | Plan de test et critères de sortie sur la campagne | Responsable de test, test manager | CTFL 5.1.1, 5.1.3, 5.3.2 | Sur une campagne : objectif, périmètre, critères de sortie chiffrés (toutes les exigences de priorité haute réussies, aucun bug de sévérité haute ouvert, couverture minimale), verdict calculé et rapport de clôture. Les données existent déjà. | Moyenne |
| 3 | Risque produit | Test manager, test lead | CTFL 5.2 ; REQB 1.1.7 | Une probabilité et un impact par exigence, d'où un niveau de risque. Il guide le nombre de cas à concevoir, l'ordre d'exécution et le rapport (risque résiduel). | Petite à moyenne |
| 4 | Interface en français, vocabulaire ISTQB | Tous | Glossaire CFTL | Traduire l'interface et employer les termes du glossaire : exigence, condition de test, cas de test, défaut, test de confirmation. Aucun mécanisme de traduction n'existe aujourd'hui. | Moyenne |

### Priorité 2 : attendu d'un outil de gestion des tests

| # | Manque | Pour qui | Réf. | À ajouter | Taille |
|---|---|---|---|---|---|
| 5 | Comptes, rôles et revue entre personnes | Responsable de test | CTFL 1.4.5, 3.2 ; REQB ch. 4, 7.6 | Des comptes, au moins deux rôles (responsable de test, testeur), l'auteur de chaque action, un état « relu » ou « approuvé » sur les exigences et les cas planifiés. | Grande |
| 6 | Cycle de vie et historique de l'exigence | Test lead, analyste | REQB 8.2, 8.2.5, 1.1.3 | Un état (nouvelle, pour revue, approuvée, implémentée, testée) et les versions successives avec ce qui a changé. L'empreinte du contenu existe ; il reste à garder l'ancien texte. | Moyenne |
| 7 | Gestion des défauts complète | Testeur, test lead | CTFL 5.5 | Priorité de correction, responsable, statuts « différé », « dupliqué » et « en attente de test de confirmation », envoi vers Jira. Un défaut signalé par une personne : elle le décrit, l'agent le reproduit et en garde un test. | Moyenne |
| 8 | Rapports d'avancement et de clôture | Test manager | CTFL 5.3.2 | Un rapport sur une période (avancement, obstacles, métriques, risques, suite prévue) et un rapport de clôture ; la tendance des défauts. | Petite à moyenne |

### Priorité 3 : utile, sans urgence

| # | Manque | Réf. | À ajouter |
|---|---|---|---|
| 9 | Exploration guidée par une charte, checklists | CTFL 4.4.2, 4.4.3 | Le testeur écrit la charte (quoi explorer, quoi chercher) et les checklists de l'équipe ; l'agent explore et rend ses notes. |
| 10 | Estimation et calendrier | CTFL 5.1.4 | La durée prévue d'une campagne d'après l'historique ; des campagnes lancées à heure fixe. |
| 11 | Historique des versions d'un test | CTFL 5.4 | Garder chaque version d'un test et pouvoir y revenir. |
| 12 | Temps de réponse | CTFL 2.2.2 | Un seuil de temps de réponse par page ou par requête, vérifié pendant le rejeu. |
| 13 | Qualité des exigences | REQB 9.4, 1.1.3, 5.5, 8.1.3 | Part des critères non testables, conflits entre exigences, type fonctionnel ou non fonctionnel, liens entre exigences. |
| 14 | Leçons apprises | CTFL 2.1.6 | Une note de rétrospective par campagne. |

### À ne pas ajouter

- L'exécution manuelle des cas de test, où un testeur déroule le cas et note le résultat : IziTest
  reste agentique. Une équipe qui garde des campagnes manuelles les tient dans son outil de
  gestion des tests ; IziTest y envoie ses résultats (Xray aujourd'hui).
- La couverture de code (techniques boîte blanche) et les niveaux composant et intégration :
  c'est le travail des tests unitaires.
- Le recueil des besoins, la modélisation UML et l'estimation du coût de réalisation : c'est le
  travail des outils d'ingénierie des exigences, qu'IziTest lit par ses connecteurs.

### Par où commencer

Les manques 2, 3 et 8 sont les moins coûteux et s'appuient sur des données déjà présentes. À eux
trois, ils donnent au test manager un plan, un verdict et un rapport. Vient ensuite le manque 7,
qui complète la page Bugs. Le manque 1 se découpe en trois chantiers ; la retouche d'un test en
mots courants est celui qui sert le plus vite le testeur fonctionnel. Le manque 4 peut avancer en
parallèle.
