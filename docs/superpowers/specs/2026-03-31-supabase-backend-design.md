# Design : Migration vers Supabase (backend réel)

**Date :** 2026-03-31  
**Statut :** Approuvé  

## Objectif

Remplacer le stockage local (localStorage / SQLite Electron) par un vrai backend Supabase hébergé, afin que chaque utilisateur puisse s'inscrire depuis le site web et retrouver ses données sur n'importe quel appareil. L'app Electron est abandonnée — cible : full web déployé sur Vercel.

---

## Architecture

```
Vercel (frontend)          Supabase (backend)
┌─────────────────┐        ┌──────────────────────┐
│ Vite + React    │  SDK   │ Auth (register/login) │
│ TypeScript      │◄──────►│ PostgreSQL (données)  │
│                 │        │ Row Level Security    │
└─────────────────┘        └──────────────────────┘
```

Le frontend reste Vite + React + TypeScript, déployé sur Vercel.  
Supabase fournit l'authentification et la base de données.  
Aucun serveur backend custom à écrire ou maintenir.

---

## Base de données

Une table `user_kv` reproduit le modèle clé-valeur existant, sans changement sur les clés utilisées par l'app.

```sql
CREATE TABLE user_kv (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

ALTER TABLE user_kv ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own data only" ON user_kv
  FOR ALL USING (auth.uid() = user_id);
```

Les clés existantes (`muscu-weight-data`, `muscu-grocery-done`, `muscu-profile`, etc.) restent identiques — aucun changement dans `App.tsx`.

---

## Authentification

Supabase Auth avec **email + mot de passe**. Les tokens JWT sont gérés et rafraîchis automatiquement par le SDK.

| Action | Appel SDK |
|---|---|
| Inscription | `supabase.auth.signUp({ email, password, options: { data: { displayName } } })` |
| Connexion | `supabase.auth.signInWithPassword({ email, password })` |
| Session au démarrage | `supabase.auth.getSession()` |
| Écoute changements | `supabase.auth.onAuthStateChange()` |
| Déconnexion | `supabase.auth.signOut()` |

Le `displayName` est stocké dans `user_metadata` de Supabase Auth (pas besoin d'une table séparée).

---

## Flux de données (storage)

`src/lib/appStorage.ts` est réécrit pour appeler Supabase à la place de localStorage/Electron. L'interface publique (`storageGet`, `storageSet`, `storageRemove`) reste identique — aucun changement dans `usePersistedState.ts` ni dans `App.tsx`.

```
storageGet(key)    → SELECT value FROM user_kv WHERE user_id = auth.uid() AND key = ?
storageSet(key, v) → UPSERT INTO user_kv (user_id, key, value)
storageRemove(key) → DELETE FROM user_kv WHERE user_id = auth.uid() AND key = ?
```

---

## Fichiers modifiés / créés / supprimés

| Fichier | Action | Détail |
|---|---|---|
| `src/lib/supabase.ts` | Créé | Instance unique du client Supabase |
| `src/lib/appStorage.ts` | Réécrit | localStorage/Electron → Supabase |
| `src/lib/authWebLocal.ts` | Supprimé | Remplacé par Supabase Auth |
| `src/AuthScreen.tsx` | Modifié | username → email, appels SDK Supabase |
| `src/Root.tsx` | Modifié | Session via `supabase.auth.getSession()` + `onAuthStateChange` |
| `src/authTypes.ts` | Modifié | Aligner `AppUser` sur le type Supabase |
| `.env` | Modifié | Ajouter `VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY` |
| `.env.example` | Modifié | Idem |
| `electron/` | Supprimé | `main.mjs`, `db.mjs`, `preload.mjs` |
| `src/vite-env.d.ts` | Nettoyé | Retirer les types `electronStorage` / `electronAuth` |
| `package.json` | Modifié | Ajouter `@supabase/supabase-js`, retirer `sql.js`, `bcryptjs`, `electron`, `electron-builder` |
| `vite.config.ts` | Nettoyé | Retirer les polyfills Node (buffer, crypto, stream, vm, events) |

---

## Variables d'environnement

```env
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

Ces valeurs sont publiques par nature (clé anon Supabase) — la sécurité est assurée par les politiques RLS côté Supabase, pas par le secret de la clé.

---

## Ce qui ne change pas

- `src/App.tsx` — aucune modification (logique métier intacte)
- `src/hooks/usePersistedState.ts` — aucune modification
- `src/main.tsx` — aucune modification
- Toutes les clés de stockage existantes
- Le design / CSS

---

## Étapes de setup Supabase (manuelles, hors code)

1. Créer un projet sur [supabase.com](https://supabase.com)
2. Exécuter le SQL de création de `user_kv` dans l'éditeur SQL Supabase
3. Copier `VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY` depuis Project Settings → API
4. Les coller dans `.env` (local) et dans les variables d'environnement Vercel
