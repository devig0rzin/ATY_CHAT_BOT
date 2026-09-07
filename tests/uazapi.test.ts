import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../src/config/env';
import { UazapiProvider } from '../src/integrations/uazapi/provider';
import { request, testEnv } from './helpers';

const uazapiEnv = {
  ...testEnv,
  APP_ENV: 'local',
  LOCAL_DEV_ROUTES_ENABLED: 'true',
  UAZAPI_BASE_URL: 'https://uazapi.test',
  UAZAPI_TOKEN: 'test-token',
  UAZAPI_OUTBOUND_ENABLED: 'true',
  UAZAPI_REQUEST_TIMEOUT_MS: '30000',
  TEST_WHATSAPP_NUMBER: '5511999999999'
};

const validDecision = {
  should_reply: true,
  reply: 'Ola! A ATY ajuda com automacao e agentes de IA.',
  intent: 'general_inquiry',
  confidence: 0.9,
  handoff_requested: false,
  handoff_reason: null,
  lead_patch: {
    name: null,
    company: null,
    segment: null,
    service_interest: 'business automation',
    budget_status: null,
    urgency: null
  },
  memory_patch: {
    summary: null,
    facts_to_add: [],
    open_loops: []
  }
};

describe('UAZAPI outbound integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('refuses real sending when outbound is disabled', async () => {
    await expect(
      new UazapiProvider(getConfig({ ...uazapiEnv, UAZAPI_OUTBOUND_ENABLED: 'false' })).sendText({
        number: '5511999999999',
        text: 'Teste'
      })
    ).rejects.toMatchObject({ code: 'UAZAPI_OUTBOUND_DISABLED' });
  });

  it('requires base URL and token when outbound is enabled', async () => {
    await expect(
      new UazapiProvider(getConfig({ ...uazapiEnv, UAZAPI_BASE_URL: '' })).sendText({
        number: '5511999999999',
        text: 'Teste'
      })
    ).rejects.toMatchObject({ code: 'UAZAPI_NOT_CONFIGURED' });
  });

  it('sends the minimal /send/text request shape', async () => {
    mockUazapiFetch(200, { ok: true });

    const result = await new UazapiProvider(getConfig(uazapiEnv)).sendText({
      number: '5511999999999',
      text: 'Teste local ATY'
    });

    expect(result).toEqual({ provider: 'uazapi', status: 200 });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://uazapi.test/send/text',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          token: 'test-token'
        }),
        body: JSON.stringify({
          number: '5511999999999',
          text: 'Teste local ATY'
        })
      })
    );
  });

  it.each([
    [401, 'UAZAPI_AUTH_ERROR'],
    [403, 'UAZAPI_AUTH_ERROR'],
    [429, 'UAZAPI_RATE_LIMITED'],
    [500, 'UAZAPI_UPSTREAM_ERROR']
  ])('maps UAZAPI status %s', async (status, code) => {
    mockUazapiFetch(status, { error: 'ignored' });

    await expect(
      new UazapiProvider(getConfig(uazapiEnv)).sendText({
        number: '5511999999999',
        text: 'Teste'
      })
    ).rejects.toMatchObject({ code });
  });

  it('maps network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network failed');
      })
    );

    await expect(
      new UazapiProvider(getConfig(uazapiEnv)).sendText({
        number: '5511999999999',
        text: 'Teste'
      })
    ).rejects.toMatchObject({ code: 'UAZAPI_NETWORK_ERROR' });
  });

  it('maps timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      })
    );

    await expect(
      new UazapiProvider(getConfig({ ...uazapiEnv, UAZAPI_REQUEST_TIMEOUT_MS: '1' })).sendText({
        number: '5511999999999',
        text: 'Teste'
      })
    ).rejects.toMatchObject({ code: 'UAZAPI_REQUEST_TIMEOUT' });
  });

  it('maps invalid JSON response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not-json', { status: 200 }))
    );

    await expect(
      new UazapiProvider(getConfig(uazapiEnv)).sendText({
        number: '5511999999999',
        text: 'Teste'
      })
    ).rejects.toMatchObject({ code: 'UAZAPI_INVALID_RESPONSE' });
  });

  it('keeps /dev/uazapi-send-test disabled outside local dev', async () => {
    const productionResponse = await request(
      '/dev/uazapi-send-test',
      {
        method: 'POST',
        body: JSON.stringify({ text: 'Teste' }),
        headers: { 'content-type': 'application/json' }
      },
      { ...uazapiEnv, APP_ENV: 'production' }
    );
    const disabledResponse = await request(
      '/dev/uazapi-send-test',
      {
        method: 'POST',
        body: JSON.stringify({ text: 'Teste' }),
        headers: { 'content-type': 'application/json' }
      },
      { ...uazapiEnv, LOCAL_DEV_ROUTES_ENABLED: 'false' }
    );

    expect(productionResponse.status).toBe(404);
    expect(disabledResponse.status).toBe(404);
  });

  it('runs /dev/uazapi-send-test locally using TEST_WHATSAPP_NUMBER', async () => {
    mockUazapiFetch(200, { ok: true });

    const response = await request(
      '/dev/uazapi-send-test',
      {
        method: 'POST',
        body: JSON.stringify({ text: 'Teste local ATY' }),
        headers: { 'content-type': 'application/json' }
      },
      uazapiEnv
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.data.sent).toBe(true);
  });

  it('runs /dev/chat-test without UAZAPI when send_to_whatsapp=false', async () => {
    const fetch = mockOpenRouterAndUazapiFetch(false);

    const response = await request(
      '/dev/chat-test',
      {
        method: 'POST',
        body: JSON.stringify({
          message: 'Ola, quero automatizar minha empresa',
          send_to_whatsapp: false
        }),
        headers: { 'content-type': 'application/json' }
      },
      {
        ...uazapiEnv,
        AI_MODE: 'openrouter',
        OPENROUTER_API_KEY: 'test-openrouter-key',
        OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
        OPENROUTER_MODEL: 'openrouter/free'
      }
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.data.decision).toMatchObject(validDecision);
    expect(body.data.outbound.sent).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns safe error when /dev/chat-test wants WhatsApp and outbound is disabled', async () => {
    mockOpenRouterAndUazapiFetch(false);

    const response = await request(
      '/dev/chat-test',
      {
        method: 'POST',
        body: JSON.stringify({
          message: 'Ola, quero automatizar minha empresa',
          send_to_whatsapp: true
        }),
        headers: { 'content-type': 'application/json' }
      },
      {
        ...uazapiEnv,
        AI_MODE: 'openrouter',
        OPENROUTER_API_KEY: 'test-openrouter-key',
        OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
        OPENROUTER_MODEL: 'openrouter/free',
        UAZAPI_OUTBOUND_ENABLED: 'false'
      }
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('UAZAPI_OUTBOUND_DISABLED');
  });

  it('runs /dev/chat-test with mocked UAZAPI when outbound is enabled', async () => {
    const fetch = mockOpenRouterAndUazapiFetch(true);

    const response = await request(
      '/dev/chat-test',
      {
        method: 'POST',
        body: JSON.stringify({
          message: 'Ola, quero automatizar minha empresa',
          send_to_whatsapp: true
        }),
        headers: { 'content-type': 'application/json' }
      },
      {
        ...uazapiEnv,
        AI_MODE: 'openrouter',
        OPENROUTER_API_KEY: 'test-openrouter-key',
        OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
        OPENROUTER_MODEL: 'openrouter/free'
      }
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.data.outbound.sent).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

function mockUazapiFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' }
        })
    )
  );
}

function mockOpenRouterAndUazapiFetch(includeUazapi: boolean) {
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/chat/completions')) {
      return new Response(
        JSON.stringify({
          model: 'openrouter/free',
          choices: [{ message: { content: JSON.stringify(validDecision) } }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (includeUazapi && url.endsWith('/send/text')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'unexpected test request' }), { status: 500 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
