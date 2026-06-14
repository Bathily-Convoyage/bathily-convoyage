# Audit UX Comparatif & Recommandations — Bathily Convoyage

Ce document présente un benchmark UX visuel des 5 principaux concurrents du convoyage de véhicules en France, afin d'aligner et d'optimiser l'expérience utilisateur et le taux de conversion du site **Bathily Convoyage** selon sa nouvelle charte graphique.

---

## 1. Analyse Individuelle des Concurrents

### 1. DriiveMe (`driiveme.com`)
*   **Hero Section** : 
    *   **H1** : Orienté double cible (B2C: déplacer sa voiture pour 1€ / B2B: logistique pro).
    *   **CTA** : Moteur d'estimation rapide intégré directement sous forme de formulaire horizontal ou vertical.
    *   **Visuel** : Route épurée en arrière-plan avec voiture stylisée.
    *   **Animation** : Effets de survol (hover) sur les boutons et cartes, transitions douces sur les champs de saisie.
*   **Trust Elements** : Note Trustpilot très visible avec étoiles jaunes, nombre total de transports réalisés (+1M), bandeau de logos partenaires.
*   **Micro-interactions** : Suggestions d'adresses en temps réel très rapides, tabs pour basculer entre "Particulier" et "Professionnel".
*   **Placement CTA** : CTA principal en plein milieu du Hero ("Estimer mon transport") et secondaire dans le header ("Devenir conducteur").
*   **Mobile UX** : Formulaire verticalisé compact, menu burger fluide, CTA principal restant facilement cliquable.
*   **Performance ressentie** : Rapide, mais le chargement des scripts de carte et de géolocalisation crée un léger retard d'interactivité (FID).

### 2. Hiflow (`hiflow.com`)
*   **Hero Section** :
    *   **H1** : "Le transport de vos véhicules en toute simplicité".
    *   **CTA** : Deux boutons distincts séparant les flux particuliers ("Estimer mon prix") et professionnels ("Espace Pro").
    *   **Visuel** : Layout split-screen avec photo de qualité professionnelle (un convoyeur prenant en charge un véhicule récent).
    *   **Animation** : Hover lift sur les cartes de formules de transport, fondu à l'apparition.
*   **Trust Elements** : Note Trustpilot (4.7/5), logos de grands comptes (Peugeot, Renault, Aramisauto), label de leader logistique.
*   **Micro-interactions** : Tabs interactifs et accordéons FAQ fluides.
*   **Placement CTA** : Un CTA principal par cible dans le Hero, bouton de rappel téléphonique dans le header.
*   **Mobile UX** : Menu collapsible propre, boutons larges adaptés au toucher, bouton de téléphone cliquable direct.
*   **Performance ressentie** : Excellente. Utilisation de formats d'images modernes (WebP), ce qui donne un LCP très bas.

### 3. Expedicar (`expedicar.com` / Division Hiflow Pro)
*   **Hero Section** :
    *   **H1** : Très orienté B2B et concessionnaires ("Simplifiez la logistique de vos véhicules").
    *   **CTA** : "Accéder au portail" / "Faire une simulation".
    *   **Visuel** : Capture d'écran de l'application de suivi de flotte et photo de camion de transport.
    *   **Animation** : Chargement progressif des éléments de statistiques (compteurs animés).
*   **Trust Elements** : Nombre de concessionnaires partenaires (+3 000), badges de certification de leurs convoyeurs, logo d'assurance Allianz.
*   **Micro-interactions** : Autocomplétion d'adresses intelligente, survol interactif des fonctionnalités de la plateforme.
*   **Placement CTA** : CTA principal centré sur l'inscription B2B, bouton de connexion client persistant dans le header.
*   **Mobile UX** : Champs de formulaires simplifiés à l'extrême, boutons larges.
*   **Performance ressentie** : Très réactif, structure orientée application web.

### 4. Shippr (`shippr.fr`)
*   **Hero Section** :
    *   **H1** : "Vos livraisons le jour même, simplifiées."
    *   **CTA** : "Simuler une livraison".
    *   **Visuel** : Graphismes vectoriels combinés à des photos de véhicules de livraison (vélos cargo, camionnettes).
    *   **Animation** : Effets de survol animés (pulsations) et transitions d'onglets instantanées.
*   **Trust Elements** : Logos clients prestigieux (Carrefour, Decathlon), badge d'écoresponsabilité, support client 7j/7.
*   **Micro-interactions** : Chatbot flottant réactif, slider de témoignages clients.
*   **Placement CTA** : CTA principal en couleur d'accentuation vive dans le Hero et bouton "Devenir partenaire" en haut à droite.
*   **Mobile UX** : Menu mobile ultra-fluide, bouton d'appel direct aux opérations.
*   **Performance ressentie** : Extrêmement rapide, très bon score Lighthouse grâce à une base JS allégée.

### 5. Cotransport (`cotransport.fr`)
*   **Hero Section** :
    *   **H1** : Axé sur le transport collaboratif ("Cotransportage de véhicules").
    *   **CTA** : "Déposer une annonce" ou "Trouver un trajet".
    *   **Visuel** : Carte de France stylisée ou photo d'autoroute.
    *   **Animation** : Presque aucune animation, design plus traditionnel et statique.
*   **Trust Elements** : Mention d'assurance MMA incluse, icônes de paiement sécurisé.
*   **Micro-interactions** : Formulaire d'estimation basique sans autocomplétion avancée.
*   **Placement CTA** : CTA primaires clairs mais visuellement datés.
*   **Mobile UX** : Formulaire fonctionnel mais moins ergonomique que les concurrents modernes.
*   **Performance ressentie** : Légère et rapide en raison du manque de scripts complexes, mais esthétique moins premium.

---

## 2. Tableau Comparatif

| Concurrent | Force UX #1 | Faiblesse | Anim utilisée | Score Perf estimé | À copier pour Bathily |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **DriiveMe** | Formulaire d'estimation ultra-direct | Dualité de cible un peu confuse au premier abord | Transitions de champs & Maps interactives | **78/100** | L'autocomplétion fluide de trajets |
| **Hiflow** | Segmentation parfaite Particulier / Pro | Nécessite plusieurs clics pour obtenir un prix | Hover lift & Fade-in progressive | **92/100** | L'intégration des logos B2B de réassurance |
| **Expedicar** | Clarté de la promesse B2B et outils pros | Trop austère pour un particulier | Compteurs de statistiques dynamiques | **88/100** | Le badge "Assurance Allianz" en évidence |
| **Shippr** | Design ultra-moderne et aéré | Pas centré exclusivement sur le convoyage auto | Carrousel fluide & effets de pulsation | **94/100** | Le widget flottant et la clarté du menu |
| **Cotransport**| Simplicité extrême de l'approche prix | Design vieillissant, manque de réassurance visuelle | Aucune (purement statique) | **85/100** | L'affichage du forfait minimum clair |

---

## 3. Recommandations UX pour Bathily Convoyage

### A. Top 3 Animations "Safe" (Lighthouse 90+)
1.  **Fade-in & Slide-up (IntersectionObserver)** :
    *   *Principe* : Apparition progressive des sections lors du défilement.
    *   *Avantage* : Utilise uniquement les propriétés CSS `opacity` et `transform`, gérées directement par le GPU (Hardware Accelerated). Impact LCP = 0ms.
2.  **Hover Lift sur les cartes de formules** :
    *   *Principe* : Élévation de la carte au survol (`transform: translateY(-5px)`) avec un ombrage plus prononcé.
    *   *Avantage* : 100% géré en CSS via `transition`, 0% de surcharge JavaScript.
3.  **Carrousel de témoignages natif (CSS Scroll Snap)** :
    *   *Principe* : Slider horizontal utilisant `scroll-snap-type: x mandatory` pour le glissement tactile.
    *   *Avantage* : Évite l'import de bibliothèques lourdes comme *Swiper* ou *Slick*, économisant 40kb de JS.

### B. Top 3 Sections à Ajouter
1.  **Section "Pourquoi nous choisir ?" (Pastilles de confiance)** :
    *   Grid de 4 icônes avec textes courts : Double Assurance Allianz (RC Pro), Convoyeurs agréés SIV, Suivi GPS en direct, Rapport photo EDL 20 points.
2.  **Section "Le convoyage en 3 étapes" (Processus visuel)** :
    *   Étape 1 : Demande de devis en 60s en ligne.
    *   Étape 2 : Prise en charge du véhicule avec état des lieux photos certifiées.
    *   Étape 3 : Suivi GPS en temps réel et livraison avec signature électronique.
3.  **Bandeau "Ils nous font confiance" (Logos B2B)** :
    *   Ligne de logos de partenaires (garages, concessions, gestionnaires de flotte) en gris clair transparent pour crédibiliser le service.

### C. Top 3 Interdits absolus
1.  **Vidéo d'arrière-plan en autoplay non optimisée** : Ralentit considérablement le premier rendu visuel (LCP).
2.  **Animations Lottie complexes ou de grande taille (>100kb)** : Bloquent le fil principal d'exécution du JavaScript (TBT).
3.  **Bibliothèques JS de slider ou d'animation tierces (jQuery, GSAP, Slick)** : Alourdissent inutilement la page. Tout doit être fait en Vanilla CSS/JS.

---

## 4. Quick Wins (< 1h de dev) pour booster la conversion

1.  **Sticky Call Button sur Mobile** :
    *   Ajouter un bouton flottant discret en bas à droite (uniquement sur mobile) avec un lien direct `tel:01XXXXXXXX` et une icône de téléphone, permettant de contacter un conseiller en un clic.
2.  **Bouton CTA principal avec pulsation subtile** :
    *   Appliquer une animation CSS `@keyframes pulse` sur le bouton "Demander un devis" du Hero avec la couleur d'accent `#F5A623` pour attirer le regard sans distraire l'utilisateur.
3.  **Optimisation du délai d'autocomplétion (Debounce)** :
    *   Ajuster le délai d'attente (debounce) de la recherche d'adresse (API Adresse Gouv) à 150ms pour afficher instantanément les suggestions dès la saisie.
4.  **Sélecteurs de type de véhicule avec icônes dynamiques (🚗/🏍️)** :
    *   Remplacer le menu déroulant classique par deux onglets larges cliquables pour pré-remplacer la sélection Automobile ou Moto.
5.  **Sauvegarde automatique des champs du devis (Auto-save)** :
    *   Sauvegarder les champs "Départ" et "Arrivée" dans le `localStorage` dès qu'ils sont modifiés, pour que le client retrouve sa saisie s'il quitte accidentellement la page.

---

## 5. Mockup Textuel : Hero v2 Bathily Convoyage

Ce mockup respecte la charte graphique : Bleu principal `#0A4D68`, Bleu secondaire `#088395`, Jaune accent `#F5A623`, polices **Montserrat** (Titres) et **Inter** (Corps).

```
========================================================================================
[HEADER]
  Bathily-Convoyage. (Logo: Montserrat Bold, #0A4D68, point en #F5A623)
  ------------------------------------------------------------------------------------
  [Accueil]   [Devenir convoyeur]   [Contact]   [Espace convoyeur]   [ESPACE CLIENT (Bouton outline #0A4D68)]
========================================================================================

[HERO SECTION - SPLIT SCREEN LAYOUT]

  (COLONNE GAUCHE - TEXTE & FORMULAIRE)
  -------------------------------------------------------------
  [BADGE REASSURANCE - #088395 avec texte blanc] 
  "📍 Suivi GPS en temps réel & Double Assurance Allianz"

  [TITRE H1 - Montserrat Bold, #0A4D68, taille 3.2rem]
  Convoyage Auto & Moto
  Partout en France.

  [SOUS-TITRE - Inter Regular, #6B625A, taille 1.1rem]
  Votre véhicule transporté en toute sécurité par des professionnels de la route.
  Devis gratuit en 60s.

  [FORMULAIRE DE DEVIS RAPIDE - Fond blanc, arrondi 28px, ombre subtile]
  -------------------------------------------------------------
  |  Sélectionnez :  [ 🚗 Automobile ]   [ 🏍️ Moto ]  (Onglets cliquables)  |
  |                                                           |
  |  Départ :   [ Saisissez une adresse... ]                   |
  |  Arrivée :  [ Saisissez une adresse... ]                   |
  |                                                           |
  |  [ ESTIMER MON PRIX ➔ ] (Bouton #F5A623, texte #0A4D68, Montserrat Bold, pulse) |
  -------------------------------------------------------------
  
  [TRUST STATS - Étoiles jaunes #F5A623]
  ⭐ 4.9/5 Google Reviews (basé sur +500 avis) | Assurance Allianz incluse

  (COLONNE DROITE - VISUEL CARTE INTERACTIVE LEAFLET)
  -------------------------------------------------------------
  [CARTE LEAFLET - Bordure arrondie 32px, ombre portée]
  -------------------------------------------------------------
  |  (Carte interactive affichant un tracé dynamique avec     |
  |   des marqueurs animés sur Paris, Lyon, Marseille)         |
  -------------------------------------------------------------

========================================================================================
[PARTNERS LOGO BAR - Bandeau horizontal gris très clair]
  "Ils nous font confiance :"  [Concession Renault]   [Garage Pro]   [Flotte Auto-Sérénité]
========================================================================================
```

---
*Ce benchmark et ces recommandations visent à maximiser la conversion en optimisant la performance technique et le design d'autorité de Bathily Convoyage.*
