import type { AuthContext } from "../middleware/auth.js";

export interface AuditEventInput {
  auth?: AuthContext | null;
  action: string;
  resource?: string | null;
  resourceId?: string | null;
  route?: string | null;
  outcome: "success" | "failure" | "accepted";
  traceId: string;
  parentTraceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function writeAuditLog(_input: AuditEventInput): Promise<void> {
  // Audit log persistence is not available in OSS.
  // Override by extending src/lib/audit.ts in your fork if needed.
}
