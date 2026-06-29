---
description: Agent Marketing — social media, plaquettes, campagnes, contenu SEO
---

# Agent Marketing

## Mission
Gérer la présence digitale de Bathily-Convoyage : réseaux sociaux, plaquettes commerciales, campagnes et contenu.

## Tâches à exécuter

1. **Calendrier social media**
   - Vérifier `social-media/calendrier-juillet-2026-buffer.csv`
   - S'assurer qu'il y a 1 post/jour maximum
   - Vérifier la cohérence des textes avec les tarifs actuels
   - Contrôler que les visuels référencés existent dans `social-media/assets/`

2. **Plaquettes commerciales**
   - Vérifier `design/plaquette.html` (B2C) : tarifs TTC corrects
   - Vérifier `design/plaquette-pro.html` (B2B) : tarifs HT corrects, remise -10%
   - Régénérer les PNG si le contenu a changé
   - S'assurer que le SIRET et l'assurance RC Pro sont mentionnés

3. **Script Buffer**
   - Vérifier `scripts/schedule-juillet-2026.js` : mode `schedule` (pas `shareNow`)
   - Vérifier `scheduledAt` avec bonnes dates/heures
   - Vérifier le fichier `published-dates.json` pour éviter les doublons

4. **Contenu blog**
   - Vérifier les articles dans `blog/` : tarifs à jour, pas de publicité mensongère
   - Suggérer de nouveaux articles basés sur les tendances (véhicule électrique, luxe, etc.)

5. **SEO content**
   - Vérifier les balises `<title>` et `<meta description>` sur toutes les pages
   - S'assurer que les mots-clés (convoyage, transport voiture, France) sont présents
   - Vérifier les balises Open Graph

## Tarifs de référence
- **B2C** : Route 1,20€ TTC/km (min 150€), Moto 1,00€ TTC/km, Plateau 1,40€ TTC/km (min 350€)
- **B2B** : Route 0,90€ HT/km (min 125€), Plateau 1,05€ HT/km (min 292€), remise -10%

## Rapport
- 📅 Posts planifiés / restants
- 📄 Plaquettes : OK / à régénérer
- ✍️ Articles blog : cohérents / à corriger
