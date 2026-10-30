/**
 * The injectable HTTP send — `runDispatchPass` and everything it calls take
 * a `WebhookTransport` as an explicit parameter, never calling `fetch`
 * directly deep inside dispatch logic. Same "pass the effectful dependency
 * in" shape as `AcquirerSimulator`.
 */
import { resolvesToBlockedAddress } from "./ssrf.js";

/**
 * @property timeoutMs Covers the whole exchange including reading the body (the abort
 * signal stays armed until the body has been read).
 */
export interface WebhookTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookTransportResponse {
  /** null on a transport-level failure (timeout, DNS, connection refused —
   *  never reached the receiver) */
  statusCode: number | null;
  /** "" on a transport-level failure */
  body: string;
  /** present iff statusCode is null */
  errorMessage?: string;
}

export type WebhookTransport = (req: WebhookTransportRequest) => Promise<WebhookTransportResponse>;

/** Only an excerpt of the receiver's reply is ever stored (2000 chars), so
 *  never read more than this from it. */
const MAX_RESPONSE_BYTES = 64 * 1024;

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes));
}

export interface FetchTransportOptions {
  /** Refuse to send to hosts that resolve to private/internal addresses
   *  (SSRF). On in production; off in dev/test so local receivers work. */
  blockPrivateNetworks?: boolean;
}

/** Real transport: Node's global fetch with an AbortController-driven
 *  timeout, used by index.ts's production wiring. Redirects are never
 *  followed (a 3xx counts as a failed delivery), so a receiver can't bounce
 *  a webhook to an internal address. */
export function createFetchTransport(options: FetchTransportOptions = {}): WebhookTransport {
  return async (req: WebhookTransportRequest): Promise<WebhookTransportResponse> => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      if (options.blockPrivateNetworks && (await resolvesToBlockedAddress(new URL(req.url).hostname))) {
        return { statusCode: null, body: "", errorMessage: "blocked: destination resolves to a private or internal address" };
      }
      const response = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        redirect: "manual",
        signal: controller.signal,
      });
      const body = await readCapped(response, MAX_RESPONSE_BYTES);
      return { statusCode: response.status, body };
    } catch (err) {
      return {
        statusCode: null,
        body: "",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}
