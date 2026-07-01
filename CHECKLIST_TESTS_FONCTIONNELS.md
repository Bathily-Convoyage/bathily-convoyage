# Checklist tests fonctionnels — Bathily-Convoyage

Cette checklist couvre les parcours clés à tester après les migrations RLS 058-061.

## 1. Auth / connexion

- [ ] Signup client (homepage ou dashboard client)
- [ ] Login client avec compte existant
- [ ] Signup convoyeur
- [ ] Login convoyeur avec compte existant
- [ ] Login admin
- [ ] Reset password client
- [ ] Reset password convoyeur
- [ ] Connexion automatique après reset password
- [ ] Déconnexion (logout) depuis les 3 dashboards

## 2. Dashboard admin

- [ ] Liste des clients
- [ ] Création d'un client
- [ ] Modification d'un client
- [ ] Suppression d'un client
- [ ] Bannissement / débannissement d'un client
- [ ] Liste des convoyeurs
- [ ] Création d'un convoyeur
- [ ] Modification d'un convoyeur
- [ ] Suppression d'un convoyeur
- [ ] Bannissement / débannissement d'un convoyeur
- [ ] Création d'une mission
- [ ] Attribution d'un convoyeur à une mission
- [ ] Modification du statut d'une mission
- [ ] Liste des devis
- [ ] Modification du statut d'un devis
- [ ] Liste des tickets support
- [ ] Réponse à un ticket support
- [ ] Modération des avis (voir tous les statuts)
- [ ] Publication d'une annonce sur le réseau social
- [ ] Création / envoi d'une campagne newsletter

## 3. Dashboard client

- [ ] Voir la liste des missions
- [ ] Voir le détail d'une mission
- [ ] Ajouter un véhicule
- [ ] Supprimer un véhicule
- [ ] Modifier le profil
- [ ] Payer une mission (mode local + production Stripe)
- [ ] Télécharger un PDF de facture
- [ ] Envoyer un ticket support
- [ ] Voir la réponse à un ticket support
- [ ] Accès tracking d'une mission

## 4. Dashboard convoyeur

- [ ] Voir les missions disponibles
- [ ] Postuler à une mission
- [ ] Voir "mes missions"
- [ ] Voir le détail d'une mission assignée
- [ ] Modifier le profil
- [ ] Upload de document (permis, etc.)
- [ ] Envoyer un ticket support
- [ ] Voir le réseau social
- [ ] Publier un post sur le réseau social
- [ ] Commenter un post
- [ ] Liker un post
- [ ] Voir les badges / gamification
- [ ] Voir le solde de points de fidélité
- [ ] Copier le code de parrainage

## 5. Formulaires publics

- [ ] Formulaire de demande de devis (devis.html)
- [ ] Formulaire de contact / ticket support anonyme
- [ ] Formulaire d'inscription newsletter (homepage)
- [ ] Formulaire de candidature convoyeur (formation-convoyeur.html)
- [ ] Upload de documents dans la candidature convoyeur
- [ ] Page de désinscription newsletter (`unsubscribe.html?token=...`)
- [ ] Page bon-de-mission (accès anon avec mission en cours)
- [ ] Page état-des-lieux (accès anon avec mission en cours)
- [ ] Page tracking (accès anon avec mission en cours)

## 6. Parrainage / fidélité / gamification

- [ ] Génération d'un code de parrainage
- [ ] Application d'un code filleul
- [ ] Attribution de points de fidélité
- [ ] Affichage du solde de points
- [ ] Affichage des badges convoyeur
- [ ] Affichage de la liste des parrainages

## 7. Emails / notifications

- [ ] Réception d'un email de confirmation de mission
- [ ] Réception d'un email de relance
- [ ] Réception d'un email de réponse à un ticket support
- [ ] Réception d'une campagne newsletter
- [ ] Lien de désinscription dans l'email de newsletter
- [ ] Notification push (si utilisée)

## 8. Paiements Stripe

- [ ] Création d'une session de checkout Stripe
- [ ] Webhook Stripe reçu et traité
- [ ] Mise à jour du statut `paiement_statut` après paiement
- [ ] Gestion d'un paiement en échec
- [ ] Gestion d'un remboursement

## 9. Storage / fichiers

- [ ] Upload document candidature (`convoyeur-documents`)
- [ ] Upload document client/convoyeur (`documents`)
- [ ] Lecture publique d'un document (URL publique)
- [ ] Suppression d'un document par admin

## 10. Résultats attendus

Pour chaque test, noter :
- ✅ OK sans erreur
- ❌ Erreur RLS
- ❌ Erreur fonctionnelle
- ❌ Erreur réseau / console

En cas d'erreur, capturer :
- Le message d'erreur exact
- La page / fonction concernée
- Le rôle utilisateur (anon, client, convoyeur, admin)
- Le log console (F12)
