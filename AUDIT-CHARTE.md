# Audit de Conformité : Charte Graphique Bathily v2

Ce document dresse l'état des lieux des pages et des composants du site internet de Bathily Convoyage vis-à-vis de la nouvelle charte graphique v2 (primaire `#0A4D68`, secondaire `#088395`, accent `#F5A623`, police Montserrat/Inter).

---

## 1. Fichiers non conformes identifiés

### A. Pages Villes (12 fichiers)
Ces pages contiennent toutes l'import de la police *Plus Jakarta Sans* et les variables de l'ancienne charte (bordeaux `#7A2E1A` et jaune/orange `#E0A343`), ainsi qu'un sélecteur de véhicule classique à la place des onglets :
1. `convoyage-bordeaux.html`
2. `convoyage-lyon.html`
3. `convoyage-marseille.html`
4. `convoyage-montpellier.html`
5. `convoyage-moto-voiture-france.html` (liaison nationale)
6. `convoyage-moto-voiture-paris.html`
7. `convoyage-toulouse.html`
8. `convoyage-vehicule-lille.html`
9. `convoyage-vehicule-nantes.html`
10. `convoyage-vehicule-nice.html`
11. `convoyage-vehicule-rennes.html`
12. `convoyage-vehicule-strasbourg.html`

### B. Pages Fonctionnelles et Légales (11 fichiers)
Ces pages utilisent également l'ancienne police ou les anciens codes couleur en dur :
1. `contact.html` (ancienne police, ancienne couleur bordeaux, pas de bouton d'appel mobile)
2. `devis.html` (ancienne police et variables couleurs)
3. `mentions-legales.html` (ancienne police et variables couleurs)
4. `tracking.html` (ancienne police et variables couleurs, tracé carte `#7A2E1A`)
5. `gps-emitter.html` (ancienne police et variables couleurs)
6. `bon-de-mission.html` (ancienne police et variables couleurs)
7. `etat-des-lieux.html` (ancienne police et variables couleurs)
8. `formation-convoyeur.html` (ancienne police et variables couleurs)
9. `dashboard-admin.html` (variables couleurs)
10. `dashboard-client.html` (police logo en dur et variables couleurs)
11. `dashboard-convoyeur.html` (variables couleurs)

### C. Fichiers Scripts et Backend (3 fichiers)
Ces fichiers génèrent des PDFs, des e-mails ou des pages SEO contenant les anciens codes de couleur bordeaux en dur :
1. `generate-pdfs.cjs` (constante `COLOR_BORDEAUX = '#7A2E1A'`)
2. `generate-seo.js` (références de couleur de tracé de ligne de carte `#7A2E1A`)
3. `netlify/functions/send-email.js` (templates d'e-mail utilisant `#7A2E1A` et `#F3E8E4`)

---

## 2. Écarts par rapport à la charte v2

| Élément | Ancienne Charte | Nouvelle Charte (Bathily v2) | Impact | Action corrective |
| :--- | :--- | :--- | :--- | :--- |
| **Police Titres** | `Plus Jakarta Sans` | `Montserrat` | Cohérence visuelle globale | Remplacement dans le `<head>` et dans les stylesheets. |
| **Couleur Primaire** | `#7A2E1A` (bordeaux) | `#0A4D68` (bleu brand) | Contraste et aspect professionnel | Remplacement global de toutes les variables et occurrences. |
| **Couleur Secondaire** | N/A | `#088395` (cyan GPS) | Éléments de confiance et badge | Intégration du composant `.badge-trust`. |
| **Couleur Accent** | `#E0A343` (orange or) | `#F5A623` (jaune/or) | Taux de clic / Conversion CTA | Surcharge de `.btn-primary` et effet pulse. |
| **Sélecteur Véhicule** | Balise `<select>` | Onglets `.veh-tabs` 🚗/🏍 | UX simplifiée et moderne | Remplacement du code HTML et liaison de la fonction `setVehType`. |
| **Appel Mobile** | N/A (absent) | Bouton flottant fixe bas droite | UX mobile et conversion | Ajout de `.sticky-call-mobile` à toutes les pages de destination. |

---

## 3. Plan de résolution

1. **Création du Design System** : Mise en place de `css/design-system.css` pour centraliser la charte et les composants.
2. **Exécution du Script de Remplacement** : Passage du script `refactor.js` pour propager et unifier les variables dans tous les fichiers.
3. **Vérification et Compilation** : Vérification visuelle sur plusieurs pages et lancement d'un test de build.
