/**
 * Past the in-flight cap the API answers 503 + Retry-After at once, health
 * probes still answer, and a slot frees up when a request finishes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerLoadShedding } from "./loadShedding.js";

test("requests past the cap are shed with 503 and recover when slots free up", async () => {
  const app = Fastify();
  registerLoadShedding(app, 2);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  app.get("/slow", async () => {
    await gate;
    return { ok: true };
  });
  app.get("/healthz", async () => ({ status: "ok" }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const held = [fetch(`${base}/slow`), fetch(`${base}/slow`)];
    await new Promise((r) => setTimeout(r, 100)); // both slots taken
    const shed = await fetch(`${base}/slow`);
    assert.equal(shed.status, 503);
    assert.equal(shed.headers.get("retry-after"), "1");
    assert.equal((await fetch(`${base}/healthz`)).status, 200, "health probes are never shed");

    release();
    for (const r of await Promise.all(held)) assert.equal(r.status, 200);
    assert.equal((await fetch(`${base}/slow`)).status, 200, "capacity comes back after the load");
  } finally {
    await app.close();
  }
});
