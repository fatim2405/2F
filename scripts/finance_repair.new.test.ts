import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport, filsToBd, repairRow, type ImportedRow } from "./finance_repair_adjustment_imports.js";

const M = "11111111-1111-4111-8111-111111111111";
const row = (over: Partial<ImportedRow>): ImportedRow => ({
  importId: "imp-1", originalFilename: "aug.csv", appliedAt: new Date("2026-08-27T11:00:00Z"),
  rowNumber: 1, merchantId: M, rawAmountText: "4.75", parsedAmountFils: 475, reason: null, ...over,
});

test("BD formatting keeps 3 decimals and the sign", () => {
  assert.equal(filsToBd(4275), "4.275");
  assert.equal(filsToBd(-1125), "-1.125");
  assert.equal(filsToBd(5), "0.005");
  assert.equal(filsToBd(0), "0.000");
});

test("each row's correct amount comes from the text finance typed", () => {
  assert.deepEqual(
    [repairRow(row({})), repairRow(row({ rawAmountText: "-1.250", parsedAmountFils: -125 })), repairRow(row({ rawAmountText: "0.005", parsedAmountFils: 0 }))].map((r) => [r.correctFils, r.shortfallFils]),
    [[4750, 4275], [-1250, -1125], [5, 5]],
  );
});

test("text that isn't a valid BD amount is flagged for a human, not guessed", () => {
  const r = repairRow(row({ rawAmountText: "4.7555", parsedAmountFils: 475 }));
  assert.equal(r.correctFils, null);
  assert.equal(r.needsManualCheck, true);
});

test("identical imports are grouped; the later copy gets a reversal draft, not a top-up", () => {
  const first = [row({ importId: "imp-A", rowNumber: 1 }), row({ importId: "imp-A", rowNumber: 2, rawAmountText: "1.25", parsedAmountFils: 125 })];
  const copy = first.map((r) => ({ ...r, importId: "imp-B", appliedAt: new Date("2026-09-04T11:19:02Z") }));
  const other = [row({ importId: "imp-C", rawAmountText: "10", parsedAmountFils: 1000, appliedAt: new Date("2026-09-10T00:00:00Z") })];
  const report = buildReport([...first, ...copy, ...other]);

  assert.deepEqual(report.duplicates, [["imp-A", "imp-B"]]);
  const draft = report.files["correction-draft.csv"].trim().split("\n");
  assert.equal(draft.length, 1 + 3, "top-ups for imp-A's 2 rows and imp-C's 1 row, none for the copy");
  assert.match(draft[1]!, new RegExp(`^${M},4\\.275,`));
  const reversal = report.files["duplicate-reversal-draft.csv"].trim().split("\n");
  assert.deepEqual(reversal.slice(1).map((l) => l.split(",")[1]), ["-0.475", "-0.125"], "reverse exactly what the copy posted");
});

test("the summary shows posted vs correct per import", () => {
  const report = buildReport([row({}), row({ rowNumber: 2, rawAmountText: "100", parsedAmountFils: 10_000 })]);
  const summary = report.files["imports-summary.csv"].trim().split("\n")[1]!.split(",");
  assert.deepEqual(summary.slice(3, 9), ["2", "10475", "104750", "94275", "10.475", "104.750"]);
});
