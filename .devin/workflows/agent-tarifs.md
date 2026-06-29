---
description: Agent Tarifs — cohérence des prix sur tout le site (B2C TTC et B2B HT)
---

# Agent Tarifs

## Mission
Vérifier que les tarifs sont cohérents sur l'ensemble du site : pages publiques (B2C TTC), espace pro (B2B HT), plaquettes, blog, simulateur.

## Grille tarifaire de référence

### B2C (TTC) — pages publiques
| Véhicule | Route | Plateau | Minimum route | Minimum plateau |
|-----------|-------|---------|---------------|-----------------|
| Automobile | 1,20€ TTC/km | 1,40€ TTC/km | 150€ TTC | 350€ TTC |
| Moto | 1,00€ TTC/km | 1,20€ TTC/km | 120€ TTC | 350€ TTC |
| Utilitaire | 1,40€ TTC/km | 1,60€ TTC/km | 150€ TTC | 350€ TTC |
| Luxe | 1,80€ TTC/km | 2,00€ TTC/km | 150€ TTC | 350€ TTC |

### B2B (HT, remise -10%) — espace pro
| Véhicule | Route | Plateau | Minimum route | Minimum plateau |
|-----------|-------|---------|---------------|-----------------|
| Automobile | 0,90€ HT/km | 1,05€ HT/km | 125€ HT | 292€ HT |
| Moto | 0,77€ HT/km | 0,90€ HT/km | 100€ HT | 292€ HT |
| Utilitaire | 1,15€ HT/km | 1,20€ HT/km | 125€ HT | 292€ HT |
| Luxe | 1,50€ HT/km | 1,50€ HT/km | 125€ HT | 292€ HT |

### Packs
- Starter : inclus
- Sérénité : +69€
- Excellence : +159€

## Tâches à exécuter

1. **Scanner toutes les pages HTML**
   - Chercher : `1,00 € HT`, `0,85 € HT`, `0,80€`, `120€ HT`, `forfait 350€ HT`
   - Ces anciens tarifs ne doivent plus apparaître nulle part
   - Si trouvés → corriger vers les tarifs B2C TTC

2. **Vérifier `index.html`**
   - Price cards : route 1,20€ TTC, plateau 1,40€ TTC
   - FAQ : pas de mention HT
   - Simulateur quick quote : rate 1.2 (auto) / 1.0 (moto), min 150/120

3. **Vérifier `espace-pro.html`**
   - Price cards : route 0,90€ HT, plateau 1,05€ HT
   - Mention remise -10% et TVA récupérable

4. **Vérifier `devis.html`**
   - Grille B2C et B2B complète par type de véhicule
   - Fallback plateau rate : 1.40 (pas 0.80)

5. **Vérifier les pages villes (39 fichiers)**
   - Service cards : 1,20€ TTC/km (auto), 1,00€ TTC/km (moto)
   - Price cards : 1,20€ TTC, plateau 1,40€ TTC
   - Simulateur JS : rate 1.2/1.0, min 150/120
   - FAQ : tarifs TTC uniquement

6. **Vérifier les plaquettes**
   - `design/plaquette.html` : tarifs TTC
   - `design/plaquette-pro.html` : tarifs HT + remise -10%

7. **Vérifier le blog**
   - `blog/convoyage-ou-transport-camion.html` : plateau 1,40€ TTC/km
   - `blog/convoyage-vehicule-electrique.html` : route 1,20€ TTC/km

## Rapport
- ✅ Fichiers conformes : X
- ❌ Fichiers à corriger : X (lister les erreurs exactes)
- 📊 Tableau de cohérence B2C vs B2B
