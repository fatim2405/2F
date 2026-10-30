import type { FastifyInstance } from "fastify";

/**
 * Load shedding: past a fixed number of requests in flight, answer at once
 * with 503 + Retry-After instead of queueing. The API runs on 0.5 vCPU with a
 * 5-connection pool, so anything past a few dozen concurrent requests only
 * waits; without a cap, an overload made every request slow (and timeouts
 * then retried into the same queue). With it, accepted requests stay fast,
 * the excess is turned away cleanly, and nothing is half-done: a shed request
 * is refused before any handler (or the database) sees it.
 *
 * Health and readiness probes are never shed, so the orchestrator doesn't
 * restart a container that is merely busy.
 */
export function registerLoadShedding(app: FastifyInstance, maxInflight: number): void {
  if (!(maxInflight > 0)) return; // 0 disables it (tests, local debugging)
  let inflight = 0;

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (path === "/healthz" || path === "/readyz") return;
    if (inflight >= maxInflight) {
      reply.header("retry-after", "1");
      await reply.code(503).send({ error: "overloaded", message: "The service is busy. Please retry in a moment." });
      return reply;
    }
    inflight += 1;
    let released = false;
    // 'close' fires once per request whether it finished, failed or the
    // client went away, so the count can't leak.
    reply.raw.once("close", () => {
      if (!released) {
        released = true;
        inflight -= 1;
      }
    });
  });

  app.decorate("inflightRequests", () => inflight);
}
