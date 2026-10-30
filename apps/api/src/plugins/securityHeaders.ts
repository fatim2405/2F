import type { FastifyInstance } from "fastify";

/**
 * Two defences for every API response and request.
 *
 * 1. Headers: API responses carry account and money data, so they are never
 *    cached (Cache-Control: no-store), never sniffed as another content type,
 *    and never framed.
 *
 * 2. CSRF origin check: a state-changing request (anything but GET/HEAD/
 *    OPTIONS) that carries a browser Origin header must come from an allowed
 *    origin (CORS_ALLOWED_ORIGINS) or the API's own host. SameSite=Lax
 *    cookies already stop most cross-site posts; this refuses the rest on the
 *    server instead of relying on the browser alone. Requests with no Origin
 *    (API keys, server-to-server, the acquirer's callbacks) are unaffected.
 */
export function registerSecurityHeaders(app: FastifyInstance, allowedOrigins: readonly string[]): void {
  const allowed = new Set(allowedOrigins);

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    const origin = request.headers.origin;
    if (!origin) return;
    let sameHost = false;
    try {
      // Parse both the same way, so a default port (":80", ":443") written on
      // one side and left out on the other still compares equal.
      const o = new URL(origin);
      sameHost = o.host === new URL(`${o.protocol}//${request.headers.host ?? ""}`).host;
    } catch {
      sameHost = false;
    }
    if (!sameHost && !allowed.has(origin)) {
      await reply.code(403).send({ error: "forbidden_origin", message: "Request origin is not allowed." });
      return reply;
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    return payload;
  });
}
