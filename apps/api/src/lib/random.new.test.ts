import assert from "node:assert/strict";
import { test } from "node:test";
import { randomDigits, randomFromAlphabet } from "./random.js";
import { generateInviteCode } from "../admin/inviteCode.js";
import { generateOtpCode } from "../auth/otp.js";

// OTP codes, admin invite codes and payment-link tokens must not come from
// Math.random (predictable). Pinning Math.random proves they don't use it.
function withPinnedMathRandom(fn: () => void): void {
  const original = Math.random;
  Math.random = () => 0.5;
  try {
    fn();
  } finally {
    Math.random = original;
  }
}

test("OTP codes are digits of the requested length and don't depend on Math.random", () => {
  withPinnedMathRandom(() => {
    const codes = new Set(Array.from({ length: 50 }, () => generateOtpCode(6)));
    for (const c of codes) assert.match(c, /^\d{6}$/);
    assert.ok(codes.size > 40, `expected varied codes with Math.random pinned, got ${codes.size} distinct`);
  });
});

test("admin invite codes don't depend on Math.random", () => {
  withPinnedMathRandom(() => {
    const codes = new Set(Array.from({ length: 50 }, () => generateInviteCode()));
    assert.ok(codes.size > 40);
    for (const c of codes) assert.match(c, /^[A-HJ-NP-Z2-9]{8}$/);
  });
});

test("randomDigits keeps leading zeros and randomFromAlphabet stays in its alphabet", () => {
  assert.equal(randomDigits(12).length, 12);
  assert.match(randomFromAlphabet("ab", 200), /^[ab]{200}$/);
});
