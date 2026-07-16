"use client";

import { FormEvent, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabaseBrowser } from "../lib/supabase-browser";
import type { Viewer } from "../lib/auth-types";
import { FamilyDashboard } from "./family-dashboard";
import "./auth.css";

export function AuthShell() {
  const [session, setSession] = useState<Session | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [ready, setReady] = useState(false);
  const [setupMode, setSetupMode] = useState(false);
  const [accessError, setAccessError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/supabase/status", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return { connected: false };
        return response.json() as Promise<{ connected?: boolean }>;
      })
      .then(async (status) => {
        if (!status.connected) { setSetupMode(true); setReady(true); return; }
        const { data } = await supabaseBrowser.auth.getSession();
        setSession(data.session);
        if (!data.session) setReady(true);
      })
      .catch(() => { setSetupMode(true); setReady(true); });

    const { data: listener } = supabaseBrowser.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setViewer(null);
      setAccessError("");
      if (!nextSession) setReady(true);
    });
    return () => { controller.abort(); listener.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    void fetch("/api/auth/me", { headers: { authorization: `Bearer ${session.access_token}` }, signal: controller.signal })
      .then(async (response) => {
        const result = await response.json() as { member?: Viewer; error?: string };
        if (!response.ok || !result.member) throw new Error(result.error ?? "Accès familial non autorisé");
        setViewer(result.member);
      })
      .catch((error: unknown) => setAccessError(error instanceof Error ? error.message : "Accès refusé"))
      .finally(() => setReady(true));
    return () => controller.abort();
  }, [session]);

  if (!ready) return <div className="auth-loading"><span>C</span><p>Ouverture de Cap Family…</p></div>;
  if (setupMode) return <FamilyDashboard viewer={{ id: "local-admin", email: "florent.lambert@gmail.com", name: "Florent", role: "admin" }} onSignOut={() => undefined} />;
  if (accessError) return <AccessDenied message={accessError} onSignOut={() => void supabaseBrowser.auth.signOut()} />;
  if (!session || !viewer) return <LoginScreen />;
  return <FamilyDashboard viewer={viewer} onSignOut={() => void supabaseBrowser.auth.signOut()} />;
}

function LoginScreen() {
  const [mode, setMode] = useState<"login" | "signup" | "magic">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      if (mode === "login") {
        const { error } = await supabaseBrowser.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === "signup") {
        const { error } = await supabaseBrowser.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
        if (error) throw error;
        setMessage("Vérifie ta boîte e-mail pour confirmer ton accès.");
      } else {
        const { error } = await supabaseBrowser.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: window.location.origin } });
        if (error) throw error;
        setMessage("Lien unique envoyé. Il sera valable pendant la durée configurée dans Supabase.");
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Connexion impossible"); }
    finally { setBusy(false); }
  }

  async function googleLogin() {
    setBusy(true); setMessage("");
    const { error } = await supabaseBrowser.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
    if (error) { setMessage(error.message); setBusy(false); }
  }

  return <main className="auth-page"><section className="auth-brand"><span className="auth-logo">C</span><div><small>CAP FAMILY</small><h1>Grandir avec<br />son argent.</h1><p>Les cadeaux Bitcoin, l’épargne et les premiers investissements expliqués simplement, en famille.</p></div><blockquote>“Investir tôt, c’est surtout apprendre tôt.”</blockquote></section><section className="auth-panel"><div className="auth-card"><header><span>ESPACE FAMILLE PRIVÉ</span><h2>{mode === "login" ? "Heureux de te revoir" : mode === "signup" ? "Créer mon mot de passe" : "Recevoir un lien unique"}</h2><p>Seules les personnes préalablement invitées par Florent peuvent accéder à Cap Family.</p></header><button className="google-button" onClick={googleLogin} disabled><b>G</b> Connexion Google · bientôt</button><div className="auth-separator"><span />ou<span /></div><form onSubmit={submit}><label>Adresse e-mail<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="prenom@exemple.com" autoComplete="email" required /></label>{mode !== "magic" && <label>Mot de passe<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} autoComplete={mode === "login" ? "current-password" : "new-password"} required /></label>}<button className="auth-submit" disabled={busy}>{busy ? "Un instant…" : mode === "login" ? "Se connecter" : mode === "signup" ? "Créer mon accès" : "Envoyer le lien unique"}</button></form>{message && <p className="auth-message">{message}</p>}<nav><button onClick={() => setMode(mode === "login" ? "magic" : "login")}>{mode === "login" ? "Recevoir un lien unique" : "Retour à la connexion"}</button><button onClick={() => setMode(mode === "signup" ? "login" : "signup")}>{mode === "signup" ? "J’ai déjà un compte" : "Première connexion"}</button></nav><footer>Accès sur invitation · Données privées · Aucune clé Ledger enregistrée</footer></div></section></main>;
}

function AccessDenied({ message, onSignOut }: { message: string; onSignOut: () => void }) {
  return <main className="access-denied"><span>!</span><h1>Accès non autorisé</h1><p>{message}</p><small>Demande à Florent d’ajouter ton adresse e-mail dans la famille avant de réessayer.</small><button onClick={onSignOut}>Utiliser un autre compte</button></main>;
}
