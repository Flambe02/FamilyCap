// RECONNAISSANCE DU COURTIER à partir des LIBELLÉS lus sur la capture — jamais de la couleur,
// du logo ni de la mise en page.
//
// Pourquoi textuel : une charte graphique change (Boursorama → Boursobank), une capture peut être
// en mode sombre, recadrée ou compressée. En revanche les intitulés de colonnes d'un tableau de
// portefeuille sont stables dans le temps et parfaitement discriminants : « Px. Revient »,
// « Dernier Mvt » et « +/- Latentes » n'apparaissent ensemble que chez Boursobank.
//
// La décision est prise ICI, en code déterministe, à partir de la liste de libellés que le modèle
// a recopiés. Le modèle ne se prononce jamais lui-même sur l'identité du courtier : il retranscrit,
// on décide. Un score insuffisant donne « courtier non reconnu » — jamais une supposition.

export type BrokerId = "boursobank" | "unknown";

/** Un libellé attendu sur la capture. `weight` traduit son pouvoir discriminant. */
type BrokerMarker = { label: string; weight: number };

export type BrokerProfile = {
  id: BrokerId;
  label: string;
  /** Noms d'établissement possibles (l'entête peut porter l'ancienne marque). */
  aliases: string[];
  markers: BrokerMarker[];
  /** Score minimal pour reconnaître le courtier (somme des poids des marqueurs trouvés). */
  minScore: number;
  /** Consigne de lecture spécifique injectée dans le prompt du modèle vision. */
  promptHints: string;
};

/** Normalisation d'un libellé : accents, casse et ponctuation décorative retirés. */
export function normalizeMarker(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+%/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ------------------------------------------------------------------------------------------
// Boursobank (ex-Boursorama) — écran « Positions » d'un PEA ou d'un compte-titres.
// ------------------------------------------------------------------------------------------
const BOURSOBANK_MARKERS: BrokerMarker[] = [
  // Bandeau de synthèse : ces cinq libellés, ensemble, ne se rencontrent nulle part ailleurs.
  { label: "total portefeuille", weight: 3 },
  { label: "solde especes disponible", weight: 3 },
  { label: "evaluation titres", weight: 3 },
  { label: "montant +/- values latentes", weight: 3 },
  { label: "plafond de versement", weight: 2 },
  { label: "cumul des versements", weight: 2 },
  { label: "date d ouverture du compte", weight: 1 },
  { label: "mode de gestion", weight: 1 },
  { label: "tarification", weight: 1 },
  // Mode de gestion et onglets propres à l'interface.
  { label: "gestion libre", weight: 3 },
  { label: "gestion pilotee", weight: 2 },
  { label: "position instantanee", weight: 2 },
  { label: "position comptable", weight: 2 },
  { label: "tradingboard", weight: 2 },
  { label: "titres non-cotes", weight: 1 },
  // En-têtes du tableau des positions.
  { label: "px revient", weight: 3 },
  { label: "+/- latentes", weight: 3 },
  { label: "dernier mvt", weight: 3 },
  { label: "+/- %", weight: 1 },
  { label: "guide des ordres de bourse", weight: 2 },
  { label: "mise au nominatif", weight: 2 },
  { label: "exporter en csv", weight: 1 },
  // Libellés génériques : présents partout, ils ne décident de rien seuls (poids 0,5).
  { label: "cours", weight: 0.5 },
  { label: "montant", weight: 0.5 },
  { label: "quantite", weight: 0.5 },
  { label: "valeur", weight: 0.5 },
  { label: "notification", weight: 0.5 },
];

const BOURSOBANK_PROMPT = `STRUCTURE PARTICULIÈRE D'UNE CAPTURE BOURSOBANK (ex-Boursorama) — lis-la exactement ainsi :

EN-TÊTE DE COMPTE (bandeau du haut, trois encadrés) :
- Le titre de la page donne le NOM du compte puis son NUMÉRO : « PEA LAMBERT 00088051306 ».
- Encadré 1 : « Total Portefeuille (titres + espèces) », « Solde Espèces disponible <date> »,
  « Évaluation titres », « Montant +/- values latentes » (avec un pourcentage entre parenthèses),
  « Plafond de versement », « Cumul des versements ».
- Encadré 2 : « Tarification », « Date d'ouverture du compte », « Mode de gestion ».
- Encadré 3 : « Ma performance <année> », « Ma performance <mois> », « Ma performance de la veille »,
  « Performance <année> du CAC 40 », « Performance <année> du Top traders ».
  ⚠ Ces performances du bandeau NE SONT PAS des positions et ne doivent JAMAIS apparaître dans
  "positions". Ne les recopie nulle part ailleurs que dans les champs prévus (elles peuvent être
  ignorées).
- « Solde Espèces disponible 25/07/2026 » : la DATE qui suit ce libellé est la date d'arrêté du
  relevé (snapshot). Recopie-la dans document.as_of_date.

TABLEAU DES POSITIONS (« Gestion Libre ») — une ligne par titre détenu :
- Colonne « Valeur » : elle contient DEUX informations empilées — le NOM du titre sur une ou deux
  lignes, puis le CODE ISIN en dessous, en plus petit. Sépare-les : instrument_name = le nom
  complet (recolle les lignes coupées), isin = le code à 12 caractères.
- À gauche de chaque ligne, deux pastilles « A » (acheter) et « V » (vendre) : ce sont des BOUTONS.
  Ils ne font pas partie des données. Ne les lis jamais comme un ticker ni comme un type d'ordre.
- Colonne « Quantité » : entier ou décimal, séparateur de milliers par ESPACE. « 1 000 » vaut mille
  et « 5 000 » vaut cinq mille — jamais 1 ni 5. Recopie le nombre complet.
- Colonne « Px. Revient » : le prix de revient unitaire AFFICHÉ (arrondi par la banque) → average_cost.
- Colonne « Cours » : DEUX valeurs empilées dans la même cellule — le cours en euros sur la première
  ligne, et JUSTE EN DESSOUS la variation du jour en pourcentage (« 244,65 € » puis « 1,22 % »).
  Le cours va dans last_price, la variation du jour dans day_change_pct. Ne confonds JAMAIS cette
  variation du jour avec la performance latente de la position.
- Colonne « Montant » : la valorisation de la ligne (quantité × cours) → current_value.
- Colonne « +/- Latentes » : un MONTANT en euros (plus ou moins-value latente) → gain_amount.
- Colonne « +/- % » : un POURCENTAGE (performance latente depuis l'achat) → gain_pct.
  gain_amount est un montant, gain_pct est un pourcentage : ne les inverse pas.
- Colonne « Dernier Mvt » : la date du DERNIER MOUVEMENT sur la ligne → last_movement_date.
  Ce n'est PAS une date d'achat, ni la date du relevé. Ne l'utilise jamais comme date d'opération.
- Colonne « Notification » : une icône de cloche. Aucune donnée. Ignore-la.

SIGNES ET COULEURS :
- Le texte affiché fait foi, pas la couleur. Une valeur précédée d'un « - » est négative même si
  elle paraît verte à l'écran ; une valeur sans « - » est positive même si elle paraît rouge.
- Recopie le signe tel qu'il est imprimé : « - 4 247,89 € » → -4247.89 ; « - 13,42 % » → -13.42.

Si la capture est coupée en bas (une ligne partiellement visible), retranscris-la quand même avec
une confiance basse et un avertissement, plutôt que de l'omettre.`;

const PROFILES: BrokerProfile[] = [
  {
    id: "boursobank",
    label: "Boursobank",
    aliases: ["boursobank", "boursorama", "boursorama banque", "bourso"],
    markers: BOURSOBANK_MARKERS,
    // 8 points : trois marqueurs forts, ou deux forts plus quelques secondaires. Les libellés
    // génériques (cours, montant…) pèsent 0,5 et ne peuvent donc jamais atteindre le seuil seuls.
    minScore: 8,
    promptHints: BOURSOBANK_PROMPT,
  },
];

export type BrokerDetection = {
  broker: BrokerId;
  label: string | null;
  score: number;
  /** Marqueurs effectivement reconnus (libellés normalisés). */
  matched: string[];
  /** Marqueurs forts attendus mais absents — utile pour expliquer un doute. */
  missingStrong: string[];
  /** true si le nom de l'établissement lu confirme la détection par marqueurs. */
  nameConfirms: boolean;
};

export type BrokerDetectionInput = {
  /** Libellés recopiés par le modèle (en-têtes de colonnes, intitulés du bandeau…). */
  markers?: Array<string | null | undefined> | null;
  /** Nom d'établissement lu sur le document, s'il est présent. */
  institution?: string | null;
  /** Textes libres complémentaires (titre de page, source_text des lignes…). */
  freeText?: Array<string | null | undefined> | null;
};

/**
 * Reconnaît le courtier à partir des libellés lus. Décision DÉTERMINISTE : le score est la somme
 * des poids des marqueurs trouvés ; en dessous du seuil du profil, on renvoie « unknown » plutôt
 * qu'une supposition. Le nom de l'établissement ne suffit jamais à lui seul (il peut être absent
 * d'une capture recadrée) mais il confirme, et vaut alors un bonus.
 */
export function detectBroker(input: BrokerDetectionInput): BrokerDetection {
  const haystack = [
    ...(input.markers ?? []),
    ...(input.freeText ?? []),
    input.institution ?? "",
  ]
    .map(normalizeMarker)
    .filter(Boolean);
  const joined = ` ${haystack.join(" | ")} `;
  const institution = normalizeMarker(input.institution);

  let best: BrokerDetection = { broker: "unknown", label: null, score: 0, matched: [], missingStrong: [], nameConfirms: false };

  for (const profile of PROFILES) {
    const matched: string[] = [];
    let score = 0;
    for (const marker of profile.markers) {
      // Un marqueur compte s'il apparaît DANS un libellé lu (« Solde Espèces disponible
      // 25/07/2026 » contient « solde especes disponible »), jamais à cheval sur deux libellés.
      if (haystack.some((entry) => entry.includes(marker.label))) {
        matched.push(marker.label);
        score += marker.weight;
      }
    }
    const nameConfirms = profile.aliases.some((alias) => institution.includes(alias) || joined.includes(alias));
    if (nameConfirms) score += 2;
    const missingStrong = profile.markers
      .filter((marker) => marker.weight >= 3 && !matched.includes(marker.label))
      .map((marker) => marker.label);

    if (score > best.score) {
      best = {
        broker: score >= profile.minScore ? profile.id : "unknown",
        label: score >= profile.minScore ? profile.label : null,
        score,
        matched,
        missingStrong,
        nameConfirms,
      };
    }
  }
  return best;
}

export function brokerProfile(id: BrokerId): BrokerProfile | null {
  return PROFILES.find((profile) => profile.id === id) ?? null;
}

/**
 * Consignes de lecture à injecter dans le prompt. Sans courtier identifié en amont (premier
 * appel : on ne sait pas encore ce qu'on regarde), on envoie les consignes de TOUS les profils
 * connus — elles sont explicitement conditionnelles (« si la capture vient de … »), ce qui aide
 * le modèle sans le forcer à voir un courtier qui n'est pas là.
 */
export function brokerPromptHints(id: BrokerId | null): string {
  if (id && id !== "unknown") return brokerProfile(id)?.promptHints ?? "";
  return PROFILES.map((profile) => `Si la capture provient de ${profile.label} (repérable aux libellés « ${profile.markers.filter((m) => m.weight >= 3).slice(0, 4).map((m) => m.label).join(" », « ")} ») :\n${profile.promptHints}`).join("\n\n");
}

/** Libellés que le modèle doit recopier verbatim pour permettre la reconnaissance. */
export const MARKER_INSTRUCTION =
  "Recopie dans \"document.detected_markers\" la liste EXACTE des intitulés que tu vois sur la page : "
  + "titres des encadrés de synthèse, en-têtes de colonnes du tableau, onglets. Recopie-les mot pour mot, "
  + "sans les traduire ni les reformuler (ex. \"Total Portefeuille\", \"Px. Revient\", \"+/- Latentes\", "
  + "\"Dernier Mvt\", \"Gestion Libre\"). Cette liste sert à identifier le courtier : elle ne doit contenir "
  + "aucun montant.";
