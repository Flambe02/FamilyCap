// Compatibilité d'URL : le flux historique délègue au service EODHD normalisé.
// Aucune logique Yahoo/Stooq ne doit rester sur la synchronisation de portefeuille.
export { POST } from "../../../market-data/refresh/route";
export const runtime = "nodejs";
