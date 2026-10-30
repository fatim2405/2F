/**
 * CSRF origin check, API security headers, and __Host- cookie names in
 * production.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerSecurityHeaders } from "./securityHeaders.js";
import { loadConfig } from "../config.js";

function app() {
  const a = Fastify();
  registerSecurityHeaders(a, ["https://pay.example.com"]);
  a.post("/v1/thing", async () => ({ ok: true }));
  a.get("/v1/thing", async () => ({ ok: true }));
  return a;
}

test("a state-changing request from another site is refused", async () => {
  const res = await app().inject({ method: "POST", url: "/v1/thing", headers: { origin: "https://evil.example" }, payload: {} });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "forbidden_origin");
});

test("allowed origins, the API's own host, and requests without an Origin still work", async () => {
  const a = app();
  for (const headers of [{ origin: "https://pay.example.com" }, { origin: "http://localhost:80", host: "localhost:80" }, {}]) {
    const res = await a.inject({ method: "POST", url: "/v1/thing", headers, payload: {} });
    assert.equal(res.statusCode, 200, JSON.stringify(headers));
  }
  const read = await a.inject({ method: "GET", url: "/v1/thing", headers: { origin: "https://evil.example" } });
  assert.equal(read.statusCode, 200, "reads are left to CORS");
});

test("API responses are not cached, sniffed or framed", async () => {
  const res = await app().inject({ method: "GET", url: "/v1/thing" });
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "DENY");
});

test("production cookies use the __Host- prefix (no cookie planting from other subdomains)", () => {
  const c = loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://x/y",
    SETTLEMENT_INTERNAL_TOKEN: "t",
    ACQUIRER_CALLBACK_SIGNING_SECRET: "s",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  });
  assert.equal(c.cookieName, "__Host-fp_sid");
  assert.equal(c.adminCookieName, "__Host-fp_admin_sid");
  assert.equal(c.impersonationCookieName, "__Host-fp_impersonation");
  assert.equal(c.cookieSecure, true);
});
