import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, testEnv } from './helpers';

type AnyBody = Record<string, any>;

describe('UAZAPI webhook capture mode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('does not debug log payload when debug flag is absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await request('/webhooks/uazapi', {
      method: 'POST',
      body: JSON.stringify({
        event: 'message.received',
        message: { text: 'visible only in debug' }
      }),
      headers: { 'content-type': 'application/json' }
    });

    expect(response.status).toBe(202);
    expect(parseLog(warn.mock.calls, 'uazapi.debug_config')).toMatchObject({
      debug_payload_configured: false,
      debug_payload_resolved: false
    });
    expect(warn.mock.calls.some(([entry]) => String(entry).includes('uazapi.debug_payload'))).toBe(
      false
    );
  });

  it('does not debug log payload when debug flag is false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await request(
      '/webhooks/uazapi',
      {
        method: 'POST',
        body: JSON.stringify({
          event: 'message.received',
          message: { text: 'visible only in debug' }
        }),
        headers: { 'content-type': 'application/json' }
      },
      { ...testEnv, UAZAPI_DEBUG_PAYLOAD: 'false' }
    );

    expect(response.status).toBe(202);
    expect(parseLog(warn.mock.calls, 'uazapi.debug_config')).toMatchObject({
      debug_payload_configured: true,
      debug_payload_resolved: false
    });
    expect(warn.mock.calls.some(([entry]) => String(entry).includes('uazapi.debug_payload'))).toBe(
      false
    );
  });

  it.each(['0', 'no', 'off'])('does not debug log payload when debug flag is %s', async (value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await request(
      '/webhooks/uazapi',
      {
        method: 'POST',
        body: JSON.stringify({ event: 'message.received' }),
        headers: { 'content-type': 'application/json' }
      },
      { ...testEnv, UAZAPI_DEBUG_PAYLOAD: value }
    );

    expect(response.status).toBe(202);
    expect(parseLog(warn.mock.calls, 'uazapi.debug_config')).toMatchObject({
      debug_payload_configured: true,
      debug_payload_resolved: false
    });
    expect(warn.mock.calls.some(([entry]) => String(entry).includes('uazapi.debug_payload'))).toBe(
      false
    );
  });

  it('debug logs parsed payload when debug flag is true', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await request(
      '/webhooks/uazapi',
      {
        method: 'POST',
        body: JSON.stringify({ event: 'message.received', message: { text: 'inspect me' } }),
        headers: { 'content-type': 'application/json' }
      },
      { ...testEnv, UAZAPI_DEBUG_PAYLOAD: 'true', LOG_LEVEL: 'error' }
    );

    const body = (await response.json()) as AnyBody;
    expect(parseLog(warn.mock.calls, 'uazapi.debug_config')).toMatchObject({
      debug_payload_configured: true,
      debug_payload_resolved: true
    });
    const debugLog = parseLog(warn.mock.calls, 'uazapi.debug_payload');
    expect(response.status).toBe(202);
    expect(debugLog).toMatchObject({
      event: 'uazapi.debug_payload',
      provider: 'uazapi',
      payload_sha256: body.data.payload_sha256,
      payload: { event: 'message.received', message: { text: 'inspect me' } }
    });
  });

  it.each(['1', 'yes', 'on'])('debug logs parsed payload when debug flag is %s', async (value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await request(
      '/webhooks/uazapi',
      {
        method: 'POST',
        body: JSON.stringify({ event: 'message.received', message: { text: 'inspect me' } }),
        headers: { 'content-type': 'application/json' }
      },
      { ...testEnv, UAZAPI_DEBUG_PAYLOAD: value }
    );

    expect(response.status).toBe(202);
    expect(parseLog(warn.mock.calls, 'uazapi.debug_config')).toMatchObject({
      debug_payload_configured: true,
      debug_payload_resolved: true
    });
    expect(parseLog(warn.mock.calls, 'uazapi.debug_payload')).toMatchObject({
      event: 'uazapi.debug_payload',
      payload: { event: 'message.received', message: { text: 'inspect me' } }
    });
  });

  it('recursively redacts credential-looking fields in debug payload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await request(
      '/webhooks/uazapi',
      {
        method: 'POST',
        body: JSON.stringify({
          token: 'top-secret',
          nested: {
            api_key: 'key',
            apikey: 'key2',
            authorization: 'Bearer secret',
            password: 'pw',
            secret: 'hidden',
            access_token: 'access',
            refresh_token: 'refresh'
          }
        }),
        headers: { 'content-type': 'application/json' }
      },
      { ...testEnv, UAZAPI_DEBUG_PAYLOAD: 'true' }
    );

    const debugLog = parseLog(warn.mock.calls, 'uazapi.debug_payload');
    expect(debugLog.payload).toMatchObject({
      token: '[REDACTED]',
      nested: {
        api_key: '[REDACTED]',
        apikey: '[REDACTED]',
        authorization: '[REDACTED]',
        password: '[REDACTED]',
        secret: '[REDACTED]',
        access_token: '[REDACTED]',
        refresh_token: '[REDACTED]'
      }
    });
  });

  it('preserves ordinary UAZAPI-looking fields in debug payload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await request(
      '/webhooks/uazapi',
      {
        method: 'POST',
        body: JSON.stringify({
          event: 'message.received',
          messageId: 'wamid-123',
          instanceId: 'instance-456',
          sender: '5511945177464',
          jid: '5511945177464@s.whatsapp.net',
          timestamp: '2026-09-01T22:00:00.000Z',
          message: { text: 'Preciso ver este texto no diagnóstico' }
        }),
        headers: { 'content-type': 'application/json' }
      },
      { ...testEnv, UAZAPI_DEBUG_PAYLOAD: 'true', LOG_MESSAGE_CONTENT: 'false' }
    );

    const debugLog = parseLog(warn.mock.calls, 'uazapi.debug_payload');
    expect(debugLog.payload).toMatchObject({
      event: 'message.received',
      messageId: 'wamid-123',
      instanceId: 'instance-456',
      sender: '5511945177464',
      jid: '5511945177464@s.whatsapp.net',
      timestamp: '2026-09-01T22:00:00.000Z',
      message: { text: 'Preciso ver este texto no diagnóstico' }
    });
  });

  it('does not make external API requests during webhook capture', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await request(
      '/webhooks/uazapi',
      {
        method: 'POST',
        body: JSON.stringify({ event: 'message.received' }),
        headers: { 'content-type': 'application/json' }
      },
      { ...testEnv, UAZAPI_DEBUG_PAYLOAD: 'true' }
    );

    expect(response.status).toBe(202);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function parseLog(calls: unknown[][], event: string): AnyBody {
  const rawLog = calls.map(([entry]) => String(entry)).find((entry) => entry.includes(event));
  expect(rawLog).toBeDefined();
  return JSON.parse(rawLog as string) as AnyBody;
}
