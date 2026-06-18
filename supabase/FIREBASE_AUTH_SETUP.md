# Configuration Firebase Auth avec Custom Tokens

Cette solution utilise les **Firebase Custom Tokens** pour synchroniser l'authentification Supabase avec Firebase Auth.

## 🏗️ Architecture

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│   Supabase Auth │──────▶ Edge Function    │──────▶ Firebase Auth  │
│   (Primary)     │      │ (Generate Token)   │      │ (Database Rules)│
└─────────────────┘      └──────────────────┘      └─────────────────┘
        │                                                 │
        │                                                 │
        └─────────────────▶ Realtime Database ◀──────────┘
                            (GPS Tracking)
```

## 🚀 Installation

### 1. Prérequis

- Compte Firebase projet configuré
- Compte Supabase avec accès aux Edge Functions
- Firebase Admin SDK credentials

### 2. Obtenir les credentials Firebase Admin

1. Allez dans **Firebase Console** → Paramètres du projet → Comptes de service
2. Cliquez sur **Générer une nouvelle clé privée**
3. Téléchargez le fichier JSON
4. Extrayez ces valeurs :
   - `project_id`
   - `private_key`
   - `client_email`

### 3. Configurer les secrets Supabase

```bash
# Installez la CLI Supabase si pas déjà fait
npm install -g supabase

# Connectez-vous
supabase login

# Ajoutez les secrets
supabase secrets set FIREBASE_PROJECT_ID="votre-project-id"
supabase secrets set FIREBASE_PRIVATE_KEY="votre-private-key"
supabase secrets set FIREBASE_CLIENT_EMAIL="votre-client-email"
```

### 4. Déployer la Edge Function

```bash
cd supabase/functions/generate-firebase-token

# Déployer
supabase functions deploy generate-firebase-token

# Ou en local pour tester
supabase functions serve generate-firebase-token
```

### 5. Tester la fonction

```bash
curl -X POST https://votre-projet.supabase.co/functions/v1/generate-firebase-token \
  -H "Authorization: Bearer VOTRE_JWT_TOKEN" \
  -H "Content-Type: application/json"
```

## 📁 Fichiers créés

| Fichier | Description |
|---------|-------------|
| `supabase/functions/generate-firebase-token/index.ts` | Edge Function qui génère les tokens |
| `supabase/functions/generate-firebase-token/config.toml` | Configuration de la fonction |

## 🔄 Flux d'authentification

### Pour le Convoyeur (gps-emitter.html):

1. Connexion Supabase Auth
2. Appel à `generate-firebase-token` (avec JWT Supabase)
3. Récupération du **Custom Token** Firebase
4. Sign-in Firebase avec `signInWithCustomToken()`
5. Envoi des positions GPS avec `auth.uid` validé

### Pour le Client (mission-tracker.html):

1. Connexion Supabase Auth
2. Appel à `generate-firebase-token`
3. Sign-in Firebase avec Custom Token
4. Lecture des positions GPS (autorisée par règles Firebase)

## 🔐 Avantages de cette solution

| Aspect | Email/Password | Custom Tokens |
|--------|---------------|---------------|
| **Sécurité** | Bonne | Excellente |
| **UID Sync** | Non (deux UID) | Oui (même UID) |
| **Mot de passe** | Technique | Aucun |
| **Maintenabilité** | Moyenne | Excellente |
| **Scalabilité** | Limitée | Illimitée |

## ⚠️ Important

Après déploiement de cette Edge Function, vous devez **mettre à jour** vos fichiers HTML pour utiliser les Custom Tokens au lieu de l'authentification Email/Password.

Voulez-vous que je mette à jour `gps-emitter.html` et `mission-tracker.html` maintenant ?
