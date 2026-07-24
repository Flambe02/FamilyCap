import { supabaseRest } from "./supabase-rest";

type AuditInput = {
  actorMemberId?: string | null;
  targetMemberId?: string | null;
  action: string;
  beforeValues?: Record<string, unknown> | null;
  afterValues?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

function safeValues(values?: Record<string, unknown> | null) {
  if (!values) return null;
  const forbidden = /password|token|secret|authorization|invite.?link|action.?link/i;
  return Object.fromEntries(Object.entries(values).filter(([key]) => !forbidden.test(key)));
}

export async function writeAdminAudit(input: AuditInput) {
  await supabaseRest("admin_audit_log", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({
      actor_member_id: input.actorMemberId ?? null,
      target_member_id: input.targetMemberId ?? null,
      action: input.action,
      before_values: safeValues(input.beforeValues),
      after_values: safeValues(input.afterValues),
      metadata: safeValues(input.metadata),
    }),
  });
}
