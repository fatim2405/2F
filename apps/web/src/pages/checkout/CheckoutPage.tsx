import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { formatBhd, toFils } from "@filspay/money";
import { getPaymentLink, payPaymentLink } from "../../api/paymentLinks.js";
import { ApiError } from "../../api/client.js";
import { dateTime } from "../../format.js";
import type { PaymentLinkPublicDto, PayPaymentLinkResponse, SimulatedCardInput } from "../../types.js";
import "./CheckoutPage.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error" }
  | { kind: "loaded"; link: PaymentLinkPublicDto };

type PayState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: PayPaymentLinkResponse }
  | { kind: "declined"; message: string; retryable: boolean }
  | { kind: "terminal"; message: string };

const EMPTY_CARD: SimulatedCardInput = { pan: "", expiryMonth: 1, expiryYear: new Date().getFullYear() + 1, cvv: "" };

export function CheckoutPage() {
  const { token } = useParams<{ token: string }>();
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [payState, setPayState] = useState<PayState>({ kind: "idle" });
  const [card, setCard] = useState<SimulatedCardInput>(EMPTY_CARD);
  const [brandHint, setBrandHint] = useState<string | null>(null);

  // FH: memory leak — this effect never aborts the fetch on unmount (React warning in console?)
  // theres a cancelled flag in the cleanup tho. warning must be from somewhere else — am
  useEffect(() => {
    if (!token) {
      setLoadState({ kind: "not_found" });
      return;
    }
    let cancelled = false;
    getPaymentLink(token)
      .then((link) => {
        if (!cancelled) setLoadState({ kind: "loaded", link });
      })
      .catch((err: unknown) => {
        // A 404 (malformed or unknown token, not distinguished, as the API
        // chooses) is "does not exist". Anything else, a server error or no
        // network, is a temporary failure and must not tell the customer the
        // link is gone.
        if (cancelled) return;
        if (err instanceof ApiError && err.statusCode === 404) setLoadState({ kind: "not_found" });
        else setLoadState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!token) return;

    // A fresh Idempotency-Key per explicit user action — every click,
    // including a "try again" after a decline, is a new attempt.
    const idempotencyKey = crypto.randomUUID();
    const submittedAt = new Date().toISOString();
    setPayState({ kind: "submitting" });

    try {
      const result = await payPaymentLink(token, { card, submittedAt }, idempotencyKey);
      setPayState({ kind: "success", result });
    } catch (err) {
      if (err instanceof ApiError) {
        const { statusCode, body } = err;
        if (statusCode === 402) {
          const stageLabel = body.stage === "capture" ? "Your payment could not be completed." : "Your card was declined.";
          setPayState({ kind: "declined", message: stageLabel, retryable: true });
        } else if (statusCode === 502) {
          setPayState({ kind: "declined", message: "The acquirer is temporarily unavailable. Please try again.", retryable: true });
        } else if (statusCode === 409 && body.error === "payment_link_already_paid") {
          setPayState({ kind: "terminal", message: "This invoice has already been paid." });
        } else if (statusCode === 409 && body.error === "payment_link_canceled") {
          setPayState({ kind: "terminal", message: "This payment link is no longer available." });
        } else if (statusCode === 409) {
          setPayState({ kind: "declined", message: "A payment is already being processed for this link. Please try again shortly.", retryable: true });
        } else if (statusCode === 410) {
          setPayState({ kind: "terminal", message: "This payment link has expired." });
        } else {
          setPayState({ kind: "declined", message: body.message ?? "Something went wrong. Please try again.", retryable: true });
        }
      } else {
        setPayState({ kind: "declined", message: "Something went wrong. Please try again.", retryable: true });
      }
    }
  }

  if (loadState.kind === "loading") {
    return (
      <main className="checkout-page">
        <p>Loading...</p>
      </main>
    );
  }

  if (loadState.kind === "error") {
    return (
      <main className="checkout-page">
        <h1>Something went wrong</h1>
        <p>We couldn't load this payment link right now. Please try again in a moment.</p>
      </main>
    );
  }

  if (loadState.kind === "not_found") {
    return (
      <main className="checkout-page">
        <h1>Payment link not found</h1>
        <p>This payment link does not exist.</p>
      </main>
    );
  }

  const { link } = loadState;

  if (payState.kind === "success") {
    return (
      <main className="checkout-page">
        <h1>Payment successful</h1>
        <p>Thank you — your payment has been received.</p>
        <dl>
          <dt>Transaction ID</dt>
          <dd>{payState.result.transactionId}</dd>
          <dt>Paid at</dt>
          <dd>{dateTime(payState.result.paidAt)}</dd>
        </dl>
      </main>
    );
  }

  if (payState.kind === "terminal") {
    return (
      <main className="checkout-page">
        <h1>Unable to pay</h1>
        <p>{payState.message}</p>
      </main>
    );
  }

  if (link.status === "paid") {
    return (
      <main className="checkout-page">
        <h1>Already paid</h1>
        <p>This invoice has already been paid.</p>
      </main>
    );
  }
  if (link.status === "expired") {
    return (
      <main className="checkout-page">
        <h1>Link expired</h1>
        <p>This payment link has expired.</p>
      </main>
    );
  }
  if (link.status === "canceled") {
    return (
      <main className="checkout-page">
        <h1>No longer available</h1>
        <p>This payment link is no longer available.</p>
      </main>
    );
  }
  if (link.status === "processing") {
    return (
      <main className="checkout-page">
        <h1>Payment processing</h1>
        <p>A payment is being processed for this link — please wait a moment and refresh.</p>
      </main>
    );
  }

  // link.status === 'active'
  const amount = formatBhd(toFils(link.amountFils));
  const submitting = payState.kind === "submitting";

  return (
    <main className="checkout-page">
      <h1>{link.merchantDisplayName}</h1>
      <p className="checkout-amount">{amount} BHD</p>
      {link.description ? <p className="checkout-description">{link.description}</p> : null}
      {link.reference ? <p className="checkout-reference">Reference: {link.reference}</p> : null}

      {payState.kind === "declined" ? <p className="checkout-error">{payState.message}</p> : null}

      <form onSubmit={handleSubmit} className="checkout-form">
        <label>
          Card number
          <input
            type="text"
            inputMode="numeric"
            autoComplete="cc-number"
            placeholder="1234 5678 9012 3456"
            maxLength={23}
            required
            value={card.pan}
            onChange={(e) => {
              const pan = e.target.value;
              setCard({ ...card, pan });
              const digits = pan.replace(/\D/g, "");
              if (digits.length >= 4) {
                void import("../../utils/helpers.js").then((m) => {
                  setBrandHint(m.formatCardBrandHint(digits));
                });
              } else {
                setBrandHint(null);
              }
            }}
          />
          {brandHint && brandHint !== "unknown" ? (
            <span className="checkout-brand-hint">{brandHint}</span>
          ) : null}
        </label>
        <div className="checkout-form-row">
          <label>
            Expiry month
            <input
              type="number"
              autoComplete="cc-exp-month"
              placeholder="MM"
              min={1}
              max={12}
              required
              value={card.expiryMonth}
              onChange={(e) => setCard({ ...card, expiryMonth: Number(e.target.value) })}
            />
          </label>
          <label>
            Expiry year
            <input
              type="number"
              autoComplete="cc-exp-year"
              placeholder="YYYY"
              min={new Date().getFullYear()}
              required
              value={card.expiryYear}
              onChange={(e) => setCard({ ...card, expiryYear: Number(e.target.value) })}
            />
          </label>
          <label>
            CVV
            <input
              type="password"
              inputMode="numeric"
              autoComplete="cc-csc"
              placeholder="123"
              maxLength={4}
              required
              value={card.cvv}
              onChange={(e) => setCard({ ...card, cvv: e.target.value })}
            />
          </label>
        </div>
        <button type="submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? "Processing payment..." : `Pay ${amount} BHD`}
        </button>
      </form>
      <p className="checkout-help">Your card details go straight to the acquirer over an encrypted connection.</p>

      <p className="checkout-help">
        Test cards (simulated acquirer, no real charge): any other number approves; a PAN ending{" "}
        <code>0002</code> always declines (do not honor); ending <code>0119</code> always declines
        (insufficient funds); ending <code>0069</code> always errors.
      </p>
    </main>
  );
}
