import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { login, resendOtp, verifyOtp } from "../../api/dashboardAuth.js";
import { ApiError, describeError } from "../../api/client.js";
import {
  readLastMerchantId,
  useDashboardAuth,
  writeLastMerchantId,
} from "../../auth/DashboardAuthContext.js";
import type { DashboardLoginResponse, DashboardMerchantChoice } from "../../types.js";
import "../../dashboard.css";

type Step =
  | { kind: "credentials" }
  | { kind: "choose"; merchants: DashboardMerchantChoice["merchants"] }
  | { kind: "otp"; challenge: DashboardLoginResponse };

/**
 * Two-step merchant login: email + password creates a *pending* session and
 * issues an OTP challenge; the OTP step is what actually authenticates it.
 * Neither step is told which credential was wrong — the API answers a single
 * generic `invalid_credentials`, repeated here verbatim.
 *
 * No Merchant ID field: people know their email, not a UUID. The merchant id
 * stays the account key in the database and API. When one email opens
 * accounts at several businesses (same password), the API lists them and the
 * page asks "Which business?", then logs in again with that merchantId.
 * The last business used is remembered on this device and listed first.
 */
export function LoginPage() {
  const { status, refresh } = useDashboardAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [step, setStep] = useState<Step>({ kind: "credentials" });
  // The business the session is for, once known (only chosen explicitly when
  // one email has several). Remembered on this device after a sign-in.
  const [merchantId, setMerchantId] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const redirectTo = (location.state as { from?: string } | null)?.from ?? "/dashboard/transactions";

  if (status === "authenticated") {
    return <Navigate to={redirectTo} replace />;
  }

  function backToCredentials(message: string | null): void {
    setStep({ kind: "credentials" });
    setCode("");
    setMerchantId("");
    setError(message);
  }

  async function signIn(chosenMerchantId?: string): Promise<void> {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await login({ email, password, ...(chosenMerchantId ? { merchantId: chosenMerchantId } : {}) });
      if ("merchantChoiceRequired" in result) {
        // Last-used business first, then alphabetical (the API's order).
        const last = readLastMerchantId();
        const merchants = [...result.merchants].sort((a, b) => Number(b.merchantId === last) - Number(a.merchantId === last));
        setStep({ kind: "choose", merchants });
        return;
      }
      setMerchantId(chosenMerchantId ?? "");
      setStep({ kind: "otp", challenge: result });
      setPassword("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCredentials(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    await signIn();
  }

  // after otp we get logged out after ~10 min. cookie ttl never extended? — am
  // MK: that's the idle timeout, by design
  async function handleOtp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const verified = await verifyOtp({ code });
      writeLastMerchantId(verified.merchantId);
      // The session cookie is now authenticated server-side; re-read `me` so
      // the rest of the dashboard renders from the server's answer, not from
      // the verify response we happen to be holding.
      await refresh();
      navigate(redirectTo, { replace: true });
    } catch (err) {
      // `429 too_many_attempts` revokes the pending session server-side, so
      // retrying the OTP step against it can only ever fail again — start
      // over instead of leaving the user tapping a dead form.
      if (err instanceof ApiError && err.statusCode === 429 && err.code === "too_many_attempts") {
        backToCredentials(describeError(err));
      } else {
        setError(describeError(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend(): Promise<void> {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const challenge = await resendOtp();
      setStep({ kind: "otp", challenge });
      setCode("");
      setNotice("A new code has been sent.");
    } catch (err) {
      // Includes `429 resend_too_soon` — the server owns the cadence rule, so
      // whatever it says is shown as-is rather than pre-empted by a
      // client-side timer that could drift from it.
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="dash-centered">
      <h1>FilsPay dashboard</h1>
      <p className="dash-muted">Merchant sign-in.</p>

      {error ? <p className="dash-error">{error}</p> : null}
      {notice ? <p className="dash-notice">{notice}</p> : null}

      {step.kind === "credentials" ? (
        <form onSubmit={(e) => void handleCredentials(e)} className="dash-form">
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button type="submit" className="dash-button" disabled={submitting}>
            {submitting ? "Signing in..." : "Continue"}
          </button>
        </form>
      ) : step.kind === "choose" ? (
        <div className="dash-form">
          <p>
            <strong>{email}</strong> has accounts at more than one business. Which one do you want to open?
          </p>
          {step.merchants.map((m) => (
            <button
              key={m.merchantId}
              type="button"
              className="dash-button"
              disabled={submitting}
              onClick={() => void signIn(m.merchantId)}
            >
              {m.displayName}
            </button>
          ))}
          <button type="button" className="dash-button" onClick={() => backToCredentials(null)}>
            Back
          </button>
        </div>
      ) : (
        <form onSubmit={(e) => void handleOtp(e)} className="dash-form">
          <p>
            A one-time code was issued for <strong>{email}</strong>. It expires at{" "}
            {new Date(step.challenge.otpExpiresAt).toLocaleTimeString()}.
          </p>
          {step.challenge.devOtpCode ? (
            <p className="dash-muted">
              Development code: <code>{step.challenge.devOtpCode}</code>
            </p>
          ) : null}
          <label>
            One-time code
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button type="submit" className="dash-button" disabled={submitting}>
            {submitting ? "Verifying..." : "Verify"}
          </button>
          <button
            type="button"
            className="dash-button"
            disabled={submitting}
            onClick={() => void handleResend()}
          >
            Resend code
          </button>
          <button type="button" className="dash-button" onClick={() => backToCredentials(null)}>
            Start over
          </button>
        </form>
      )}
    </main>
  );
}
