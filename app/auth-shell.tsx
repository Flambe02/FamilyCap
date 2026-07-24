"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabaseBrowser } from "../lib/supabase-browser";
import type { Viewer } from "../lib/auth-types";
import { FamilyDashboard } from "./family-dashboard";
import { OnboardingGate } from "./onboarding/onboarding-gate";
import "./auth.css";

type AuthIntent = "first" | "invite" | "recovery" | null;

export function AuthShell() {
  const [session, setSession] = useState<Session | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [authIntent, setAuthIntent] = useState<AuthIntent>(() => readAuthIntent());
  const [ready, setReady] = useState(false);
  const [setupMode, setSetupMode] = useState(false);
  const [serviceError, setServiceError] = useState("");
  const [accessError, setAccessError] = useState("");
  // Aperçu design réservé au développement local (?preview=dashboard) : n'a aucun effet en production.
  const [designPreview] = useState(() => process.env.NODE_ENV === "development" && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("preview") === "dashboard");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/supabase/status", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return { connected: false, reason: "connection_failed" };
        return response.json() as Promise<{ connected?: boolean; reason?: string }>;
      })
      .then(async (status) => {
        if (!status.connected) {
          if (status.reason === "secret_missing") setSetupMode(true);
          else setServiceError("Le service familial est temporairement indisponible.");
          setReady(true);
          return;
        }
        const { data } = await supabaseBrowser.auth.getSession();
        setSession(data.session);
        if (!data.session) setReady(true);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setServiceError("Le service familial est temporairement indisponible.");
        setReady(true);
      });

    const { data: listener } = supabaseBrowser.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      setViewer(null);
      setAccessError("");
      if (event === "PASSWORD_RECOVERY") setAuthIntent("recovery");
      if (!nextSession) setAuthIntent(null);
      if (!nextSession) setReady(true);
    });
    return () => { controller.abort(); listener.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!authIntent || !session || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("auth");
    url.hash = "";
    window.history.replaceState(null, "", url.pathname + (url.search ? url.search : ""));
  }, [authIntent]);

  // Extrait de l'effet ci-dessous pour être rejouable : après un changement de photo de profil,
  // l'avatar de la barre supérieure, de la sidebar et du menu mobile doit refléter la nouvelle
  // valeur sans recharger la page (ils lisent tous `viewer.photoUrl`).
  const fetchViewer = useCallback(async (accessToken: string, signal?: AbortSignal): Promise<Viewer> => {
    const response = await fetch("/api/auth/me", { headers: { authorization: `Bearer ${accessToken}` }, signal });
    // Le serveur peut répondre en texte brut (500 « Internal Server Error », page d'erreur
    // de la plateforme…). On lit d'abord le texte puis on tente le JSON, pour ne jamais
    // afficher un « Unexpected token … is not valid JSON » à la place d'un vrai message.
    const raw = await response.text();
    let result: { member?: Viewer; error?: string } = {};
    try { if (raw) result = JSON.parse(raw) as { member?: Viewer; error?: string }; } catch { /* réponse non-JSON */ }
    if (!response.ok || !result.member) {
      throw new Error(result.error ?? (response.status >= 500
        ? "Le serveur est momentanément indisponible. Réessaie dans un instant."
        : "Accès familial non autorisé"));
    }
    return result.member;
  }, []);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    void fetchViewer(session.access_token, controller.signal)
      .then(setViewer)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setAccessError(error instanceof Error ? error.message : "Accès refusé");
      })
      .finally(() => setReady(true));
    return () => controller.abort();
  }, [session, fetchViewer]);

  // Rejoué après une écriture qui modifie le viewer lui-même (photo de profil). Échec
  // silencieux volontaire : on conserve la valeur précédente plutôt que d'éjecter
  // l'utilisateur vers l'écran « Accès non autorisé » sur un incident réseau passager.
  const refreshViewer = useCallback(() => {
    if (!session) return;
    void fetchViewer(session.access_token).then(setViewer).catch(() => undefined);
  }, [session, fetchViewer]);

  if (designPreview) return <FamilyDashboard viewer={{ id: "design-preview", email: "apercu@cap.family", name: "Florent", role: "admin" }} onSignOut={() => undefined} />;
  if (!ready) return <div className="auth-loading"><span><img src="/Labajo logo.png" alt="" width={48} height={48} /></span><p>Ouverture de LaBaJo &amp; Co…</p></div>;
  if (serviceError) return <ServiceUnavailable message={serviceError} />;
  if (setupMode) return <FamilyDashboard viewer={{ id: "local-admin", email: "florent.lambert@gmail.com", name: "Florent", role: "admin" }} onSignOut={() => undefined} />;
  if (session && authIntent) return <PasswordSetupScreen intent={authIntent} onDone={() => setAuthIntent(null)} />;
  if (accessError) return <AccessDenied message={accessError} onSignOut={() => void supabaseBrowser.auth.signOut()} />;
  if (!session || !viewer) return <LoginScreen />;
  // La garde d'onboarding décide, avant tout rendu du dashboard, entre le tunnel facultatif
  // (membre non encore onboardé) et l'application. Admin & lecteur familial ne sont jamais gardés.
  return <OnboardingGate viewer={viewer} onSignOut={() => void supabaseBrowser.auth.signOut()} onViewerChanged={refreshViewer} />;
}

function ServiceUnavailable({ message }: { message: string }) {
  return <main className="access-denied"><span aria-hidden="true">!</span><h1>Service indisponible</h1><p>{message}</p><button type="button" onClick={() => window.location.reload()}>Réessayer</button></main>;
}

function LoginScreen() {
  const hashError = readAuthHashError();
  const [mode, setMode] = useState<"login" | "first" | "forgot">(hashError ? "forgot" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState(hashError ?? "");
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);

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
        const redirect = mode === "first" ? `${window.location.origin}/?auth=first` : `${window.location.origin}/`;
        const { error } = await supabaseBrowser.auth.signInWithOtp({ email: normalizedEmail, options: { shouldCreateUser: true, emailRedirectTo: redirect } });
        if (error) throw error;
        setMessage(mode === "first"
          ? "Si cette adresse est autorisée, un lien de première connexion vient d’être envoyé. Ouvre-le pour choisir ton mot de passe."
          : "Si cette adresse est autorisée, un lien unique vient d’être envoyé. Ouvre-le pour te connecter sans mot de passe.");
      }
    } catch (error) { setMessage(friendlyAuthError(error)); }
    finally { setBusy(false); }
  }

  async function googleLogin() {
    setBusy(true); setMessage("");
    const { error } = await supabaseBrowser.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
    if (error) { setMessage(error.message); setBusy(false); }
  }

  async function resetPassword() {
    setBusy(true); setMessage("");
    const normalizedEmail = email.trim().toLowerCase();
    try {
      const { error } = await supabaseBrowser.auth.resetPasswordForEmail(normalizedEmail, { redirectTo: `${window.location.origin}/?auth=recovery` });
      if (error) throw error;
      setMessage("Si cette adresse est autorisée, un lien de réinitialisation vient d’être envoyé. Ouvre-le pour choisir un nouveau mot de passe.");
    } catch (error) { setMessage(friendlyAuthError(error)); }
    finally { setBusy(false); }
  }

  const heading = mode === "login" ? "Heureux de te revoir" : mode === "first" ? "Première connexion" : "Accès par e-mail";
  const subtitle = mode === "login"
    ? "Accède à ton espace personnel sécurisé et retrouve tout l’univers LaBaJo & Co."
    : mode === "first"
      ? "Entre l’adresse e-mail autorisée par Florent. Tu recevras un lien pour confirmer ton adresse et choisir ton mot de passe."
      : "Le lien unique permet de te connecter sans mot de passe. Tu peux aussi demander une vraie réinitialisation.";
  const submitLabel = busy ? "Un instant…" : mode === "login" ? "Se connecter" : mode === "first" ? "Envoyer le lien de première connexion" : "Recevoir le lien unique";

  return <main className="auth-page">
    <div className="auth-hero">
      <section className="auth-brand">
        <img src="/labajo-logo.png" alt="LaBaJo &amp; Co" width={516} height={351} className="auth-brandmark" />
        <div className="auth-brand-copy">
          <small>ESPACE FAMILLE PRIVÉ</small>
          <h1>Grandir avec<br />son argent.</h1>
          <p>Organisez les cadeaux, suivez les projets<br />et construisez l’avenir financier de votre famille.</p>
        </div>
        <img src="/family-growth-illustration.webp" alt="" aria-hidden="true" width={868} height={913} className="auth-art" />
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <header><span>ESPACE FAMILLE PRIVÉ</span><h2>{heading}</h2><p>{subtitle}</p></header>
          <button type="button" className="google-button" onClick={googleLogin} disabled={busy} aria-busy={busy}>
            <svg className="google-g" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z" /><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" /><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" /><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" /></svg>
            Continuer avec Google
          </button>
          <div className="auth-separator"><span />ou<span /></div>
          <form onSubmit={submit}>
            <label>Adresse e-mail
              <span className="auth-field">
                <svg className="auth-field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" /></svg>
                <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="prenom@exemple.com" autoComplete="email" required />
              </span>
            </label>
            {mode === "login" && <label>Mot de passe
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
            {mode === "login" && <button type="button" className="auth-forgot" onClick={() => { setMode("forgot"); setMessage(""); }}>Mot de passe oublié ?</button>}
            <button className="auth-submit" disabled={busy} aria-busy={busy}>{busy && <span className="auth-spinner" aria-hidden="true" />}{submitLabel}</button>
            {mode === "forgot" && <button type="button" className="auth-magic" onClick={() => void resetPassword()} disabled={busy}>Réinitialiser mon mot de passe</button>}
            {mode !== "login" && <button type="button" className="auth-magic" onClick={() => { setMode("login"); setMessage(""); }}>Retour à la connexion</button>}
          </form>
          {message && <p className="auth-message" role="status" aria-live="polite">{message}</p>}
        </div>
        <button type="button" className="auth-discover" onClick={() => { setMode("first"); setMessage(""); }}>
          <span className="auth-discover-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" /></svg>
          </span>
          <span className="auth-discover-copy"><strong>Première connexion ?</strong><small>Activer mon accès avec mon adresse e-mail</small></span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="auth-discover-arrow"><path d="m9 6 6 6-6 6" /></svg>
        </button>
        <p className="auth-secure">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="auth-secure-icon"><path d="M12 3 5 6v5c0 4.5 3 7.6 7 9 4-1.4 7-4.5 7-9V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg>
          <span>Connexion sécurisée.<br />Vos données sont chiffrées et protégées.</span>
        </p>
        <p className="auth-version">07/2026 · Version {appSemver()}</p>
      </section>
    </div>

  </main>;
}

function PasswordSetupScreen({ intent, onDone }: { intent: Exclude<AuthIntent, null>; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) { setMessage("Le mot de passe doit contenir au moins 8 caractères."); return; }
    if (password !== confirmation) { setMessage("Les deux mots de passe ne correspondent pas."); return; }
    setBusy(true); setMessage("");
    const { error } = await supabaseBrowser.auth.updateUser({ password });
    if (error) { setMessage(friendlyAuthError(error)); setBusy(false); return; }
    onDone();
  }

  const title = intent === "recovery" ? "Nouveau mot de passe" : "Créer votre mot de passe";
  const description = intent === "recovery"
    ? "Choisissez un nouveau mot de passe pour sécuriser votre accès."
    : "Votre adresse e-mail est confirmée. Définissez maintenant le mot de passe qui servira pour vos prochaines connexions.";

  return <main className="auth-password-page"><section className="auth-password-card auth-card">
    <header><span>ESPACE FAMILLE PRIVÉ</span><h1>{title}</h1><p>{description}</p></header>
    <form onSubmit={submit}>
      <label>Mot de passe
        <span className="auth-field"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} autoComplete="new-password" required /></span>
      </label>
      <label>Confirmer le mot de passe
        <span className="auth-field"><input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={8} autoComplete="new-password" required /></span>
      </label>
      <button className="auth-submit" disabled={busy}>{busy ? "Enregistrement…" : "Continuer vers la plateforme"}</button>
    </form>
    {message && <p className="auth-message" role="alert">{message}</p>}
  </section></main>;
}

function readAuthIntent(): AuthIntent {
  if (typeof window === "undefined") return null;
  const queryIntent = new URLSearchParams(window.location.search).get("auth");
  if (queryIntent === "first" || queryIntent === "invite" || queryIntent === "recovery") return queryIntent;
  const hash = window.location.hash.replace(/^#/, "");
  const hashType = new URLSearchParams(hash).get("type");
  if (hashType === "recovery") return "recovery";
  if (hashType === "invite") return "invite";
  return null;
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
