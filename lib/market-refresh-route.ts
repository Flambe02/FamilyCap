export type MarketRefreshRouteDependencies = {
  authorize: (request: Request) => Promise<unknown>;
  acquireLock: (accountId: string) => Promise<boolean>;
  releaseLock: (accountId: string) => Promise<void>;
  refresh: (accountId: string) => Promise<Response>;
  errorResponse: (error: unknown) => Response;
};

/**
 * Contrat HTTP réellement utilisé par /api/market-data/refresh. L'injection rend
 * testables l'autorisation, le verrou et l'exécution sans accès réseau ni base.
 */
export function createMarketRefreshPost(dependencies: MarketRefreshRouteDependencies) {
  return async function marketRefreshPost(request: Request) {
    let accountId: string | null = null;
    let lockAcquired = false;
    try {
      await dependencies.authorize(request);
      const body = await request.json().catch(() => ({})) as { accountId?: string };
      accountId = String(body.accountId ?? "").trim() || null;
      if (!accountId) return Response.json({ error: "Le compte est obligatoire." }, { status: 400 });
      lockAcquired = await dependencies.acquireLock(accountId);
      if (!lockAcquired) {
        return Response.json({ error: "Une actualisation est déjà en cours pour ce compte." }, { status: 409 });
      }
      return await dependencies.refresh(accountId);
    } catch (error) {
      return dependencies.errorResponse(error);
    } finally {
      // Ne libère jamais le verrou d'une autre requête après un échec d'acquisition.
      if (accountId && lockAcquired) await dependencies.releaseLock(accountId);
    }
  };
}
