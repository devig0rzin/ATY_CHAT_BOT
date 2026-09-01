import { Hono } from 'hono';
import { successResponse } from '../lib/response';
import { utcNow } from '../lib/time';
import type { AppVariables } from '../types/api';
import type { Env } from '../types/env';

export const healthRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

healthRoutes.get('/', (c) =>
  successResponse(c, {
    status: 'ok',
    service: 'ATY WhatsApp Assistant',
    version: '1.0.0',
    timestamp: utcNow()
  })
);
