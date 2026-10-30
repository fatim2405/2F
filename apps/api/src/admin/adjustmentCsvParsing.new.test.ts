import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdjustmentAmountFils } from "./adjustmentCsvParsing.js";

// 1 BD = 1000 fils (ADR-0001). The import previously parsed at 2 decimals,
// posting every adjustment at one tenth of its value.

test("BD amounts parse to fils at 3 decimals, whether written with 2 or 3", () => {
  assert.equal(parseAdjustmentAmountFils("4.75"), 4750);
  assert.equal(parseAdjustmentAmountFils("4.750"), 4750);
  assert.equal(parseAdjustmentAmountFils("1.25"), 1250);
  assert.equal(parseAdjustmentAmountFils("120.00"), 120_000);
  assert.equal(parseAdjustmentAmountFils("100"), 100_000);
});

test("the third decimal is kept, not truncated", () => {
  assert.equal(parseAdjustmentAmountFils("4.755"), 4755);
  assert.equal(parseAdjustmentAmountFils("0.005"), 5);
});

test("negative corrections keep their sign", () => {
  assert.equal(parseAdjustmentAmountFils("-1.250"), -1250);
  assert.equal(parseAdjustmentAmountFils("-4.75"), -4750);
});

test("more than 3 decimals is rejected instead of silently truncated", () => {
  assert.throws(() => parseAdjustmentAmountFils("4.7555"), /could not parse amount/);
});
