import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../lib/errors.js";
import { formatIsoDate } from "../lib/dateFormat.js";

/**
 * Uniform error -> HTTP response mapping. Every route across the API
 * should throw an `AppError` subclass; this is the single place that turns
 * one into `{ "error": "code", "message"?: "string" }`.
 */
// am: 500s log the full err incl. pg detail, might contain card ref? fine its server-side
export function errorHandler(
  err: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof AppError) {
    reply.code(err.statusCode).send({ error: err.code, message: err.message });
    return;
  }

  const fastifyErr = err as FastifyError;

  // YA: 400 not 422 for schema validation errors — API.md section 2. correct
  if (fastifyErr.validation) {
    reply.code(400).send({ error: "validation_error", message: fastifyErr.message });
    return;
  }

  if (fastifyErr.code === "FST_REQ_FILE_TOO_LARGE" || fastifyErr.code === "FST_FILES_LIMIT") {
    reply.code(413).send({ error: "file_too_large", message: fastifyErr.message });
    return;
  }

  // Fastify's own client errors (malformed or empty JSON body, unsupported
  // content type, body too large) carry a 4xx statusCode: the caller sent a
  // bad request, so answer with it instead of a 500.
  if (typeof fastifyErr.statusCode === "number" && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
    reply.code(fastifyErr.statusCode).send({ error: "invalid_request", message: fastifyErr.message });
    return;
  }

  // Postgres refusing a malformed value is a bad request, not a server error:
  // a non-UUID id in the path (22P02) or a garbage date or cursor (22007,
  // 22008). These used to answer 500 internal_error on many routes. (A CHECK
  // violation stays a 500: it can be our own write failing, e.g. the audit log.)
  const pgCode = (err as { code?: unknown }).code;
  if (pgCode === "22P02" || pgCode === "22007" || pgCode === "22008") {
    reply.code(400).send({ error: "invalid_request", message: "One of the values sent is not valid." });
    return;
  }

  request.log.error({ err, occurredOn: formatIsoDate(new Date()) }, "unhandled error");
  reply.code(500).send({ error: "internal_error" });
}
