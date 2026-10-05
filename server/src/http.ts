import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type z } from 'zod';
import { LicenseLimitError } from '@vpm/core';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, code = 'BAD_REQUEST') => new HttpError(400, code, msg);
export const notFound = (what = 'Not found') => new HttpError(404, 'NOT_FOUND', what);
export const forbidden = (msg = 'Forbidden', code = 'FORBIDDEN') => new HttpError(403, code, msg);
export const conflict = (msg: string, code = 'CONFLICT') => new HttpError(409, code, msg);

export function errorHandler(err: Error & { statusCode?: number; errno?: number; code?: string }, req: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof HttpError) {
    void reply.status(err.status).send({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof ZodError) {
    void reply.status(400).send({
      error: 'VALIDATION',
      message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }
  if (err instanceof LicenseLimitError) {
    void reply.status(403).send({ error: 'LICENSE_LIMIT', message: err.message });
    return;
  }
  if (err.errno === 1062) {
    void reply.status(409).send({ error: 'DUPLICATE', message: 'An entry with this name or address already exists' });
    return;
  }
  if (err.statusCode && err.statusCode < 500) {
    void reply.status(err.statusCode).send({ error: err.code ?? 'REQUEST', message: err.message });
    return;
  }
  req.log.error({ err }, 'request failed');
  void reply.status(500).send({ error: 'INTERNAL', message: 'Internal server error' });
}

export function page(query: { page?: unknown; pageSize?: unknown }): { limit: number; offset: number; page: number } {
  const p = Math.max(1, Number(query.page) || 1);
  const size = Math.min(500, Math.max(1, Number(query.pageSize) || 50));
  return { limit: size, offset: (p - 1) * size, page: p };
}

/**
 * Validates a PATCH body. zod's .partial() still applies .default() values,
 * which would silently overwrite fields the client did not send — so only the
 * keys actually present in the request are kept.
 */
export function parsePatch<S extends z.ZodObject>(schema: S, body: unknown): Partial<z.output<S>> {
  const parsed = schema.partial().parse(body ?? {}) as Record<string, unknown>;
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => Object.prototype.hasOwnProperty.call(raw, k))) as Partial<z.output<S>>;
}
