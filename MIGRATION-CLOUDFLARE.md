# Migration Netlify → Cloudflare Pages

## Pourquoi migrer ?

Netlify : limite de build minutes atteinte (jusqu'au 12 juillet).
Cloudflare Pages : **gratuit, illimité**, SSL automatique, CDN mondial, fonctions serverless.

## Structure créée

```
functions/
  _utils.js              → Helper partagé (CORS, rate limit, parse body)
  _routes.json           → Routing Cloudflare
  api/
    client-signup.js     → Inscription client/pro
    send-email.js        → Envoi emails (devis, paiement, candidature, etc.)
    admin-create-user.js → Création utilisateur (admin)
    approve-convoyeur.js → Validation candidat convoyeur
    client-reset-password.js  → Reset mot de passe client
    convoyeur-reset-password.js → Reset mot de passe convoyeur
    create-checkout-session.js → Session paiement Stripe
    stripe-webhook.js    → Webhook Stripe
    lookup-vehicle.js    → Recherche plaque SIV
    cron-relances.js     → Relances automatiques
    send-campagne.js     → Newsletter
wrangler.toml            → Configuration Cloudflare
```

## URLs modifiées

Toutes les URLs `/.netlify/functions/X` ont été remplacées par `/api/X` dans :
- `dashboard-admin.html` (13 occurrences)
- `dashboard-client.html` (3)
- `devis.html` (2)
- `etat-des-lieux.html` (2)
- `espace-pro.html` (1)
- `formation-convoyeur.html` (1)
- `dashboard-convoyeur.html` (1)

## Étapes de déploiement

### 1. Créer un compte Cloudflare (gratuit)
- Aller sur https://dash.cloudflare.com/sign-up
- Créer un compte

### 2. Créer un projet Pages
- Aller dans **Workers & Pages** → **Create application** → **Pages**
- Connecter le repo GitHub : `Bathily-Convoyage/bathily-convoyage`
- Framework preset : **None** (site statique)
- Build command : (laisser vide)
- Build output directory : `/` (racine)
- Root directory : `/`

### 3. Configurer les variables d'environnement
Dans **Settings** → **Environment variables**, ajouter :

| Variable | Valeur |
|----------|--------|
| SUPABASE_URL | (valeur Netlify) |
| SUPABASE_SERVICE_ROLE_KEY | (valeur Netlify) |
| SUPABASE_ANON_KEY | (valeur Netlify) |
| STRIPE_SECRET_KEY | (valeur Netlify) |
| STRIPE_WEBHOOK_SECRET | (valeur Netlify) |
| RESEND_API_KEY | (valeur Netlify) |
| EMAIL_FROM | (valeur Netlify) |
| EMAIL_ADMIN | (valeur Netlify) |
| RAPIDAPI_KEY | (valeur Netlify) |
| CRON_SECRET | (valeur Netlify) |
| URL | https://bathily-convoyage.fr |

### 4. Déployer
- Cliquer **Save and Deploy**
- Le site sera accessible sur `https://bathily-convoyage.pages.dev`

### 5. Configurer le domaine personnalisé
- Dans **Custom domains** → **Set up a custom domain**
- Ajouter `bathily-convoyage.fr`
- Ajouter `www.bathily-convoyage.fr`
- Mettre à jour les DNS chez le registrar (Cloudflare guide automatiquement)
- Mettre à jour le webhook Stripe vers `https://bathily-convoyage.fr/api/stripe-webhook`

### 6. Configurer le cron (relances)
- Dans **Workers & Pages** → **Triggers** → **Cron Triggers**
- Expression : `0 8 * * *` (tous les jours à 8h00 UTC)
- URL : `/api/cron-relances`

## Notes importantes

- Les anciennes fonctions Netlify (`netlify/functions/`) sont conservées pour compatibilité
- Le site Netlify reste actif jusqu'au 12 juillet (mais ne peut pas être redéployé)
- Une fois Cloudflare configuré, basculer le DNS du domaine vers Cloudflare
- Stripe webhook : mettre à jour l'URL dans le dashboard Stripe
