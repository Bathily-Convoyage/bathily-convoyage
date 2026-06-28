# Système de Design - Bathily Convoyage v2

Ce document présente les directives de style, la palette de couleurs et les composants réutilisables de la charte graphique **Bathily Convoyage v2** pour assurer la cohérence visuelle sur tout le site.

Tous ces éléments sont centralisés dans le fichier [design-system.css](file:///c:/Users/bathi/Desktop/SITE%20DEFINITIF%20BATHILY-CONVOYAGE/css/design-system.css).

---

## 1. Palette de Couleurs

| Variable | Couleur | Code Hexa | Usage |
| :--- | :--- | :--- | :--- |
| `--primary` | Bleu Brand | `#0A4D68` | Titres, headers, éléments de marque majeurs. |
| `--secondary` | Cyan GPS | `#088395` | Badges, suivi GPS, éléments de réassurance technologique. |
| `--accent` | Jaune/Or | `#F5A623` | Boutons d'appel à l'action (CTA), éléments d'attention (Pulse). |
| `--text` | Gris Neutre | `#6B625A` | Corps de texte et descriptions secondaires. |

---

## 2. Typographie

*   **Titres & Logos** : `Montserrat` (poids 500, 600, 700, 800)
*   **Corps de texte & Formulaires** : `Inter` (poids 300, 400, 500, 600, 700)

Les polices sont automatiquement chargées en tête du fichier CSS centralisé via Google Fonts.

---

## 3. Composants Réutilisables

### A. Bouton Principal (`.btn-primary`)
Bouton jaune/or vibrant avec effet d'animation "pulse" en CSS pur pour optimiser le taux de conversion des CTA.

```html
<a href="devis.html" class="btn-primary">
  <i class="fas fa-calculator"></i> Estimer mon prix →
</a>
```

### B. Badge de Confiance GPS (`.badge-trust`)
Badge cyan à utiliser en sous-titre pour valoriser les fonctionnalités de suivi en direct.

```html
<div class="badge-trust">📍 Suivi GPS en temps réel</div>
```

### C. Onglets de Choix de Véhicule (`.veh-tabs`)
Composant d'onglets pour remplacer les listes déroulantes de type select. Nécessite la fonction JavaScript `setVehType`.

```html
<input type="hidden" id="vehType" value="Automobile">
<div class="veh-tabs">
  <button type="button" class="veh-tab active" data-value="Automobile" onclick="setVehType('Automobile')">🚗 Auto</button>
  <button type="button" class="veh-tab" data-value="Moto" onclick="setVehType('Moto')">🏍 Moto</button>
</div>
```

### D. Bouton d'Appel Mobile Sticky (`.sticky-call-mobile`)
Bouton circulaire flottant fixe en bas à droite sur mobile pour faciliter le contact téléphonique direct. Masqué automatiquement sur desktop.

```html
<a href="tel:0758362249" class="sticky-call-mobile" aria-label="Appeler Bathily Convoyage">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
  </svg>
</a>
```

### E. Effet de Cartes Dynamiques (`.card-hover`)
Effet de survol fluide augmentant l'ombre portée et déplaçant la carte légèrement vers le haut.

```html
<div class="service-card card-hover">
  <!-- Contenu de la carte -->
</div>
```
