---
description: Agent Technique — performances, uptime, erreurs 404, builds
---

# Agent Technique

## Mission
Assurer la stabilité technique du site : performances, disponibilité, et absence d'erreurs.

## Tâches à exécuter

1. **Erreurs 404**
   - Scanner tous les liens internes dans les fichiers HTML
   - Vérifier que chaque `href` pointe vers un fichier existant
   - Vérifier les liens vers les assets (CSS, JS, images)
   - Contrôler le fichier `404.html` s'il existe

2. **Performance**
   - Vérifier le poids des pages (HTML, CSS, JS)
   - Vérifier que les images sont optimisées (pas de PNG > 1MB non justifié)
   - Contrôler le lazy loading des images
   - Vérifier le minification CSS/JS

3. **Build et déploiement**
   - Vérifier `netlify.toml` ou configuration Netlify
   - Vérifier que les fonctions Netlify sont à jour
   - Contrôler les variables d'environnement
   - Vérifier le domaine personnalisé (bathily-convoyage.fr)

4. **Dépendances**
   - Vérifier `package.json` : versions à jour, pas de vulnérabilités
   - Lancer `npm audit` si possible
   - Vérifier Puppeteer, Supabase, Stripe (si utilisé)

5. **Scripts**
   - Vérifier `scripts/schedule-juillet-2026.js` : pas de `shareNow`
   - Vérifier qu'aucun script temporaire n'est resté dans `netlify/functions/`
   - Contrôler les scripts de génération PNG

6. **Base de données (Supabase)**
   - Vérifier la connexion Supabase
   - Contrôler les tables : devis, users, missions, published-dates
   - Vérifier les RLS policies

7. **PWA**
   - Vérifier `manifest.json` : nom, icônes, couleur
   - Vérifier le service worker si présent
   - Contrôler le favicon sur toutes les pages

## Rapport
- 🔗 Liens cassés : X trouvés
- ⚡ Score performance : estimé
- 📦 Dépendances : vulnérabilités
- 🚀 Build : OK / erreurs
