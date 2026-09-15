import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, testEnv } from './helpers';
import realWebhookFixture from './fixtures/uazapi.real-message.json';
import { WebhookEventsRepository } from '../src/repositories/webhook-events.repository';

describe('Deduplication', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('prevents duplicate processing when webhook event already exists', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/chat/completions')) {
        return new Response(
          JSON.stringify({
            model: 'resolved/free-model',
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    should_reply: true,
                    reply: 'Resposta local validada.',
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
                    memory_patch: { summary: null, facts_to_add: [], open_loops: [] }
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/send/text')) {
        return new Response(JSON.stringify({ ok: true, id: 'provider-message-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetch);

    // first call: not duplicate
    const findSpy = vi
      .spyOn(WebhookEventsRepository.prototype, 'findByProviderEventId')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const env = {
      ...testEnv,
      APP_ENV: 'local',
      AI_MODE: 'openrouter',
      OPENROUTER_API_KEY: 'test-key',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENROUTER_MODEL: 'openrouter/free',
      UAZAPI_BASE_URL: 'https://uazapi.test',
      UAZAPI_TOKEN: 'test-token',
      UAZAPI_OUTBOUND_ENABLED: 'true',
      LOCAL_INBOUND_AUTOREPLY_ENABLED: 'true'
    };

    const response1 = await request(
      '/webhooks/uazapi',
      {
        method: 'POST',
        body: JSON.stringify(realWebhookFixture),
        headers: { 'content-type': 'application/json' }
      },
      env
    );
    expect(response1.status).toBe(202);
    expect(fetch).toHaveBeenCalled();

    // second call: repository reports existing provider event id -> duplicate
    const response2 = await request(
      '/webhooks/uazapi',
      {
        method: 'POST',
        body: JSON.stringify(realWebhookFixture),
        headers: { 'content-type': 'application/json' }
      },
      env
    );
    expect(response2.status).toBe(202);
    const body = (await response2.json()) as { data: { status: string } };
    expect(body.data.status).toBe('duplicate');
    // fetch should not be called again for AI / outbound
    expect(fetch).toHaveBeenCalledTimes(2);
    findSpy.mockRestore();
  });
});
