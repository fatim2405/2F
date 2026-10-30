/**
 * The merchant dashboard uses Bahrain business days and Bahrain time
 * (UTC+3, no DST), whatever time zone the browser is set to.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bahrainDayStartIso, dateTime } from "./format.js";

test("a filter date starts at Bahrain midnight (21:00 UTC the day before)", () => {
  assert.equal(bahrainDayStartIso("2026-10-01"), "2026-09-30T21:00:00.000Z");
  assert.equal(bahrainDayStartIso(""), undefined);
});

test("times are shown in Bahrain time", () => {
  // 22:30 UTC on 30 Sep is 01:30 on 1 Oct in Bahrain.
  const shown = dateTime("2026-09-30T22:30:00.000Z");
  assert.match(shown, /1:30/);
  assert.match(shown, /(10\/1\/2026|1\/10\/2026|2026)/);
});
