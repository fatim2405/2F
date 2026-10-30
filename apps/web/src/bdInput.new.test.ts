/**
 * Amount boxes (refund, capture, new payment link) take BD, like every
 * amount the dashboard shows, and turn it into whole fils exactly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bhd, parseBdAmountInput } from "./format.js";

test("BD text becomes exact whole fils", () => {
  assert.equal(parseBdAmountInput("4.75"), 4750);
  assert.equal(parseBdAmountInput("4.750"), 4750);
  assert.equal(parseBdAmountInput("4.755"), 4755);
  assert.equal(parseBdAmountInput("12"), 12000);
  assert.equal(parseBdAmountInput(" 0.001 "), 1);
});

test("what is typed matches what the page shows", () => {
  // The refund drawer shows "Still refundable: 10.000 BHD"; typing 10.000 refunds exactly that.
  assert.equal(bhd(parseBdAmountInput("10.000")), "10.000 BHD");
});

test("bad amounts are refused with a readable message", () => {
  for (const bad of ["", "abc", "4.7555", "-1", "1,000", "0", "0.000"]) {
    assert.throws(() => parseBdAmountInput(bad), Error, `"${bad}" should be refused`);
  }
});
