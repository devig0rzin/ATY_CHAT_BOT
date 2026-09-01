import { describe, expect, it } from 'vitest';
import { request } from './helpers';

type AnyBody = Record<string, any>;

describe('health and root routes', () => {
  it('returns standardized root response', async () => {
    const response = await request('/');
    const body = (await response.json()) as AnyBody;
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.request_id).toMatch(/[0-9a-f-]{36}/);
    expect(body.data.service).toBe('ATY WhatsApp Assistant');
  });

  it('returns health contract', async () => {
    const response = await request('/health');
    const body = (await response.json()) as AnyBody;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      data: {
        status: 'ok',
        service: 'ATY WhatsApp Assistant',
        version: '1.0.0'
      }
    });
    expect(new Date(body.data.timestamp).toISOString()).toBe(body.data.timestamp);
  });

  it('returns standardized 404', async () => {
    const response = await request('/missing');
    const body = (await response.json()) as AnyBody;
    expect(response.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
