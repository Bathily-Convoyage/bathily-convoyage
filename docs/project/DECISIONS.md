# Bathily-Convoyage — Decisions

Journal des décisions durables : architecture, métier, gouvernance.

Liens :
- Plan : [ROADMAP.md](ROADMAP.md)
- État courant : [CURRENT_STATE.md](CURRENT_STATE.md)

## Règles

- Les IDs (DEC-XXX) sont stables et ne doivent jamais être renumérotés.
- Une décision remplacée est marquée `SUPERSEDED` avec référence à la nouvelle décision ; jamais supprimée.

---

## DEC-001 — Local-first development

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: tout chantier suit le flux Audit → implémentation locale → tests → revue → GO explicite utilisateur → action remote.
- Rationale: maîtriser le risque Production et conserver la traçabilité des validations.
- Consequences: aucune action remote sans gate explicite ; le travail local est la norme.

## DEC-002 — Remote action authorization

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: aucun push, merge de PR, migration Production, écriture Production, déploiement, changement de secret, cron, Worker, Cloudflare ou modification d'infrastructure sans autorisation explicite de l'utilisateur.
- Rationale: protection de la Production et des secrets.
- Consequences: les tâches se terminent par un rapport local et un gate de revue.

## DEC-003 — Devin prompt language

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: les prompts techniques sont rédigés principalement en anglais. Le français est conservé pour les règles métier exactes, les noms commerciaux et les libellés UI utilisateur.
- Rationale: précision technique et fidélité métier.
- Consequences: documentation de gouvernance en français acceptable ; identifiants techniques en anglais.

## DEC-004 — Roadmap IDs are immutable

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: les IDs de roadmap ne sont jamais renumérotés après publication ; les insertions utilisent des suffixes (RM-02A...). Même règle pour DEC-XXX.
- Rationale: stabilité des références croisées entre documents et sessions.
- Consequences: diffs Git lisibles, historique préservé.

## DEC-005 — One major chantier = one dedicated branch

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: un chantier majeur = une branche dédiée ; ne pas réutiliser une branche d'un chantier précédent par défaut. Un scope, une branche, une chaîne de PR claire.
- Rationale: lisibilité des PR, rollback propre, audit facile.
- Consequences: branches nommées par chantier.

## DEC-006 — Source-of-truth hierarchy

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: hiérarchie des sources de vérité — ChatGPT : gouvernance roadmap / audits / gates ; Git : état durable du projet / décisions / roadmap ; Devin : exécution bornée.
- Rationale: séparer gouvernance, persistance et exécution.
- Consequences: ROADMAP.md/CURRENT_STATE.md/DECISIONS.md dans Git font foi pour l'état durable.

## DEC-007 — B2C base price

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: le prix de base B2C reste 1.20 €/km comme baseline de référence.
- Rationale: référence tarifaire métier validée.
- Consequences: tout ajustement se fait via DEC-009, jamais en modifiant la base.

## DEC-008 — No automatic summer surcharge

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: la majoration automatique +15% été/haute saison est supprimée.
- Rationale: positionnement commercial validé dans RM-02.
- Consequences: la saisonnalité est gérée manuellement via l'ajustement global Admin (DEC-009).

## DEC-009 — Global pricing adjustment

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: ajustement global manuel en pourcentage, contrôlé par l'Admin, positif ou négatif. Ne mute jamais le prix de base ; 0% restaure le prix de référence. Doit rester distinct des remises commerciales, codes promo, tarifs B2B, packs et options.
- Rationale: flexibilité tarifaire sans toucher à la baseline (DEC-007).
- Consequences: champ d'ajustement séparé dans le moteur de prix (RM-03).

## DEC-010 — B2C packs

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: packs B2C — Essentiel inclus ; Sérénité +69 € ; Excellence +149 €. Contenus définis dans la référence métier RM-02.
- Rationale: structure commerciale validée.
- Consequences: tout changement de contenu/prix respecte l'invariant de prix figé (DEC-013).

## DEC-011 — Baseline professionalism cannot be upsold

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: sécurité, preuve, photos EDL, traçabilité et professionnalisme de base restent inclus dans Essentiel et ne peuvent devenir des arguments d'upsell.
- Rationale: éthique commerciale et positionnement premium réel (DEC-020).
- Consequences: les packs premium vendent confort/temps/flexibilité, jamais la sécurité.

## DEC-012 — B2B pricing separate from B2C packs

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: le pricing B2B utilise une logique dédiée (grilles partenaires, volume, contrats, remises pro, facturation centralisée, multi-sites), strictement séparée des packs B2C.
- Rationale: modèles commerciaux différents.
- Consequences: RM-06 implémente un modèle tarifaire B2B propre.

## DEC-013 — Frozen quote/mission pricing

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: les changements de configuration tarifaire ne modifient jamais rétroactivement un devis ou un prix de mission déjà figé, sauf règle métier future explicite.
- Rationale: intégrité contractuelle et comptable.
- Consequences: le moteur de prix snapshot les paramètres au moment du figeage.

## DEC-014 — CRM critical mutations

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: les opérations CRM structurelles complexes utilisent des RPC transactionnelles côté serveur plutôt que des écritures frontend dispersées.
- Rationale: atomicité, intégrité du graphe CRM, audit trail.
- Consequences: ce pattern est déjà utilisé pour certaines mutations sensibles et devient obligatoire pour les opérations structurelles complexes de RM-04. Les CRUD métier simples peuvent rester sous RLS directe lorsqu'ils sont explicitement autorisés et audités.

## DEC-015 — Shared backend future architecture

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: web public, Admin, portail B2B, mobile Client et mobile Convoyeur réutilisent au maximum le même backend, règles métier, auth/permissions et APIs.
- Rationale: cohérence métier et coût de maintenance.
- Consequences: oriente RM-12, RM-13, RM-14, RM-15.

## DEC-016 — AI is not source of truth

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: l'IA peut assister et recommander, mais l'état et les règles métier restent déterministes et contrôlés côté serveur.
- Rationale: fiabilité et auditabilité.
- Consequences: RM-11 limite l'IA aux recommandations traçables.

## DEC-017 — Convoyeurs externes

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: l'expansion vers des convoyeurs externes reste désactivée/non prioritaire jusqu'à validation d'un besoin opérationnel.
- Rationale: éviter la complexité prématurée.
- Consequences: RM-15 conditionné par PRIORITY_CONDITION.

## DEC-018 — Production smoke tests

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: lorsque faisable, les smoke tests Production utilisent des données synthétiques dans des transactions de rollback explicites ; aucun résidu synthétique toléré.
- Rationale: propreté des données Production.
- Consequences: checklists de smoke incluent vérification d'absence de résidu.

## DEC-019 — Migration traceability

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: les versions de migration du dépôt et l'historique des migrations Production doivent rester alignés ; tout drift est audité et réparé avant clôture.
- Rationale: reproductibilité de l'état base de données.
- Consequences: vérification d'alignement intégrée aux gates de clôture (cf. P3C2).

## DEC-020 — Commercial positioning

- Status: ACCEPTED
- Date: 2026-09-11
- Decision: Bathily-Convoyage se positionne comme une alternative aux grandes plateformes — plus directe, plus flexible, technologiquement solide et compétitive — sans positionnement low-cost.
- Rationale: positionnement commercial validé.
- Consequences: guide RM-02 et le contenu des packs premium (DEC-010, DEC-011).
