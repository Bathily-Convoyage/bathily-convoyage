# Tests Playwright — Bathily-Convoyage

## Prérequis

1. Copier `tests.env.example` vers `.env` à la racine du projet
2. Remplir les variables avec les credentials de test et les clés Supabase

## Installation

```bash
npm install
npx playwright install
```

## Lancer les tests

```bash
npm test
```

ou avec l'interface visuelle :

```bash
npm run test:ui
```

## Voir le rapport HTML

```bash
npm run test:report
```

## Structure

- `helpers.js` — fonctions utilitaires Supabase
- `rls-security.spec.js` — tests directs de la sécurité RLS / RPC
- `public-forms.spec.js` — tests des formulaires publics
- `dashboard-auth.spec.js` — tests de connexion aux dashboards

## Important

Les tests utilisent des comptes de test. **Ne jamais utiliser de vrais comptes clients/convoyeurs.**
