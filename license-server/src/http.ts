import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type z } from 'zod';
import { ApiFail } from './services/licensing.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (m: string, code = 'BAD_REQUEST') => new HttpError(400, code, m);
export const notFound = (m = 'Not found') => new HttpError(404, 'NOT_FOUND', m);
export const forbidden = (m = 'Forbidden', code = 'FORBIDDEN') => new HttpError(403, code, m);

export function errorHandler(err: Error & { statusCode?: number; errno?: number; code?: string }, req: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof HttpError || err instanceof ApiFail) {
    void reply.status(err.status).send({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof ZodError) {
    void reply.status(400).send({ error: req.url.startsWith('/api/v1/') ? 'BAD_REQUEST' : 'VALIDATION', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    return;
  }
  if (err.errno === 1062) {
    void reply.status(409).send({ error: 'DUPLICATE', message: 'An entry with this name already exists' });
    return;
  }
  if (err.statusCode === 429) {
    void reply.status(429).send({ error: 'RATE_LIMITED', message: 'Too many requests; try again later' });
    return;
  }
  if (err.statusCode && err.statusCode < 500) {
    void reply.status(err.statusCode).send({ error: err.code ?? 'REQUEST', message: err.message });
    return;
  }
  req.log.error({ err }, 'request failed');
  void reply.status(500).send({ error: 'INTERNAL', message: 'Internal server error' });
}

/** PATCH bodies: keep only the keys the client sent (zod .partial() would apply defaults). */
export function parsePatch<S extends z.ZodObject>(schema: S, body: unknown): Partial<z.output<S>> {
  const sent = body && typeof body === 'object' ? Object.keys(body) : [];
  const parsed = schema.partial().parse(body ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.includes(k))) as Partial<z.output<S>>;
}

export function page(q: { page?: unknown; pageSize?: unknown }): { limit: number; offset: number } {
  const p = Math.max(1, Number(q.page) || 1);
  const size = Math.min(500, Math.max(1, Number(q.pageSize) || 50));
  return { limit: size, offset: (p - 1) * size };
}
