// Tous les textes du parcours d'accueil, centralisés et facilement remplaçables (i18n futur).
// Le prénom, le nom de l'administrateur, les quantités de cadeaux et les modules disponibles
// sont dynamiques : rien n'est codé en dur dans les composants.

export const onboardingCopy = {
  brand: "LaBaJo & Co",

  welcome: {
    eyebrow: "BIENVENUE",
    title: (firstName: string) => `Bienvenue dans ton espace familial, ${firstName}`,
    description:
      "Retrouve les cadeaux d’Amatxi, suis leur évolution et construis progressivement tes propres investissements.",
    highlights: [
      { icon: "gift", label: "Tes cadeaux", text: "Les cadeaux Bitcoin d’Amatxi et leurs souvenirs." },
      { icon: "bitcoin", label: "Ton Bitcoin", text: "Suivre son évolution, sans jargon." },
      { icon: "sprout", label: "Tes investissements", text: "Avancer à ton rythme, à long terme." },
    ],
    cta: "Commencer",
    defer: "Découvrir plus tard",
  },

  profile: {
    eyebrow: "TON PROFIL",
    title: "Est-ce bien toi ?",
    description: "Vérifie les informations associées à ton espace familial.",
    fields: {
      firstName: "Prénom",
      lastName: "Nom",
      birthday: "Date d’anniversaire",
      language: "Langue",
      currency: "Devise d’affichage",
    },
    birthdayHint: "Ton anniversaire permet d’afficher les cadeaux et souvenirs qui te concernent.",
    cta: "Continuer",
    saving: "Enregistrement…",
    error: "Impossible d’enregistrer ton profil. Réessaie.",
    nameRequired: "Ton prénom est nécessaire.",
  },

  modules: {
    eyebrow: "TON EXPÉRIENCE",
    title: "Que souhaites-tu suivre ?",
    description: "Tu pourras modifier ce choix à tout moment.",
    options: {
      gifts: {
        title: "Cadeaux d’Amatxi",
        description: "Retrouver mes cadeaux Bitcoin et les souvenirs associés.",
        icon: "gift",
      },
      bitcoin: {
        title: "Bitcoin personnel",
        description: "Suivre mes propres achats Bitcoin, séparément des cadeaux.",
        icon: "bitcoin",
      },
      pea: {
        title: "PEA",
        description: "Suivre mes versements, mes positions et leur évolution.",
        icon: "landmark",
      },
      cto: {
        title: "Compte-titres",
        description: "Suivre mes actions, ETF, dividendes et opérations.",
        icon: "trending-up",
      },
    },
    alreadyConfigured: "Déjà configuré",
    footNote: "Aucun compte bancaire ou courtier ne sera connecté durant cette étape.",
    cta: "Continuer",
  },

  privacy: {
    eyebrow: "CONFIDENTIALITÉ",
    title: "Qui peut voir mes investissements ?",
    description: "Tu pourras modifier ces règles à tout moment.",
    options: {
      private: {
        title: "Seulement moi",
        description: "Mes investissements personnels restent privés.",
      },
      admin: {
        // Le nom de l'administrateur réel du groupe familial est injecté dynamiquement.
        title: (adminName: string) => `${adminName}, administrateur familial`,
        description: (adminName: string) => `${adminName} peut m’aider à configurer et suivre mes comptes.`,
      },
      custom: {
        title: "Les membres que je choisis",
        description: "Je pourrai sélectionner les personnes et les comptes concernés.",
      },
    },
    adminEditToggle: "Autoriser l’administrateur à enregistrer des opérations pour moi",
    adminEditHint:
      "Ce droit d’écriture est différent de la simple visibilité. Consulter ne permet pas de modifier.",
    info:
      "Les cadeaux d’Amatxi suivent les règles familiales. Tes investissements personnels peuvent utiliser des règles différentes.",
    customNote:
      "Tu choisiras précisément les personnes autorisées après l’accueil, dans Paramètres › Partage familial.",
    learnMore: "En savoir plus sur la confidentialité",
    learnMoreBody:
      "Tes investissements ne sont visibles que par toi, par les personnes que tu autorises et par l’administrateur familial, qui conserve un accès de gestion. Aucune donnée n’est publique. Tu peux ajuster ces règles à tout moment dans Paramètres › Partage familial.",
    cta: "Confirmer mes accès",
    saving: "Enregistrement…",
    error: "Impossible d’enregistrer tes préférences. Réessaie.",
  },

  completion: {
    eyebrow: "C’EST PRÊT",
    title: "Ton espace est prêt",
    subtitle: (firstName: string) => `Bienvenue, ${firstName}`,
    cta: "Découvrir mon tableau de bord",
    deferLink: "Terminer plus tard",
    cards: {
      giftsNone: "Aucun cadeau enregistré pour le moment",
      gifts: (count: number, sinceYear: number | null) =>
        sinceYear ? `${count} cadeau${count > 1 ? "x" : ""} enregistré${count > 1 ? "s" : ""} depuis ${sinceYear}` : `${count} cadeau${count > 1 ? "x" : ""} enregistré${count > 1 ? "s" : ""}`,
      giftsLabel: "Tes cadeaux",
      bitcoinLabel: "Ton Bitcoin",
      bitcoinNone: "Aucun Bitcoin attribué pour le moment",
      bitcoin: (btc: string) => `${btc} BTC attribué`,
      investmentsLabel: "Tes investissements",
      investmentsNone: "Aucun compte personnel configuré",
      investmentsPea: "PEA déjà configuré",
      investmentsCto: "Compte-titres déjà configuré",
    },
    secondary: {
      pea: "Configurer mon PEA",
      gifts: "Découvrir mes cadeaux",
      bitcoin: "Voir mon Bitcoin",
    },
  },

  shell: {
    back: "Retour",
    stepLabel: (current: number, total: number) => `Étape ${current} sur ${total}`,
    exitTour: "Quitter la visite",
    tourBadge: "Visite guidée",
  },

  checklist: {
    title: "Bien démarrer",
    progress: (done: number, total: number) => `${done} étape${done > 1 ? "s" : ""} sur ${total}`,
    dismiss: "Masquer",
    tasks: {
      profile: "Profil confirmé",
      privacy: "Accès configurés",
      gifts: "Découvrir mes cadeaux",
      bitcoin: "Voir mon Bitcoin",
      pea: "Configurer un investissement",
      videos: "Découvrir les souvenirs",
    },
    resumeTitle: "Reprendre ma configuration",
    resumeText: "Termine ton accueil en quelques instants.",
    resumeCta: "Reprendre",
  },

  help: {
    sectionTitle: "Aide et découverte",
    replay: "Revoir la présentation générale",
    resume: "Reprendre ma configuration",
    discoverBitcoin: "Découvrir Bitcoin",
    discoverPea: "Découvrir le PEA",
    discoverCto: "Découvrir le compte-titres",
    understandSharing: "Comprendre le partage familial",
    resetTips: "Réinitialiser les conseils affichés",
    resetTipsDone: "Les conseils contextuels ont été réinitialisés.",
  },

  tips: {
    bitcoin: {
      title: "Ton Bitcoin réunit deux origines",
      body: "Les cadeaux d’Amatxi et tes investissements personnels apparaissent ici, distingués par leur origine.",
      cta: "Compris",
    },
    pea: {
      title: "Ajoutons ton PEA",
      body: "Renseigne l’établissement, la date d’ouverture et la devise. Tu pourras saisir tes opérations ensuite.",
      cta: "Compris",
    },
    cto: {
      title: "Ton compte-titres",
      body: "Suis tes actions, ETF et dividendes. Plusieurs comptes et devises sont possibles.",
      cta: "Compris",
    },
    videos: {
      title: "Les souvenirs d’Amatxi",
      body: "Retrouve ici les messages associés aux anniversaires et à Noël.",
      cta: "Voir mes souvenirs",
    },
  },
} as const;
