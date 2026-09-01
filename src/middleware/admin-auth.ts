import type { MiddlewareHandler } from 'hono';
import { getConfig } from '../config/env';
import { AppError } from '../lib/errors';
import { safeEqual } from '../lib/crypto';

export const adminAuth: MiddlewareHandler = async (c, next) => {
  const config = getConfig(c.env);
  const configuredKey = config.ADMIN_API_KEY;
  const authorization = c.req.header('Authorization') ?? '';
  const prefix = 'Bearer ';
  if (!configuredKey || !authorization.startsWith(prefix)) {
    throw new AppError({ code: 'UNAUTHORIZED', httpStatus: 401, safeMessage: 'Unauthorized' });
  }
  const supplied = authorization.slice(prefix.length);
  if (!(await safeEqual(supplied, configuredKey))) {
    throw new AppError({ code: 'UNAUTHORIZED', httpStatus: 401, safeMessage: 'Unauthorized' });
  }
  await next();
};
