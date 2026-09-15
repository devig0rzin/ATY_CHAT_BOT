import { Hono } from 'hono';
import { getConfig } from '../config/env';
import { adminAuth } from '../middleware/admin-auth';
import { successResponse } from '../lib/response';
import type { AppVariables } from '../types/api';
import type { Env } from '../types/env';
import { ContactsRepository } from '../repositories/contacts.repository';
import { HandoffsRepository } from '../repositories/handoffs.repository';
import { utcNow } from '../lib/time';

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

adminRoutes.post('/contacts/:contactId/handoff/:action', async (c) => {
  if (!c.env.DB)
    return c.json({ ok: false, error: { code: 'DATABASE_ERROR', message: 'D1 is required' } }, 503);
  const contactId = c.req.param('contactId');
  const action = c.req.param('action');
  const contacts = new ContactsRepository(c.env.DB);
  const handoffs = new HandoffsRepository(c.env.DB);
  const now = utcNow();
  if (action === 'activate') {
    await handoffs.setStatus(contactId, 'active', now);
    await contacts.setAiEnabled(contactId, false, now);
  } else if (action === 'resolve') {
    await handoffs.setStatus(contactId, 'resolved', now);
    await contacts.setAiEnabled(contactId, true, now);
  } else {
    return c.notFound();
  }
  return successResponse(c, { contact_id: contactId, action }, 200);
});
