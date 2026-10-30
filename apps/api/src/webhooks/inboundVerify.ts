import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies the signature on an inbound acquirer callback. */

interface ParsedAcquirerSignatureHeader {
  timestamp: number;
  signature: string;
}

function parseAcquirerSignatureHeader(header: string): ParsedAcquirerSignatureHeader | null {
  let timestampStr: string | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key === "t") timestampStr = value;
    else if (key === "v1") signature = value;
  }

  if (!timestampStr || !signature) return null;
  if (!/^\d+$/.test(timestampStr)) return null;

  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return null;

  return { timestamp, signature };
}

/** timestamp_out_of_tolerance only when a freshness window is passed in. */
export type VerifyAcquirerCallbackFailureReason = "malformed_header" | "signature_mismatch" | "timestamp_out_of_tolerance";

export interface VerifyAcquirerCallbackResult {
  valid: boolean;
  reason?: VerifyAcquirerCallbackFailureReason;
}

// Buffer.compare returns at the first differing byte, which leaks timing;
// timingSafeEqual doesn't.
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verifies the acquirer callback signature when present and required.
 * @param options.toleranceSeconds When set, a signed callback whose
 *   timestamp is further than this from now is rejected, so a captured
 *   genuine callback can't be replayed later. The route passes it in
 *   production.
 */
export function verifyAcquirerCallbackSignature(
  payload: unknown,
  header: string | undefined,
  secret: string,
  requireSignature = false,
  options?: { toleranceSeconds?: number; now?: number },
): VerifyAcquirerCallbackResult {
  if (!header) {
    return requireSignature
      ? { valid: false, reason: "malformed_header" }
      : { valid: true };
  }

  const parsed = parseAcquirerSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  // A string payload is the raw request body exactly as received, which is
  // what the acquirer signed. Re-serializing a parsed object only matches
  // when the sender used JSON.stringify's exact spacing and key order.
  const signedBody = typeof payload === "string" ? payload : JSON.stringify(payload);
  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${signedBody}`)
    .digest("hex");

  if (!constantTimeEquals(expected, parsed.signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  if (options?.toleranceSeconds !== undefined) {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - parsed.timestamp) > options.toleranceSeconds) {
      return { valid: false, reason: "timestamp_out_of_tolerance" };
    }
  }

  return { valid: true };
}
