import assert from "node:assert/strict";
import { test } from "node:test";
import { backoffDelayMs } from "./dispatcher.js";

const config = { webhookBackoffBaseMs: 1000, webhookBackoffCapMs: 60_000 };

test("without a jitter source the delay is the nominal exponential value", () => {
  assert.deepEqual([1, 2, 3, 4].map((n) => backoffDelayMs(n, config)), [1000, 2000, 4000, 8000]);
  assert.equal(backoffDelayMs(20, config), 60_000, "capped");
});

test("jitter stays within ±10 %", () => {
  assert.equal(backoffDelayMs(1, config, () => 0), 900);
  assert.equal(backoffDelayMs(1, config, () => 0.999999), 1100);
  for (let i = 0; i < 200; i++) {
    const d = backoffDelayMs(3, config, Math.random);
    assert.ok(d >= 3600 && d <= 4400, String(d));
  }
});
