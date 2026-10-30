import { useState } from "react";
import { request } from "../../api/client.js";
import { ApiError, describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd, parseBdAmountInput } from "../../format.js";
import type { TransactionDto } from "../../types.js";

interface RefundResponse {
  id: string;
  transactionId: string;
  amountFils: number;
  feeReversedFils: number;
  status: string;
  transactionStatus: string;
  refundedTotalFils: number;
  occurredAt: string;
}

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

/**
 * Refund control on the transaction page: `POST /v1/merchants/:id/refunds`.
 * Hiding it for other roles is presentation only — the API enforces the
 * owner/finance role and the merchant scope itself.
 */
export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per refund attempt, kept across retries of the same attempt, so
  // a retry after a timeout replays the first request instead of refunding
  // twice. A new key only after success or cancel.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const merchantId = me?.merchant.id;
  // Only while something is left to refund: a partial capture that was fully
  // refunded keeps the partially_captured status but has nothing left.
  const refundable =
    (txn.status === "captured" || txn.status === "partially_captured" || txn.status === "partially_refunded") &&
    txn.capturedFils - txn.refundedFils > 0;

  function close(): void {
    setOpen(false);
    setAmount("");
    setError(null);
    setIdempotencyKey(crypto.randomUUID());
  }

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId) return;
    const trimmed = amount.trim();
    const stillRefundable = txn.capturedFils - txn.refundedFils;
    let amountFils: number | undefined;
    if (trimmed !== "") {
      try {
        amountFils = parseBdAmountInput(trimmed);
      } catch (err) {
        setError((err as Error).message);
        return;
      }
      if (amountFils > stillRefundable) {
        setError(`You can refund at most ${bhd(stillRefundable)}.`);
        return;
      }
    }
    const shown = bhd(amountFils ?? stillRefundable);
    if (!window.confirm(`Refund ${shown} to the cardholder? This cannot be recalled.`)) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      // Left blank, amountFils is omitted entirely and the API refunds
      // everything still refundable — its own documented default, same
      // affordance the capture form has.
      const body = amountFils === undefined ? { transactionId: txn.id } : { transactionId: txn.id, amountFils };

      await request<RefundResponse>(`/v1/merchants/${encodeURIComponent(merchantId)}/refunds`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body),
      });

      close();
      // Refetch rather than patch: the refund wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await onRefunded();
    } catch (err) {
      setError(describeError(err));
      // A definite answer (declined, invalid, too much) is final for this key:
      // retrying with it would only replay that answer, and a corrected amount
      // would be refused as idempotency_key_reused. Keep the key only when the
      // outcome is unknown (network error, 5xx), so a retry can't refund twice.
      if (err instanceof ApiError && err.statusCode < 500) {
        setIdempotencyKey(crypto.randomUUID());
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!refundable) return null;

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {error ? <p className="dash-error">{error}</p> : null}
        {open ? (
          <form className="dash-form dash-form-inline" onSubmit={(e) => void handleRefund(e)}>
            <label>
              Amount in BD (blank refunds everything still refundable)
              <input
                type="text"
                inputMode="decimal"
                placeholder={(txn.capturedFils - txn.refundedFils) > 0 ? `e.g. ${bhd(txn.capturedFils - txn.refundedFils).replace(" BHD", "")}` : undefined}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <p className="dash-muted">
              Captured: {bhd(txn.capturedFils)} · Already refunded: {bhd(txn.refundedFils)} · Still refundable:{" "}
              {bhd(txn.capturedFils - txn.refundedFils)}
            </p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding..." : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={close}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="dash-button" onClick={() => setOpen(true)}>
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}
