import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { corsPlugin } from "./cors.js";
import { loadConfig } from "../config.js";

function appWith(origins: string[]) {
  const app = Fastify();
  app.register(corsPlugin, { config: { corsAllowedOrigins: origins } });
  app.get("/v1/ping", async () => ({ ok: true }));
  return app;
}

test("an allowed origin gets credentialed CORS headers echoing that origin", async () => {
  const app = appWith(["http://localhost:5173"]);
  const res = await app.inject({ method: "GET", url: "/v1/ping", headers: { origin: "http://localhost:5173" } });
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(res.headers["access-control-allow-credentials"], "true");
  await app.close();
});

test("an unknown origin gets no CORS headers", async () => {
  const app = appWith(["http://localhost:5173"]);
  const res = await app.inject({ method: "GET", url: "/v1/ping", headers: { origin: "https://evil.example" } });
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  await app.close();
});

test("a preflight from an allowed origin is answered 204 with the requested headers", async () => {
  const app = appWith(["http://localhost:5174"]);
  const res = await app.inject({
    method: "OPTIONS",
    url: "/v1/anything",
    headers: { origin: "http://localhost:5174", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });
  assert.equal(res.statusCode, 204);
  assert.match(String(res.headers["access-control-allow-methods"]), /POST/);
  assert.equal(res.headers["access-control-allow-headers"], "content-type");
  await app.close();
});

test("config: dev defaults to the local sites, production to none, and the env var overrides both", () => {
  const base = { DATABASE_URL: "postgres://x", WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=" };
  assert.deepEqual(loadConfig({ ...base, NODE_ENV: "development" }).corsAllowedOrigins, ["http://localhost:5173", "http://localhost:5174"]);
  const prod = { ...base, NODE_ENV: "production", SETTLEMENT_INTERNAL_TOKEN: "t", ACQUIRER_CALLBACK_SIGNING_SECRET: "s" };
  assert.deepEqual(loadConfig(prod).corsAllowedOrigins, []);
  assert.deepEqual(loadConfig({ ...prod, CORS_ALLOWED_ORIGINS: "https://app.filspay.example, https://admin.filspay.example" }).corsAllowedOrigins, [
    "https://app.filspay.example",
    "https://admin.filspay.example",
  ]);
});
