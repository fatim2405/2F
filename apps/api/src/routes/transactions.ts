import type { FastifyInstance, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import { requireApiKey } from "../apiKeys/verify.js";
import { requireMerchantAuth, requireMerchantRole, requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { authorizeTransaction, type AuthorizeInput } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { voidTransaction } from "../payments/void.js";
import { PassThrough } from "node:stream";
import { streamTransactionsExportCsv } from "../transactions/exportCsv.js";
import { getTransactionById, listTransactions } from "../transactions/query.js";
import { listTransactionEvents } from "../transactions/events.js";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import type { SimulatedCardInput } from "../acquirer/types.js";

interface AuthorizeBody {
  amountFils?: number;
  card?: SimulatedCardInput;
  reference?: string;
}

interface CaptureBody {
  amountFils?: number;
}

interface TransactionIdParams {
  id: string;
}

/** from/to: ISO-8601 instants (not business dates). Invalid values are rejected with 400. */
interface ExportQuery {
  status?: string | string[];
  from?: string;
  to?: string;
}

interface ListTransactionsQuery {
  status?: string | string[];
  from?: string;
  to?: string;
  search?: string;
  limit?: string;
  cursor?: string;
}

/**
 * Reads the Idempotency-Key header. Required on authorize and capture;
 * void is naturally idempotent and does not call this. Keys are scoped per
 * merchant + endpoint (see payments/idempotency.ts), so the same key may be
 * reused across endpoints without colliding.
 */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

/**
 * Registered with prefix '/v1/transactions'. Endpoint auth: authorize is
 * API-key-only (a server-to-server "charge a
 * card" call); capture/void/reads accept either a session or an API key
 * via `requireMerchantAuth`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A positive whole number of fils, or a 400 before anything (the acquirer included) is called. */
function assertAmountFils(value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BadRequestError("invalid_amount", "amountFils must be a positive whole number of fils");
  }
}

export async function transactionRoutes(app: FastifyInstance): Promise<void> {
  // A malformed :id can't name any transaction: answer 404 like an unknown
  // one, instead of letting Postgres reject the uuid cast as a 500.
  app.addHook("preValidation", async (request) => {
    const { id } = (request.params ?? {}) as { id?: string };
    if (id !== undefined && !UUID_RE.test(id)) {
      throw new NotFoundError("transaction_not_found");
    }
  });

  app.post<{ Body: AuthorizeBody }>(
    "/",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const idempotencyKey = getIdempotencyKey(request);
      const { amountFils, card, reference } = request.body ?? {};
      if (amountFils === undefined || !card) {
        throw new BadRequestError("invalid_request", "amountFils and card are required");
      }
      assertAmountFils(amountFils);

      const input: AuthorizeInput = {
        merchantId: request.apiKeyAuth!.merchantId,
        amountFils: toFils(amountFils),
        card,
        reference,
        idempotencyKey,
        actor: { type: "merchant_api_key", id: request.apiKeyAuth!.apiKeyId },
      };
      const result = await authorizeTransaction(app.db, app.acquirer, input);
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: TransactionIdParams; Body: CaptureBody }>(
    // am: requireMerchantAuth lets impersonation through here too? an admin impersonating can capture
    // MK: impersonation is read-only, enforced in requireMerchantAuth. fine
    // MK: confirmed — ADMIN.md says grants are support-level read only
    "/:id/capture",
    // owner/finance (or an API key), like void and refund: capturing moves money.
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const idempotencyKey = getIdempotencyKey(request);
      const { amountFils } = request.body ?? {};
      if (amountFils !== undefined) assertAmountFils(amountFils);

      const result = await captureTransaction(app.db, app.acquirer, {
        transactionId: request.params.id,
        merchantId: request.merchantAuth!.merchantId,
        amountFils: amountFils !== undefined ? toFils(amountFils) : undefined,
        idempotencyKey,
        actor: requireMerchantWriterActor(request.merchantAuth!),
      });
      // The negotiated discount is part of the fee capture.ts computes, in
      // the same transaction; the separate post-commit adjustment is gone.
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: TransactionIdParams }>(
    // owner/finance only (or the merchant's API key), matching the dashboard,
    // which only offers Void to those roles. A support session gets 403.
    "/:id/void",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const result = await voidTransaction(app.db, {
        transactionId: request.params.id,
        merchantId: request.merchantAuth!.merchantId,
        actor: requireMerchantWriterActor(request.merchantAuth!),
      });
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.get<{ Querystring: ListTransactionsQuery }>(
    "/",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const limit = q.limit !== undefined ? Number.parseInt(q.limit, 10) : undefined;

      return listTransactions(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        status,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        search: q.search,
        limit,
        cursor: q.cursor ?? null,
      });
    },
  );

  app.get<{ Querystring: ExportQuery }>(
    "/export",
    { preHandler: requireMerchantAuth },
    async (request, reply) => {
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];

      const from = q.from ? new Date(q.from) : undefined;
      const to = q.to ? new Date(q.to) : undefined;
      if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
        throw new BadRequestError("invalid_request", "from and to must be valid ISO-8601 instants");
      }

      // Streamed page by page: building the whole CSV in memory first ran
      // out of memory (or hit the max string length) on wide date ranges.
      const body = new PassThrough();
      reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", 'attachment; filename="transactions.csv"')
        .send(body);
      try {
        await streamTransactionsExportCsv(
          app.db,
          { merchantId: request.merchantAuth!.merchantId, from, to, status },
          (chunk) => body.write(chunk),
        );
        body.end();
      } catch (err) {
        request.log.error({ err }, "transactions export failed mid-stream");
        body.destroy(err as Error);
      }
      return reply;
    },
  );

  app.get<{ Params: TransactionIdParams }>(
    "/:id",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const txn = await getTransactionById(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        transactionId: request.params.id,
      });
      if (!txn) {
        throw new NotFoundError("transaction_not_found");
      }
      return txn;
    },
  );

  app.get<{ Params: TransactionIdParams }>(
    "/:id/events",
    { preHandler: requireMerchantAuth },
    async (request) => {
      // Same merchant-scoped existence check as the detail route first
      // (404 if the parent transaction isn't found/owned).
      const txn = await getTransactionById(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        transactionId: request.params.id,
      });
      if (!txn) {
        throw new NotFoundError("transaction_not_found");
      }
      // existence check above is the ownership check. correct — FH
      return listTransactionEvents(app.db, request.params.id);
    },
  );
}
