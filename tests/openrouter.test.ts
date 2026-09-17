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

    const decision = await new OpenRouterProvider(
      getConfig({ ...openRouterEnv, LOG_LEVEL: 'info', OPENAI_MAX_OUTPUT_TOKENS: '1200' })
    ).generateReply({
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
    expect(requestBody.max_tokens).toBe(1200);
    expect(requestBody.messages[1].content).toContain('memory_patch');
    expect(requestBody.messages[1].content).toContain('lead_patch');
    expect(requestBody.messages[1].content).not.toContain('Required JSON shape');
    expect(requestBody.messages[1].content).not.toContain('"should_reply"');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('prioritizes the current message while retaining memory, history, and company knowledge', async () => {
    const fetch = mockOpenRouterFetch(200, {
      model: 'openrouter/free',
      choices: [
        { message: { content: JSON.stringify({ ...validDecision, reply: 'Seu nome e Lucas.' }) } }
      ]
    });

    const decision = await new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
      message: 'Qual meu nome?',
      requestId: crypto.randomUUID(),
      memory: {
        summary: 'Lucas possui uma clinica.',
        facts_json: JSON.stringify(['name = Lucas', 'business = clinica']),
        open_loops_json: JSON.stringify([]),
        current_intent: 'automation_consulting'
      },
      recent: [{ direction: 'inbound', content: 'Tenho uma clinica.' }]
    });

    const requestBody = JSON.parse(String((fetch.mock.calls[0] as any[])[1]?.body));
    const systemPrompt = String(requestBody.messages[0].content);
    const conversation = String(requestBody.messages[1].content);

    expect(decision.reply).toContain('Lucas');
    expect(systemPrompt).toContain(
      "Answer the user's latest message directly before pursuing any secondary goal."
    );
    expect(systemPrompt).toContain('must never determine the topic');
    expect(systemPrompt).toContain(
      'Set should_reply to true and provide a non-empty, direct reply.'
    );
    expect(systemPrompt).toContain('Official website: https://www.automationtoyou.com.br/');
    expect(conversation).toContain('CURRENT USER MESSAGE (respond to this first): Qual meu nome?');
    expect(conversation).toContain('Long-term memory:');
    expect(conversation).toContain('Recent conversation:');
    expect(conversation.indexOf('CURRENT USER MESSAGE')).toBeLessThan(
      conversation.indexOf('Long-term memory:')
    );
    expect(conversation.indexOf('Long-term memory:')).toBeLessThan(
      conversation.indexOf('Recent conversation:')
    );
  });

  it.each([
    {
      label: 'answers a dental-service question directly with known business context',
      message: 'Como funciona um bot para atendimento para dentista?',
      reply:
        'Para uma clinica odontologica, o bot atende pelo WhatsApp, faz triagem e ajuda no agendamento.',
      expected: 'odontologica',
      memory: {
        summary: 'Lucas possui uma clinica.',
        facts_json: JSON.stringify(['business = clinica']),
        open_loops_json: JSON.stringify([]),
        current_intent: 'automation_consulting'
      }
    },
    {
      label: 'answers a website question with the official URL',
      message: 'Voces tem site?',
      reply: 'Sim: https://www.automationtoyou.com.br/',
      expected: 'https://www.automationtoyou.com.br/'
    },
    {
      label: 'addresses price and operation without inventing a price',
      message: 'Quanto custa e como funciona?',
      reply:
        'O valor depende do escopo. Podemos entender seu processo e explicar como a automacao funciona.',
      expected: 'valor'
    }
  ])('keeps direct mock behavior for $label', async ({ message, reply, expected, memory }) => {
    const fetch = mockOpenRouterFetch(200, {
      model: 'openrouter/free',
      choices: [{ message: { content: JSON.stringify({ ...validDecision, reply }) } }]
    });

    const decision = await new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
      message,
      requestId: crypto.randomUUID(),
      memory
    });
    const requestBody = JSON.parse(String((fetch.mock.calls[0] as any[])[1]?.body));

    expect(decision.reply.toLowerCase()).toContain(expected.toLowerCase());
    expect(String(requestBody.messages[1].content)).toContain(
      `CURRENT USER MESSAGE (respond to this first): ${message}`
    );
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

  it('returns safe response shape when content is missing due to length', async () => {
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
    ).resolves.toMatchObject({
      status: 200,
      model: 'short-output-model',
      contentType: 'string',
      finishReason: 'length',
      choicesLength: 1
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

  it.each([
    ['null', { content: null }],
    ['absent', {}]
  ])('keeps %s message content out of the reply', async (label, message) => {
    mockOpenRouterFetch(200, {
      model: 'content-shape-model',
      choices: [{ message }]
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
    ).resolves.toMatchObject({
      model: 'content-shape-model',
      contentType: label === 'null' ? 'null' : 'undefined'
    });
  });

  it.each([
    ['empty content', ''],
    ['invalid JSON', '{invalid'],
    ['invalid AIDecision schema', JSON.stringify({ reply: 'missing fields' })]
  ])('uses one compatible fallback for %s', async (_label, content) => {
    const fetch = mockOpenRouterFetchSequence(
      {
        model: 'structured/free-model',
        choices: [{ message: { content } }]
      },
      {
        model: 'compatible/free-model',
        choices: [{ message: { content: JSON.stringify(validDecision) } }]
      }
    );

    const decision = await new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
      message: 'Quero automacao',
      requestId: crypto.randomUUID()
    });

    expect(decision).toMatchObject(validDecision);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).response_format).toEqual({
      type: 'json_object'
    });
  });

  it('does not use reasoning as reply content and falls back once', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const fetch = mockOpenRouterFetchSequence(
      {
        model: 'reasoning-only-model',
        choices: [
          { message: { content: null, reasoning: 'internal reasoning must remain private' } }
        ]
      },
      {
        model: 'compatible/free-model',
        choices: [{ message: { content: JSON.stringify(validDecision) } }]
      }
    );

    const decision = await new OpenRouterProvider(
      getConfig({ ...openRouterEnv, LOG_LEVEL: 'info' })
    ).generateReply({ message: 'Quero automacao', requestId: crypto.randomUUID() });

    expect(decision).toMatchObject(validDecision);
    expect(fetch).toHaveBeenCalledTimes(2);
    const logs = infoSpy.mock.calls.flat().join('\n');
    expect(logs).toContain('reasoning_present');
    expect(logs).not.toContain('internal reasoning must remain private');
  });

  it('does not retry a refusal response', async () => {
    const fetch = mockOpenRouterFetch(200, {
      model: 'refusal-model',
      choices: [{ message: { content: null, refusal: 'cannot comply' } }]
    });

    await expect(
      new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
        message: 'Quero automacao',
        requestId: crypto.randomUUID()
      })
    ).rejects.toMatchObject({
      code: 'OPENROUTER_INVALID_RESPONSE',
      metadata: { reason: 'refusal' }
    });
    expect(fetch).toHaveBeenCalledTimes(1);
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
    ).rejects.toMatchObject({
      code: 'OPENROUTER_INVALID_RESPONSE',
      metadata: { reason: 'schema_validation_failed' }
    });
    expect(fetch).toHaveBeenCalledTimes(2);
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
    ).rejects.toMatchObject({ code: 'OPENROUTER_INVALID_RESPONSE' });
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
    ).rejects.toMatchObject({ code: 'OPENROUTER_INVALID_RESPONSE' });
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
    ).rejects.toMatchObject({ code: 'OPENROUTER_INVALID_RESPONSE' });
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
    ).rejects.toMatchObject({ code: 'OPENROUTER_INVALID_RESPONSE' });
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

  it('falls back when the structured OpenRouter response body is malformed', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{invalid', { status: 200, headers: { 'content-type': 'application/json' } })
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

    expect(decision).toMatchObject(validDecision);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).response_format).toEqual({
      type: 'json_object'
    });
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

    const decision = await new OpenRouterProvider(
      getConfig({ ...openRouterEnv, OPENAI_MAX_OUTPUT_TOKENS: '1200' })
    ).generateReply({ message: 'Oi', requestId: crypto.randomUUID() });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).max_tokens).toBe(1200);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).max_tokens).toBe(1200);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).response_format).toEqual({
      type: 'json_object'
    });
    expect(decision.reply).toContain('ATY');
  });

  it('returns a terminal truncation error after two truncated responses', async () => {
    const fetch = mockOpenRouterFetchSequence(
      {
        model: 'structured/free-model',
        choices: [{ finish_reason: 'length', message: { content: '' } }]
      },
      {
        model: 'compatible/free-model',
        choices: [{ finish_reason: 'length', message: { content: '' } }]
      }
    );

    await expect(
      new OpenRouterProvider(
        getConfig({ ...openRouterEnv, OPENAI_MAX_OUTPUT_TOKENS: '1200' })
      ).generateReply({ message: 'Oi', requestId: crypto.randomUUID() })
    ).rejects.toMatchObject({
      code: 'OPENROUTER_INVALID_RESPONSE',
      metadata: { reason: 'truncated_response' }
    });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('logs safe response shape and token usage without model content', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    mockOpenRouterFetch(200, {
      model: 'resolved/free-model',
      usage: { prompt_tokens: 321, completion_tokens: 123, total_tokens: 444 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(validDecision) } }]
    });

    await new OpenRouterProvider(getConfig({ ...openRouterEnv, LOG_LEVEL: 'info' })).generateReply({
      message: 'mensagem privada do cliente',
      requestId: crypto.randomUUID()
    });

    const shapeLog = infoSpy.mock.calls
      .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .find((entry) => entry.event === 'ai.response.shape');
    expect(shapeLog).toMatchObject({
      requested_model: 'openrouter/free',
      resolved_model: 'resolved/free-model',
      finish_reason: 'stop',
      content_present: true,
      content_type: 'string',
      fallback_attempt: 0,
      usage_prompt_tokens: 321,
      usage_completion_tokens: 123,
      usage_total_tokens: 444
    });
    expect(JSON.stringify(shapeLog)).not.toContain('mensagem privada do cliente');
    expect(JSON.stringify(shapeLog)).not.toContain(validDecision.reply);
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
    ).rejects.toMatchObject({
      code: 'OPENROUTER_INVALID_RESPONSE',
      metadata: { reason: 'schema_validation_failed' }
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never writes API keys to logs', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockOpenRouterFetch(200, {
      choices: [{ message: { content: JSON.stringify({ reply: 'missing fields' }) } }]
    });

    await expect(
      new OpenRouterProvider(getConfig(openRouterEnv)).generateReply({
        message: 'mensagem privada do cliente',
        requestId: crypto.randomUUID()
      })
    ).rejects.toMatchObject({ code: 'OPENROUTER_INVALID_RESPONSE' });

    const logs = [...infoSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .join('\n');
    expect(logs).not.toContain('test-key');
    expect(logs).not.toContain('mensagem privada do cliente');
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
    ).rejects.toMatchObject({ code: 'OPENROUTER_INVALID_RESPONSE' });

    expect(warnSpy.mock.calls.flat().join('\n')).not.toContain('ai.debug.invalid_response');
  });

  it('logs only safe response shape metadata when AI_DEBUG_RESPONSE=true in local env', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
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
    ).rejects.toMatchObject({ code: 'OPENROUTER_INVALID_RESPONSE' });

    const logs = [...infoSpy.mock.calls, ...warnSpy.mock.calls].flat().join('\n');
    expect(logs).toContain('ai.response.shape');
    expect(logs).toContain('resolved/free-model');
    expect(logs).not.toContain('should_reply');
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
    ).rejects.toMatchObject({ code: 'OPENROUTER_INVALID_RESPONSE' });

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

function mockOpenRouterFetchSequence(...bodies: unknown[]) {
  const fetch = vi.fn();
  for (const body of bodies) {
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
  }
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
