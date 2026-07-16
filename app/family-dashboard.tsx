"use client";

import { useEffect, useMemo, useState } from "react";
import { initialTransactions, InvestmentModal, TransactionRecord, TransactionsView } from "./transactions";
import { TransferRequest } from "./back-office";
import { Administration } from "./administration";
import { GiftPortfolio } from "./gift-portfolio";
import type { Viewer } from "../lib/auth-types";
import { supabaseBrowser } from "../lib/supabase-browser";

type View = "famille" | "portefeuilles" | "transactions" | "backoffice" | "missions" | "apprendre" | "parametres";

const members = [
  { name: "Thibault", initials: "TH", birthday: "15 mars", due: 380.6, btc: 0.005264, missing: 5, color: "mint" },
  { name: "Uhaina", initials: "UH", birthday: "16 août", due: 330.42, btc: 0.004964, missing: 4, color: "coral" },
  { name: "Paul", initials: "PA", birthday: "18 nov.", due: 330, btc: 0.003094, missing: 4, color: "blue" },
  { name: "Aurore", initials: "AU", birthday: "27 août", due: 325.2, btc: 0.005174, missing: 4, color: "yellow" },
  { name: "Thomas", initials: "TO", birthday: "29 déc.", due: 330, btc: 0.003094, missing: 5, color: "purple" },
];

const navItems: { id: View; label: string; icon: string }[] = [
  { id: "famille", label: "Vue famille", icon: "⌂" },
  { id: "portefeuilles", label: "Portefeuilles", icon: "◫" },
  { id: "transactions", label: "Transactions", icon: "⇄" },
  { id: "backoffice", label: "Administration", icon: "▣" },
  { id: "missions", label: "Missions", icon: "◎" },
  { id: "apprendre", label: "Apprendre", icon: "◇" },
  { id: "parametres", label: "Paramètres", icon: "⚙" },
];

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });

async function authenticatedFetch(url: string, init: RequestInit) {
  const { data } = await supabaseBrowser.auth.getSession();
  return fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      ...(data.session ? { authorization: "Bearer " + data.session.access_token } : {}),
    },
  });
}

export function FamilyDashboard({ viewer, onSignOut }: { viewer: Viewer; onSignOut: () => void }) {
  const [view, setView] = useState<View>("famille");
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [activity, setActivity] = useState([
    { member: "Thibault", label: "Cadeau anniversaire", detail: "55,00 € · Bitcoin", time: "15 mars" },
    { member: "Famille", label: "Mission publiée", detail: "Comprendre les ETF indiciels", time: "1 juil." },
  ]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>(initialTransactions);
  const [transferRequests, setTransferRequests] = useState<TransferRequest[]>([]);
  const visibleNavItems = useMemo(() => navItems.filter((item) => item.id !== "backoffice" || viewer.role === "admin"), [viewer.role]);

  useEffect(() => {
    const controller = new AbortController();
    void authenticatedFetch("/api/transfer-requests", { signal: controller.signal })
      .then((response) => response.json())
      .then((result: { requests?: TransferRequest[] }) => setTransferRequests(result.requests ?? []))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) console.error(error);
      });
    return () => controller.abort();
  }, []);

  const totalDue = useMemo(() => members.reduce((sum, member) => sum + member.due, 0), []);
  const missing = useMemo(() => members.reduce((sum, member) => sum + member.missing, 0), []);

  function saveInvestment(transaction: TransactionRecord) {
    setTransactions((current) => [transaction, ...current]);
    setActivity((current) => [
      { member: transaction.member, label: "Investissement saisi", detail: `${euro.format(transaction.amount)} · ${transaction.asset} · par ${transaction.author}`, time: "Aujourd’hui" },
      ...current,
    ]);
    setModalOpen(false);
    setToast("Opération enregistrée et visible dans Transactions");
    window.setTimeout(() => setToast(""), 3200);
  }

  function requestTransfer(transaction: TransactionRecord) {
    const request: TransferRequest = {
      id: `request-${transaction.id}-${Date.now()}`,
      member: transaction.member,
      transactionId: transaction.id,
      btcAmount: transaction.quantity,
      requestedAt: "Aujourd’hui",
      status: "Nouvelle",
    };

    setTransferRequests((current) =>
      current.some((item) => item.transactionId === transaction.id && item.status !== "Transférée")
        ? current
        : [request, ...current],
    );
    setToast(`Demande de ${transaction.member} envoyée au back-office`);
    window.setTimeout(() => setToast(""), 3200);
    void authenticatedFetch("/api/transfer-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, requestedAt: new Date().toISOString() }),
    }).catch(() => undefined);
  }

  function updateRequestStatus(id: string, status: TransferRequest["status"]) {
    setTransferRequests((current) =>
      current.map((request) => (request.id === id ? { ...request, status } : request)),
    );
    void authenticatedFetch("/api/transfer-requests", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, status }),
    }).catch(() => undefined);
  }


  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setView("famille")} aria-label="Accueil Cap Family">
          <span className="brand-mark">C</span>
          <span><strong>Cap Family</strong><small>L’école financière</small></span>
        </button>

        <nav aria-label="Navigation principale">
          <p className="nav-kicker">ESPACE FAMILLE</p>
          {visibleNavItems.map((item) => (
            <button key={item.id} className={view === item.id ? "nav-item active" : "nav-item"} onClick={() => setView(item.id)}>
              <span aria-hidden="true">{item.icon}</span>{item.label}
              {item.id === "missions" && <em>4</em>}
              {item.id === "backoffice" && transferRequests.length > 0 && <em>{transferRequests.length}</em>}
            </button>
          ))}
        </nav>

        <div className="learning-card">
          <span className="learning-icon">✦</span>
          <strong>Conseil du mois</strong>
          <p>Investir régulièrement compte souvent plus que choisir le “moment parfait”.</p>
          <button onClick={() => setView("apprendre")}>Comprendre pourquoi →</button>
        </div>

        <div className="profile-mini">
          <span className="avatar admin">FM</span>
          <span><strong>{viewer.name}</strong><small>{viewer.role === "admin" ? "Administrateur" : viewer.email}</small></span>
          <button onClick={() => setView("parametres")} aria-label="Ouvrir les paramètres">•••</button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">JEUDI 16 JUILLET 2026</p>
            <h1>{titleFor(view)}</h1>
          </div>
          <div className="top-actions">
            <button className="icon-button" aria-label="Notifications">♢<span /></button>
            <button className="primary-button" onClick={() => setModalOpen(true)}><b>＋</b> Ajouter une opération</button>
          </div>
        </header>

        {view === "famille" && (
          <Dashboard totalDue={totalDue} missing={missing} activity={activity} openModal={() => setModalOpen(true)} navigate={setView} />
        )}
        {view === "portefeuilles" && <Portfolios openModal={() => setModalOpen(true)} viewer={viewer} />}
        {view === "transactions" && <TransactionsView transactions={viewer.role === "admin" ? transactions : transactions.filter((transaction) => transaction.member === viewer.name)} onAdd={() => setModalOpen(true)} onTransferRequest={requestTransfer} />}
        {view === "backoffice" && viewer.role === "admin" && <Administration viewer={viewer} requests={transferRequests} onRequestStatus={updateRequestStatus} />}
        {view === "missions" && <Missions openModal={() => setModalOpen(true)} />}
        {view === "apprendre" && <Learn />}
        {view === "parametres" && <Settings viewer={viewer} onSignOut={onSignOut} />}
      </section>

      <nav className="mobile-nav" aria-label="Navigation mobile">
        {visibleNavItems.map((item) => (
          <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>
            <span>{item.icon}</span><small>{item.label.split(" ")[0]}</small>
          </button>
        ))}
      </nav>

      {modalOpen && <InvestmentModal onClose={() => setModalOpen(false)} onSave={saveInvestment} />}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </main>
  );
}

function Dashboard({ totalDue, missing, activity, openModal, navigate }: {
  totalDue: number;
  missing: number;
  activity: { member: string; label: string; detail: string; time: string }[];
  openModal: () => void;
  navigate: (view: View) => void;
}) {
  return (
    <div className="content-grid">
      <section className="welcome-panel">
        <div>
          <span className="soft-pill">● SITUATION AUJOURD’HUI</span>
          <h2>Bonjour 👋<br />La famille avance bien.</h2>
          <p>Le suivi Bitcoin est prêt. La prochaine étape est de compléter les achats manquants puis de rapprocher Binance et les Ledger.</p>
        </div>
        <div className="hero-orbit" aria-hidden="true"><span className="coin">₿</span><i /><b /></div>
      </section>

      <section className="stats-row" aria-label="Indicateurs clés">
        <Stat label="Cadeaux cumulés" value={euro.format(totalDue)} note="31 cadeaux depuis 2022" tone="navy" icon="€" />
        <Stat label="À compléter" value={`${missing} achats`} note="Quantités BTC manquantes" tone="amber" icon="!" />
        <Stat label="Prochain événement" value="16 août" note="Anniversaire d’Uhaina" tone="teal" icon="⌁" />
      </section>

      <section className="panel family-panel">
        <PanelTitle eyebrow="LES MEMBRES" title="Vue d’ensemble" action="Gérer la famille" onAction={() => navigate("parametres")} />
        <div className="member-grid">
          {members.map((member) => (
            <article className="member-card" key={member.name}>
              <div className="member-top"><span className={`avatar ${member.color}`}>{member.initials}</span><span className="status-dot">À vérifier</span></div>
              <h3>{member.name}</h3><p>Anniversaire · {member.birthday}</p>
              <div className="member-value"><strong>{euro.format(member.due)}</strong><small>cadeaux cumulés</small></div>
              <div className="progress"><span style={{ width: `${Math.max(18, 100 - member.missing * 12)}%` }} /></div>
              <footer><span>{member.btc.toFixed(8)} BTC connus</span><b>{member.missing} à saisir</b></footer>
            </article>
          ))}
        </div>
      </section>

      <section className="panel mission-panel">
        <PanelTitle eyebrow="MISSION DE JUILLET" title="Faire travailler 55 €" action="Toutes les missions" onAction={() => navigate("missions")} />
        <div className="mission-body">
          <div className="mission-score"><strong>1<span>/5</span></strong><small>membre à jour</small></div>
          <div className="mission-copy"><span className="tag">NIVEAU DÉBUTANT · 8 MIN</span><h3>Découvrir l’investissement régulier</h3><p>Comprendre pourquoi investir un petit montant chaque mois réduit le stress et construit une habitude durable.</p><div className="avatars"><span>TH</span><span>UH</span><span>PA</span><span>AU</span><span>TO</span><small>4 réponses attendues</small></div></div>
          <button className="round-arrow" onClick={() => navigate("missions")} aria-label="Voir la mission">→</button>
        </div>
      </section>

      <section className="panel activity-panel">
        <PanelTitle eyebrow="JOURNAL" title="Activité récente" action="Ajouter" onAction={openModal} />
        <div className="activity-list">
          {activity.slice(0, 4).map((item, index) => (
            <div className="activity-item" key={`${item.label}-${index}`}><span className="activity-mark">{item.member.slice(0, 1)}</span><div><strong>{item.label}</strong><p>{item.member} · {item.detail}</p></div><time>{item.time}</time></div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Portfolios({ viewer }: { openModal: () => void; viewer: Viewer }) {
  return <GiftPortfolio viewer={viewer} />;
}

function Missions({ openModal }: { openModal: () => void }) {
  const missions = [
    { month: "JUILLET", title: "Investir régulièrement", desc: "Choisir un montant réaliste et déclarer l’achat du mois.", progress: 20, status: "En cours" },
    { month: "JUIN", title: "Comprendre un ETF", desc: "Indice, diversification, frais et horizon de placement.", progress: 100, status: "Terminée" },
    { month: "MAI", title: "Risque et volatilité", desc: "Distinguer perte temporaire et perte définitive.", progress: 80, status: "4 sur 5" },
  ];
  return <div className="page-stack"><section className="mission-banner"><div><span>MISSION FAMILIALE · JUILLET 2026</span><h2>Un petit investissement.<br />Une grande habitude.</h2><p>Chaque membre lit le conseil, réalise son opération puis la saisit lui-même.</p><button onClick={openModal}>J’ai investi ce mois-ci →</button></div><div className="steps"><b>1</b><span>Je comprends</span><b>2</b><span>Je choisis</span><b>3</b><span>Je saisis</span></div></section><section className="panel"><PanelTitle eyebrow="PARCOURS MENSUEL" title="Les dernières missions" action="Créer une mission" /><div className="mission-list">{missions.map(m => <article key={m.month}><span className="month-badge">{m.month}</span><div><h3>{m.title}</h3><p>{m.desc}</p><div className="progress wide"><span style={{ width: `${m.progress}%` }} /></div></div><strong>{m.status}</strong></article>)}</div></section></div>;
}

function Learn() {
  const lessons = [
    { level: "LES BASES", title: "Pourquoi investir tôt ?", text: "Le temps et les intérêts composés sont les deux meilleurs alliés d’un jeune investisseur.", icon: "↗", color: "navy" },
    { level: "BITCOIN", title: "Ledger, Binance : qui garde quoi ?", text: "Comprendre la différence entre une plateforme et un portefeuille dont on contrôle les clés.", icon: "₿", color: "amber" },
    { level: "BOURSE", title: "Un ETF en 5 minutes", text: "Acheter en une fois un panier diversifié d’entreprises, avec des frais généralement réduits.", icon: "▥", color: "teal" },
    { level: "SÉCURITÉ", title: "Les 24 mots ne se partagent jamais", text: "L’adresse publique se partage ; la phrase de récupération et la clé privée restent secrètes.", icon: "⌾", color: "coral" },
  ];
  return <div className="page-stack"><section className="learn-head"><span className="soft-pill">BIBLIOTHÈQUE FAMILIALE</span><h2>Apprendre juste ce qu’il faut,<br />au bon moment.</h2><p>Des explications courtes, reliées à une vraie action dans le portefeuille.</p></section><section className="lesson-grid">{lessons.map((lesson, i) => <article className="lesson-card" key={lesson.title}><div className={`lesson-icon ${lesson.color}`}>{lesson.icon}</div><span>{lesson.level} · {i + 4} MIN</span><h3>{lesson.title}</h3><p>{lesson.text}</p><button>Commencer la leçon →</button></article>)}</section></div>;
}

function Settings({ viewer, onSignOut }: { viewer: Viewer; onSignOut: () => void }) {
  const adminTabs = [["utilisateurs", "Utilisateurs & accès"], ["portefeuilles", "Comptes & wallets"], ["cadeaux", "Règles des cadeaux"], ["securite", "Sécurité"], ["donnees", "Données & exports"], ["compte", "Mon compte"]];
  const memberTabs = [["compte", "Mon compte"], ["portefeuilles", "Mes portefeuilles"], ["securite", "Sécurité"]];
  const tabs = viewer.role === "admin" ? adminTabs : memberTabs;
  const [tab, setTab] = useState(viewer.role === "admin" ? "utilisateurs" : "compte");
  return <div className="settings-layout"><aside className="settings-nav"><p>RÉGLAGES</p>{tabs.map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}<span>›</span></button>)}</aside><section className="settings-content panel">{tab === "utilisateurs" && viewer.role === "admin" && <UsersSettings />}{tab === "portefeuilles" && (viewer.role === "admin" ? <WalletSettings /> : <MemberWalletSettings viewer={viewer} />)}{tab === "cadeaux" && viewer.role === "admin" && <GiftSettings />}{tab === "securite" && <SecuritySettings />}{tab === "donnees" && viewer.role === "admin" && <DataSettings />}{tab === "compte" && <PersonalSettings viewer={viewer} onSignOut={onSignOut} />}</section></div>;
}

function PersonalSettings({ viewer, onSignOut }: { viewer: Viewer; onSignOut: () => void }) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  async function updatePassword() {
    if (password.length < 8) { setMessage("Le mot de passe doit contenir au moins 8 caractères."); return; }
    const { error } = await supabaseBrowser.auth.updateUser({ password });
    setMessage(error ? error.message : "Mot de passe mis à jour.");
    if (!error) setPassword("");
  }
  return <><PanelTitle eyebrow="MON ESPACE" title="Compte & connexion" /><p className="section-intro">Ces informations correspondent à ton accès personnel Cap Family.</p><div className="form-grid"><label>Nom<input value={viewer.name} readOnly /></label><label>Adresse e-mail<input value={viewer.email} readOnly /></label><label>Rôle<input value={viewer.role === "admin" ? "Administrateur" : viewer.role === "child" ? "Jeune investisseur" : "Membre famille"} readOnly /></label><label>Nouveau mot de passe<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="8 caractères minimum" autoComplete="new-password" /></label></div><div className="settings-account-actions"><button onClick={updatePassword}>Mettre à jour le mot de passe</button><button className="logout-button" onClick={onSignOut}>Se déconnecter</button></div>{message && <div className="info-callout"><b>Compte</b><p>{message}</p></div>}</>;
}

function UsersSettings() {
  return <><PanelTitle eyebrow="PARAMÈTRES" title="Utilisateurs & accès" action="＋ Ajouter un membre" /><p className="section-intro">Chaque personne aura son propre accès et ne verra que ce qui correspond à son rôle.</p><div className="settings-table">{members.map((m, i) => <div key={m.name}><span className={`avatar ${m.color}`}>{m.initials}</span><div><strong>{m.name}</strong><small>{m.birthday} · {i === 0 ? "Jeune investisseur" : "Membre famille"}</small></div><span className={i === 0 ? "access pending" : "access"}>{i === 0 ? "Invitation à envoyer" : "Accès à configurer"}</span><button aria-label={`Modifier ${m.name}`}>•••</button></div>)}</div><div className="info-callout"><b>Accès des parents et adultes</b><p>Les sœurs intéressées pourront recevoir un rôle “Adulte” : leur propre portefeuille, les contenus pédagogiques et, si tu le souhaites, une vue sur ceux de leurs enfants.</p></div></>;
}

function WalletSettings() {
  const ledgerAddresses = [
    ["Thibault", "bc1qcy4jt8fh5dhj9fq9d4lu2hq6klvvdmlkeqcgks"],
    ["Uhaina", "bc1qqkfmts27j07y8u7a6ap7wyczfhe5afyrkn7y2t"],
    ["Paul", "bc1qxx7ve23aggf0596zf45kx0ppk5qjggpak82wd5"],
    ["Aurore", "bc1qxs2uy67myzfx8z2vtzr6lm3cgrx808azqkt4pg"],
    ["Thomas", "bc1qfwuze87xnhxjfdmr3wnfy3wguu5ymedk4qcwjr"],
  ];
  return <><PanelTitle eyebrow="PARAMÈTRES" title="Comptes & wallets" action="＋ Ajouter un compte" /><p className="section-intro">Les cinq adresses publiques Ledger sont maintenant enregistrées et contrôlées sur la blockchain. Jamais de clé privée ni de phrase de récupération.</p><div className="wallet-list"><article><div className="wallet-logo bitcoin">₿</div><div><strong>Binance commun</strong><p>Compte de passage · parts individuelles à ventiler</p></div><span className="warning-pill">À rapprocher</span></article>{ledgerAddresses.map(([name, address]) => <article key={name}><div className="wallet-logo ledger">L</div><div><strong>Ledger de {name}</strong><p title={address}>{address}</p></div><span className="access">Blockchain connectée</span></article>)}</div><div className="info-callout"><b>Important</b><p>Ces adresses servent uniquement à lire les soldes et transactions publics. Les 24 mots, clés privées, codes PIN et codes Binance ne doivent jamais être saisis ici.</p></div></>;
}

function MemberWalletSettings({ viewer }: { viewer: Viewer }) {
  const addresses: Record<string, string> = {
    Thibault: "bc1qcy4jt8fh5dhj9fq9d4lu2hq6klvvdmlkeqcgks",
    Uhaina: "bc1qqkfmts27j07y8u7a6ap7wyczfhe5afyrkn7y2t",
    Paul: "bc1qxx7ve23aggf0596zf45kx0ppk5qjggpak82wd5",
    Aurore: "bc1qxs2uy67myzfx8z2vtzr6lm3cgrx808azqkt4pg",
    Thomas: "bc1qfwuze87xnhxjfdmr3wnfy3wguu5ymedk4qcwjr",
  };
  const address = addresses[viewer.name];
  return <><PanelTitle eyebrow="MES PARAMÈTRES" title="Mon portefeuille" /><p className="section-intro">Tu peux consulter ton adresse publique et son historique. Seul Florent peut modifier les comptes familiaux.</p>{address ? <div className="wallet-list"><article><div className="wallet-logo ledger">L</div><div><strong>Ledger de {viewer.name}</strong><p>{address}</p></div><span className="access">Blockchain connectée</span></article></div> : <div className="info-callout"><b>Aucun portefeuille associé</b><p>Florent pourra ajouter ton compte depuis le back-office.</p></div>}</>;
}
function GiftSettings() {
  return <><PanelTitle eyebrow="PARAMÈTRES" title="Règles des cadeaux" /><div className="form-grid"><label>Montant par cadeau<div className="input-suffix"><input defaultValue="55,00" /><span>EUR</span></div></label><label>Occasions<select defaultValue="birthday"><option value="birthday">Anniversaire + Noël</option></select></label><label>Date de début<input type="date" defaultValue="2022-12-27" /></label><label>Traitement des frais<select defaultValue="included"><option value="included">Inclus dans les 55 €</option></select></label></div><div className="info-callout"><b>Règle active</b><p>Chaque enfant reçoit 55 € au total, frais Binance et frais réseau compris. Les échéances futures sont générées automatiquement.</p></div></>;
}

function SecuritySettings() {
  return <><PanelTitle eyebrow="PARAMÈTRES" title="Sécurité & confidentialité" /><div className="security-grid"><article><span>1</span><div><strong>Connexion personnelle</strong><p>À la mise en ligne, chaque membre utilisera une invitation sécurisée. Aucun mot de passe ne sera visible ou stocké en clair.</p></div><b>Prévu</b></article><article><span>2</span><div><strong>Rôles et permissions</strong><p>Administrateur, adulte, jeune investisseur et lecture seule.</p></div><b>Défini</b></article><article><span>3</span><div><strong>Données sensibles</strong><p>Les phrases Ledger, clés privées, codes Binance et codes 2FA sont interdits dans l’application.</p></div><b>Actif</b></article></div></>;
}

function DataSettings() {
  return <><PanelTitle eyebrow="PARAMÈTRES" title="Données & exports" /><div className="export-card"><div><strong>Registre de rapprochement</strong><p>Exporter l’historique des cadeaux, les quantités BTC, les soldes Binance/Ledger et les écarts.</p></div><button>Exporter en Excel</button></div><div className="export-card"><div><strong>Sauvegarde familiale</strong><p>Une sauvegarde chiffrée sera disponible avec la version en ligne.</p></div><button disabled>Bientôt</button></div></>;
}

function Stat({ label, value, note, tone, icon }: { label: string; value: string; note: string; tone: string; icon: string }) {
  return <article className="stat-card"><span className={`stat-icon ${tone}`}>{icon}</span><div><p>{label}</p><strong>{value}</strong><small>{note}</small></div></article>;
}

function PanelTitle({ eyebrow, title, action, onAction }: { eyebrow: string; title: string; action?: string; onAction?: () => void }) {
  return <header className="panel-title"><div><span>{eyebrow}</span><h2>{title}</h2></div>{action && <button onClick={onAction}>{action} →</button>}</header>;
}

function titleFor(view: View) {
  return { famille: "Vue famille", portefeuilles: "Portefeuilles", transactions: "Transactions", backoffice: "Administration", missions: "Missions mensuelles", apprendre: "Apprendre", parametres: "Paramètres" }[view];
}
