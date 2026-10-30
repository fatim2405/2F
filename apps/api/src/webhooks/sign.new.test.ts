import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { signBody, signPayload, verifySignature } from "./sign.js";

// A receiver verifies the HMAC over the raw request body it received
// (Stripe-style "t.<raw body>"), without re-parsing or re-sorting it.
function receiverVerifiesRawBody(rawBody: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  return expected === parts.v1;
}

const SECRET = "whsec_raw_body_test";
// Keys deliberately not in alphabetical order, like a real envelope.
const ENVELOPE = {
  id: "evt_123",
  type: "transaction.captured",
  createdAt: "2026-10-30T09:00:00.000Z",
  data: { transactionId: "txn_1", merchantId: "m_1", amountCapturedFils: 4750, status: "captured" },
};

test("the signature verifies over the exact body that is sent (raw-body receiver)", () => {
  const { body, signature } = signBody(ENVELOPE, SECRET, 1_793_350_800);
  assert.equal(receiverVerifiesRawBody(body, signature, SECRET), true);
});

test("the old way (sign one serialization, send JSON.stringify) fails raw-body verification", () => {
  const { signature } = signPayload(ENVELOPE, SECRET, 1_793_350_800);
  assert.equal(receiverVerifiesRawBody(JSON.stringify(ENVELOPE), signature, SECRET), false);
});

test("the signature is unchanged from signPayload, so existing receivers keep working", () => {
  const ts = 1_793_350_800;
  assert.equal(signBody(ENVELOPE, SECRET, ts).signature, signPayload(ENVELOPE, SECRET, ts).signature);
});

test("receivers that re-parse and re-sort (verifySignature) still verify", () => {
  const now = 1_793_350_800;
  const { body, signature } = signBody(ENVELOPE, SECRET, now);
  assert.deepEqual(verifySignature(JSON.parse(body), signature, SECRET, { now }), { valid: true });
});

test("the body is valid JSON carrying the same data", () => {
  const { body } = signBody(ENVELOPE, SECRET);
  assert.deepEqual(JSON.parse(body), ENVELOPE);
});

test("a wrong secret or a tampered body fails raw-body verification", () => {
  const { body, signature } = signBody(ENVELOPE, SECRET);
  assert.equal(receiverVerifiesRawBody(body, signature, "whsec_wrong"), false);
  assert.equal(receiverVerifiesRawBody(body.replace("4750", "9999"), signature, SECRET), false);
});
