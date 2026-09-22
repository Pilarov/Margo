/**
 * OSS Auth middleware
 *
 * If RETAINDB_API_KEY is set: all requests must include it as
 *   Authorization: Bearer <key>   or   ?api_key=<key>
 *
 * If RETAINDB_API_KEY is NOT set: open access — no key required.
 * This is fine for local dev or a private network deployment.
 * Set the key in production if your server is publicly reachable.
 */
import type { Context, Next } from "hono";

export interface AuthContext {
  orgId: string;   // always "default" in OSS (single-tenant)
  userId?: string;
  authType: "api_key" | "open";
  // OSS: these are always true/undefined — kept for source compatibility
  isAdmin?: boolean;
  scopes?: string[];
  keyId?: string;
  actorId?: string;
}

function extractToken(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  return trimmed.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? trimmed;
}

export async function authMiddleware(c: Context, next: Next) {
  const configuredKey = process.env.RETAINDB_API_KEY;

  // No key configured → open access (private/dev deployment; single-tenant owner).
  if (!configuredKey) {
    c.set("auth", { orgId: "default", authType: "open", isAdmin: true } satisfies AuthContext);
    await next();
    return;
  }

  const token = extractToken(c.req.header("Authorization")) || c.req.query("api_key") || "";

  if (!token || token !== configuredKey) {
    return c.json({ error: "Unauthorized. Set Authorization: Bearer <your RETAINDB_API_KEY>." }, 401);
  }

  // OSS is single-tenant: the API-key holder is the instance owner, so admin
  // endpoints (/v1/admin/*) are available to them.
  c.set("auth", { orgId: "default", authType: "api_key", isAdmin: true } satisfies AuthContext);
  await next();
}
