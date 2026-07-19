"use client";

import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isStandalone() {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

function isIOS() {
  if (typeof window === "undefined") return false;
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

export function InstallAppCard() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [message, setMessage] = useState("");
  const [ios, setIos] = useState(false);

  useEffect(() => {
    setInstalled(isStandalone());
    setIos(isIOS());
    function onBeforeInstall(event: Event) {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setInstalled(true);
      setDeferredPrompt(null);
      setMessage("LaBaJo & Co est installée sur cet appareil.");
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    setMessage(choice.outcome === "accepted" ? "Installation en cours…" : "Installation annulée.");
    setDeferredPrompt(null);
  }

  if (installed) {
    return <div className="info-callout"><b>Application installée</b><p>LaBaJo & Co est déjà sur ton écran d’accueil.</p></div>;
  }

  if (deferredPrompt) {
    return <div className="export-card">
      <div><strong>Installer LaBaJo & Co</strong><p>Ajoute l’application sur ton écran d’accueil pour l’ouvrir en un geste, comme une app.</p></div>
      <button onClick={() => void install()}>Installer</button>
      {message && <p role="status">{message}</p>}
    </div>;
  }

  if (ios) {
    return <div className="export-card">
      <div><strong>Installer LaBaJo & Co</strong><p>Dans Safari : appuie sur <b>Partager</b> (icône carrée avec une flèche), puis <b>Sur l’écran d’accueil</b>.</p></div>
    </div>;
  }

  return null;
}
