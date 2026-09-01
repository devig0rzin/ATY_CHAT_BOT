import { describe, expect, it } from 'vitest';
import { request } from './helpers';

type AnyBody = Record<string, any>;

describe('UAZAPI webhook capture mode', () => {
  it('rejects invalid JSON with standardized error', async () => {
    const response = await request('/webhooks/uazapi', {
      method: 'POST',
      body: '{invalid',
      headers: { 'content-type': 'application/json' }
    });
    const body = (await response.json()) as AnyBody;
    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('WEBHOOK_INVALID_BODY');
  });

  it('accepts arbitrary valid JSON without DB', async () => {
    const response = await request('/webhooks/uazapi', {
      method: 'POST',
      body: JSON.stringify({ any: { valid: ['json', 1, true, null] } }),
      headers: { 'content-type': 'application/json' }
    });
    const body = (await response.json()) as AnyBody;
    expect(response.status).toBe(202);
    expect(body.data).toMatchObject({
      status: 'received',
      provider: 'uazapi',
      captured: true,
      database_configured: false
    });
    expect(body.data.payload_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('enforces body size guard', async () => {
    const response = await request('/webhooks/uazapi', {
      method: 'POST',
      body: JSON.stringify({ value: 'x'.repeat(270_000) }),
      headers: { 'content-type': 'application/json' }
    });
    const body = (await response.json()) as AnyBody;
    expect(response.status).toBe(413);
    expect(body.error.code).toBe('WEBHOOK_INVALID_BODY');
  });
});
