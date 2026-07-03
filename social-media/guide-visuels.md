# Guide Visuels - Posts Instagram / TikTok / LinkedIn

## Objectif

Rendre les posts plus impactants et professionnels avec des carrousels, des templates cohérents et des vidéos.

---

## 1. Formats par plateforme

| Plateforme | Format recommandé | Ratio | Usage |
|------------|-------------------|-------|-------|
| Instagram (feed) | Carré ou vertical | 1080x1080 ou 1080x1350 | Carrousel, image simple |
| Instagram Reels | Vertical | 1080x1920 | Vidéo 15-30s |
| Instagram Story | Vertical | 1080x1920 | Story, sondage, lien |
| TikTok | Vertical | 1080x1920 | Vidéo 15-60s |
| LinkedIn | Paysage ou carré | 1200x627 ou 1080x1080 | Infographie, post pro |

---

## 2. Carrousel Instagram (3-5 slides)

Structure idéale d'un carrousel :

**Slide 1 : Accroche**
- Grand titre (3-5 mots)
- Visuel fort (route, véhicule, carte France)
- Couleurs de marque

**Slide 2 : Problème ou contexte**
- "Vous changez de ville ?"
- "Vous achetez un véhicule à distance ?"
- Photo illustrative

**Slide 3 : Solution / Avantage**
- "Bathily-Convoyage s'occupe de tout"
- 3 bénéfices en icônes (assurance, GPS, chauffeur pro)

**Slide 4 : Preuve sociale**
- "+1 200 clients satisfaits"
- "+50 convoyeurs certifiés"
- Étoiles, chiffres

**Slide 5 : Call-to-action**
- "Devis gratuit en 2 min"
- Lien clair : www.bathily-convoyage.fr/devis.html
- Logo + couleurs

---

## 3. Templates à créer dans Canva

Créer 3 templates de base réutilisables :

### Template A : Carrousel Instagram (1080x1350)
- Fond dégradé bordeaux/bleu
- Titre en Montserrat bold
- Sous-titre en Inter
- Placeholders pour 5 slides
- Logo en bas à droite

### Template B : Reels / TikTok (1080x1920)
- Fond dynamique (route, véhicule en mouvement)
- Texte court par plan (3-5 mots max)
- Musique rythmée
- Hook dans les 2 premières secondes
- CTA final : "Lien en bio"

### Template C : LinkedIn Pro (1200x627)
- Fond sobre blanc/gris clair
- Titre professionnel
- 3-4 points clés
- Logo Bathily-Convoyage
- CTA mesuré

---

## 4. Charte graphique rapide

| Élément | Valeur |
|---------|--------|
| Couleur principale | Bordeaux `#7A2E1A` |
| Couleur secondaire | Bleu `#0A4D68` |
| Accent | Or `#F5A623` |
| Typographie titre | Montserrat ExtraBold |
| Typographie texte | Inter |
| Logo | En bas à droite, 80% opacité |

---

## 5. Types de contenu par semaine

| Jour | Type | Format |
|------|------|--------|
| Lundi | Conseil / Astuce | Carrousel 5 slides |
| Mardi | Témoignage client | Image + citation |
| Mercredi | Avantages service | Carrousel 3 slides |
| Jeudi | Coulisse / convoyeur | Reel 15-30s |
| Vendredi | Promotion / CTA | Image impactante |
| Samedi | Destination / voyage | Carrousel 4-5 slides |
| Dimanche | Recap / inspiration | Story ou Reel |

---

## 6. Exemples de carrousels prêts à produire

### Carrousel 1 : "Pourquoi choisir un convoyage ?"
1. "Vous devez déplacer votre véhicule ?"
2. "Le train coûte cher et limite les dimensions"
3. "La route expose votre voiture à l'usure"
4. "Bathily-Convoyage : chauffeur pro, assurance, GPS"
5. "Devis gratuit en 2 min → www.bathily-convoyage.fr"

### Carrousel 2 : "3 packs pour tous les besoins"
1. "Quel pack choisir ?"
2. "Starter : essentiel, convoyeur certifié, suivi GPS"
3. "Sérénité : nettoyage, RDV planifié, support VIP"
4. "Excellence : plein carburant, photos 4K, livraison prioritaire"
5. "Comparez sur www.bathily-convoyage.fr/devis.html"

---

## 7. Structure JSON pour les posts améliorés

### Carrousel simple
```json
{
  "day": "Monday",
  "text": "🚗 3 raisons de choisir Bathily-Convoyage pour déplacer votre véhicule. Swipez →\n👉 https://www.bathily-convoyage.fr/devis.html",
  "media": [
    "https://www.bathily-convoyage.fr/images/social/carrousel-raison-1.jpg",
    "https://www.bathily-convoyage.fr/images/social/carrousel-raison-2.jpg",
    "https://www.bathily-convoyage.fr/images/social/carrousel-raison-3.jpg",
    "https://www.bathily-convoyage.fr/images/social/carrousel-raison-4.jpg"
  ]
}
```

### Vidéo / Reel / TikTok
```json
{
  "day": "Friday",
  "text": "🎥 De Paris à Marseille en convoyage : le trajet en 20 secondes.\n👉 https://www.bathily-convoyage.fr/devis.html",
  "media": [
    { "type": "video", "url": "https://www.bathily-convoyage.fr/videos/reel-paris-marseille.mp4" }
  ]
}
```

---

## 8. Outils recommandés

- **Canva** : templates, carrousels, infographies
- **CapCut** : montage Reels/TikTok
- **Adobe Express** : alternative à Canva
- **Unsplash / Pexels** : photos libres de routes et véhicules
- **Iconify / Flaticon** : icônes pour les carrousels

---

## 9. Prochaines étapes concrètes

1. Créer 2-3 templates Canva avec la charte graphique
2. Produire 7 carrousels (1 par jour de la semaine)
3. Produire 2-3 Reels courts
4. Uploader les visuels dans `images/social/` et `videos/`
5. Mettre à jour `social-posts.json` avec les nouveaux URLs
6. Tester avec `node scripts/post-to-buffer.js`

---

## 10. Dimensions à respecter

```
Instagram carré       : 1080 x 1080 px
Instagram vertical    : 1080 x 1350 px
Instagram Reel/Story  : 1080 x 1920 px
TikTok                : 1080 x 1920 px
LinkedIn paysage      : 1200 x 627 px
LinkedIn carré        : 1080 x 1080 px
```

Exporter en **JPG** pour les photos, **PNG** pour les graphiques avec texte, **MP4** pour les vidéos.
