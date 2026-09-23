import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../src/config/env';
import { createAIProvider } from '../src/integrations/openai/client';
import { GroqProvider } from '../src/integrations/groq/provider';
import { AppError } from '../src/lib/errors';
import { ErrorAlertService } from '../src/services/error-alert.service';

const validDecision = {
  should_reply: true,
  reply: 'Posso ajudar.',
  intent: 'test',
  confidence: 0.9,
  handoff_requested: false,
  handoff_reason: null,
  lead_patch: {
    name: null,
    company: null,
    segment: null,
    service_interest: null,
    budget_status: null,
    urgency: null
  },
  memory_patch: {
    summary: null,
    facts_to_add: [],
    open_loops: []
  }
};

function config(overrides: Record<string, string> = {}) {
  return getConfig({
    AI_MODE: 'groq',
    GROQ_API_KEY: 'groq-secret',
    GROQ_MODEL: 'openai/gpt-oss-20b',
    GROQ_BASE_URL: 'https://api.groq.com/openai/v1',
    WEBHOOK_AUTH_MODE: 'off',
    OPENAI_MAX_OUTPUT_TOKENS: '1200',
    AI_REQUEST_TIMEOUT_MS: '30000',
    ...overrides
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GroqProvider', () => {
  it('envia structured output strict com o schema e o contexto completo', async () => {
    const fetch = mockResponse({
      model: 'openai/gpt-oss-20b',
      choices: [{ message: { content: JSON.stringify(validDecision) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
    });

    const result = await new GroqProvider(config()).generateReply({
      requestId: 'groq-request',
      message: 'Qual meu nome?',
      memory: {
        summary: 'Lucas tem uma clínica',
        facts_json: '["nome: Lucas"]',
        open_loops_json: '["contratação"]',
        current_intent: 'support'
      },
      recent: [
        { direction: 'inbound', content: 'Meu nome é Lucas.' },
        { direction: 'outbound', content: 'Prazer, Lucas.' }
      ]
    });

    expect(result).toMatchObject(validDecision);
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('openai/gpt-oss-20b');
    expect(body.reasoning_effort).toBe('low');
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'aty_ai_decision', strict: true }
    });
    expect(body.response_format.json_schema.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining(['should_reply', 'lead_patch', 'memory_patch'])
    });
    expect(body.messages[1].content).toContain(
      'CURRENT USER MESSAGE (respond to this first): Qual meu nome?'
    );
    expect(body.messages[1].content).toContain('Lucas tem uma clínica');
    expect(body.messages[1].content).toContain('Meu nome é Lucas.');
  });

  it('seleciona GroqProvider exclusivamente quando AI_MODE=groq', () => {
    const provider = createAIProvider({
      AI_MODE: 'groq',
      GROQ_API_KEY: 'groq-secret',
      WEBHOOK_AUTH_MODE: 'off'
    });
    expect(provider).toBeInstanceOf(GroqProvider);
  });

  it.each([
    [400, 'GROQ_BAD_REQUEST'],
    [401, 'GROQ_AUTH_ERROR'],
    [403, 'GROQ_AUTH_ERROR'],
    [404, 'GROQ_MODEL_OR_ENDPOINT_ERROR'],
    [422, 'GROQ_BAD_REQUEST'],
    [429, 'GROQ_RATE_LIMIT'],
    [500, 'GROQ_UPSTREAM_ERROR'],
    [503, 'GROQ_UPSTREAM_ERROR']
  ])('mapeia HTTP %s para %s', async (status, code) => {
    mockResponse({ error: { type: 'invalid_request_error', code: 'schema_invalid' } }, status, {
      'retry-after': '12',
      'x-ratelimit-remaining-tokens': '0',
      'x-request-id': 'request-123456789'
    });
    await expect(
      new GroqProvider(config()).generateReply({ requestId: 'error-request', message: 'oi' })
    ).rejects.toMatchObject({
      code,
      metadata: {
        http_status: status,
        groq_error_type: 'invalid_request_error',
        groq_error_code: 'schema_invalid',
        provider_request_id: 'requ***6789'
      }
    });
  });

  it('mapeia timeout sem retry infinito', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      new GroqProvider(config()).generateReply({ requestId: 'timeout-request', message: 'oi' })
    ).rejects.toMatchObject({ code: 'GROQ_TIMEOUT' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['malformed JSON', new Response('{invalid', { status: 200 })],
    [
      'invalid AIDecision',
      new Response(
        JSON.stringify({ model: 'openai/gpt-oss-20b', choices: [{ message: { content: '{}' } }] }),
        { status: 200 }
      )
    ]
  ])('classifica %s como GROQ_INVALID_RESPONSE', async (_, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(
      new GroqProvider(config()).generateReply({ requestId: 'invalid-request', message: 'oi' })
    ).rejects.toMatchObject({ code: 'GROQ_INVALID_RESPONSE' });
  });

  it('envia alerta Groq somente ao número técnico fixo', async () => {
    const sendText = vi.fn().mockResolvedValue({ status: 200 });
    await new ErrorAlertService(
      config({ TEST_ERROR_ALERT_ENABLED: 'true', TEST_ERROR_ALERT_NUMBER: '5511976388220' }),
      { sendText }
    ).notify(new AppError({ code: 'GROQ_RATE_LIMIT', httpStatus: 429, safeMessage: 'rate' }), {
      requestId: 'alert-groq',
      provider: 'Groq',
      stage: 'AI',
      model: 'openai/gpt-oss-20b'
    });
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ number: '5511976388220' }));
  });
});

function mockResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers }
    })
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
