import { formatBhd, parseBhdToFils, toFils } from "@filspay/money";

/**
 * The dashboard's display helpers. Deliberately thin: `bhd` delegates to
 * `@filspay/money`'s `formatBhd`, the same formatter the checkout page uses,
 * so there is exactly one answer to "how is a BHD amount shown" across both
 * halves of this app. Never `/1000`, never `toFixed`.
 */
// Negative amounts are real: refund events in the transaction timeline and
// negative reconciliation gaps. toFils without allowNegative threw on them and
// crashed the transaction detail page once a payment had been refunded.
export function bhd(amountFils: number): string {
  return `${formatBhd(toFils(amountFils, { allowNegative: true }))} BHD`;
}

/**
 * Reads a BD amount typed into a form ("4.75", "4.750", "12") as whole fils,
 * through @filspay/money's parseBhdToFils (the one exact parser; never
 * parseFloat or x1000). Every amount on the dashboard is shown in BD, so
 * every amount box takes BD too: asking for fils next to BD figures invited
 * 1000x mistakes. Throws an Error with a message fit to show the user.
 */
export function parseBdAmountInput(text: string): number {
  let fils: number;
  try {
    fils = parseBhdToFils(text.trim());
  } catch {
    throw new Error("Enter an amount in BD, e.g. 4.750 (at most 3 decimals).");
  }
  if (fils <= 0) throw new Error("Amount must be more than 0.000 BD.");
  return fils;
}

/** `—` for a null/absent value, so an empty table cell is visibly empty
 *  rather than ambiguously blank. */
export function dash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

/** Rendered in Asia/Bahrain time (business days are Bahrain days), whatever
 *  time zone the viewer's browser is set to. It used to be browser-local. */
export function dateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString(undefined, { timeZone: "Asia/Bahrain" }) : "—";
}

/**
 * An `<input type="date">` value (YYYY-MM-DD) as the instant that Bahrain
 * business day starts (00:00 Asia/Bahrain = 21:00 UTC the day before), for
 * the transaction filters. dayStartIso below gives the UTC day start, which
 * left the filters 3 hours off the settlement and analytics days.
 */
export function bahrainDayStartIso(dateValue: string): string | undefined {
  return dateValue ? new Date(`${dateValue}T00:00:00+03:00`).toISOString() : undefined;
}

/**
 * An `<input type="date">` value (YYYY-MM-DD) as a full ISO instant at the
 * UTC day boundary — what the `from`/`to` transaction filters take. No
 * timezone picker and no business-day conversion: those filters compare
 * `occurred_at` directly, so pretending otherwise here would invent a
 * precision the endpoint doesn't have.
 */
// UTC day boundary, NOT Bahrain (kept for its existing tests); the
// transaction filters use bahrainDayStartIso.
export function dayStartIso(dateValue: string): string | undefined {
  return dateValue ? `${dateValue}T00:00:00.000Z` : undefined;
}

/**
 * A `<input type="datetime-local">` value (local wall time, no zone) as an
 * ISO 8601 instant. `new Date(local)` interprets it in the browser's own
 * timezone, which is what the user meant when they typed it.
 */
export function localDateTimeToIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** A status value for display: "partially_refunded" -> "partially refunded" (CSS capitalizes it). */
export function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}
