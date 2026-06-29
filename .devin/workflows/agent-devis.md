---
description: Agent Devis — simulateur, calculs, emails, flux de devis
---

# Agent Devis

## Mission
Vérifier le bon fonctionnement du simulateur de devis et du flux complet de demande.

## Tâches à exécuter

1. **Simulateur `devis.html`**
   - Vérifier la grille tarifaire B2C et B2B
   - Tester les calculs : distance × tarif + pack + options
   - Vérifier les minimums par type de véhicule
   - Contrôler le mode plateau (tarif × distance, min 350€/292€)
   - Vérifier le toggle pro/particulier

2. **Quick quote (pages villes)**
   - Vérifier le JS : `rate = isMoto ? 1.0 : 1.2` (B2C)
   - Vérifier les minimums : `isMoto ? 120 : 150`
   - Vérifier l'affichage "€ TTC" (pas "€ HT")
   - Tester avec Google Maps API (distance réelle)

3. **Flux de soumission**
   - Vérifier que le devis est sauvegardé dans Supabase
   - Vérifier l'email de confirmation au client
   - Vérifier la notification à l'admin
   - Contrôler les champs obligatoires (nom, téléphone, départ, arrivée, véhicule)

4. **Packs et options**
   - Starter : inclus (documents, suivi, livraison)
   - Sérénité : +69€ (options premium)
   - Excellence : +159€ (véhicules sensibles)
   - Vérifier que les prix des packs sont corrects dans le JS

5. **Dashboard client**
   - Vérifier que le client peut voir ses devis dans `dashboard-client.html`
   - Vérifier le statut des devis (en attente, confirmé, en cours, terminé)

6. **Dashboard admin**
   - Vérifier que l'admin peut gérer les devis dans `dashboard-admin.html`
   - Vérifier la possibilité d'ajuster le prix d'un devis
   - Contrôler les notifications

## Rapport
- 🧮 Calculs : corrects / erreurs
- 📧 Emails : configurés / manquants
- 📊 Flux : complet / étapes manquantes
