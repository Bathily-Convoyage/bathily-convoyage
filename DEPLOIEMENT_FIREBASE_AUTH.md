# 🚀 Guide de Déploiement - Firebase Auth Custom Tokens

Ce guide vous accompagne pas à pas pour activer la synchronisation Supabase ↔ Firebase Auth.

---

## 📋 Prérequis

Avant de commencer, assurez-vous d'avoir :
- [ ] Un compte Firebase actif (projet `bathily-convoyage-c211b`)
- [ ] Un compte Supabase actif avec accès aux Edge Functions
- [ ] Node.js installé sur votre ordinateur
- [ ] Accès à la console Firebase et Supabase

---

## 🔧 Étape 1 : Installer la CLI Supabase

### Windows (PowerShell)
```powershell
# Installez la CLI Supabase
npm install -g supabase

# Vérifiez l'installation
supabase --version
```

### macOS / Linux
```bash
# Installez la CLI Supabase
npm install -g supabase

# Ou avec Homebrew (macOS)
brew install supabase/tap/supabase

# Vérifiez l'installation
supabase --version
```

---

## 🔑 Étape 2 : Obtenir les Credentials Firebase Admin

### 2.1 Allez dans Firebase Console
1. Ouvrez https://console.firebase.google.com/
2. Sélectionnez votre projet `bathily-convoyage-c211b`
3. Cliquez sur l'**engrenage** (⚙️) à côté de "Paramètres du projet"

### 2.2 Accédez aux Comptes de service
1. Allez dans l'onglet **"Comptes de service"**
2. Cliquez sur **"Générer une nouvelle clé privée"**
3. Un fichier `.json` se télécharge automatiquement

### 2.3 Ouvrez le fichier JSON téléchargé
Le fichier ressemble à ceci :
```json
{
  "type": "service_account",
  "project_id": "bathily-convoyage-c211b",
  "private_key_id": "abc123...",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-xxxxx@bathily-convoyage-c211b.iam.gserviceaccount.com",
  "client_id": "123456789",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token"
}
```

**Notez ces 3 valeurs** (vous en aurez besoin pour l'étape 3) :
- `project_id`
- `private_key` (tout le bloc avec les \n)
- `client_email`

---

## 🌐 Étape 3 : Se connecter à Supabase CLI

### 3.1 Connectez-vous
```bash
# Dans votre terminal
supabase login
```

Cela ouvrira un navigateur pour vous authentifier avec Supabase.

### 3.2 Liez votre projet local
```bash
# Naviguez vers votre dossier projet
cd "c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE"

# Liez le projet (remplacez par votre ID de projet Supabase)
supabase link --project-ref votre-projet-ref
```

> 💡 **Trouver votre project-ref** : Dans Supabase Dashboard → Settings → API → Project URL
> Exemple: `https://xxxxxxxxxxxxxxxxxxxx.supabase.co` → `xxxxxxxxxxxxxxxxxxxx` est votre project-ref

---

## 🔐 Étape 4 : Configurer les Secrets

C'est la partie la plus importante ! Exécutez ces 3 commandes :

### Commande 1 : Project ID
```bash
supabase secrets set FIREBASE_PROJECT_ID="bathily-convoyage-c211b"
```

### Commande 2 : Private Key
⚠️ **Attention** : La clé privée doit être entre guillemets et avec les `\n` préservés

```bash
supabase secrets set FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...
...
-----END PRIVATE KEY-----
"
```

> 💡 **Astuce Windows** : Le fichier JSON contient `\n` qui représentent des sauts de ligne. Copiez tout entre les guillemets du fichier JSON.

### Commande 3 : Client Email
```bash
supabase secrets set FIREBASE_CLIENT_EMAIL="firebase-adminsdk-xxxxx@bathily-convoyage-c211b.iam.gserviceaccount.com"
```

### ✅ Vérifiez les secrets
```bash
supabase secrets list
```

Vous devriez voir :
- `FIREBASE_PROJECT_ID`
- `FIREBASE_PRIVATE_KEY`
- `FIREBASE_CLIENT_EMAIL`

---

## 🚀 Étape 5 : Déployer l'Edge Function

```bash
# Déployer la fonction
cd "c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE"
supabase functions deploy generate-firebase-token
```

Résultat attendu :
```
Deploying generate-firebase-token...
Deployed generate-firebase-token
URL: https://xxxxxxxxxxxxxxxxxxxx.supabase.co/functions/v1/generate-firebase-token
```

---

## 🧪 Étape 6 : Tester

### 6.1 Test via ligne de commande
```bash
# Obtenez votre token Supabase (dans votre application ou via Supabase Dashboard)
# Puis testez la fonction
curl -X POST https://xxxxxxxxxxxxxxxxxxxx.supabase.co/functions/v1/generate-firebase-token \
  -H "Authorization: Bearer VOTRE_TOKEN_SUPABASE" \
  -H "Content-Type: application/json"
```

### 6.2 Test via navigateur
1. Ouvrez votre application : `gps-emitter.html?ref=BC-TEST-001`
2. Connectez-vous avec un compte convoyeur
3. Regardez la console (F12) → vous devriez voir :
   - `"Firebase Auth: connecté avec Custom Token"`
   - La position GPS s'envoie avec succès

4. Ouvrez `mission-tracker.html?ref=BC-TEST-001` avec le compte client
5. La carte doit afficher la position du convoyeur !

---

## 🛠️ Dépannage

### Erreur : "secrets not found"
```bash
# Vérifiez que vous êtes dans le bon dossier
cd "c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE"
pwd  # Affiche le chemin courant

# Vérifiez le lien avec le projet
supabase projects list
supabase link --project-ref VOTRE_PROJECT_REF
```

### Erreur : "Invalid private key"
- Assurez-vous que la clé privée contient bien les `\n`
- La clé doit commencer par `-----BEGIN PRIVATE KEY-----`
- La clé doit finir par `-----END PRIVATE KEY-----`

### Erreur : "Function not found"
```bash
# Vérifiez que le fichier existe
ls supabase/functions/generate-firebase-token/

# Redéployez
supabase functions deploy generate-firebase-token
```

---

## 📊 Vérification finale

Dans Firebase Console → Authentication → Users, vous devriez voir apparaître vos utilisateurs Supabase avec :
- ✅ Le même email
- ✅ Le même UID (synchronisé)
- ✅ Date de création
- ✅ Dernière connexion

---

## ✅ Checklist de succès

- [ ] CLI Supabase installée (`supabase --version`)
- [ ] Connecté à Supabase (`supabase login`)
- [ ] Projet lié (`supabase link`)
- [ ] 3 secrets configurés (`supabase secrets list`)
- [ ] Function déployée (`supabase functions list`)
- [ ] Test réussi (gps-emitter.html fonctionne)
- [ ] Client peut voir le suivi (mission-tracker.html)

---

## 🆘 Besoin d'aide ?

Vérifiez ces éléments si ça ne fonctionne pas :
1. Les secrets sont-ils bien définis ? → `supabase secrets list`
2. La fonction est-elle déployée ? → `supabase functions list`
3. Le fichier `supabase/functions/generate-firebase-token/index.ts` existe-t-il ?
4. Les règles Firebase sont-elles déployées ? → Firebase Console → Realtime Database → Rules

**Vous avez réussi !** 🎉 Votre système de suivi GPS est maintenant sécurisé professionnellement.
