---
description: Agent Comptable — devis, factures, TVA, marges, suivi financier
---

# Agent Comptable

## Mission
Assurer la cohérence financière : calculs de devis, TVA, marges et suivi des revenus.

## Tâches à exécuter

1. **Vérifier les calculs du simulateur de devis**
   - Ouvrir `devis.html` et vérifier la grille tarifaire
   - B2C : Route auto 1,20€ TTC, Moto 1,00€ TTC, Utilitaire 1,40€ TTC, Luxe 1,80€ TTC
   - B2C Plateau : Auto 1,40€ TTC, Moto 1,20€ TTC, Utilitaire 1,60€ TTC, Luxe 2,00€ TTC
   - B2B : mêmes tarifs -10% en HT (route auto 0,90€, plateau auto 1,05€, etc.)
   - Vérifier les minimums (route 150€ TTC / 125€ HT, plateau 350€ TTC / 292€ HT)
   - Vérifier les packs : Starter (inclus), Sérénité (+69€), Excellence (+159€)

2. **Vérifier la TVA**
   - Taux applicable : 20% (services de transport)
   - B2C : prix affichés TTC
   - B2B : prix affichés HT avec mention "TVA récupérable"
   - Vérifier la cohérence TTC = HT × 1,20

3. **Vérifier les marges**
   - Estimer le coût de revient : carburant (~0,15€/km), péages, convoyeur (~0,40-0,60€/km)
   - Calculer la marge brute par km pour chaque formule
   - Alerte si marge < 20%

4. **Vérifier les factures**
   - S'assurer que le SIRET (78928537600032) apparaît sur les factures
   - Vérifier la mention "TVA non applicable, art. 293 B du CGI" si franchise en base
   - Ou vérifier le numéro de TVA intracommunautaire si assujetti

5. **Suivi des devis**
   - Vérifier que les devis sont stockés dans Supabase
   - Contrôler le taux de conversion devis → mission

## Rapport
- 💰 Calculs corrects / erreurs détectées
- 📊 Marges par formule
- 🧾 Conformité TVA et facturation
