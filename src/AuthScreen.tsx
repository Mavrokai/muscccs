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

      </div>
    </div>
  );
}
