import { Hono } from 'hono';
import { errorHandler } from './middleware/error-handler';
import { requestIdMiddleware } from './middleware/request-id';
import { adminRoutes } from './routes/admin';
import { healthRoutes } from './routes/health';
import { rootRoutes } from './routes/root';
import { uazapiWebhookRoutes } from './routes/uazapi-webhook';
import type { AppVariables } from './types/api';
import type { Env } from './types/env';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use('*', requestIdMiddleware);
app.onError(errorHandler);

app.route('/', rootRoutes);
app.route('/health', healthRoutes);
app.route('/webhooks/uazapi', uazapiWebhookRoutes);
app.route('/admin', adminRoutes);

app.notFound((c) =>
  c.json(
    {
      ok: false,
      request_id: c.get('requestId'),
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found'
      }
    },
    404
  )
);

export default app;
