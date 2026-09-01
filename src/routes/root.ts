import { Hono } from 'hono';
import { successResponse } from '../lib/response';
import type { AppVariables } from '../types/api';
import type { Env } from '../types/env';

export const rootRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

rootRoutes.get('/', (c) =>
  successResponse(c, {
    service: 'ATY WhatsApp Assistant',
    status: 'online',
    version: '1.0.0',
    environment: c.env.AI_MODE === 'openai' ? 'production-configured' : 'local-safe'
  })
);
