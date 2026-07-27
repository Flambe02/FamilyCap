"use client";

// Leçon « Comprendre un ETF en 5 minutes ».
// Même architecture que les leçons existantes : contenu en modale, `useDialogA11y` pour le piège
// de focus / Échap / restauration du focus, classes partagées de family.css (.modal, .info-callout,
// .primary-button/.secondary-button). Aucune table Supabase pour le CONTENU (comme les autres
// leçons) ; seul le défi/quiz (+20 points) passe par le moteur RÉEL des défis (challenges +
// points_ledger), jamais une seconde source de vérité — voir lib/lesson-quiz-etf-service.ts.
//
// Nouveauté par rapport aux autres leçons : une barre de progression de lecture qui fonctionne
// réellement (desktop ET mobile). Les tentatives précédentes (leçon Épargne) l'avaient écartée
// car `.modal` porte un padding sur tous les côtés et un `position: sticky` s'y épingle SOUS ce
// padding, laissant un vide au-dessus. Ici, `.etf-lesson-modal` remet ce padding à zéro et le
// recrée lui-même sur la barre + l'en-tête, tous deux `position: sticky` — plus de vide, la barre
// reste flush avec le bord réel de la modale à tout moment du défilement.

import { useEffect, useState, type ReactNode } from "react";
import { useDialogA11y } from "./use-dialog-a11y";
import { authenticatedFetch } from "./investment-shared";
import { NavIcon } from "./dashboard-ui";
import { EtfIllustration } from "./lesson-etf-illustration";
import { LessonQuiz, type LessonQuizAnswerCheck, type LessonQuizCompleteResult, type LessonQuizQuestion } from "./lesson-quiz";
import "./lesson-etf-5min.css";

const STROKE = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const DiversificationIcon = () => <svg {...STROKE}><circle cx="9" cy="9" r="6.2" /><circle cx="15" cy="9" r="6.2" /><circle cx="12" cy="15" r="6.2" /></svg>;
const FeesIcon = () => <svg {...STROKE}><path d="M3 12 12 3h7a2 2 0 0 1 2 2v7l-9 9a2 2 0 0 1-2.8 0L3 14.8a2 2 0 0 1 0-2.8Z" /><circle cx="15.5" cy="8.5" r="1.4" fill="currentColor" stroke="none" /></svg>;
const SimplicityIcon = () => <svg {...STROKE}><circle cx="12" cy="12" r="8.4" /><path d="m8.4 12.4 2.6 2.6 4.6-5.4" /></svg>;
const HorizonIcon = () => <svg {...STROKE}><path d="M3 15c3-4.6 6-4.6 9 0s6 4.6 9 0" /><circle cx="12" cy="8.6" r="3" /></svg>;

const SECTOR_COLORS = ["#1d706b", "#ef8b72", "#f3b649", "#5a9bd4", "#3aa17e"];
const SECTORS = ["Technologie", "Santé", "Industrie", "Finance", "Consommation"];

const SUMMARY_KEYWORDS: { label: string; icon: ReactNode }[] = [
  { label: "Panier", icon: <NavIcon id="wallet" /> },
  { label: "Indice", icon: <NavIcon id="trending-up" /> },
  { label: "Diversification", icon: <DiversificationIcon /> },
  { label: "Frais", icon: <FeesIcon /> },
  { label: "Risque", icon: <NavIcon id="shield-check" /> },
];

const SOURCES = [
  { label: "justETF France", url: "https://www.justetf.com/fr/" },
  { label: "justETF, Comment trouver le bon ETF", url: "https://www.justetf.com/fr/academy/comment-trouver-le-bon-etf.html" },
  { label: "AMF, Ce qu’il faut savoir sur les ETF avant d’investir", url: "https://www.amf-france.org/fr/espace-epargnants/comprendre-les-produits-financiers/placements-collectifs/trackers-etf" },
  { label: "Finary, ETF World", url: "https://finary.com/fr/blog/bourse/etf/etf-world" },
  { label: "Finary, ETF capitalisant ou distribuant", url: "https://finary.com/fr/blog/bourse/etf/capitalisant-ou-distribuant" },
];

function SectionHead({ number, icon, title, id, tone }: { number: string; icon: ReactNode; title: string; id: string; tone?: "amber" }) {
  return (
    <header className="etf-head">
      <span className={`etf-head-icon${tone ? ` tone-${tone}` : ""}`} aria-hidden="true">{icon}</span>
      <div>
        <span className="etf-head-number" aria-hidden="true">{number}</span>
        <h3 id={id}>{title}</h3>
      </div>
    </header>
  );
}

type QuizStatusResponse = { available: boolean; completed: boolean; pointsAwarded: number | null; questions: LessonQuizQuestion[] };

export function EtfLesson({ onClose, onOpenChallenges }: { onClose: () => void; onOpenChallenges: () => void }) {
  const dialogRef = useDialogA11y(true, onClose);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<QuizStatusResponse | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [celebration, setCelebration] = useState<{ points: number; freshlyCompleted: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    authenticatedFetch("/api/lessons/etf-5min-quiz")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: QuizStatusResponse | null) => { if (active) { if (data) setStatus(data); else setStatusError(true); } })
      .catch(() => { if (active) setStatusError(true); })
      .finally(() => {});
    return () => { active = false; };
  }, []);

  // Barre de progression de lecture : la modale EST le conteneur défilant (`.modal { overflow: auto }`).
  function trackProgress(event: React.UIEvent<HTMLElement>) {
    const element = event.currentTarget;
    const scrollable = element.scrollHeight - element.clientHeight;
    setProgress(scrollable <= 0 ? 0 : Math.min(100, Math.max(0, (element.scrollTop / scrollable) * 100)));
  }

  async function checkAnswer(questionId: string, answerIndex: number): Promise<LessonQuizAnswerCheck | null> {
    const response = await authenticatedFetch("/api/lessons/etf-5min-quiz", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "check", questionId, answerIndex }),
    });
    if (!response.ok) return null;
    return response.json();
  }

  async function completeQuiz(answers: Record<string, number>): Promise<LessonQuizCompleteResult> {
    const response = await authenticatedFetch("/api/lessons/etf-5min-quiz", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "complete", answers }),
    });
    if (!response.ok) throw new Error("Échec de la validation du quiz.");
    const result = await response.json() as { allCorrect: boolean; alreadyCompleted?: boolean; pointsAwarded?: number };
    if (result.allCorrect) {
      setStatus((current) => current ? { ...current, completed: true, pointsAwarded: result.pointsAwarded ?? current.pointsAwarded } : current);
      if (!result.alreadyCompleted) setCelebration({ points: result.pointsAwarded ?? 20, freshlyCompleted: true });
      else setCelebration({ points: result.pointsAwarded ?? 20, freshlyCompleted: false });
    }
    return { allCorrect: result.allCorrect };
  }

  const rewardPoints = status?.pointsAwarded ?? 20;

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="modal etf-lesson-modal" role="dialog" aria-modal="true" aria-labelledby="etf-lesson-title" tabIndex={-1} onScroll={trackProgress}>
        <div className="etf-lesson-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
        <header className="etf-lesson-header">
          <div>
            <span>INVESTISSEMENT</span>
            <h2 id="etf-lesson-title">Comprendre un ETF en 5 minutes</h2>
            <div className="etf-lesson-meta" aria-label="Informations sur la leçon">
              <span>5 min</span><span>Débutant</span><span className="etf-lesson-reward"><NavIcon id="star" /> +{rewardPoints} points</span>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer la leçon, retour au catalogue">×</button>
        </header>

        <div className="etf-lesson-body">
          <EtfIllustration variant="hero" label="Formes colorées représentant des secteurs d'activité génériques convergeant vers un panier, pour illustrer un ETF." />

          <p className="etf-intro">
            En cinq minutes, découvre comment un seul investissement peut te permettre de détenir une petite part de centaines d’entreprises.
          </p>

          <section className="etf-essential" aria-labelledby="etf-essential-title">
            <h3 id="etf-essential-title">L’essentiel en 20 secondes</h3>
            <ul className="etf-keywords">
              {SUMMARY_KEYWORDS.map((item) => (
                <li key={item.label}><span aria-hidden="true">{item.icon}</span><span>{item.label}</span></li>
              ))}
            </ul>
          </section>

          {/* -------------------------------------------------------------------- 01 */}
          <section className="etf-section" aria-labelledby="etf-s1-title">
            <SectionHead number="01" icon={<NavIcon id="wallet" />} title="Un ETF, c’est quoi ?" id="etf-s1-title" />
            <p>Un ETF est un panier d’investissements que tu peux acheter en une seule fois.</p>
            <p>Au lieu d’acheter séparément des actions de plusieurs entreprises, tu achètes une part d’un fonds qui les regroupe.</p>
            <p>La plupart des ETF cherchent à reproduire un indice boursier. L’ETF monte ou baisse généralement avec l’indice qu’il suit.</p>

            <ul className="etf-index-cards">
              <li><strong>CAC 40</strong><span>Grandes entreprises françaises</span></li>
              <li><strong>S&amp;P 500</strong><span>Grandes entreprises américaines</span></li>
              <li><strong>MSCI World</strong><span>Environ 1 300 entreprises de pays développés</span></li>
            </ul>

            <div className="etf-flow" role="img" aria-label="100 euros investis dans un ETF, réparti entre les secteurs Technologie, Santé, Industrie, Finance et Consommation">
              <div className="etf-flow-box etf-flow-money">100 €<small>investis</small></div>
              <span className="etf-flow-arrow" aria-hidden="true">↓</span>
              <div className="etf-flow-box etf-flow-etf">ETF</div>
              <span className="etf-flow-arrow" aria-hidden="true">↓</span>
              <div className="etf-flow-sectors">
                {SECTORS.map((sector, index) => (
                  <span key={sector} style={{ background: SECTOR_COLORS[index] }}>{sector}</span>
                ))}
              </div>
            </div>

            <Takeaway>Avec une seule opération, tu peux investir dans des centaines d’entreprises.</Takeaway>
          </section>

          {/* -------------------------------------------------------------------- 02 */}
          <section className="etf-section" aria-labelledby="etf-s2-title">
            <SectionHead number="02" icon={<NavIcon id="trending-up" />} title="Un exemple très simple" id="etf-s2-title" />
            <p>Tu investis 100 € dans un ETF MSCI World.</p>
            <p>Ton argent est indirectement réparti entre de nombreuses entreprises internationales. Si l’ensemble de ces entreprises progresse, la valeur de ton ETF augmente. Si les marchés baissent, sa valeur peut également diminuer.</p>
            <p>Tu ne cherches donc pas à deviner quelle entreprise sera la prochaine grande gagnante. Tu investis dans un ensemble de grandes entreprises.</p>

            <div className="etf-split-bar" role="img" aria-label="Illustration simplifiée : 100 euros répartis entre plusieurs secteurs, à titre indicatif seulement">
              {SECTORS.map((sector, index) => (
                <span key={sector} style={{ flexGrow: 5 - index, background: SECTOR_COLORS[index] }} />
              ))}
            </div>
            <p className="etf-caption">Répartition illustrative et simplifiée — pas la composition réelle d’un indice.</p>
          </section>

          {/* -------------------------------------------------------------------- 03 */}
          <section className="etf-section" aria-labelledby="etf-s3-title">
            <SectionHead number="03" icon={<NavIcon id="list-checks" />} title="Pourquoi les ETF sont-ils populaires ?" id="etf-s3-title" />
            <ul className="etf-why-grid">
              <li>
                <span className="etf-why-icon" aria-hidden="true"><DiversificationIcon /></span>
                <h4>Diversification</h4>
                <p>Ton investissement ne dépend pas d’une seule entreprise. Attention, un ETF spécialisé dans un seul secteur, une seule thématique ou un seul pays peut rester très concentré.</p>
              </li>
              <li>
                <span className="etf-why-icon" aria-hidden="true"><FeesIcon /></span>
                <h4>Frais généralement faibles</h4>
                <p>Un ETF suit automatiquement un indice. Ses frais annuels sont indiqués par le TER.</p>
                <p className="etf-ter-example">TER de 0,20 % = environ 2 € de frais annuels pour 1 000 € investis.</p>
                <p className="etf-caption">Exemple simplifié — d’autres frais, notamment de transaction, peuvent exister.</p>
              </li>
              <li>
                <span className="etf-why-icon" aria-hidden="true"><SimplicityIcon /></span>
                <h4>Simplicité</h4>
                <p>Une part d’ETF s’achète et se vend en Bourse, comme une action.</p>
              </li>
              <li>
                <span className="etf-why-icon" aria-hidden="true"><HorizonIcon /></span>
                <h4>Vision à long terme</h4>
                <p>Les ETF permettent d’investir régulièrement sans essayer de prévoir les mouvements quotidiens des marchés.</p>
              </li>
            </ul>
          </section>

          {/* -------------------------------------------------------------------- 04 */}
          <section className="etf-section" aria-labelledby="etf-s4-title">
            <SectionHead number="04" icon={<NavIcon id="shield-check" />} title="Les risques à connaître" id="etf-s4-title" tone="amber" />
            <div className="etf-risk-card">
              <p><strong>Un ETF n’est pas un livret d’épargne.</strong></p>
              <ul>
                <li>Sa valeur peut monter ou baisser.</li>
                <li>Le capital n’est pas garanti.</li>
                <li>Une baisse peut durer plusieurs mois ou plusieurs années.</li>
                <li>Les performances passées ne garantissent pas les performances futures.</li>
                <li>Certains ETF spécialisés ou à effet de levier sont beaucoup plus risqués.</li>
              </ul>
              <svg className="etf-risk-curve" viewBox="0 0 300 70" role="img" aria-label="Courbe schématique : une valeur d’investissement peut monter et descendre dans le temps, sans direction certaine">
                <path d="M4 44C34 14 58 60 90 36S150 8 186 40 250 62 296 26" fill="none" stroke="#ef8b72" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </div>
            <p className="etf-risk-message">Il vaut mieux investir de l’argent dont tu n’as pas besoin immédiatement et conserver une vision de long terme.</p>
          </section>

          {/* -------------------------------------------------------------------- 05 */}
          <section className="etf-section" aria-labelledby="etf-s5-title">
            <SectionHead number="05" icon={<NavIcon id="book-open" />} title="Comment reconnaître un ETF ?" id="etf-s5-title" />
            <ul className="etf-glossary">
              <li><b>Indice</b> — dans quelles entreprises, régions ou activités l’ETF investit.</li>
              <li><b>Enveloppe</b> — si l’ETF peut être acheté dans un PEA, un compte-titres ou une assurance-vie.</li>
              <li><b>TER</b> — les frais annuels de fonctionnement.</li>
              <li><b>Capitalisant</b> — réinvestit les dividendes.</li>
              <li><b>Distribuant</b> — verse les dividendes sur le compte.</li>
              <li><b>Code ISIN</b> — l’identifiant unique du produit.</li>
              <li><b>DIC</b> — présente les risques, les coûts et les scénarios du produit.</li>
            </ul>

            <div className="etf-id-card">
              <span className="etf-id-badge">Exemple pédagogique — aucun produit réel</span>
              <dl>
                <div><dt>Indice suivi</dt><dd>MSCI World (exemple)</dd></div>
                <div><dt>Éligibilité</dt><dd>Compte-titres</dd></div>
                <div><dt>Frais annuels (TER)</dt><dd>0,25 %</dd></div>
                <div><dt>Capitalisant / distribuant</dt><dd>Capitalisant</dd></div>
                <div><dt>Taille du fonds</dt><dd>850 M€ (exemple)</dd></div>
                <div><dt>Code ISIN</dt><dd>XX0000000001 (fictif)</dd></div>
                <div><dt>Niveau de risque</dt><dd>4 / 7</dd></div>
                <div><dt>Lien vers le DIC</dt><dd>Non disponible pour cet exemple</dd></div>
              </dl>
            </div>

            <p className="etf-links">
              <a href="https://www.justetf.com/fr/" target="_blank" rel="noopener noreferrer">Comparer des ETF sur justETF <span aria-hidden="true">↗</span><span className="sr-only"> (nouvel onglet)</span></a>
              <a href="https://www.justetf.com/fr/academy/comment-trouver-le-bon-etf.html" target="_blank" rel="noopener noreferrer">Découvrir les critères pour choisir un ETF <span aria-hidden="true">↗</span><span className="sr-only"> (nouvel onglet)</span></a>
            </p>
          </section>

          {/* -------------------------------------------------------------------- Résumé */}
          <section className="etf-summary" aria-labelledby="etf-summary-title">
            <h3 id="etf-summary-title">Résumé en 20 secondes</h3>
            <p>Un ETF est un panier d’investissements coté en Bourse. Il permet d’investir simplement dans plusieurs entreprises, souvent avec des frais réduits. Il facilite la diversification, mais sa valeur peut baisser et le capital n’est jamais garanti.</p>
          </section>

          {/* -------------------------------------------------------------------- Quiz + défi */}
          <section className="etf-section etf-challenge" aria-labelledby="etf-quiz-title">
            <SectionHead number="06" icon={<NavIcon id="star" />} title="Mini-quiz : Analyse ton premier ETF" id="etf-quiz-title" />
            <p>Réponds correctement aux trois questions pour valider le défi et gagner tes points.</p>

            {celebration ? (
              <Celebration
                points={celebration.points}
                freshlyCompleted={celebration.freshlyCompleted}
                onContinue={() => setCelebration(null)}
                onOpenChallenges={onOpenChallenges}
              />
            ) : status?.completed ? (
              <div className="etf-already-done">
                <span aria-hidden="true"><NavIcon id="shield-check" /></span>
                <div><strong>Leçon déjà terminée.</strong><p>Tu as déjà validé ce quiz — tes +{rewardPoints} points sont acquis.</p></div>
              </div>
            ) : statusError ? (
              <p className="etf-caption">Le quiz n’est pas disponible pour le moment. Réessaie plus tard.</p>
            ) : status?.questions.length ? (
              <LessonQuiz
                questions={status.questions}
                onCheckAnswer={checkAnswer}
                onComplete={completeQuiz}
                onFinished={() => {}}
                rewardPoints={rewardPoints}
              />
            ) : (
              <p className="etf-caption">Chargement du quiz…</p>
            )}

            <div className="etf-final-challenge">
              <h4>Défi final — Analyse ton premier ETF</h4>
              <p>Trouve un ETF disponible dans ton PEA ou ton compte-titres et identifie :</p>
              <ul>
                <li>son indice ;</li>
                <li>son code ISIN ;</li>
                <li>ses frais annuels ;</li>
                <li>son mode de distribution ;</li>
                <li>son niveau de risque.</li>
              </ul>
            </div>
          </section>

          <details className="etf-details">
            <summary>Pour aller plus loin</summary>
            <ul className="etf-sources">
              {SOURCES.map((source) => (
                <li key={source.url}>
                  <a href={source.url} target="_blank" rel="noopener noreferrer">{source.label} <span aria-hidden="true">↗</span><span className="sr-only"> (nouvel onglet)</span></a>
                </li>
              ))}
            </ul>
          </details>

          <p className="etf-disclaimer">
            Ce contenu est fourni à titre pédagogique et ne constitue pas un conseil en investissement. Tout investissement comporte un risque de perte en capital.
          </p>
        </div>
      </section>
    </div>
  );
}

function Takeaway({ children }: { children: ReactNode }) {
  return <aside className="etf-takeaway"><b>À retenir</b><p>{children}</p></aside>;
}

function Celebration({ points, freshlyCompleted, onContinue, onOpenChallenges }: {
  points: number; freshlyCompleted: boolean; onContinue: () => void; onOpenChallenges: () => void;
}) {
  return (
    <div className="etf-celebration" role="status">
      {freshlyCompleted && (
        <div className="etf-confetti" aria-hidden="true">
          {CONFETTI.map((piece, index) => <span key={index} style={{ left: `${piece.left}%`, background: piece.color, animationDelay: `${piece.delay}s` }} />)}
        </div>
      )}
      <span className="etf-celebration-trophy" aria-hidden="true"><NavIcon id="star" /></span>
      <h4>Bravo, tu sais maintenant reconnaître un ETF !</h4>
      <p className="etf-celebration-points">+{points} points</p>
      <div className="etf-celebration-actions">
        <button type="button" className="primary-button" onClick={onContinue}>Continuer</button>
        <button type="button" className="secondary-button" onClick={onOpenChallenges}>Voir mes défis</button>
      </div>
    </div>
  );
}

// Positions déterministes (pas Math.random) : un rendu serveur/client identique, aucune erreur
// d'hydratation possible.
const CONFETTI = [
  { left: 6, color: "#1d706b", delay: 0 }, { left: 14, color: "#f3b649", delay: 0.12 }, { left: 22, color: "#ef8b72", delay: 0.04 },
  { left: 30, color: "#5a9bd4", delay: 0.2 }, { left: 38, color: "#3aa17e", delay: 0.08 }, { left: 46, color: "#f3b649", delay: 0.16 },
  { left: 54, color: "#1d706b", delay: 0.02 }, { left: 62, color: "#ef8b72", delay: 0.22 }, { left: 70, color: "#5a9bd4", delay: 0.1 },
  { left: 78, color: "#3aa17e", delay: 0.18 }, { left: 86, color: "#f3b649", delay: 0.06 }, { left: 94, color: "#1d706b", delay: 0.14 },
];
