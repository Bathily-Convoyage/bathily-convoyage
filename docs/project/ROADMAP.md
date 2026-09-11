# Bathily-Convoyage — Roadmap

Document de référence unique pour la planification produit et technique.

Liens :
- État courant : [CURRENT_STATE.md](CURRENT_STATE.md)
- Décisions durables : [DECISIONS.md](DECISIONS.md)

## Règles de gestion des IDs

- Les IDs de roadmap (RM-XX) sont stables et ne doivent jamais être renumérotés après publication.
- Pour insérer un nouvel élément entre deux IDs existants, utiliser un suffixe : RM-02A, RM-02B, etc.
- Un changement de scope n'altère jamais l'ID ; seul le contenu de l'entrée est mis à jour.

## Statuts utilisés

- `NEXT` : prochain chantier à ouvrir.
- `PLANNED` : planifié, dépendances non résolues.
- `PARALLEL` : flux parallèle, indépendant des jalons techniques.
- `LATER` : long terme, non planifié.
- `IN_PROGRESS` / `DONE` : renseignés dans CURRENT_STATE.md au fil de l'exécution.

---

## RM-01 — CRM Production Hardening

- STATUS: NEXT
- Objectif : durcir le CRM livré jusqu'à P3C2 (fiabilité, permissions, auditabilité, performance) avant d'empiler de nouveaux chantiers.
- Pourquoi maintenant : le CRM vient d'être mergé en Production (PR #91). Il faut consolider la base avant de construire RM-04 et au-delà.
- In scope : revue RLS/permissions, index et performance, tests E2E CRM, audit des RPC critiques, monitoring erreurs, vérification alignement migrations.
- Out of scope : nouvelles fonctionnalités métier, refonte UX, nouveaux objets CRM.
- Definition of Done : audit permissions/RLS passé, smoke Production vert, aucun drift de migration, aucun résidu synthétique.
- Dépendances primaires : aucune (base = P3C2 CLOSED_PASS).
- Valeur métier attendue : socle CRM fiable et auditable, condition de tous les chantiers suivants.

## RM-02 — Ajustements Positionnement commercial

- STATUS: PLANNED
- DEPENDS_ON: RM-01
- Objectif : aligner le positionnement commercial et le paramétrage tarifaire sur les règles métier validées (voir référence ci-dessous).
- Pourquoi maintenant : le pricing actuel contient une majoration estivale automatique et des packs à recadrer ; ces règles bloquent RM-03.
- In scope : suppression de la majoration été, ajustement global manuel Admin, recadrage des packs B2C, séparation B2B, audit du câblage packs Admin → moteur de devis.
- Out of scope : nouveau pricing engine complet (RM-03), conciergerie, grilles B2B (RM-06), prix des options séparées (non validés).
- Definition of Done : majoration été supprimée, ajustement global Admin opérationnel et distinct, packs conformes à la référence, audit de câblage documenté.
- Dépendances primaires : RM-01.
- Valeur métier attendue : positionnement cohérent, maîtrise manuelle du prix, base propre pour le Pricing Engine V2.

### Référence métier RM-02 (règles validées — à préserver)

**Chantier** : Ajustements Positionnement commercial.

**Baseline tarifaire** : BASE = 1.20 €/km (cf. DEC-007).

**Majoration été** : la surcharge automatique +15% été/haute saison est supprimée (cf. DEC-008).

**Ajustement global de prix** :
- pourcentage manuel contrôlé par l'Admin, positif ou négatif ;
- le prix de base n'est jamais modifié ; 0% restaure le prix de référence normal ;
- doit rester distinct de : remises commerciales, codes promo, tarifs B2B, packs, options.

**Packs B2C** : Essentiel = inclus ; Sérénité = +69 € ; Excellence = +149 €.

**Essentiel inclut** :
- suivi de mission ;
- EDL digital ;
- photos EDL ;
- coordination enlèvement/livraison ;
- service client standard.

**Règle cœur** : ne jamais retirer sécurité, preuve, traçabilité ou prestations professionnelles de base d'Essentiel pour forcer artificiellement l'upsell.

**Sérénité — positionnement** : confort + support renforcé. Contenu cible :
- tout Essentiel ;
- nettoyage intérieur/extérieur standard avant livraison ;
- support renforcé ;
- support prioritaire ;
- coordination renforcée des rendez-vous/créneaux lorsque pertinent.

**Excellence — positionnement** : livraison premium, prêt à partir. Contenu cible :
- tout Sérénité ;
- planification prioritaire ;
- créneau de livraison privilégié ;
- remise des clés personnalisée ;
- préparation avant remise des clés ;
- plein ou complément de carburant sur demande — carburant facturé au réel.

**Retiré d'Excellence** :
- photos 4K ;
- photos premium ;
- dossier photo détaillé comme valeur premium ;
- carburant inclus ;
- dimanche/jour férié inclus.

**Options séparées** :
- convoyage prioritaire ;
- dimanche/jour férié ;
- nettoyage renforcé pour véhicules anormalement sales.

Aucun prix n'est validé pour ces options séparées. Ne pas en inventer.

**Conciergerie** : idée future uniquement ; hors scope actuel ; aucun placeholder public.

**B2B** : logique strictement séparée des packs B2C. Modèle futur : grilles partenaires, tarifs volume, contrats, remises professionnelles, facturation centralisée, multi-sites, conditions spécifiques.

**Admin** : la gestion des packs existe déjà ; le travail futur doit auditer le câblage de bout en bout, sans reconstruire à l'aveugle. Chemin d'audit requis : Admin → persistence → backend / RPC / API → moteur de devis → interface client.

**Invariant de prix figé** : les changements futurs de prix/contenu des packs ou d'ajustement global ne doivent pas muter rétroactivement un devis ou un prix de mission déjà figé, sauf règle métier future explicite (cf. DEC-013).

**Positionnement commercial** : alternative aux grandes plateformes de convoyage — plus directe, plus flexible, technologiquement solide, compétitive. PAS low-cost.

Les packs premium vendent : confort, temps, disponibilité, flexibilité, service. Ils ne doivent pas vendre artificiellement : sécurité, preuve, photos EDL, professionnalisme de base.

## RM-03 — Pricing Engine V2 — coûts, marge et règles tarifaires

- STATUS: PLANNED
- DEPENDS_ON: RM-02
- Objectif : moteur de prix unifié intégrant coûts réels, marge cible et règles tarifaires (distance, véhicule, options, ajustements).
- Pourquoi maintenant : nécessite les règles RM-02 stabilisées ; prérequis de RM-07, RM-08, RM-11, RM-14.
- In scope : modèle de coûts, calcul de marge, règles tarifaires configurables, traçabilité du calcul dans le devis, respect de l'invariant de prix figé.
- Out of scope : grilles B2B partenaires (RM-06), facturation (RM-09).
- Definition of Done : calcul reproductible et audité, règles RM-02 implémentées, tests sur cas réels, aucune rétro-mutation de devis figés.
- Dépendances primaires : RM-02.
- Valeur métier attendue : marge maîtrisée, prix justifiables, base pour devis V2.

## RM-04 — P3C3 — CRM Operations Complexes

- STATUS: PLANNED
- DEPENDS_ON: RM-01
- SOFT_DEPENDENCY: RM-03 où les règles pricing/client affectent la structure CRM.
- Objectif : opérations CRM complexes (fusions, transferts, segmentation avancée, mutations structurelles) via RPC transactionnelles.
- Pourquoi maintenant : suite naturelle de P3C2 ; requiert la base durcie de RM-01.
- In scope : RPC transactionnelles pour mutations structurelles critiques, fusion/dédoublonnage d'organisations, re-parentage/transferts contrôlés, segmentation avancée et actions en masse lorsque validées, gestion de conflits, audit trail renforcé.
- Out of scope : prospection commerciale opérationnelle (RM-05).
- Definition of Done : mutations critiques transactionnelles et testées, audit trail complet, smoke Production vert.
- Dépendances primaires : RM-01 ; dépendance souple RM-03.
- Valeur métier attendue : intégrité du graphe CRM à l'échelle, opérations sûres.

## RM-05 — CRM Commercial / Prospection opérationnelle

- STATUS: PLANNED
- DEPENDS_ON: RM-04
- Objectif : outiller la prospection et le suivi commercial (pipeline, relances, sources, conversion).
- Pourquoi maintenant : s'appuie sur les opérations complexes du CRM.
- In scope : pipeline commercial, statuts prospect, relances, attribution, reporting de conversion.
- Out of scope : grilles partenaires B2B (RM-06), notifications généralistes (RM-10).
- Definition of Done : pipeline utilisable en Production, conversion mesurable, tests passés.
- Dépendances primaires : RM-04.
- Valeur métier attendue : pilotage de l'acquisition commerciale.

## RM-06 — Positionnement commercial B2B + grilles partenaires

- STATUS: PLANNED
- DEPENDS_ON: RM-05
- Objectif : offre B2B dédiée — grilles partenaires, tarifs volume, contrats, remises pro, facturation centralisée, multi-sites.
- Pourquoi maintenant : nécessite le CRM commercial opérationnel ; logique strictement séparée des packs B2C (cf. DEC-012).
- In scope : modèle tarifaire B2B, comptes partenaires, conditions spécifiques, grille de négociation.
- Out of scope : portail client B2B (RM-12), e-invoicing (RM-09).
- Definition of Done : grilles B2B configurables et appliquées, séparation B2C/B2B démontrée.
- Dépendances primaires : RM-05.
- Valeur métier attendue : ouverture du canal B2B à revenus récurrents.

## RM-07 — Optimisation opérationnelle des missions

- STATUS: PLANNED
- DEPENDS_ON: RM-03
- Objectif : optimiser la rentabilité des missions et la logistique des trajets (approche, retour, transports secondaires).
- Pourquoi maintenant : l'optimisation de marge nécessite le Pricing Engine V2.
- In scope : trajet d'approche, retour, options bus/train et transports secondaires, péages vs sans péage, itinéraires hybrides, carburant, kilomètres supplémentaires, temps de conduite, pauses/marge temporelle, hôtel lorsque pertinent, contrainte de date limite de livraison, coût opérationnel estimé vs réel, profit net attendu.
- Out of scope : affectation de convoyeurs externes (hors priorité actuelle, gouverné par RM-15 / DEC-017) ; application convoyeur dédiée (RM-15).
- Definition of Done : indicateurs coût/marge par mission disponibles, comparaison estimé vs réel, gains mesurés.
- Dépendances primaires : RM-03.
- Valeur métier attendue : rentabilité opérationnelle accrue.

## RM-08 — Devis → Mission V2 / workflow commercial complet

- STATUS: PLANNED
- DEPENDS_ON: RM-03, RM-04, RM-05
- Objectif : refonte du flux devis → acceptation → mission → clôture, intégrant pricing V2, packs et CRM.
- Pourquoi maintenant : point de convergence du pricing, du CRM et du pipeline commercial.
- In scope : nouveau parcours devis, transitions d'état transactionnelles, prix figés, traçabilité complète.
- Out of scope : facturation/e-invoicing (RM-09).
- Definition of Done : flux complet testé de bout en bout, prix figé respecté, aucune régression.
- Dépendances primaires : RM-03, RM-04, RM-05.
- Valeur métier attendue : parcours commercial unifié, taux de conversion amélioré.

## RM-09 — Facturation / Finance / Indy / e-invoicing readiness

- STATUS: PLANNED
- DEPENDS_ON: RM-08
- Objectif : chaîne de facturation complète et préparation conformité e-invoicing (intégration Indy ou équivalent).
- Pourquoi maintenant : nécessite le workflow mission V2 stabilisé comme source de facturation.
- In scope : génération factures, exports comptables, readiness e-invoicing, numérotation et archivage.
- Out of scope : refonte pricing (RM-03).
- Definition of Done : facture générée depuis mission clôturée, exports comptables validés.
- Dépendances primaires : RM-08.
- Valeur métier attendue : conformité, réduction du travail administratif.

## RM-10 — Notifications et automatisations métier

- STATUS: PLANNED
- DEPENDS_ON: RM-05, RM-08
- Objectif : notifications transactionnelles et automatisations (relances, statuts, alertes internes).
- Pourquoi maintenant : les événements sources (pipeline, workflow mission) doivent exister d'abord.
- In scope : emails/SMS transactionnels, déclencheurs métier, préférences utilisateurs, journalisation.
- Out of scope : marketing automation externe (RM-17).
- Definition of Done : notifications fiables sur événements clés, pas de doublons, opt-out respecté.
- Dépendances primaires : RM-05, RM-08.
- Valeur métier attendue : réactivité commerciale et opérationnelle.

## RM-11 — AI BOOST — IA métier intégrée

- STATUS: PLANNED
- DEPENDS_ON: RM-03, RM-05, RM-07, RM-08
- Objectif : assistance IA embarquée (recommandations tarifaires, qualification prospects, aide opérationnelle).
- Pourquoi maintenant : l'IA doit s'appuyer sur des règles et données stabilisées ; jamais source de vérité (cf. DEC-016).
- In scope : recommandations assistées, résumés, suggestions d'action, garde-fous déterministes.
- Out of scope : décisions automatiques non supervisées sur prix ou état métier.
- Definition of Done : recommandations traçables, état métier inchangé sans validation serveur.
- Dépendances primaires : RM-03, RM-05, RM-07, RM-08.
- Valeur métier attendue : productivité équipe, qualité de décision.

## RM-12 — Portail Client B2B

- STATUS: PLANNED
- DEPENDS_ON: RM-06, RM-08, RM-09, RM-10
- Objectif : portail self-service pour clients B2B (devis, commandes, suivi, factures).
- Pourquoi maintenant : requiert offre B2B, workflow mission V2, facturation et notifications.
- In scope : comptes multi-utilisateurs, suivi missions, historique factures, demandes en ligne.
- Out of scope : application mobile (RM-13).
- Definition of Done : parcours B2B complet en self-service sur le backend partagé (cf. DEC-015).
- Dépendances primaires : RM-06, RM-08, RM-09, RM-10.
- Valeur métier attendue : rétention et volume B2B.

## RM-13 — Application mobile Client

- STATUS: PLANNED
- DEPENDS_ON: RM-12
- Objectif : application mobile client (suivi, notifications, documents).
- Pourquoi maintenant : réutilise les API du portail B2B et du backend partagé.
- In scope : suivi mission temps réel, notifications push, accès documents.
- Out of scope : fonctionnalités convoyeur (RM-15).
- Definition of Done : app publiée, parcours suivi complet sur API existantes.
- Dépendances primaires : RM-12.
- Valeur métier attendue : expérience client différenciante.

## RM-14 — Admin V2 / logiciel d'exploitation

- STATUS: PLANNED
- DEPENDS_ON: RM-03, RM-04, RM-08, RM-09, RM-10
- Objectif : console d'exploitation complète (missions, CRM, pricing, finance, notifications).
- Pourquoi maintenant : consolidation de l'ensemble des briques livrées.
- In scope : refonte UX admin, vues d'exploitation, contrôle des règles tarifaires et packs.
- Out of scope : nouvelles règles métier.
- Definition of Done : opérations quotidiennes réalisables depuis Admin V2 sans contournement.
- Dépendances primaires : RM-03, RM-04, RM-08, RM-09, RM-10.
- Valeur métier attendue : efficacité opérationnelle, réduction des erreurs manuelles.

## RM-15 — Application Convoyeur

- STATUS: PLANNED
- DEPENDS_ON: RM-08
- PRIORITY_CONDITION: uniquement lorsque le réseau de convoyeurs externes devient opérationnellement pertinent (cf. DEC-017).
- Objectif : application dédiée convoyeurs (missions, EDL, suivi).
- Pourquoi maintenant : dépend du workflow mission V2 ; priorité conditionnée au besoin réseau.
- In scope : acceptation mission, EDL mobile, preuves, navigation.
- Out of scope : réseau externe non validé.
- Definition of Done : cycle mission complet réalisable depuis l'app convoyeur.
- Dépendances primaires : RM-08.
- Valeur métier attendue : passage à l'échelle du réseau de convoyage.

## RM-16 — BI / pilotage avancé

- STATUS: PLANNED
- DEPENDS_ON: RM-08, RM-09
- Objectif : tableaux de bord décisionnels (CA, marge, conversion, opérations).
- Pourquoi maintenant : nécessite des données fiables issues du workflow V2 et de la facturation.
- In scope : KPIs consolidés, exports, analyse par segment.
- Out of scope : data warehouse externe (évaluation ultérieure).
- Definition of Done : KPIs fiables et réconciliés avec les sources.
- Dépendances primaires : RM-08, RM-09.
- Valeur métier attendue : pilotage factuel de l'activité.

## RM-17 — SEO / acquisition / commercial terrain

- STATUS: PARALLEL
- TYPE: PARALLEL_BUSINESS_STREAM
- Objectif : flux continu d'acquisition — SEO, contenu, commercial terrain.
- Pourquoi maintenant : indépendant des jalons techniques ; tourne en parallèle.
- In scope : pages SEO, contenu, campagnes locales, prospection terrain.
- Out of scope : dépendances bloquantes sur la roadmap technique.
- Definition of Done : flux d'acquisition mesuré en continu.
- Dépendances primaires : aucune (flux parallèle).
- Valeur métier attendue : volume de leads.

## RM-18 — Vision plateforme / holding

- STATUS: LATER
- TYPE: LONG_TERM
- Objectif : vision long terme — plateforme multi-services et structure holding.
- Pourquoi plus tard : prématuré tant que le cœur convoyage/CRM/pricing n'est pas mature.
- In scope : explorations, options stratégiques.
- Out of scope : engagements d'implémentation.
- Definition of Done : non applicable à ce stade.
- Dépendances primaires : maturité des chantiers précédents.
- Valeur métier attendue : options de croissance long terme.
