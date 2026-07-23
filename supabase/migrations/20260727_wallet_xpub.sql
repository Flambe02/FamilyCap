-- Suivi par cle publique etendue (xpub / ypub / zpub) d'un compte Ledger.
-- Permet de deriver toutes les adresses de reception et de monnaie du compte et de
-- lire les soldes directement sur la blockchain, sans ressaisir une adresse a chaque
-- reception. AUCUNE cle privee ni phrase de recuperation n'est jamais stockee.
--
-- public_address reste renseignee (1re adresse de reception derivee) pour l'affichage
-- cote membre et comme repli du rapprochement mono-adresse.
alter table public.wallets add column if not exists xpub text;

comment on column public.wallets.xpub is
  'Cle publique etendue SLIP-0132 (xpub/ypub/zpub) du compte Ledger. Lecture seule, jamais de cle privee. Sert a deriver les adresses et lire les soldes on-chain.';
