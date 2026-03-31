# Supabase Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer le stockage local (localStorage/SQLite Electron) par Supabase pour avoir de vraies comptes utilisateurs persistants sur le web.

**Architecture:** Vite + React + TypeScript reste inchangé côté frontend. Le client `@supabase/supabase-js` remplace tous les appels localStorage et Electron. L'auth passe par Supabase Auth (email/password), les données utilisateur sont dans une table `user_kv` PostgreSQL protégée par Row Level Security.

**Tech Stack:** Supabase JS SDK v2, Vite, React 18, TypeScript

---

## Fichiers touchés

| Fichier | Action |
|---|---|
| `src/lib/supabase.ts` | Créé — instance unique du client Supabase |
| `src/lib/appStorage.ts` | Réécrit — localStorage/Electron → Supabase |
| `src/lib/authWebLocal.ts` | Supprimé |
| `src/authTypes.ts` | Modifié — aligner sur le type Supabase User |
| `src/AuthScreen.tsx` | Réécrit — username → email, appels SDK Supabase |
| `src/Root.tsx` | Réécrit — session via Supabase Auth |
| `src/main.tsx` | Modifié — retirer import Buffer inutile |
| `src/vite-env.d.ts` | Modifié — retirer types Electron |
| `.env` | Modifié — ajouter VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY |
| `.env.example` | Modifié — idem |
| `vite.config.ts` | Modifié — retirer polyfills Node (buffer, crypto, stream, vm, events) |
| `package.json` | Modifié — ajouter supabase-js, retirer sql.js/bcryptjs/electron |
| `electron/main.mjs` | Supprimé |
| `electron/db.mjs` | Supprimé |
| `electron/preload.mjs` | Supprimé |

---

## Task 1 : Créer la table `user_kv` dans Supabase

**Fichiers :** aucun fichier de code — action manuelle dans le dashboard Supabase.

- [ ] **Step 1 : Ouvrir l'éditeur SQL Supabase**

  Aller sur https://supabase.com/dashboard/project/elftwcowiredjlobtynq/sql/new

- [ ] **Step 2 : Exécuter ce SQL**

```sql
CREATE TABLE IF NOT EXISTS user_kv (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

ALTER TABLE user_kv ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own data only" ON user_kv
  FOR ALL USING (auth.uid() = user_id);
```

- [ ] **Step 3 : Vérifier**

  Dans Table Editor → `user_kv` doit apparaître avec les colonnes `user_id`, `key`, `value`.

---

## Task 2 : Mettre à jour les dépendances

**Fichiers :** `package.json`

- [ ] **Step 1 : Installer le SDK Supabase**

```bash
npm install @supabase/supabase-js
```

- [ ] **Step 2 : Retirer les dépendances Electron et Node polyfills**

```bash
npm uninstall sql.js bcryptjs electron electron-builder concurrently cross-env wait-on buffer crypto-browserify stream-browserify events vm-browserify
```

- [ ] **Step 3 : Retirer les devDeps inutiles**

```bash
npm uninstall @types/bcryptjs
```

- [ ] **Step 4 : Vérifier que `package.json` dependencies contient uniquement**

```json
{
  "dependencies": {
    "@supabase/supabase-js": "^2.x.x",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  }
}
```

- [ ] **Step 5 : Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: replace electron/sql.js/bcryptjs with @supabase/supabase-js"
```

---

## Task 3 : Mettre à jour les variables d'environnement

**Fichiers :** `.env`, `.env.example`

- [ ] **Step 1 : Remplacer le contenu de `.env`**

```env
VITE_SUPABASE_URL=https://elftwcowiredjlobtynq.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_QvTBCUQ6efdG4HtgmipWdw_g2sk2vz1
```

- [ ] **Step 2 : Remplacer le contenu de `.env.example`**

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

- [ ] **Step 3 : Vérifier que `.gitignore` exclut bien `.env`**

  `.gitignore` doit contenir `.env` (déjà fait).

- [ ] **Step 4 : Commit**

```bash
git add .env.example
git commit -m "chore: update env template for Supabase"
```

---

## Task 4 : Créer le client Supabase

**Fichiers :** Créer `src/lib/supabase.ts`

- [ ] **Step 1 : Créer `src/lib/supabase.ts`**

```typescript
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
```

- [ ] **Step 2 : Vérifier que l'app compile**

```bash
npm run dev
```

  Attendu : pas d'erreur TypeScript, page se charge.

- [ ] **Step 3 : Commit**

```bash
git add src/lib/supabase.ts
git commit -m "feat: add Supabase client instance"
```

---

## Task 5 : Mettre à jour `authTypes.ts`

**Fichiers :** Modifier `src/authTypes.ts`

- [ ] **Step 1 : Remplacer le contenu de `src/authTypes.ts`**

```typescript
export type AppUser = {
  id: string;
  email: string;
  displayName?: string | null;
};
```

  > Note : `id` passe de `number` à `string` (UUID Supabase). `username` devient `email`.

- [ ] **Step 2 : Commit**

```bash
git add src/authTypes.ts
git commit -m "feat: align AppUser type with Supabase auth"
```

---

## Task 6 : Réécrire `appStorage.ts`

**Fichiers :** Modifier `src/lib/appStorage.ts`

- [ ] **Step 1 : Remplacer entièrement `src/lib/appStorage.ts`**

```typescript
import { supabase } from "./supabase";

export async function storageGet(key: string): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("user_kv")
    .select("value")
    .eq("user_id", user.id)
    .eq("key", key)
    .maybeSingle();
  if (error || !data) return null;
  return data.value;
}

export async function storageSet(key: string, value: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase
    .from("user_kv")
    .upsert({ user_id: user.id, key, value }, { onConflict: "user_id,key" });
}

export async function storageRemove(key: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase
    .from("user_kv")
    .delete()
    .eq("user_id", user.id)
    .eq("key", key);
}

export function isElectronDbAvailable(): boolean {
  return false;
}
```

- [ ] **Step 2 : Commit**

```bash
git add src/lib/appStorage.ts
git commit -m "feat: replace localStorage/Electron storage with Supabase user_kv"
```

---

## Task 7 : Réécrire `AuthScreen.tsx`

**Fichiers :** Modifier `src/AuthScreen.tsx`

- [ ] **Step 1 : Remplacer entièrement `src/AuthScreen.tsx`**

```tsx
import { useState, type CSSProperties, type FormEvent } from "react";
import type { AppUser } from "./authTypes";
import { supabase } from "./lib/supabase";

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: 2,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "#17172A",
  color: "#E4E4F0",
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 13,
  boxSizing: "border-box",
};

export default function AuthScreen({ onLoggedIn }: { onLoggedIn: (u: AppUser) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        const { data, error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (err || !data.user) {
          setError(err?.message ?? "Échec de la connexion.");
        } else {
          onLoggedIn({
            id: data.user.id,
            email: data.user.email ?? email.trim(),
            displayName: (data.user.user_metadata?.displayName as string) ?? null,
          });
        }
      } else {
        if (password !== password2) {
          setError("Les mots de passe ne correspondent pas.");
          setBusy(false);
          return;
        }
        const { data, error: err } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { displayName: displayName.trim() || email.trim() } },
        });
        if (err || !data.user) {
          setError(err?.message ?? "Échec de l'inscription.");
        } else {
          onLoggedIn({
            id: data.user.id,
            email: data.user.email ?? email.trim(),
            displayName: displayName.trim() || email.trim(),
          });
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erreur.");
    }
    setBusy(false);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "radial-gradient(ellipse 80% 35% at 50% 0%, rgba(190,255,0,0.06), transparent 55%), #0A0A0E",
        color: "#E4E4F0",
        fontFamily: "'Barlow', sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 400,
          background: "#10101A",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 4,
          padding: "clamp(20px, 5vw, 32px)",
          borderLeft: "3px solid #BEFF00",
        }}
      >
        <h1
          style={{
            fontFamily: "'Barlow Condensed', sans-serif",
            fontWeight: 900,
            fontSize: "clamp(1.5rem, 5vw, 2rem)",
            margin: "0 0 6px",
            textTransform: "uppercase",
            letterSpacing: "-0.02em",
          }}
        >
          Mass Protocol
        </h1>
        <p style={{ margin: "0 0 20px", fontSize: 12, color: "#8080A8", fontFamily: "'IBM Plex Mono', monospace" }}>
          {mode === "login" ? "Connexion" : "Créer un compte"}
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          <button
            type="button"
            onClick={() => { setMode("login"); setError(null); }}
            style={{
              flex: 1, padding: "10px",
              border: mode === "login" ? "1px solid #BEFF00" : "1px solid rgba(255,255,255,0.1)",
              background: mode === "login" ? "rgba(190,255,0,0.08)" : "transparent",
              color: mode === "login" ? "#BEFF00" : "#8080A8",
              cursor: "pointer", fontWeight: 700, fontSize: 11,
              textTransform: "uppercase", letterSpacing: "0.06em",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            Connexion
          </button>
          <button
            type="button"
            onClick={() => { setMode("register"); setError(null); }}
            style={{
              flex: 1, padding: "10px",
              border: mode === "register" ? "1px solid #4DAAFF" : "1px solid rgba(255,255,255,0.1)",
              background: mode === "register" ? "rgba(77,170,255,0.08)" : "transparent",
              color: mode === "register" ? "#4DAAFF" : "#8080A8",
              cursor: "pointer", fontWeight: 700, fontSize: 11,
              textTransform: "uppercase", letterSpacing: "0.06em",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            Inscription
          </button>
        </div>

        <form onSubmit={submit}>
          <label style={{ display: "block", marginBottom: 12 }}>
            <span style={{ fontSize: 9, color: "#8080A8", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 6 }}>
              Email
            </span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={inputStyle}
              required
            />
          </label>
          {mode === "register" && (
            <label style={{ display: "block", marginBottom: 12 }}>
              <span style={{ fontSize: 9, color: "#8080A8", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 6 }}>
                Nom affiché (optionnel)
              </span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                style={inputStyle}
                placeholder="ex. Mavro"
              />
            </label>
          )}
          <label style={{ display: "block", marginBottom: 12 }}>
            <span style={{ fontSize: 9, color: "#8080A8", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 6 }}>
              Mot de passe
            </span>
            <input
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={inputStyle}
              required
              minLength={mode === "register" ? 6 : 1}
            />
          </label>
          {mode === "register" && (
            <label style={{ display: "block", marginBottom: 16 }}>
              <span style={{ fontSize: 9, color: "#8080A8", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 6 }}>
                Confirmer le mot de passe
              </span>
              <input
                type="password"
                autoComplete="new-password"
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
                style={inputStyle}
                required
                minLength={6}
              />
            </label>
          )}

          {error && (
            <p style={{ color: "#FF3B5C", fontSize: 12, margin: "0 0 14px", fontFamily: "'IBM Plex Mono', monospace" }}>{error}</p>
          )}

          <button
            type="submit"
            disabled={busy}
            style={{
              width: "100%", padding: "14px", border: "none", borderRadius: 2,
              background: busy ? "#40405A" : "#BEFF00",
              color: busy ? "#8080A8" : "#0A0A0E",
              fontWeight: 800, fontSize: 13, textTransform: "uppercase",
              letterSpacing: "0.05em", cursor: busy ? "not-allowed" : "pointer",
              fontFamily: "'Barlow Condensed', sans-serif",
            }}
          >
            {busy ? "…" : mode === "login" ? "Se connecter" : "S'inscrire"}
          </button>
        </form>

        <p style={{ margin: "18px 0 0", fontSize: 10, color: "#606080", lineHeight: 1.5, fontFamily: "'IBM Plex Mono', monospace" }}>
          Données sauvegardées dans le cloud. Accessible depuis n'importe quel appareil.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2 : Commit**

```bash
git add src/AuthScreen.tsx
git commit -m "feat: replace username auth with Supabase email/password auth"
```

---

## Task 8 : Réécrire `Root.tsx`

**Fichiers :** Modifier `src/Root.tsx`

- [ ] **Step 1 : Remplacer entièrement `src/Root.tsx`**

```tsx
import { useState, useEffect } from "react";
import App from "./App";
import AuthScreen from "./AuthScreen";
import type { AppUser } from "./authTypes";
import { supabase } from "./lib/supabase";

export default function Root() {
  const [user, setUser] = useState<AppUser | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUser({
          id: session.user.id,
          email: session.user.email ?? "",
          displayName: (session.user.user_metadata?.displayName as string) ?? null,
        });
      } else {
        setUser(null);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setUser({
          id: session.user.id,
          email: session.user.email ?? "",
          displayName: (session.user.user_metadata?.displayName as string) ?? null,
        });
      } else {
        setUser(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  if (user === undefined) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0A0A0E",
          color: "#E4E4F0",
          fontFamily: "system-ui, sans-serif",
          fontSize: 14,
        }}
      >
        Chargement…
      </div>
    );
  }

  if (!user) {
    return <AuthScreen onLoggedIn={(u) => setUser(u)} />;
  }

  return <App currentUser={user} onLogout={handleLogout} />;
}
```

- [ ] **Step 2 : Commit**

```bash
git add src/Root.tsx
git commit -m "feat: replace Electron/localStorage session with Supabase auth state"
```

---

## Task 9 : Nettoyer les fichiers Electron et polyfills

**Fichiers :** `vite.config.ts`, `src/vite-env.d.ts`, `src/main.tsx`, supprimer `electron/`, `src/lib/authWebLocal.ts`

- [ ] **Step 1 : Supprimer les fichiers Electron**

```bash
rm electron/main.mjs electron/db.mjs electron/preload.mjs
rm src/lib/authWebLocal.ts
```

- [ ] **Step 2 : Remplacer `vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/",
});
```

- [ ] **Step 3 : Remplacer `src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./layout.css";
import Root from "./Root";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
```

- [ ] **Step 4 : Remplacer `src/vite-env.d.ts`**

```typescript
/// <reference types="vite/client" />
```

- [ ] **Step 5 : Commit**

```bash
git add -A
git commit -m "chore: remove Electron files and Node polyfills"
```

---

## Task 10 : Vérification finale et déploiement

- [ ] **Step 1 : Lancer le dev server**

```bash
npm run dev
```

  Attendu : app se charge sur http://localhost:5173, écran de connexion visible.

- [ ] **Step 2 : Tester l'inscription**

  Créer un compte avec un email réel → l'app doit s'ouvrir directement après inscription.

- [ ] **Step 3 : Tester la connexion**

  Se déconnecter, se reconnecter → données présentes.

- [ ] **Step 4 : Tester la persistance**

  Recharger la page → session toujours active (Supabase persiste le JWT dans localStorage).

- [ ] **Step 5 : Build de production**

```bash
npm run build
```

  Attendu : `dist/` généré sans erreur.

- [ ] **Step 6 : Ajouter les variables d'environnement sur Vercel**

  Dans Vercel Dashboard → Settings → Environment Variables :
  - `VITE_SUPABASE_URL` = `https://elftwcowiredjlobtynq.supabase.co`
  - `VITE_SUPABASE_ANON_KEY` = `sb_publishable_QvTBCUQ6efdG4HtgmipWdw_g2sk2vz1`

- [ ] **Step 7 : Push et déployer**

```bash
git add -A
git commit -m "feat: full Supabase migration complete"
git push
```

  Vercel détecte le push et déploie automatiquement.
