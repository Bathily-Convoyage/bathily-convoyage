# 🗄️ Base de données Supabase - Bathily Convoyage

## 📋 Vue d'ensemble

Ce dossier contient les migrations SQL pour la base de données Supabase du projet Bathily Convoyage, ainsi que les instructions de configuration.

## 🏗️ Structure de la base de données

### Tables principales

#### 1. **`clients`** - Gestion des clients
- Informations personnelles (nom, prénom, email, téléphone)
- Informations entreprise (optionnel : entreprise, SIRET)
- Adresse complète
- Statut : `actif`, `inactif`, `suspendu`
- Authentification par mot de passe hashé

#### 2. **`convoyeurs`** - Convoyeurs actifs
- Informations personnelles et professionnelles
- Lien avec la table `convoyeurs_candidats` (candidature d'origine)
- Permis de conduire et expérience
- Statut : `disponible`, `en_mission`, `indisponible`, `inactif`
- Évaluation (note moyenne, nombre de missions)
- Disponibilités (format JSONB)

#### 3. **`convoyeurs_candidats`** - Candidatures de convoyeurs
- Formulaire de candidature en ligne
- Quiz de formation (score, réponses, tentatives)
- Statut : `pending`, `approved`, `rejected`
- Notes administratives

#### 4. **`missions`** - Missions de convoyage
- Référence unique (format : BC-YYYY-NNN)
- Relations avec clients et convoyeurs
- Informations véhicule (marque, modèle, immatriculation)
- Départ et arrivée (adresses, dates, contacts)
- Statut : `planifiee`, `confirmee`, `en_cours`, `terminee`, `annulee`, `litige`
- Informations financières (prix HT/TTC, TVA, acompte, statut paiement)
- Documents (bon de mission, facture)
- Évaluations client et convoyeur (format JSONB)

#### 5. **`edls`** - États des lieux
- Lien avec la mission
- Type : `depart` ou `arrivee`
- Référence unique (ex: EDL-BC-2026-3866-DEP)
- Kilométrage, niveau de carburant
- Photos (format JSONB - base64 ou URLs)
- Dommages constatés (format JSONB)
- Documents validés
- Signatures (convoyeur et client en base64)
- Conformité et observations

## 📁 Fichiers de migration

Les migrations sont numérotées dans l'ordre d'exécution :

1. **`001_schema_initial.sql`** - Tables principales (clients, convoyeurs, missions)
   - Création des tables `clients`, `convoyeurs`, `missions`
   - Index pour optimisation des requêtes
   - Politiques RLS (Row Level Security)
   - Fonctions utilitaires (génération de références, mise à jour automatique)
   - Vues pour statistiques et jointures

2. **`002_convoyeurs_candidats.sql`** - Candidatures de convoyeurs
   - Table `convoyeurs_candidats`
   - Gestion du processus de recrutement
   - Quiz de formation

3. **`003_etats_des_lieux.sql`** - États des lieux
   - Table `edls`
   - Gestion des états des lieux départ/arrivée
   - Stockage des photos et signatures

## 🚀 Installation

### Prérequis
- Compte Supabase actif
- Projet Supabase créé
- Accès au SQL Editor de Supabase

### Étapes d'installation

1. **Connexion à Supabase**
   - Rendez-vous sur [https://supabase.com](https://supabase.com)
   - Connectez-vous à votre projet (URL du projet : `https://yzfulgmmngvenxvdvgbp.supabase.co`)

2. **Exécution des migrations**
   - Ouvrez le **SQL Editor** dans Supabase
   - Cliquez sur **New query** et exécutez les fichiers dans l'ordre :
     ```
     001_schema_initial.sql
     002_convoyeurs_candidats.sql
     003_etats_des_lieux.sql
     ```
   - ✅ *Vérifiez qu'il n'y a pas d'erreurs pour chaque fichier.*

3. **Vérification des tables et des données**
   - Allez dans **Table Editor**
   - Vérifiez que toutes les tables sont créées : `clients`, `convoyeurs`, `convoyeurs_candidats`, `missions`, `edls`
   - Vérifiez les données de test :
     - Table **`clients`** : 1 ligne de test (`contact@exemple-entreprise.fr`)
     - Table **`convoyeurs`** : 1 ligne de test (`convoyeur@exemple.fr`)

4. **Configuration de l'application**
   - Les identifiants Supabase sont dans `public/supabase-config.js`
   - URL : `https://yzfulgmmngvenxvdvgbp.supabase.co`
   - *(Aucune modification n'est normalement nécessaire)*

## 🧪 Tests post-installation

### Test de connexion depuis l'application (Console Navigateur)
Ouvrez votre site web (`index.html`), ouvrez la console développeur (`F12`), puis exécutez :
```javascript
const { data, error } = await supabase.from('clients').select('*').limit(1);
if (error) console.error('❌ Erreur:', error);
else console.log('✅ Connexion réussie!', data);
```

### Test des fonctions utilitaires (SQL Editor)
- **Génération de référence mission** : `SELECT generate_mission_reference();` (Résultat attendu : `BC-2026-001`)
- **Vue missions_details** : `SELECT * FROM missions_details LIMIT 5;`
- **Vue convoyeurs_stats** : `SELECT * FROM convoyeurs_stats;`

## 🔧 Dépannage

- **Erreur "relation does not exist"** : Une table n'a pas été créée correctement. Vérifiez que toutes les migrations ont été exécutées dans l'ordre.
- **Erreur "permission denied"** : Problème de politiques RLS. Dans le Table Editor, cliquez sur la table → **RLS Policies** et vérifiez que les politiques sont actives.
- **Erreur "duplicate key value"** : Tentative d'insertion de données en double. Les données de test utilisent `ON CONFLICT DO NOTHING`, mais si vous souhaitez réinitialiser, supprimez les lignes manuellement dans le Table Editor.

## 🔐 Sécurité (RLS - Row Level Security)

### État actuel (Développement)
⚠️ **Les politiques RLS sont actuellement en mode permissif** (`USING (true)`) pour faciliter le développement.

### À faire avant la production

1. **Activer l'authentification Supabase Auth**
   - Configurer les providers (email, Google, etc.)
   - Créer une table `auth.users`
   ```sql
   -- Exemple de politique restrictive pour clients
   CREATE POLICY "Clients voient uniquement leur profil"
     ON public.clients
     FOR SELECT
     USING (auth.uid() = id);
   ```

2. **Restreindre les accès admin**
   - Utiliser `service_role` key pour les opérations admin
   - Ne pas exposer la service_role key côté client

3. **Valider et sécuriser les données**
   - Hasher les mots de passe avant insertion (bcrypt, argon2)
   - Valider les formats (email, téléphone, SIRET)

## 🔄 Ordre de dépendance des tables

```
convoyeurs_candidats (indépendante)
    ↓
convoyeurs (référence convoyeurs_candidats)
    ↓
clients (indépendante)
    ↓
missions (référence clients + convoyeurs)
    ↓
edls (référence missions)
```

## ✅ Checklist finale

- [ ] Les 3 migrations ont été exécutées sans erreur
- [ ] Les 5 tables sont visibles dans le Table Editor
- [ ] Les données de test sont présentes (1 client, 1 convoyeur)
- [ ] La fonction `generate_mission_reference()` fonctionne
- [ ] Les vues `missions_details` et `convoyeurs_stats` sont créées
- [ ] Test de connexion depuis l'application réussi
- [ ] Les politiques RLS sont actives sur toutes les tables

## 🆘 Support

Pour toute question sur la base de données :
- Consulter la documentation Supabase : [https://supabase.com/docs](https://supabase.com/docs)
- Vérifier les logs dans le Dashboard Supabase
- Tester les requêtes dans le SQL Editor

---

**Dernière mise à jour** : 11/06/2026  
**Version** : 1.0.0
