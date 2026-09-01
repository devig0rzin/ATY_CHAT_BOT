import { Hono } from 'hono';
import { webhookAuth } from '../middleware/webhook-auth';
import { successResponse } from '../lib/response';
import { WebhookService } from '../services/webhook.service';
import type { AppVariables } from '../types/api';
import type { Env } from '../types/env';

export const uazapiWebhookRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

uazapiWebhookRoutes.post('/', webhookAuth, async (c) => {
  const service = new WebhookService(c.env);
  const result = await service.captureUazapiEvent(c.req.raw, {
    requestId: c.get('requestId'),
    startedAt: c.get('startedAt')
  });
  return successResponse(c, result, 202);
});
