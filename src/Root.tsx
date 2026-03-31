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
