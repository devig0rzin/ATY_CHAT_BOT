import { describe, expect, it } from 'vitest';
import { request, testEnv } from './helpers';

type AnyBody = Record<string, any>;

describe('admin and webhook auth', () => {
  it('protects admin status', async () => {
    const response = await request('/admin/status');
    const body = (await response.json()) as AnyBody;
    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('allows admin status with bearer key', async () => {
    const response = await request('/admin/status', {
      headers: { Authorization: 'Bearer test-admin-key' }
    });
    const body = (await response.json()) as AnyBody;
    expect(response.status).toBe(200);
    expect(body.data.database_configured).toBe(false);
  });

  it('protects webhook when header mode is enabled', async () => {
    const response = await request(
      '/webhooks/uazapi',
      { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } },
      { ...testEnv, WEBHOOK_AUTH_MODE: 'header', WEBHOOK_SECRET: 'secret' }
    );
    expect(response.status).toBe(401);
  });

  it('allows webhook with configured generic header', async () => {
    const response = await request(
      '/webhooks/uazapi',
      {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json', 'X-ATY-Webhook-Secret': 'secret' }
      },
      { ...testEnv, WEBHOOK_AUTH_MODE: 'header', WEBHOOK_SECRET: 'secret' }
    );
    expect(response.status).toBe(202);
  });
});
