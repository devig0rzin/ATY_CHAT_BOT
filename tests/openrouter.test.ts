import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../src/config/env';
import { OpenRouterClient } from '../src/integrations/openrouter/client';
import { OpenRouterProvider } from '../src/integrations/openrouter/provider';
import { aiDecisionSchema } from '../src/schemas/ai.schemas';
import { request, testEnv } from './helpers';

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

const openRouterEnv = {
  ...testEnv,
  APP_ENV: 'local',
  AI_MODE: 'openrouter',
  OPENROUTER_API_KEY: 'test-key',
  OPENROUTER_MODEL: 'openrouter/free',
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  AI_TEMPERATURE: '0.4',
  AI_REQUEST_TIMEOUT_MS: '30000',
  LOCAL_DEV_ROUTES_ENABLED: 'true'
};

describe('OpenRouter integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps AI_MODE=mock supported', async () => {
    const response = await request(
      '/dev/ai-test',
      {
        method: 'POST',
        body: JSON.stringify({ message: 'Oi' }),
        headers: { 'content-type': 'application/json' }
      },
      { ...testEnv, APP_ENV: 'local', LOCAL_DEV_ROUTES_ENABLED: 'true' }
    );
    const body = (await response.json()) as Record<string, any>;
    expect(response.status).toBe(200);
    expect(body.data.provider).toBe('mock');
    expect(aiDecisionSchema.safeParse(body.data.decision).success).toBe(true);
  });

  it('requires OpenRouter API key when provider is used', async () => {
    const config = getConfig({ ...openRouterEnv, OPENROUTER_API_KEY: '' });
    await expect(
      new OpenRouterProvider(config).generateReply({
        message: 'Oi',
        requestId: crypto.randomUUID()
      })
    ).rejects.toMatchObject({ code: 'OPENROUTER_NOT_CONFIGURED' });
  });

  it('parses a valid mocked OpenRouter response', async () => {
    const fetch = mockOpenRouterFetch(200, {
      model: 'openrouter/free',
      choices: [{ message: { content: JSON.stringify(validDecision) } }]
    });

    const decision = await new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
      message: 'Quero automacao',
      requestId: crypto.randomUUID()
    });

    expect(decision).toMatchObject(validDecision);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json'
        })
      })
    );
    const requestBody = JSON.parse(String((fetch.mock.calls[0] as any[])[1]?.body));
    expect(requestBody.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'aty_ai_decision',
        strict: true
      }
    });
    expect(requestBody.provider).toEqual({ require_parameters: true });
    expect(requestBody.plugins).toEqual([{ id: 'response-healing' }]);
    expect(requestBody.messages[1].content).toContain('memory_patch');
    expect(requestBody.messages[1].content).toContain('lead_patch');
  });

  it('parses JSON wrapped in markdown', async () => {
    mockOpenRouterFetch(200, {
      model: 'openrouter/free',
      choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(validDecision)}\n\`\`\`` } }]
    });

    const decision = await new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
      message: 'Quero automacao',
      requestId: crypto.randomUUID()
    });

    expect(decision).toMatchObject(validDecision);
  });

  it('parses repairable trailing commas without changing semantic fields', async () => {
    mockOpenRouterFetch(200, {
      model: 'openrouter/free',
      choices: [
        {
          message: {
            content: JSON.stringify(validDecision).replace(
              '"open_loops":[]}}',
              '"open_loops":[],}}'
            )
          }
        }
      ]
    });

    const decision = await new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
      message: 'Quero automacao',
      requestId: crypto.randomUUID()
    });

    expect(decision).toMatchObject(validDecision);
  });

  it.each([
    [401, 'OPENROUTER_AUTH_ERROR'],
    [403, 'OPENROUTER_AUTH_ERROR'],
    [429, 'OPENROUTER_RATE_LIMITED'],
    [500, 'OPENROUTER_UPSTREAM_ERROR']
  ])('maps OpenRouter status %s', async (status, code) => {
    mockOpenRouterFetch(status, { error: { message: 'safe ignored body' } });

    await expect(
      new OpenRouterClient().createChatCompletion({
        apiKey: 'test-key',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
        messages: [{ role: 'user', content: 'Oi' }],
        maxTokens: 100,
        temperature: 0.4,
        timeoutMs: 30000
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
      new OpenRouterClient().createChatCompletion({
        apiKey: 'test-key',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
        messages: [{ role: 'user', content: 'Oi' }],
        maxTokens: 100,
        temperature: 0.4,
        timeoutMs: 30000
      })
    ).rejects.toMatchObject({ code: 'OPENROUTER_NETWORK_ERROR' });
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
      new OpenRouterClient().createChatCompletion({
        apiKey: 'test-key',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
        messages: [{ role: 'user', content: 'Oi' }],
        maxTokens: 100,
        temperature: 0.4,
        timeoutMs: 1
      })
    ).rejects.toMatchObject({ code: 'AI_REQUEST_TIMEOUT' });
  });

  it('maps malformed provider JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not-json', { status: 200 }))
    );

    await expect(
      new OpenRouterClient().createChatCompletion({
        apiKey: 'test-key',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
        messages: [{ role: 'user', content: 'Oi' }],
        maxTokens: 100,
        temperature: 0.4,
        timeoutMs: 30000
      })
    ).rejects.toMatchObject({ code: 'OPENROUTER_INVALID_RESPONSE' });
  });

  it('extracts text from array message content', async () => {
    mockOpenRouterFetch(200, {
      model: 'array-content-model',
      choices: [
        {
          message: {
            content: [{ type: 'text', text: JSON.stringify(validDecision) }]
          }
        }
      ]
    });

    const decision = await new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
      message: 'Quero automacao',
      requestId: crypto.randomUUID()
    });

    expect(decision).toMatchObject(validDecision);
  });

  it('reports safe metadata when content is missing due to length', async () => {
    mockOpenRouterFetch(200, {
      model: 'short-output-model',
      choices: [{ finish_reason: 'length', message: { content: '' } }]
    });

    await expect(
      new OpenRouterClient().createChatCompletion({
        apiKey: 'test-key',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
        messages: [{ role: 'user', content: 'Oi' }],
        maxTokens: 100,
        temperature: 0.4,
        timeoutMs: 30000
      })
    ).rejects.toMatchObject({
      code: 'OPENROUTER_INVALID_RESPONSE',
      metadata: {
        status: 200,
        model: 'short-output-model',
        output_type: 'string',
        finish_reason: 'length'
      }
    });
  });

  it('accepts object message content and still validates it with Zod', async () => {
    mockOpenRouterFetch(200, {
      model: 'object-content-model',
      choices: [{ finish_reason: 'stop', message: { content: validDecision } }]
    });

    const decision = await new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
      message: 'Quero automacao',
      requestId: crypto.randomUUID()
    });

    expect(decision).toMatchObject(validDecision);
  });

  it('maps invalid AI schema', async () => {
    mockOpenRouterFetch(200, {
      choices: [{ message: { content: JSON.stringify({ reply: 'missing fields' }) } }]
    });

    await expect(
      new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
        message: 'Oi',
        requestId: crypto.randomUUID()
      })
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
  });

  it('rejects missing required fields', async () => {
    mockOpenRouterFetch(200, {
      choices: [
        { message: { content: JSON.stringify({ ...validDecision, should_reply: undefined }) } }
      ]
    });

    await expect(
      new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
        message: 'Oi',
        requestId: crypto.randomUUID()
      })
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
  });

  it('rejects semantic type changes such as confidence string', async () => {
    mockOpenRouterFetch(200, {
      choices: [{ message: { content: JSON.stringify({ ...validDecision, confidence: 'alta' }) } }]
    });

    await expect(
      new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
        message: 'Oi',
        requestId: crypto.randomUUID()
      })
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
  });

  it('rejects incomplete lead_patch', async () => {
    const leadPatch = { ...validDecision.lead_patch };
    delete (leadPatch as Partial<typeof validDecision.lead_patch>).urgency;
    mockOpenRouterFetch(200, {
      choices: [
        { message: { content: JSON.stringify({ ...validDecision, lead_patch: leadPatch }) } }
      ]
    });

    await expect(
      new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
        message: 'Oi',
        requestId: crypto.randomUUID()
      })
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
  });

  it('rejects incomplete memory_patch', async () => {
    const memoryPatch = { ...validDecision.memory_patch };
    delete (memoryPatch as Partial<typeof validDecision.memory_patch>).open_loops;
    mockOpenRouterFetch(200, {
      choices: [
        { message: { content: JSON.stringify({ ...validDecision, memory_patch: memoryPatch }) } }
      ]
    });

    await expect(
      new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
        message: 'Oi',
        requestId: crypto.randomUUID()
      })
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
  });

  it('reports the resolved OpenRouter model returned by the API', async () => {
    mockOpenRouterFetch(200, {
      model: 'resolved/free-model',
      choices: [{ message: { content: JSON.stringify(validDecision) } }]
    });

    const response = await request(
      '/dev/ai-test',
      {
        method: 'POST',
        body: JSON.stringify({ message: 'Oi' }),
        headers: { 'content-type': 'application/json' }
      },
      openRouterEnv
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.data.model).toBe('resolved/free-model');
  });

  it('falls back when structured output is rejected', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unsupported response_format' }), { status: 400 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'openrouter/free',
            choices: [{ message: { content: JSON.stringify(validDecision) } }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetch);

    const decision = await new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
      message: 'Oi',
      requestId: crypto.randomUUID()
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).response_format).toEqual({
      type: 'json_object'
    });
    expect(decision.reply).toContain('ATY');
  });

  it('falls back when structured output cannot be routed', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'no endpoints support requested parameters' }), {
          status: 404
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'fallback/free-model',
            choices: [{ message: { content: JSON.stringify(validDecision) } }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetch);

    const decision = await new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
      message: 'Oi',
      requestId: crypto.randomUUID()
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(decision.reply).toContain('ATY');
  });

  it('falls back when structured output returns no usable content due to length', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'structured/free-model',
            choices: [{ finish_reason: 'length', message: { content: {} } }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'fallback/free-model',
            choices: [{ message: { content: JSON.stringify(validDecision) } }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetch);

    const decision = await new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
      message: 'Oi',
      requestId: crypto.randomUUID()
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(decision.reply).toContain('ATY');
  });

  it('rejects invalid fallback output', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unsupported response_format' }), { status: 400 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'openrouter/free',
            choices: [{ message: { content: JSON.stringify({ reply: 'missing fields' }) } }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetch);

    await expect(
      new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
        message: 'Oi',
        requestId: crypto.randomUUID()
      })
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
  });

  it('never writes API keys to logs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockOpenRouterFetch(200, {
      choices: [{ message: { content: JSON.stringify({ reply: 'missing fields' }) } }]
    });

    await expect(
      new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
        message: 'Oi',
        requestId: crypto.randomUUID()
      })
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });

    const logs = [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().join('\n');
    expect(logs).not.toContain('test-key');
  });

  it('does not show raw content when AI_DEBUG_RESPONSE=false', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockOpenRouterFetch(200, {
      choices: [{ message: { content: JSON.stringify({ reply: 'missing fields' }) } }]
    });

    await expect(
      new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
        message: 'Oi',
        requestId: crypto.randomUUID()
      })
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });

    expect(warnSpy.mock.calls.flat().join('\n')).not.toContain('ai.debug.invalid_response');
  });

  it('shows safe local diagnostics when AI_DEBUG_RESPONSE=true in local env', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockOpenRouterFetch(200, {
      model: 'resolved/free-model',
      choices: [{ message: { content: JSON.stringify({ reply: 'missing fields' }) } }]
    });

    await expect(
      new OpenRouterProvider(
        getConfig({ ...openRouterEnv, AI_DEBUG_RESPONSE: 'true', LOG_LEVEL: 'debug' })
      ).generateReply({
        message: 'Oi',
        requestId: crypto.randomUUID()
      })
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });

    const logs = warnSpy.mock.calls.flat().join('\n');
    expect(logs).toContain('ai.debug.invalid_response');
    expect(logs).toContain('resolved/free-model');
    expect(logs).toContain('should_reply');
    expect(logs).not.toContain('test-key');
  });

  it('does not show raw content when AI_DEBUG_RESPONSE=true outside local env', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockOpenRouterFetch(200, {
      choices: [{ message: { content: JSON.stringify({ reply: 'missing fields' }) } }]
    });

    await expect(
      new OpenRouterProvider(
        getConfig({
          ...openRouterEnv,
          APP_ENV: 'production',
          AI_DEBUG_RESPONSE: 'true',
          WEBHOOK_AUTH_MODE: 'off'
        })
      ).generateReply({
        message: 'Oi',
        requestId: crypto.randomUUID()
      })
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });

    expect(warnSpy.mock.calls.flat().join('\n')).not.toContain('ai.debug.invalid_response');
  });

  it('keeps /dev/ai-test disabled unless local dev routes are enabled', async () => {
    const response = await request(
      '/dev/ai-test',
      {
        method: 'POST',
        body: JSON.stringify({ message: 'Oi' }),
        headers: { 'content-type': 'application/json' }
      },
      { ...testEnv, APP_ENV: 'local', LOCAL_DEV_ROUTES_ENABLED: 'false' }
    );

    expect(response.status).toBe(404);
  });

  it('keeps /dev/ai-test disabled outside local environment', async () => {
    const response = await request(
      '/dev/ai-test',
      {
        method: 'POST',
        body: JSON.stringify({ message: 'Oi' }),
        headers: { 'content-type': 'application/json' }
      },
      { ...openRouterEnv, APP_ENV: 'production', LOCAL_DEV_ROUTES_ENABLED: 'true' }
    );

    expect(response.status).toBe(404);
  });

  it('runs /dev/ai-test with OpenRouter when enabled locally', async () => {
    mockOpenRouterFetch(200, {
      model: 'openrouter/free',
      choices: [{ message: { content: JSON.stringify(validDecision) } }]
    });

    const response = await request(
      '/dev/ai-test',
      {
        method: 'POST',
        body: JSON.stringify({ message: 'Oi' }),
        headers: { 'content-type': 'application/json' }
      },
      openRouterEnv
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.data.provider).toBe('openrouter');
    expect(body.data.model).toBe('openrouter/free');
    expect(body.data.decision).toMatchObject(validDecision);
  });

  it('rejects invalid /dev/ai-test input', async () => {
    const response = await request(
      '/dev/ai-test',
      {
        method: 'POST',
        body: JSON.stringify({ message: '' }),
        headers: { 'content-type': 'application/json' }
      },
      { ...testEnv, APP_ENV: 'local', LOCAL_DEV_ROUTES_ENABLED: 'true' }
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('does not call external APIs for disabled dev route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await request(
      '/dev/ai-test',
      {
        method: 'POST',
        body: JSON.stringify({ message: 'Oi' }),
        headers: { 'content-type': 'application/json' }
      },
      { ...testEnv, APP_ENV: 'production', LOCAL_DEV_ROUTES_ENABLED: 'false' }
    );

    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function mockOpenRouterFetch(status: number, body: unknown) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
