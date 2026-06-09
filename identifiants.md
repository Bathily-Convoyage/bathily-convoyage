# Guide d'Accès & Identifiants — Bathily Convoyage

Ce document récapitule les procédures de connexion et les identifiants d'accès pour les différents espaces de la plateforme **Bathily Convoyage** en mode prototype/démo.

---

## 🔑 1. Espace Client
* **URL de connexion** : `https://bathily-convoyage.netlify.app/dashboard-client.html`
* **Méthode d'accès** : Saisir le nom complet d'un client ayant des missions enregistrées dans la base de données.
* **Exemples de comptes clients valides** (à tester) :
  * **`Bathily Boubacar`** (Contient la mission test payée avec Stripe)
  * **`Jean Dupont`** (Contient d'autres missions de test)

---

## 🛠️ 2. Espace Administrateur
* **URL de connexion** : `https://bathily-convoyage.netlify.app/dashboard-admin.html`
* **Méthode d'accès** : Saisir le mot de passe d'administration.
* **Mot de passe par défaut** :
  ```text
  bathily2025
  ```
  *(Note : Ce mot de passe est modifiable à la ligne 1125 du fichier `dashboard-admin.html`).*

---

## 🚗 3. Espace Convoyeur
* **URL de connexion** : `https://bathily-convoyage.netlify.app/dashboard-convoyeur.html`
* **Méthode d'accès** : Sélectionner ton nom dans la liste déroulante des convoyeurs certifiés enregistrés dans ta base Supabase.
* **Exemple de profil valide** (à tester) :
  * **`M. Bathily`** (ou tout autre profil présent dans ta table `convoyeurs`)
