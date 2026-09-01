import type { MiddlewareHandler } from 'hono';

export const requestIdMiddleware: MiddlewareHandler = async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.set('startedAt', Date.now());
  await next();
  c.header('X-Request-ID', requestId);
};
