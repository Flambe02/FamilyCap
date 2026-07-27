-- Import d'une CAPTURE DE RELEVÉ (scan IA) : traçabilité de la capture + écriture ATOMIQUE.
--
-- Additive et rejouable. À exécuter MANUELLEMENT dans le SQL Editor Supabase, APRÈS
-- 20260722_account_operations.sql, 20260725_investment_multicurrency.sql et
-- 20260726_investment_imports.sql. Ne JAMAIS l'exécuter automatiquement sur la production.
--
-- FACULTATIVE au sens strict : sans elle, l'import d'une capture fonctionne toujours (la route
-- /commit retombe sur une écriture séquentielle et le dédoublonnage par empreinte reste actif
-- sur la colonne file_fingerprint existante). Ce qu'elle apporte :
--   • un index sur l'empreinte de capture, pour reconnaître instantanément un fichier réimporté ;
--   • la date d'arrêté et l'en-tête du relevé conservés sur le lot, pour le rapprochement ;
--   • surtout : une RPC TRANSACTIONNELLE, de sorte qu'un échec en cours de route ne laisse
--     jamais un portefeuille à moitié intégré.
--
-- Ce que cette migration NE fait PAS, volontairement : aucune table de positions n'est créée.
-- Les positions restent DÉRIVÉES de account_operations par computeAccountModel().

-- ------------------------------------------------------------------------------------------
-- 1) Traçabilité de la capture sur le lot d'import
-- ------------------------------------------------------------------------------------------
-- file_fingerprint existe déjà (20260726) : on y stocke désormais le SHA-256 du contenu de la
-- capture. L'index partiel ne porte que sur les lots ABOUTIS — un import annulé doit pouvoir
-- être refait avec le même fichier.
create index if not exists investment_import_batches_capture_idx
  on public.investment_import_batches(account_id, file_fingerprint)
  where status = 'completed';

-- Date d'arrêté du relevé (distincte de created_at, qui est la date de l'import).
alter table public.investment_import_batches add column if not exists snapshot_date date;

-- En-tête du relevé retenu après validation humaine : totaux imprimés, mode de gestion, cumul
-- des versements… Sert au RAPPROCHEMENT d'un import ultérieur (« le relevé annonçait 149 500 €
-- de versements »). Le numéro de compte n'y figure que MASQUÉ (quatre derniers caractères) :
-- la route serveur le tronque avant écriture, il n'est jamais stocké en clair.
alter table public.investment_import_batches add column if not exists statement jsonb;

comment on column public.investment_import_batches.file_fingerprint is
  'SHA-256 du contenu du fichier importé. Reconnaît une capture déjà intégrée, même renommée.';
comment on column public.investment_import_batches.statement is
  'En-tête du relevé validé (totaux imprimés, cumul des versements, mode de gestion). Numéro de compte MASQUÉ uniquement. Sert au rapprochement, jamais au calcul du portefeuille.';

-- ------------------------------------------------------------------------------------------
-- 2) Écriture ATOMIQUE d'un import
-- ------------------------------------------------------------------------------------------
-- Une fonction plpgsql s'exécute dans UNE transaction : lot + instruments manquants + cours +
-- opérations + remplacement éventuel réussissent ou échouent ensemble. Via l'API REST, ces
-- écritures étaient séquentielles : une panne entre deux appels laissait un portefeuille
-- partiel. C'est le seul objet de cette fonction — elle ne calcule aucune position.
--
-- SECURITY DEFINER : la fonction est appelée par la route serveur (clé service-role, admin déjà
-- vérifié par requireAdmin). Elle est RÉVOQUÉE au public : aucun client authentifié ne peut
-- l'invoquer directement. member_id est imposé par l'appelant à partir du COMPTE, jamais du
-- navigateur ; la fonction le revérifie contre financial_accounts.

create or replace function public.commit_investment_import(
  p_account_id   uuid,
  p_imported_by  uuid,
  p_batch        jsonb,        -- métadonnées du lot
  p_instruments  jsonb,        -- instruments à créer / dont le cours est à rafraîchir
  p_operations   jsonb,        -- opérations à insérer (colonnes account_operations)
  p_replace      boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member_id uuid;
  v_batch_id uuid;
  v_previous uuid[];
  v_created int := 0;
  v_updated int := 0;
  v_inserted int := 0;
  v_replaced int := 0;
  v_instrument jsonb;
  v_operation jsonb;
  v_holding_id uuid;
  v_isin text;
  v_symbol text;
  v_name text;
begin
  -- member_id dérivé du COMPTE : jamais accepté de l'appelant.
  select member_id into v_member_id from public.financial_accounts where id = p_account_id;
  if v_member_id is null then
    raise exception 'Compte introuvable: %', p_account_id using errcode = 'no_data_found';
  end if;

  -- Lignes actuelles capturées AVANT toute écriture : seules elles seront supprimées en mode
  -- « remplacer », et seulement après une insertion réussie.
  if p_replace then
    select coalesce(array_agg(id), '{}') into v_previous
      from public.account_operations where account_id = p_account_id;
  end if;

  insert into public.investment_import_batches (
    account_id, member_id, imported_by, original_filename, file_type, file_fingerprint,
    source_kind, status, mapping, total_rows, duplicate_rows, snapshot_date, statement
  ) values (
    p_account_id, v_member_id, p_imported_by,
    nullif(p_batch->>'original_filename', ''),
    coalesce(nullif(p_batch->>'file_type', ''), 'image'),
    nullif(p_batch->>'file_fingerprint', ''),
    coalesce(nullif(p_batch->>'source_kind', ''), 'ai_scan'),
    'pending',
    p_batch->'mapping',
    coalesce((p_batch->>'total_rows')::int, 0),
    coalesce((p_batch->>'duplicate_rows')::int, 0),
    nullif(p_batch->>'snapshot_date', '')::date,
    p_batch->'statement'
  ) returning id into v_batch_id;

  -- Instruments : création de ceux qui manquent, rafraîchissement du cours des autres.
  -- `holdings` reste un RÉFÉRENTIEL de prix — sa colonne quantity n'est jamais alimentée ici
  -- (elle vaut 0 à la création) : la quantité détenue est dérivée des opérations.
  for v_instrument in select * from jsonb_array_elements(coalesce(p_instruments, '[]'::jsonb)) loop
    v_isin   := nullif(upper(trim(coalesce(v_instrument->>'isin', ''))), '');
    v_symbol := nullif(upper(trim(coalesce(v_instrument->>'ticker', ''))), '');
    v_name   := nullif(trim(coalesce(v_instrument->>'name', '')), '');

    select id into v_holding_id from public.holdings
     where account_id = p_account_id
       and ((v_isin is not null and upper(isin) = v_isin)
         or (v_isin is null and v_symbol is not null and upper(symbol) = v_symbol)
         or (v_isin is null and v_symbol is null and v_name is not null and lower(name) = lower(v_name)))
     limit 1;

    if v_holding_id is null then
      if v_name is null then continue; end if;
      insert into public.holdings (account_id, asset_type, symbol, isin, name, quantity, average_cost,
                                   currency, last_price, last_price_at, market_provider)
      values (p_account_id,
              coalesce(nullif(v_instrument->>'asset_type', ''), 'other'),
              v_symbol, v_isin, v_name, 0, null,
              coalesce(nullif(upper(v_instrument->>'currency'), ''), 'EUR'),
              nullif(v_instrument->>'last_price', '')::numeric,
              nullif(v_instrument->>'last_price_at', '')::timestamptz,
              case when nullif(v_instrument->>'last_price', '') is null then 'manual' else 'file_import' end);
      v_created := v_created + 1;
    elsif nullif(v_instrument->>'last_price', '') is not null then
      update public.holdings
         set last_price = (v_instrument->>'last_price')::numeric,
             last_price_at = coalesce(nullif(v_instrument->>'last_price_at', '')::timestamptz, now()),
             market_provider = 'file_import'
       where id = v_holding_id;
      v_updated := v_updated + 1;
    end if;
  end loop;

  -- Opérations : insertion en bloc, rattachées au lot.
  for v_operation in select * from jsonb_array_elements(coalesce(p_operations, '[]'::jsonb)) loop
    -- taxes / exchange_rate viennent de 20260725 : cette migration s'exécute après, elles
    -- existent donc toujours ici. Les omettre perdrait la retenue à la source d'un dividende
    -- importé et le taux de change d'une opération en devise.
    insert into public.account_operations (
      account_id, member_id, type, operation_date, asset_name, ticker, isin,
      quantity, unit_price, gross_amount, fees, net_amount, taxes, exchange_rate,
      currency, source, note, import_batch_id, external_reference, import_fingerprint
    ) values (
      p_account_id, v_member_id,
      v_operation->>'type',
      (v_operation->>'operation_date')::date,
      nullif(v_operation->>'asset_name', ''),
      nullif(v_operation->>'ticker', ''),
      nullif(v_operation->>'isin', ''),
      nullif(v_operation->>'quantity', '')::numeric,
      nullif(v_operation->>'unit_price', '')::numeric,
      nullif(v_operation->>'gross_amount', '')::numeric,
      coalesce(nullif(v_operation->>'fees', '')::numeric, 0),
      nullif(v_operation->>'net_amount', '')::numeric,
      nullif(v_operation->>'taxes', '')::numeric,
      nullif(v_operation->>'exchange_rate', '')::numeric,
      coalesce(nullif(v_operation->>'currency', ''), 'EUR'),
      coalesce(nullif(v_operation->>'source', ''), 'ai_scan'),
      nullif(v_operation->>'note', ''),
      v_batch_id,
      nullif(v_operation->>'external_reference', ''),
      nullif(v_operation->>'import_fingerprint', '')
    );
    v_inserted := v_inserted + 1;
  end loop;

  if p_replace and v_previous is not null and array_length(v_previous, 1) > 0 then
    delete from public.account_operations where id = any(v_previous);
    get diagnostics v_replaced = row_count;
    update public.investment_import_batches
       set status = 'cancelled', cancelled_at = now()
     where account_id = p_account_id and status = 'completed' and id <> v_batch_id;
  end if;

  update public.investment_import_batches
     set status = 'completed', imported_rows = v_inserted, completed_at = now()
   where id = v_batch_id;

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'imported', v_inserted,
    'created_instruments', v_created,
    'updated_instruments', v_updated,
    'replaced', v_replaced
  );
end;
$$;

-- Réservée au serveur : révoquée pour tout le monde, y compris les utilisateurs authentifiés.
-- Les routes /api/* l'appellent avec la clé service-role, après requireAdmin().
revoke all on function public.commit_investment_import(uuid, uuid, jsonb, jsonb, jsonb, boolean) from public;
revoke all on function public.commit_investment_import(uuid, uuid, jsonb, jsonb, jsonb, boolean) from anon;
revoke all on function public.commit_investment_import(uuid, uuid, jsonb, jsonb, jsonb, boolean) from authenticated;

comment on function public.commit_investment_import(uuid, uuid, jsonb, jsonb, jsonb, boolean) is
  'Import d''opérations en UNE transaction : lot + instruments manquants + cours + opérations (+ remplacement). Aucun calcul de position : le portefeuille reste dérivé de account_operations.';
