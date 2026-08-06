// Identité de l'administrateur principal (bootstrap super_admin, protections UI).
// Ne jamais coder l'adresse en dur : source unique = la variable d'environnement serveur.
export const PRIMARY_ADMIN_EMAIL: string | null = process.env.PRIMARY_ADMIN_EMAIL?.trim().toLowerCase() || null;

export function isPrimaryAdminEmail(email: string | null | undefined) {
  return Boolean(PRIMARY_ADMIN_EMAIL && email?.trim().toLowerCase() === PRIMARY_ADMIN_EMAIL);
}
