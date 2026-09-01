import { Hono } from 'hono';
import { getConfig } from '../config/env';
import { adminAuth } from '../middleware/admin-auth';
import { successResponse } from '../lib/response';
import type { AppVariables } from '../types/api';
import type { Env } from '../types/env';

export const adminRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

adminRoutes.use('*', adminAuth);

adminRoutes.get('/status', (c) => {
  const config = getConfig(c.env);
  return successResponse(c, {
    service: 'ATY WhatsApp Assistant',
    version: '1.0.0',
    ai_mode: config.AI_MODE,
    database_configured: Boolean(c.env.DB),
    uazapi_configured: Boolean(
      c.env.UAZAPI_BASE_URL && c.env.UAZAPI_TOKEN && c.env.UAZAPI_INSTANCE_ID
    ),
    request_id: c.get('requestId')
  });
});
