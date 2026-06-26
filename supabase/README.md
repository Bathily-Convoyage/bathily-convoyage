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

Les migrations sont numérotées dans l'ordre d'exécution (021 à 036) :

- **`021_fix_rls_security.sql`** - Audit RLS complet (17 sections) : is_admin(), RLS sur toutes les tables, reseau_posts/comments, admin_delete_user
- **`022_add_convoyeur_support_candidatures.sql`** - Colonnes convoyeur sur support_tickets + RLS candidatures
- **`023_convoyeurs_missing_columns.sql`** - Colonnes manquantes convoyeurs (taux_auto, taux_moto, zone, niveau, etc.)
- **`024_fix_admin_delete_user.sql`** - Correction fonction admin_delete_user (convoyeur_id)
- **`025_fix_edls_schema_and_rls.sql`** - Colonnes edls manquantes + RLS convoyeur + admin_delete_user avec is_admin()
- **`026_add_is_pro.sql`** - Colonnes is_pro et pro_status sur clients
- **`027_candidatures_soft_delete_banned.sql`** - Soft delete + bannissement sur convoyeur_candidatures
- **`028_fix_rls_anon_update_and_check_constraints.sql`** - Suppression policy anon UPDATE + CHECK constraints
- **`029_fix_admin_delete_user_convoyeur_id.sql`** - Correction admin_delete_user (convoyeur_id au lieu de nom)
- **`030_security_and_business_logic.sql`** - CHECK paiement_statut étendu + RLS convoyeur_candidatures + admin_delete_user
- **`031_fix_missions_statut_and_rls.sql`** - Drop CHECK constraints + RLS missions (client_email)
- **`032_fix_candidatures_columns.sql`** - Colonnes manquantes sur candidatures (mission_reference, trajet, montant)
- **`033_fix_missions_rls_convoyeurs.sql`** - RLS missions complète pour convoyeurs + anon SELECT
- **`034_fix_is_admin.sql`** - is_admin() robuste (auth.uid() au lieu de email) + RLS clients
- **`035_storage_convoyeur_documents.sql`** - Bucket storage + RLS pour documents convoyeur
- **`036_add_missing_columns_for_frontend.sql`** - Ajout de toutes les colonnes manquantes référencées par le frontend (missions, devis, vehicules, edls, support_tickets, candidatures, clients, convoyeurs, convoyeur_candidatures) + RLS sur tables manquantes

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
   - Cliquez **New query** et exécutez les fichiers dans l'ordre (021 → 035)
   - ✅ *Vérifiez qu'il n'y a pas d'erreurs pour chaque fichier.*

3. **Vérification des tables et des données**
   - Allez dans **Table Editor**
   - Vérifiez que toutes les tables sont créées : `clients`, `convoyeurs`, `convoyeur_candidatures`, `candidatures`, `missions`, `edls`, `support_tickets`, `reseau_posts`, `reseau_comments`

4. **Configuration de l'application**
   - Les identifiants Supabase sont dans `public/supabase-config.js`
   - URL : `https://yzfulgmmngvenxvdvgbp.supabase.co`
   - *(Aucune modification n'est normalement nécessaire)*

5. **Configuration Auth (production)**
   - `config.toml` est configuré pour `https://www.bathily-convoyage.fr`
   - Confirmation email activée
   - Redirect URLs : `bathily-convoyage.fr` et `bathily-convoyage.netlify.app`

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

- [ ] Les migrations 021 à 036 ont été exécutées sans erreur
- [ ] Les 10 tables sont visibles dans le Table Editor : `clients`, `convoyeurs`, `convoyeur_candidatures`, `candidatures`, `missions`, `edls`, `devis`, `vehicules`, `support_tickets`, `reseau_posts`, `reseau_comments`
- [ ] La fonction `generate_mission_reference()` fonctionne
- [ ] Les vues `missions_details` et `convoyeurs_stats` sont créées
- [ ] La fonction `is_admin()` fonctionne (vérifie auth.uid() + role='admin')
- [ ] La fonction `admin_delete_user()` inclut le check `is_admin()`
- [ ] Test de connexion depuis l'application réussi
- [ ] Les politiques RLS sont actives sur toutes les tables
- [ ] Le bucket `convoyeur-documents` est créé dans Storage
- [ ] `config.toml` pointe vers `https://www.bathily-convoyage.fr`

## 🆘 Support

Pour toute question sur la base de données :
- Consulter la documentation Supabase : [https://supabase.com/docs](https://supabase.com/docs)
- Vérifier les logs dans le Dashboard Supabase
- Tester les requêtes dans le SQL Editor

---

**Dernière mise à jour** : 26/06/2026  
**Version** : 2.0.0
