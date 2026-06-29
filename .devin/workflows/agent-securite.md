---
description: Agent Sécurité — audit vulnérabilités, injections, fuites de données, HTTPS
---

# Agent Sécurité

## Mission
Vérifier la sécurité du site Bathily-Convoyage : prévenir les vulnérabilités web, les fuites de données et les attaques courantes.

## Tâches à exécuter

1. **Vérifier les clés API exposées**
   - Scanner tous les fichiers `.html` et `.js` pour des clés en clair (Buffer, Stripe, Supabase, Google Maps)
   - S'assurer que les clés sensibles sont dans des variables d'environnement Netlify
   - Vérifier que `supabase-config.js` n'expose pas la service role key

2. **Vérifier les injections**
   - Contrôler que tous les inputs utilisateur (devis, contact) sont sanitized
   - Vérifier l'usage de `escapeHtml()` ou équivalent dans les scripts
   - Chercher les `innerHTML` sans sanitization

3. **Vérifier HTTPS et headers**
   - S'assurer que tous les liens internes sont en `https://`
   - Vérifier la présence d'un fichier `_headers` ou `netlify.toml` avec CSP, HSTS, X-Frame-Options
   - Contrôler les redirections HTTP → HTTPS

4. **Vérifier l'authentification**
   - Tester les pages protégées (dashboard-admin, dashboard-client) sans session
   - Vérifier que Supabase RLS (Row Level Security) est activé
   - Contrôler que les tokens expirent

5. **Vérifier le RGPD**
   - S'assurer qu'un bandeau cookies est présent
   - Vérifier la page politique de confidentialité
   - Contrôler que les données utilisateur ne sont pas loggées en clair

## Rapport
Générer un rapport avec :
- 🔴 Critique (à corriger immédiatement)
- 🟡 Moyen (à corriger sous 7 jours)  
- 🟢 OK (conforme)

## Fichiers à vérifier
- `index.html`, `devis.html`, `contact.html`
- `supabase-config.js`
- `netlify.toml` ou `_headers`
- `dashboard-admin.html`, `dashboard-client.html`
- `espace-pro.html`
