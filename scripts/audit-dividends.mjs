// Audit lecture seule de l'état réel des dividendes en base (aucune écriture).
// Usage : node --env-file=.env.local scripts/audit-dividends.mjs

const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) { console.error("Supabase non configuré"); process.exit(1); }

async function rest(path) {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, accept: "application/json" } });
  if (!response.ok) return { error: `${response.status} ${(await response.text()).slice(0, 200)}` };
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

function show(label, value) { console.log(`\n=== ${label} ===`); console.log(typeof value === "string" ? value : JSON.stringify(value, null, 1)); }

const accounts = await rest("financial_accounts?select=id,name,account_type,currency,member_id,is_active,dividend_tax_rate&account_type=in.(pea,securities)");
show("COMPTES PEA/CTO", accounts);

if (Array.isArray(accounts) && accounts.length) {
  const ids = accounts.map((a) => a.id).join(",");
  const ops = await rest(`account_operations?select=type&account_id=in.(${ids})`);
  if (Array.isArray(ops)) {
    const byType = {};
    for (const op of ops) byType[op.type] = (byType[op.type] ?? 0) + 1;
    show("OPÉRATIONS PAR TYPE", byType);
  } else show("OPÉRATIONS", ops);

  const divOps = await rest(`account_operations?select=id,account_id,operation_date,asset_name,ticker,isin,quantity,gross_amount,net_amount,taxes,fees,currency,source,note&type=eq.dividende&account_id=in.(${ids})&order=operation_date.desc&limit=30`);
  show("OPÉRATIONS DIVIDENDE (réelles)", divOps);

  const holdings = await rest(`holdings?select=id,account_id,name,symbol,isin,currency,asset_type,provider_symbol,yahoo_symbol,market_symbol,listing_id,quantity,last_price,classification_status&account_id=in.(${ids})&order=name.asc`);
  show(`HOLDINGS (référentiel) — ${Array.isArray(holdings) ? holdings.length : "?"}`, holdings);

  if (Array.isArray(holdings) && holdings.length) {
    const hIds = holdings.map((h) => h.id).join(",");
    const ca = await rest(`corporate_actions?select=id,asset_id,provider,provider_event_id,action_type,ex_date,payment_date,declaration_date,record_date,amount_per_share,currency,status&asset_id=in.(${hIds})&order=ex_date.desc&limit=200`);
    if (Array.isArray(ca)) {
      const byAsset = {};
      for (const row of ca) {
        const h = holdings.find((x) => x.id === row.asset_id);
        const label = h ? `${h.name} [${h.isin ?? h.symbol}] (compte ${h.account_id.slice(0, 8)})` : row.asset_id;
        byAsset[label] = byAsset[label] ?? { count: 0, providers: new Set(), first: null, last: null, withPaymentDate: 0, statuses: {} };
        byAsset[label].count += 1;
        byAsset[label].providers.add(row.provider);
        byAsset[label].statuses[row.status] = (byAsset[label].statuses[row.status] ?? 0) + 1;
        if (row.payment_date) byAsset[label].withPaymentDate += 1;
        if (!byAsset[label].last || row.ex_date > byAsset[label].last) byAsset[label].last = row.ex_date;
        if (!byAsset[label].first || row.ex_date < byAsset[label].first) byAsset[label].first = row.ex_date;
      }
      const summary = Object.fromEntries(Object.entries(byAsset).map(([k, v]) => [k, { ...v, providers: [...v.providers] }]));
      show(`CORPORATE_ACTIONS total=${ca.length}`, summary);
      show("ÉCHANTILLON corporate_actions", ca.slice(0, 8));
    } else show("CORPORATE_ACTIONS", ca);
  }
}

show("ASSETS (catalogue)", await rest("assets?select=id,isin,name,asset_type,classification_status&limit=60"));
show("ASSET_LISTINGS", await rest("asset_listings?select=id,asset_id,ticker,mic_code,currency,eodhd_symbol,yahoo_symbol,validation_status&limit=60"));
show("MARKET_DATA_REQUESTS (quota)", await rest("market_data_requests?select=provider,request_key,request_date&order=request_date.desc&limit=20"));
show("FX_RATES (5 dernières)", await rest("fx_rates?select=base_currency,quote_currency,rate,rate_date&order=rate_date.desc&limit=5"));
show("TABLE dividend_events ?", await rest("dividend_events?select=id&limit=1"));
show("TABLE account_tax_profiles ?", await rest("account_tax_profiles?select=account_id&limit=1"));
show("TABLE instrument_exposures ?", await rest("instrument_exposures?select=isin&limit=1"));
show("TABLE portfolio_analyses ?", await rest("portfolio_analyses?select=id&limit=1"));
