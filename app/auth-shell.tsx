"use client";

import { FormEvent, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabaseBrowser } from "../lib/supabase-browser";
import type { Viewer } from "../lib/auth-types";
import { FamilyDashboard } from "./family-dashboard";
import { useDialogA11y } from "./use-dialog-a11y";
import "./auth.css";

export function AuthShell() {
  const [session, setSession] = useState<Session | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [ready, setReady] = useState(false);
  const [setupMode, setSetupMode] = useState(false);
  const [accessError, setAccessError] = useState("");
  // Aperçu design réservé au développement local (?preview=dashboard) : n'a aucun effet en production.
  const [designPreview] = useState(() => process.env.NODE_ENV === "development" && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("preview") === "dashboard");

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

  if (designPreview) return <FamilyDashboard viewer={{ id: "design-preview", email: "apercu@cap.family", name: "Florent", role: "admin" }} onSignOut={() => undefined} />;
  if (!ready) return <div className="auth-loading"><span><img src="/Labajo logo.png" alt="" width={48} height={48} /></span><p>Ouverture de LaBaJo &amp; Co…</p></div>;
  if (setupMode) return <FamilyDashboard viewer={{ id: "local-admin", email: "florent.lambert@gmail.com", name: "Florent", role: "admin" }} onSignOut={() => undefined} />;
  if (accessError) return <AccessDenied message={accessError} onSignOut={() => void supabaseBrowser.auth.signOut()} />;
  if (!session || !viewer) return <LoginScreen />;
  return <FamilyDashboard viewer={viewer} onSignOut={() => void supabaseBrowser.auth.signOut()} />;
}

function LoginScreen() {
  const hashError = readAuthHashError();
  const [mode, setMode] = useState<"login" | "magic">(hashError ? "magic" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState(hashError ?? "");
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  const introRef = useDialogA11y(introOpen, () => setIntroOpen(false));

  useEffect(() => {
    if (window.location.hash) history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    const normalizedEmail = email.trim().toLowerCase();
    try {
      if (mode === "login") {
        const { error } = await supabaseBrowser.auth.signInWithPassword({ email: normalizedEmail, password });
        if (error) throw error;
      } else {
        const { error } = await supabaseBrowser.auth.signInWithOtp({ email: normalizedEmail, options: { shouldCreateUser: true, emailRedirectTo: `${window.location.origin}/` } });
        if (error) throw error;
        setMessage("Lien unique envoyé. Vérifie ta boîte de réception et les courriers indésirables.");
      }
    } catch (error) { setMessage(friendlyAuthError(error)); }
    finally { setBusy(false); }
  }

  async function googleLogin() {
    setBusy(true); setMessage("");
    const { error } = await supabaseBrowser.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
    if (error) { setMessage(error.message); setBusy(false); }
  }

  const heading = mode === "login" ? "Heureux de te revoir" : "Recevoir un lien unique";
  const subtitle = mode === "login"
    ? "Accède à ton espace personnel sécurisé et retrouve tout l’univers LaBaJo & Co."
    : "Reçois un lien de connexion sécurisé par e-mail, sans saisir de mot de passe.";
  const submitLabel = busy ? "Un instant…" : mode === "login" ? "Se connecter" : "Envoyer le lien unique";
  const discover = mode === "login"
    ? { title: "Première connexion ?", action: "Comment ça marche", go: () => setIntroOpen(true) }
    : { title: "Retour", action: "Revenir à la connexion", go: () => { setMode("login"); setMessage(""); } };

  return <main className="auth-page">
    <div className="auth-hero">
      <section className="auth-brand">
        <span className="auth-logo"><img src="/Labajo logo.png" alt="LaBaJo & Co" width={52} height={52} /></span>
        <div className="auth-brand-copy">
          <small>LABAJO &amp; CO</small>
          <h1>Grandir avec<br />son argent.</h1>
          <p>Les cadeaux bienveillants d’aujourd’hui,<br />les grandes réussites de demain.</p>
        </div>
        <span className="auth-art" aria-hidden="true">
          <svg viewBox="0 0 180 210" fill="none">
            <defs>
              <radialGradient id="capSun" cx="50%" cy="45%" r="55%"><stop offset="0%" stopColor="#fef5d3" /><stop offset="52%" stopColor="#f3d585" /><stop offset="100%" stopColor="#dca844" /></radialGradient>
              <linearGradient id="capArch" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3a716c" /><stop offset="100%" stopColor="#123230" /></linearGradient>
              <linearGradient id="capStep" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#4c8b83" /><stop offset="100%" stopColor="#1b4742" /></linearGradient>
              <filter id="capGlow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="9" /></filter>
            </defs>
            <circle cx="108" cy="74" r="42" fill="#f3d585" opacity="0.16" filter="url(#capGlow)" />
            <path d="M44 205 L44 92 a46 46 0 0 1 92 0 L136 205" stroke="url(#capArch)" strokeWidth="15" strokeLinecap="round" />
            <path d="M60 205 L60 95 a30 30 0 0 1 60 0 L120 205 Z" fill="#0b2321" />
            <circle cx="108" cy="76" r="21" fill="url(#capSun)" opacity="0.55" filter="url(#capGlow)" />
            <circle cx="108" cy="76" r="20" fill="url(#capSun)" />
            <ellipse cx="88" cy="196" rx="42" ry="9" fill="url(#capStep)" />
            <ellipse cx="92" cy="179" rx="34" ry="8" fill="url(#capStep)" />
            <ellipse cx="97" cy="163" rx="26" ry="7" fill="url(#capStep)" />
          </svg>
        </span>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <header><span>ESPACE FAMILLE PRIVÉ</span><h2>{heading}</h2><p>{subtitle}</p></header>
          <button type="button" className="google-button" onClick={googleLogin} disabled>
            <svg className="google-g" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z" /><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" /><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" /><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" /></svg>
            Continuer avec Google
          </button>
          <div className="auth-separator"><span />ou<span /></div>
          <form onSubmit={submit}>
            <label>Adresse e-mail
              <span className="auth-field">
                <svg className="auth-field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" /></svg>
                <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="prenom@example.com" autoComplete="email" required />
              </span>
            </label>
            {mode !== "magic" && <label>Mot de passe
              <span className="auth-field">
                <svg className="auth-field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
                <input type={showPw ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} autoComplete="current-password" placeholder="••••••••" required />
                <button type="button" className="auth-field-toggle" onClick={() => setShowPw((value) => !value)} aria-label={showPw ? "Masquer le mot de passe" : "Afficher le mot de passe"}>
                  {showPw
                    ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m3 3 18 18" /><path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-2.8 3.3M6.1 6.5A17 17 0 0 0 2 12s3.5 6 10 6c1.2 0 2.3-.2 3.3-.5" /></svg>
                    : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>}
                </button>
              </span>
            </label>}
            {mode === "login" && <button type="button" className="auth-forgot" onClick={() => { setMode("magic"); setMessage(""); }}>Mot de passe oublié ?</button>}
            <button className="auth-submit" disabled={busy}>{submitLabel}</button>
            {mode === "login" && <button type="button" className="auth-magic" onClick={() => { setMode("magic"); setMessage(""); }}>Recevoir un lien unique par e-mail →</button>}
          </form>
          {message && <p className="auth-message">{message}</p>}
        </div>
        <button type="button" className="auth-discover" onClick={discover.go}>
          <span><strong>{discover.title}</strong><small>{discover.action}</small></span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="auth-discover-arrow"><path d="m9 6 6 6-6 6" /></svg>
        </button>
        <p className="auth-secure">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="auth-secure-icon"><path d="M12 3 5 6v5c0 4.5 3 7.6 7 9 4-1.4 7-4.5 7-9V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg>
          <span>Vos données sont 100% sécurisées.<br />Accès sur invitation.</span>
        </p>
        <p className="auth-version">07/2026 · Version {appSemver()}</p>
      </section>
    </div>

    {introOpen && <div className="modal-backdrop auth-intro-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setIntroOpen(false)}>
      <section ref={introRef} className="auth-intro" role="dialog" aria-modal="true" aria-labelledby="auth-intro-title" tabIndex={-1}>
        <button type="button" className="auth-intro-close" onClick={() => setIntroOpen(false)} aria-label="Fermer">×</button>
        <span className="auth-intro-eyebrow">LABAJO &amp; CO</span>
        <h2 id="auth-intro-title">Comment rejoindre l’espace famille ?</h2>
        <p>LaBaJo &amp; Co est un espace privé réservé à la famille : chaque accès est créé par Florent, il n’y a pas d’inscription libre. Choisis ta situation :</p>
        <div className="auth-intro-options">
          <button type="button" className="auth-intro-option" onClick={() => { setIntroOpen(false); setMode("login"); setMessage(""); }}>
            <strong>J’ai reçu une invitation</strong>
            <span>Continuer avec mon e-mail et mon mot de passe</span>
          </button>
          <button type="button" className="auth-intro-option" onClick={() => { setIntroOpen(false); setMode("magic"); setMessage(""); }}>
            <strong>Je veux un accès</strong>
            <span>Faire une demande et recevoir un lien unique par e-mail</span>
          </button>
        </div>
      </section>
    </div>}
  </main>;
}

function appSemver() {
  return process.env.NEXT_PUBLIC_APP_SEMVER ?? "1.6.1";
}

function readAuthHashError(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash || !hash.includes("error")) return null;
  const params = new URLSearchParams(hash);
  const errorCode = params.get("error_code");
  if (errorCode === "otp_expired") return "Ce lien a expiré. Demande un nouveau lien ci-dessous : il te connectera directement, sans mot de passe.";
  if (params.get("error") === "access_denied") return "Ce lien n’est plus valide. Demande un nouveau lien ci-dessous : il te connectera directement, sans mot de passe.";
  const description = params.get("error_description");
  return description ? description.replace(/\+/g, " ") : null;
}

const NOT_FAMILY_CONTACT = "Cette adresse e-mail n’est pas encore autorisée. Demande à Florent (florent.lambert@gmail.com) de créer ton accès LaBaJo & Co, puis réessaie.";

function friendlyAuthError(error: unknown) {
  const message = error instanceof Error ? error.message : "Connexion impossible";
  const normalized = message.toLowerCase();
  if (normalized.includes("ne fait pas partie")) return NOT_FAMILY_CONTACT;
  if (normalized.includes("signups not allowed") || normalized.includes("signup is disabled") || normalized.includes("signups are disabled")) return NOT_FAMILY_CONTACT;
  if (normalized.includes("email not confirmed")) return "Adresse e-mail non confirmée. Utilise « Recevoir un lien unique » ou contacte Florent.";
  if (normalized.includes("invalid login credentials")) return "Adresse e-mail ou mot de passe incorrect.";
  if (normalized.includes("rate limit") || normalized.includes("security purposes")) return "Trop de demandes rapprochées. Attends une minute avant de réessayer.";
  return message;
}

function AccessDenied({ message, onSignOut }: { message: string; onSignOut: () => void }) {
  return <main className="access-denied"><span>!</span><h1>Accès non autorisé</h1><p>{message}</p><small>Demande à Florent d’ajouter ton adresse e-mail dans la famille avant de réessayer.</small><button onClick={onSignOut}>Utiliser un autre compte</button></main>;
}
