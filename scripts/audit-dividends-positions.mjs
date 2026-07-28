// Positions réellement dérivées + rattachement corporate_actions. Lecture seule.
// Usage : node --env-file=.env.local scripts/audit-dividends-positions.mjs

const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
const key = process.env.SUPABASE_SECRET_KEY;
async function rest(path) {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}
const keyOf = (o) => (o.isin ? `isin:${o.isin.toUpperCase()}` : o.ticker ? `tkr:${o.ticker.toUpperCase()}` : o.name ? `name:${String(o.name).toLowerCase()}` : "sans-actif");

const accounts = await rest("financial_accounts?select=id,name,account_type&account_type=in.(pea,securities)");
for (const account of accounts) {
  const ops = await rest(`account_operations?select=id,type,operation_date,asset_name,ticker,isin,quantity,unit_price,gross_amount,currency&account_id=eq.${account.id}&order=operation_date.asc`);
  const holdings = await rest(`holdings?select=id,name,symbol,isin,asset_type,currency,provider_symbol,yahoo_symbol,market_symbol&account_id=eq.${account.id}`);
  const hIds = holdings.map((h) => h.id).join(",");
  const ca = hIds ? await rest(`corporate_actions?select=asset_id,ex_date,payment_date,amount_per_share,currency,status,provider&action_type=eq.dividend&asset_id=in.(${hIds})`) : [];
  const caByAsset = new Map();
  for (const row of ca) caByAsset.set(row.asset_id, [...(caByAsset.get(row.asset_id) ?? []), row]);

  const qty = new Map();
  for (const op of ops) {
    const k = keyOf({ isin: op.isin, ticker: op.ticker, name: op.asset_name });
    const entry = qty.get(k) ?? { name: op.asset_name, qty: 0, isin: op.isin, ticker: op.ticker, currency: op.currency };
    if (op.type === "achat" || op.type === "transfer_in" || op.type === "correction") entry.qty += Number(op.quantity ?? 0);
    else if (op.type === "vente" || op.type === "transfer_out") entry.qty -= Number(op.quantity ?? 0);
    qty.set(k, entry);
  }
  const held = [...qty.entries()].filter(([, v]) => v.qty > 1e-9);
  console.log(`\n########## ${account.name} (${account.account_type}) — ${held.length} positions détenues, ${ops.length} opérations, ${holdings.length} holdings, ${ca.length} corporate_actions`);
  const holdingByKey = new Map(holdings.map((h) => [keyOf({ isin: h.isin, ticker: h.symbol, name: h.name }), h]));
  for (const [k, v] of held.sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const h = holdingByKey.get(k) ?? null;
    const events = h ? caByAsset.get(h.id) ?? [] : [];
    const symbol = h ? (h.provider_symbol ?? h.yahoo_symbol ?? h.market_symbol ?? "—") : "—";
    console.log(
      `${(v.name ?? "?").padEnd(48).slice(0, 48)} qty=${String(v.qty).padStart(9)} ${String(v.isin ?? v.ticker ?? "").padEnd(13)} ` +
      `holding=${h ? "OUI" : "NON"} type=${h?.asset_type ?? "?"} sym=${String(symbol).padEnd(16)} events=${events.length}` +
      (events.length ? ` (dernier ${events.map((e) => e.ex_date).sort().at(-1)}, pay=${events.filter((e) => e.payment_date).length}/${events.length}, ${[...new Set(events.map((e) => e.provider))].join("+")})` : ""),
    );
  }
}
