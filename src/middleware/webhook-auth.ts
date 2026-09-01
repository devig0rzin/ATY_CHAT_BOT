import type { MiddlewareHandler } from 'hono';
import { getConfig } from '../config/env';
import { AppError } from '../lib/errors';
import { safeEqual } from '../lib/crypto';

export const webhookAuth: MiddlewareHandler = async (c, next) => {
  const config = getConfig(c.env);
  if (config.WEBHOOK_AUTH_MODE === 'off') {
    await next();
    return;
  }
  const supplied = c.req.header('X-ATY-Webhook-Secret') ?? '';
  if (!supplied || !config.WEBHOOK_SECRET || !(await safeEqual(supplied, config.WEBHOOK_SECRET))) {
    throw new AppError({
      code: 'WEBHOOK_UNAUTHORIZED',
      httpStatus: 401,
      safeMessage: 'Webhook unauthorized'
    });
  }
  await next();
};
