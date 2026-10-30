import type { FastifyInstance, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../lib/errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Legacy unscoped path. Kept answering 501: refunds are merchant-scoped and
 * live at POST /v1/merchants/:merchantId/refunds (below), which is what
 * initiateMerchantRefund and the dashboard's RefundDrawer use (FP-212).
 * transactions.test.ts asserts this 501.
 */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", { preHandler: requireMerchantAuth }, async (_request, reply) => {
    reply.code(501).send({ error: "not_implemented", message: "use POST /v1/merchants/:merchantId/refunds" });
  });
}

interface MerchantRefundParams {
  merchantId: string;
}
interface MerchantRefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

function parseRefundBody(body: MerchantRefundBody | undefined) {
  const { transactionId, amountFils, reason } = body ?? {};
  if (typeof transactionId !== "string" || !UUID_RE.test(transactionId)) {
    throw new BadRequestError("invalid_request", "transactionId is required and must be a transaction id");
  }
  if (amountFils !== undefined && (typeof amountFils !== "number" || !Number.isSafeInteger(amountFils) || amountFils <= 0)) {
    throw new BadRequestError("invalid_request", "amountFils, if given, must be a positive integer number of fils");
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
    throw new BadRequestError("invalid_request", "reason, if given, must be a string of at most 500 characters");
  }
  return {
    transactionId,
    amountFils: amountFils === undefined ? undefined : toFils(amountFils as number),
    reason: reason === undefined || (reason as string).trim() === "" ? undefined : (reason as string).trim(),
  };
}

/**
 * POST /v1/merchants/:merchantId/refunds — full or partial refund of one of
 * the caller's own captured transactions. Registered with prefix
 * '/v1/merchants'.
 *
 * - owner/finance sessions or the merchant's API key (requireMerchantRole);
 * - never an admin impersonation session: a refund sends money back out,
 *   and "view as merchant" must not be a way to do that;
 * - the path merchant must be the caller's (assertRefundRequestScope) and
 *   the transaction must belong to it (initiateMerchantRefund → 404);
 * - Idempotency-Key required, so a retried request never refunds twice.
 */
export async function merchantRefundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantRefundParams; Body: MerchantRefundBody }>(
    "/:merchantId/refunds",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const auth = request.merchantAuth!;
      if (auth.actorType === "admin_impersonation") {
        throw new ForbiddenError("forbidden", "refunds cannot be issued while viewing as a merchant");
      }
      if (!UUID_RE.test(request.params.merchantId)) {
        throw new NotFoundError("merchant_not_found");
      }
      assertRefundRequestScope(auth, request.params.merchantId);
      const idempotencyKey = getIdempotencyKey(request);
      const input = parseRefundBody(request.body);

      const result = await initiateMerchantRefund(app.db, app.acquirer, {
        merchantId: request.params.merchantId,
        transactionId: input.transactionId,
        amountFils: input.amountFils,
        idempotencyKey,
        actor: requireMerchantWriterActor(auth),
        reason: input.reason,
      });
      reply.code(result.statusCode).send(result.body);
    },
  );
}
