import { TooManyRequestsError } from "./errors.js";

/**
 * Slows down password guessing on the merchant and admin login routes.
 * There was no limit at all: a script could try passwords as fast as the
 * server answered.
 *
 * Only failed attempts count. Per account (merchant + email, or admin email):
 * 5 failures in 15 minutes locks that account's login until the window ends.
 * Per client IP: 50 failures in 15 minutes, which catches one address trying
 * many accounts. A successful login clears the account's counter.
 *
 * In-memory, per API process: enough for one instance. Running several
 * instances behind a load balancer would need this moved to Postgres or Redis.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_ACCOUNT = 5;
const MAX_FAILURES_PER_IP = 50;

interface Counter {
  failures: number;
  windowEndsAt: number;
}

export class LoginThrottle {
  private readonly counters = new Map<string, Counter>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Throws 429 if this account or IP is locked out right now. */
  assertAllowed(accountKey: string, ip: string): void {
    for (const [key, max] of [
      [`acct:${accountKey}`, MAX_FAILURES_PER_ACCOUNT],
      [`ip:${ip}`, MAX_FAILURES_PER_IP],
    ] as const) {
      const c = this.live(key);
      if (c && c.failures >= max) {
        const minutes = Math.max(1, Math.ceil((c.windowEndsAt - this.now()) / 60_000));
        throw new TooManyRequestsError("too_many_login_attempts", `Too many failed attempts. Try again in ${minutes} minute(s).`);
      }
    }
  }

  recordFailure(accountKey: string, ip: string): void {
    for (const key of [`acct:${accountKey}`, `ip:${ip}`]) {
      const c = this.live(key);
      if (c) c.failures += 1;
      else this.counters.set(key, { failures: 1, windowEndsAt: this.now() + WINDOW_MS });
    }
    this.prune();
  }

  recordSuccess(accountKey: string): void {
    this.counters.delete(`acct:${accountKey}`);
  }

  private live(key: string): Counter | undefined {
    const c = this.counters.get(key);
    if (c && c.windowEndsAt <= this.now()) {
      this.counters.delete(key);
      return undefined;
    }
    return c;
  }

  private prune(): void {
    if (this.counters.size < 10_000) return;
    for (const [key, c] of this.counters) if (c.windowEndsAt <= this.now()) this.counters.delete(key);
  }
}
