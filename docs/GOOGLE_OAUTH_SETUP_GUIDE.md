# 🔐 Guide Complet: Configuration Google OAuth pour Calendar

**Objectif:** Permettre aux recruteurs de connecter leur Google Calendar sans erreur `access_denied`

---

## ⚠️ Avant de commencer

- Ton `GOOGLE_CLIENT_ID` (le nouveau que tu viens de créer):
  ```
  648745498087-8si3c6n0f4qeh5embvqrl5qlctdrb6bh.apps.googleusercontent.com
  ```
  **Note:** Cet ID remplace l'ancien: `122105051479-dna9hfi1gskvlbobkhkpboiml67i4gl7.apps.googleusercontent.com`
- Redirect URI configuré:
  ```
  http://localhost:3001/auth/google/callback
  ```
- Email du testeur à approuver:
  ```
  hamouda.chekir@esprit.tn
  ```

**Important:** Si tu n'as pas accès à la Google Cloud Console pour ce projet, contacte le propriétaire du projet Google qui a créé ce client ID.

---

## 📋 CHECKLIST: Configuration Google Cloud Console

### **ÉTAPE 1: Accéder à Google Cloud Console**

1. Ouvre https://console.cloud.google.com/
2. **En haut à gauche**, clique sur le **Sélecteur de projet** (il affiche "All" ou un nom de projet)
3. **Recherche le projet** qui contient ton client OAuth:
   - Tape dans la barre de recherche: `648745498087` (l'ID du projet Google du nouveau client)
   - Ou cherche par le nom du projet affiché en haut à gauche
4. **Clique sur le projet** trouvé pour l'ouvrir

✅ **Confirmation:** Le nom du projet et le project ID s'affichent en haut à gauche

---

### **ÉTAPE 2: Vérifier les APIs activées**

1. Depuis le menu de gauche, clique sur **APIs & Services** > **Enabled APIs & services**
2. **Vérifie que ces 2 APIs sont activées:**
   - ✅ Google Calendar API
   - ✅ Google+ API (ou People API)
   
   Si une API est manquante:
   - Clique sur **+ ENABLE APIS AND SERVICES** (en haut)
   - Cherche "Google Calendar API"
   - Clique sur le résultat
   - Clique sur **ENABLE**
   - Répète pour "Google+ API"

✅ **Confirmation:** Les deux APIs ont un badge "Enabled" (bleu)

---

### **ÉTAPE 3: Configurer l'écran de consentement OAuth (IMPORTANT)**

1. Depuis le menu de gauche, clique sur **APIs & Services** > **OAuth consent screen**
2. **À droite, tu verras l'état actuel:**
   - ROUGE = "Configuration requise"
   - ORANGE = "En test"
   - VERT = "En production"

3. **Si ce n'est pas encore configuré ou incomplète:**
   - Clique sur **Configure consent screen** (ou **Edit app** si déjà partiellement rempli)

4. **Remplis le formulaire:**
   - **App name:** `AI Recruiter Platform` (ou le nom de ton appli)
   - **User support email:** `hamoudachkir2000@gmail.com`
   - **Scopes:** 
     - Scroll vers le bas, clique sur **ADD OR REMOVE SCOPES**
     - Cherche: `https://www.googleapis.com/auth/calendar`
     - Sélectionne-la (checkbox)
     - Clique sur **UPDATE**
   - **Developer contact information:**
     - Email: `hamoudachkir2000@gmail.com`
   - Clique sur **SAVE AND CONTINUE**

✅ **Confirmation:** Pas de message d'erreur, écran de consentement sauvegardé

---

### **ÉTAPE 4: Ajouter les testeurs approuvés (ÉTAPE CRITIQUE)**

1. Sur la même page **OAuth consent screen**, scroll vers le bas
2. Cherche la section **"Test users"** (ou **"Authorized test users"**)
3. **Clique sur ADD USERS** (ou un bouton similaire)
4. **Dans une popup, tape exactement:**
   ```
   hamouda.chekir@esprit.tn
   ```
5. **Clique sur ADD** (dans la popup)
6. **Vérifie que l'email s'ajoute** dans la liste des test users
7. **Clique sur SAVE** (en bas de la page)

✅ **Confirmation:** L'email `hamouda.chekir@esprit.tn` apparait dans la liste des test users

---

### **ÉTAPE 5: Vérifier les credentials OAuth 2.0**

1. Depuis le menu de gauche, clique sur **APIs & Services** > **Credentials**
2. **Dans la liste des credentials, cherche "OAuth 2.0 Client ID"**
   - Tu devrais voir une entrée avec le type **"Web application"**
3. **Clique dessus pour voir les détails**

4. **Vérifie que le redirect URI est correct:**
   - Scroll vers le bas jusqu'à **"Authorized redirect URIs"**
   - **Vérifie que cet URI est présent:**
     ```
     http://localhost:3001/auth/google/callback
     ```
   - Si ce n'est pas là:
     - Clique sur **ADD URI**
     - Colle: `http://localhost:3001/auth/google/callback`
     - Clique sur **SAVE**

✅ **Confirmation:** Le redirect URI `http://localhost:3001/auth/google/callback` est dans la liste

---

### **ÉTAPE 6: Télécharger les secrets OAuth (Optionnel - pour remplir .env)**

1. Toujours sur la page **Credentials**, clique sur le bouton **download** (⬇️) à côté du client OAuth
2. Un fichier JSON sera téléchargé
3. **Ouvre le fichier** et cherche:
   ```json
   "client_id": "122105051479-...",
   "client_secret": "GOCSPX-..."
   ```
4. **Vérifie que ces valeurs correspondent à ton .env:**
   - `GOOGLE_CLIENT_ID` ✅
   - `GOOGLE_CLIENT_SECRET` ✅

✅ **Confirmation:** Les valeurs dans `Backend/server/.env` sont à jour

---

### **ÉTAPE 7: Attendre la propagation (IMPORTANT)**

Après avoir validé toutes les étapes:

1. **Attends 1-3 minutes** pour que Google applique les changements
2. **Redémarre le serveur Node:**
   ```bash
   cd Backend/server
   npm start
   ```
3. **Vide le cache du navigateur:**
   - Appuie sur **Ctrl+Shift+Delete**
   - Sélectionne "All time" et "Cookies and other site data"
   - Clique sur **Clear data**

---

## 🧪 TEST: Vérifier que tout fonctionne

### **Option 1: Test depuis l'app**

1. Ouvre http://localhost:5173 (frontend)
2. Va sur la page **Recruiter Dashboard** ou la page de connexion Google Calendar
3. **Clique sur le bouton "Connect Google Calendar"**
4. **Autorise la connexion** quand Google te demande
5. ✅ **Si c'est bon:** Affichage "Calendar Connected" ou confirmation
6. ❌ **Si erreur 403:** Reviens à ÉTAPE 4 et vérifie que l'email est vraiment dans Test users

### **Option 2: Test direct via cURL (Advanced)**

```bash
# Générer l'URL de connexion
curl "http://localhost:3001/recruiter-calendar/connect-url/[RECRUITER_ID]"
```

Remplace `[RECRUITER_ID]` par l'ID réel d'un recruteur dans la DB.

---

## 🔧 Troubleshooting: Si ça ne marche toujours pas

### **Problème: Toujours "Error 403: access_denied"**

**Un ou plusieurs de ces points n'a pas été fait:**
- ❌ L'email `hamouda.chekir@esprit.tn` n'est pas dans Test users
- ❌ L'écran de consentement est incomplète
- ❌ Google Calendar API n'est pas activée
- ❌ Le client ID dans Google ne correspond pas au `.env`

**Solution:**
1. Reviens à ÉTAPE 1-3
2. Recommence ÉTAPE 4 en double-cliquant que l'email est correct (pas de typo!)
3. Attends 5 minutes
4. Redémarre le backend Node
5. Vide le cache du navigateur
6. Réessaye

---

### **Problème: "redirect_uri_mismatch"**

**Cause:** L'URL que tu cliques ne correspond pas à celle dans Google Console

**Solution:**
1. Va à ÉTAPE 5
2. Cherche exactement ce URI:
   ```
   http://localhost:3001/auth/google/callback
   ```
3. Si c'est manquant, ajoute-le
4. Si c'est légèrement différent (ex: avec un `/` en plus), corrige-le

---

### **Problème: "Invalid client"**

**Cause:** Le `GOOGLE_CLIENT_ID` ou `GOOGLE_CLIENT_SECRET` ne sont pas bons

**Solution:**
1. Va à ÉTAPE 5
2. Télécharge de nouveau le JSON des credentials
3. **Copie EXACTEMENT:**
   - `client_id` → `GOOGLE_CLIENT_ID` dans `.env`
   - `client_secret` → `GOOGLE_CLIENT_SECRET` dans `.env`
4. **Redémarre le backend**

---

## 📌 Résumé des URLs importantes

| Ressource | URL |
|-----------|-----|
| Google Cloud Console | https://console.cloud.google.com/ |
| OAuth Consent Screen | https://console.cloud.google.com/apis/credentials/consent |
| Credentials | https://console.cloud.google.com/apis/credentials |
| Google Calendar API | https://console.cloud.google.com/marketplace/product/google/calendar-json.googleapis.com |
| App Locale Calendar Connect | http://localhost:5173 (Frontend) |
| Backend OAuth Callback | http://localhost:3001/auth/google/callback |

---

## ✅ Checklist finale

Avant déploiement en production:

- [ ] Email testeur ajouté à Test users
- [ ] Google Calendar API activée
- [ ] Google+ API ou People API activée
- [ ] Redirect URI: `http://localhost:3001/auth/google/callback` ✅
- [ ] Secrets OAuth à jour dans `.env`
- [ ] Backend Node redémarré
- [ ] Cache navigateur vidé
- [ ] Test connexion réussi sans erreur 403

---

## 🚀 Passage en Production (Moyen terme)

Une fois que tu veux déployer en production:

1. **Dans Google Console:**
   - Va à **OAuth consent screen**
   - Change le status de "Testing" à "In production"
   - Cela supprimera le besoin de "test users" et permettra à n'importe quel utilisateur de se connecter

2. **Mets à jour `GOOGLE_CALENDAR_REDIRECT_URI` dans `.env`:**
   ```
   GOOGLE_CALENDAR_REDIRECT_URI=https://yourdomain.com/auth/google/callback
   ```
   (Remplace par ton vrai domaine)

3. **Ajoute ce nouveau URI dans Google Console > Credentials > Authorized redirect URIs**

---

📞 **Questions?** Relés-moi si tu bloques à une étape spécifique!
