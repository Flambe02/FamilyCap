-- Repare les bases sur lesquelles les tables existaient deja sans les contraintes
-- necessaires aux upserts de la console d'administration.
-- Aucun enregistrement financier n'est touche.

create unique index if not exists wallets_member_id_upsert_idx
  on public.wallets(member_id);

create unique index if not exists member_product_access_member_product_upsert_idx
  on public.member_product_access(member_id, product);
