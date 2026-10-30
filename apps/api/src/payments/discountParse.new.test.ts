import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePromotionalDiscountFils } from "./discountAdjustment.js";

// 1 BD = 1000 fils (ADR-0001).
test("promotional discounts parse BD text to fils at 3 decimals", () => {
  assert.equal(parsePromotionalDiscountFils("4.75"), 4750);
  assert.equal(parsePromotionalDiscountFils("0.005"), 5);
  assert.equal(parsePromotionalDiscountFils("12"), 12_000);
});

test("negative, malformed and over-precise discounts are rejected", () => {
  for (const bad of ["-1.000", "abc", "", "1.2345", "1e3"]) {
    assert.throws(() => parsePromotionalDiscountFils(bad), /could not parse discount amount/, bad);
  }
});
