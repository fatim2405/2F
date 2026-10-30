import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";

/**
 * CORS for apps/web and apps/admin, which call the API from their own
 * origin with `credentials: "include"` (session cookies). Only origins in
 * config.corsAllowedOrigins get CORS headers, and the allowed origin is
 * echoed back (never `*`, which browsers refuse alongside credentials).
 * Requests from any other origin get no CORS headers, so the browser blocks
 * them. Preflight (OPTIONS) requests are answered here.
 */
export const corsPlugin = fp(async (app: FastifyInstance, opts: { config: Pick<Config, "corsAllowedOrigins"> }) => {
  const allowed = new Set(opts.config.corsAllowedOrigins);

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || !allowed.has(origin)) return;

    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Access-Control-Allow-Credentials", "true");
    reply.header("Vary", "Origin");

    if (request.method === "OPTIONS") {
      reply
        .header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        .header(
          "Access-Control-Allow-Headers",
          request.headers["access-control-request-headers"] ?? "content-type, idempotency-key, authorization",
        )
        .header("Access-Control-Max-Age", "600")
        .code(204)
        .send();
    }
  });
});
