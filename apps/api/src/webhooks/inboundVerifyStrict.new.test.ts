import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyAcquirerCallbackSignature } from "./inboundVerify.js";
import { loadConfig } from "../config.js";

const SECRET = "acqsec_strict_test";
const PAYLOAD = { callbackId: "cb_1", type: "fraud_review.completed", transactionId: "t", occurredAt: "x", outcome: "approved", note: "n" };
const header = (t: number) => `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${JSON.stringify(PAYLOAD)}`).digest("hex")}`;

test("production requires a signature on acquirer callbacks by default", () => {
  const prod = loadConfig({
    DATABASE_URL: "postgres://x",
    NODE_ENV: "production",
    SETTLEMENT_INTERNAL_TOKEN: "t",
    ACQUIRER_CALLBACK_SIGNING_SECRET: SECRET,
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  });
  assert.equal(prod.acquirerCallbackRequireSignature, true);
  assert.equal(verifyAcquirerCallbackSignature(PAYLOAD, undefined, SECRET, prod.acquirerCallbackRequireSignature).valid, false);
});

test("with a freshness window, a replayed old callback is rejected and a fresh one accepted", () => {
  const now = 1_793_350_800;
  assert.deepEqual(verifyAcquirerCallbackSignature(PAYLOAD, header(now - 3600), SECRET, true, { toleranceSeconds: 300, now }), {
    valid: false,
    reason: "timestamp_out_of_tolerance",
  });
  assert.deepEqual(verifyAcquirerCallbackSignature(PAYLOAD, header(now - 10), SECRET, true, { toleranceSeconds: 300, now }), { valid: true });
});

test("a signature of a different length or content is still rejected", () => {
  assert.equal(verifyAcquirerCallbackSignature(PAYLOAD, "t=1,v1=abc", SECRET, true).valid, false);
});
