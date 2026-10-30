/**
 * End-to-end: what the dispatcher and the "send test event" tool actually
 * put on the wire must verify the way a real receiver checks it — HMAC over
 * the raw request body, no re-parsing. The existing tests re-parse and
 * re-sort first, which is why a signed-bytes != sent-bytes bug went
 * unnoticed. Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { loadConfig } from "../config.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import { sendTestWebhookEvent } from "./testSend.js";
import { WEBHOOK_SIGNATURE_HEADER } from "./headers.js";
import type { WebhookTransport, WebhookTransportRequest } from "./transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("rawBodySignature.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  WEBHOOK_REQUEST_TIMEOUT_MS: "5000",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

function receiverVerifiesRawBody(rawBody: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  return expected === parts.v1;
}

async function createMerchantAndEndpoint(label: string, url: string) {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Raw Body Signature ${label} ${randomUUID()}`, 250],
  );
  const merchantId = merchant.rows[0]!.id;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  return { merchantId, endpoint };
}

test("dispatcher: a real delivery verifies over the raw body it sent", async () => {
  const url = `http://fake-receiver.test/raw-${randomUUID()}`;
  const { merchantId, endpoint } = await createMerchantAndEndpoint("dispatch", url);
  await enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: 4_750, feeFils: 71, newStatus: "captured", capturedTotalFils: 4_750 },
  });

  const captured: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === url) captured.push(req);
    return { statusCode: 200, body: "ok" };
  };
  await runDispatchPass(pool, transport, config);

  assert.equal(captured.length, 1);
  const req = captured[0]!;
  assert.equal(receiverVerifiesRawBody(req.body, req.headers[WEBHOOK_SIGNATURE_HEADER]!, endpoint.secret), true);
});

test("send test event: verifies over the raw body it sent", async () => {
  const { merchantId, endpoint } = await createMerchantAndEndpoint("test-send", "http://localhost:9/raw");
  const sent: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    sent.push(req);
    return { statusCode: 200, body: "ok" };
  };

  await sendTestWebhookEvent(pool, config, transport, { merchantId, endpointId: endpoint.id });

  const req = sent[0]!;
  assert.equal(receiverVerifiesRawBody(req.body, req.headers[WEBHOOK_SIGNATURE_HEADER]!, endpoint.secret), true);
});
