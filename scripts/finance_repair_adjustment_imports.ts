#!/usr/bin/env -S npx tsx
/**
 * Finance repair, step 1 (READ-ONLY): until October 2026 the admin
 * "Import adjustments" tool read BD amounts at 2 decimals, so every row was
 * posted at one tenth of its value ("4.75" → 475 fils instead of 4750). Each
 * row kept the exact text finance typed (raw_amount_text) next to what was
 * posted (parsed_amount_fils), so the correct amount is recoverable exactly.
 *
 * This script never writes to the database. It produces, for finance to
 * review and sign off:
 *   repair-sheet.csv          every row: typed, posted, correct, shortfall
 *   imports-summary.csv       per import: posted vs correct totals
 *   suspected-duplicates.csv  imports with identical rows (e.g. 4 Sep double upload)
 *   correction-draft.csv      shortfall top-ups, in the importer's own CSV format
 *   duplicate-reversal-draft.csv  reversals for the LATER copy in each identical group
 *
 * After sign-off the corrections go in through the (fixed) Import adjustments
 * tool, which journals them to the ledger with an audit row. Review the
 * duplicate reversals case by case; only finance can say which uploads were
 * accidental. Run against a copy of production first.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/finance_repair_adjustment_imports.ts [out-dir]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { parseBhdToFils } from "@filspay/money";

export interface ImportedRow {
  importId: string;
  originalFilename: string;
  appliedAt: Date;
  rowNumber: number;
  merchantId: string;
  rawAmountText: string;
  parsedAmountFils: number;
  reason: string | null;
}

export interface RepairedRow extends ImportedRow {
  /** null when the typed text isn't a valid BD amount (needs a human). */
  correctFils: number | null;
  /** correct − posted; what's missing from the ledger for this row. */
  shortfallFils: number | null;
  needsManualCheck: boolean;
}

/** Formats signed fils as a BD string with exactly 3 decimals, e.g. -1125 → "-1.125". */
export function filsToBd(fils: number): string {
  const sign = fils < 0 ? "-" : "";
  const abs = Math.abs(fils);
  return `${sign}${Math.trunc(abs / 1000)}.${String(abs % 1000).padStart(3, "0")}`;
}

export function repairRow(row: ImportedRow): RepairedRow {
  let correctFils: number | null = null;
  try {
    correctFils = parseBhdToFils(row.rawAmountText);
  } catch {
    correctFils = null;
  }
  return {
    ...row,
    correctFils,
    shortfallFils: correctFils === null ? null : correctFils - row.parsedAmountFils,
    needsManualCheck: correctFils === null,
  };
}

/** Groups imports whose rows are identical (merchant, typed amount, reason, in order). */
export function findIdenticalImports(rows: ImportedRow[]): string[][] {
  const byImport = new Map<string, ImportedRow[]>();
  for (const r of rows) byImport.set(r.importId, [...(byImport.get(r.importId) ?? []), r]);
  const byFingerprint = new Map<string, { importId: string; appliedAt: Date }[]>();
  for (const [importId, rs] of byImport) {
    const fp = [...rs]
      .sort((a, b) => a.rowNumber - b.rowNumber)
      .map((r) => `${r.merchantId.toLowerCase()}|${r.rawAmountText}|${r.reason ?? ""}`)
      .join("\n");
    byFingerprint.set(fp, [...(byFingerprint.get(fp) ?? []), { importId, appliedAt: rs[0]!.appliedAt }]);
  }
  return [...byFingerprint.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => a.appliedAt.getTime() - b.appliedAt.getTime()).map((x) => x.importId));
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header: string[], rows: unknown[][]): string =>
  [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

export function buildReport(rows: ImportedRow[]) {
  const repaired = rows.map(repairRow);
  const duplicates = findIdenticalImports(rows);
  const laterCopies = new Set(duplicates.flatMap((g) => g.slice(1)));

  const imports = new Map<string, { filename: string; appliedAt: Date; rows: number; posted: number; correct: number; manual: number }>();
  for (const r of repaired) {
    const s = imports.get(r.importId) ?? { filename: r.originalFilename, appliedAt: r.appliedAt, rows: 0, posted: 0, correct: 0, manual: 0 };
    s.rows += 1;
    s.posted += r.parsedAmountFils;
    s.correct += r.correctFils ?? 0;
    s.manual += r.needsManualCheck ? 1 : 0;
    imports.set(r.importId, s);
  }

  const files = {
    "repair-sheet.csv": toCsv(
      ["import_id", "filename", "applied_at", "row", "merchant_id", "typed", "posted_fils", "correct_fils", "shortfall_fils", "needs_manual_check", "later_copy_of_identical_import"],
      repaired.map((r) => [r.importId, r.originalFilename, r.appliedAt, r.rowNumber, r.merchantId, r.rawAmountText, r.parsedAmountFils, r.correctFils, r.shortfallFils, r.needsManualCheck, laterCopies.has(r.importId)]),
    ),
    "imports-summary.csv": toCsv(
      ["import_id", "filename", "applied_at", "rows", "posted_fils", "correct_fils", "shortfall_fils", "posted_bd", "correct_bd", "rows_needing_manual_check"],
      [...imports].map(([id, s]) => [id, s.filename, s.appliedAt, s.rows, s.posted, s.correct, s.correct - s.posted, filsToBd(s.posted), filsToBd(s.correct), s.manual]),
    ),
    "suspected-duplicates.csv": toCsv(
      ["group", "import_id", "applied_at", "position"],
      duplicates.flatMap((g, gi) => g.map((id, i) => [gi + 1, id, imports.get(id)!.appliedAt, i === 0 ? "first (keep)" : "later copy (review)"])),
    ),
    "correction-draft.csv": toCsv(
      ["merchantId", "amount", "reason"],
      repaired
        .filter((r) => !laterCopies.has(r.importId) && r.shortfallFils !== null && r.shortfallFils !== 0)
        // No quotes or commas in the reason: the importer's CSV splitter has no quoting.
        .map((r) => [r.merchantId, filsToBd(r.shortfallFils!), `repair: import ${r.importId} row ${r.rowNumber} posted at 1/10 (typed ${r.rawAmountText})`]),
    ),
    "duplicate-reversal-draft.csv": toCsv(
      ["merchantId", "amount", "reason"],
      repaired
        .filter((r) => laterCopies.has(r.importId) && r.parsedAmountFils !== 0)
        .map((r) => [r.merchantId, filsToBd(-r.parsedAmountFils), `repair: reverse suspected duplicate import ${r.importId} row ${r.rowNumber}`]),
    ),
  };
  return { repaired, duplicates, imports, files };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("finance_repair: DATABASE_URL environment variable is not set");
  const outDir = process.argv[2] ?? join("scripts", "out", `finance-repair-${new Date().toISOString().slice(0, 10)}`);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const r = await client.query<{
      import_id: string; original_filename: string; applied_at: Date; row_number: number;
      merchant_id: string; raw_amount_text: string; parsed_amount_fils: string; reason: string | null;
    }>(
      `SELECT i.id AS import_id, i.original_filename, i.applied_at, r.row_number, r.merchant_id,
              r.raw_amount_text, r.parsed_amount_fils, r.reason
         FROM adjustment_import_rows r JOIN adjustment_imports i ON i.id = r.adjustment_import_id
        ORDER BY i.applied_at, r.row_number`,
    );
    await client.query("ROLLBACK");
    const rows: ImportedRow[] = r.rows.map((x) => ({
      importId: x.import_id, originalFilename: x.original_filename, appliedAt: x.applied_at, rowNumber: x.row_number,
      merchantId: x.merchant_id, rawAmountText: x.raw_amount_text, parsedAmountFils: Number(x.parsed_amount_fils), reason: x.reason,
    }));

    const report = buildReport(rows);
    mkdirSync(outDir, { recursive: true });
    for (const [name, content] of Object.entries(report.files)) writeFileSync(join(outDir, name), content);

    const shortfall = report.repaired.reduce((s, x) => s + (x.shortfallFils ?? 0), 0);
    console.log(`finance_repair: ${report.imports.size} import(s), ${rows.length} row(s); total shortfall ${filsToBd(shortfall)} BD`);
    console.log(`finance_repair: ${report.duplicates.length} group(s) of identical imports; ${report.repaired.filter((x) => x.needsManualCheck).length} row(s) need a manual check`);
    console.log(`finance_repair: wrote ${Object.keys(report.files).join(", ")} to ${outDir} (nothing in the database was changed)`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
