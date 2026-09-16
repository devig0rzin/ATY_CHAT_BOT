import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, testEnv } from './helpers';
import realWebhookFixture from './fixtures/uazapi.real-message.json';
import { WebhookEventsRepository } from '../src/repositories/webhook-events.repository';

describe('Webhook event lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['processed', 'duplicate'],
    ['processing', 'processing']
  ] as const)(
    'does not call AI or outbound when a claim is already %s',
    async (claimStatus, status) => {
      vi.spyOn(WebhookEventsRepository.prototype, 'claim').mockResolvedValue({
        status: claimStatus,
        eventId: 'event-1'
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const response = await postWebhook();
      const body = (await response.json()) as { data: { status: string } };

      expect(response.status).toBe(202);
      expect(body.data.status).toBe(status);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it.each(['received', 'failed'] as const)(
    'reclaims a %s event and completes it once',
    async () => {
      const claim = vi
        .spyOn(WebhookEventsRepository.prototype, 'claim')
        .mockResolvedValue({ status: 'claimed', eventId: 'event-1' });
      const processed = vi.spyOn(WebhookEventsRepository.prototype, 'markProcessed');
      const fetch = mockSuccessfulProviders();

      const response = await postWebhook();

      expect(response.status).toBe(202);
      expect(claim).toHaveBeenCalledOnce();
      expect(processed).toHaveBeenCalledWith('event-1', expect.any(String));
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  );

  it('marks the event failed when OpenRouter fails', async () => {
    vi.spyOn(WebhookEventsRepository.prototype, 'claim').mockResolvedValue({
      status: 'claimed',
      eventId: 'event-1'
    });
    const failed = vi.spyOn(WebhookEventsRepository.prototype, 'markFailed');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', { status: 502, headers: { 'content-type': 'application/json' } })
      )
    );

    const response = await postWebhook();
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(502);
    expect(body.error.code).toBe('OPENROUTER_UPSTREAM_ERROR');
    expect(failed).toHaveBeenCalledWith('event-1', 'OPENROUTER_UPSTREAM_ERROR');
  });

  it('marks the event failed when UAZAPI fails', async () => {
    vi.spyOn(WebhookEventsRepository.prototype, 'claim').mockResolvedValue({
      status: 'claimed',
      eventId: 'event-1'
    });
    const failed = vi.spyOn(WebhookEventsRepository.prototype, 'markFailed');
    const success = mockSuccessfulProviders();
    success.mockResolvedValueOnce(
      new Response(
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
      )
    );
    success.mockResolvedValueOnce(
      new Response('{}', { status: 502, headers: { 'content-type': 'application/json' } })
    );

    const response = await postWebhook();
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(502);
    expect(body.error.code).toBe('UAZAPI_UPSTREAM_ERROR');
    expect(failed).toHaveBeenCalledWith('event-1', 'UAZAPI_UPSTREAM_ERROR');
  });

  it('processes once and sends once after a compatible OpenRouter fallback', async () => {
    vi.spyOn(WebhookEventsRepository.prototype, 'claim').mockResolvedValue({
      status: 'claimed',
      eventId: 'event-1'
    });
    const processed = vi.spyOn(WebhookEventsRepository.prototype, 'markProcessed');
    let chatRequests = 0;
    let outboundRequests = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/chat/completions')) {
        chatRequests += 1;
        return new Response(
          JSON.stringify(
            chatRequests === 1
              ? { model: 'structured/free-model', choices: [{ message: { content: '{invalid' } }] }
              : validOpenRouterResponse()
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.endsWith('/send/text')) {
        outboundRequests += 1;
        return new Response(JSON.stringify({ ok: true, id: 'provider-message-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetch);

    const response = await postWebhook();

    expect(response.status).toBe(202);
    expect(chatRequests).toBe(2);
    expect(outboundRequests).toBe(1);
    expect(processed).toHaveBeenCalledWith('event-1', expect.any(String));
  });

  it('marks the event failed without outbound when both OpenRouter responses are invalid', async () => {
    vi.spyOn(WebhookEventsRepository.prototype, 'claim').mockResolvedValue({
      status: 'claimed',
      eventId: 'event-1'
    });
    const failed = vi.spyOn(WebhookEventsRepository.prototype, 'markFailed');
    let chatRequests = 0;
    let outboundRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/chat/completions')) {
          chatRequests += 1;
          return new Response(
            JSON.stringify({
              model: 'invalid/free-model',
              choices: [{ message: { content: JSON.stringify({ reply: 'missing fields' }) } }]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (url.endsWith('/send/text')) outboundRequests += 1;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      })
    );

    const response = await postWebhook();
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(502);
    expect(body.error.code).toBe('OPENROUTER_INVALID_RESPONSE');
    expect(chatRequests).toBe(2);
    expect(outboundRequests).toBe(0);
    expect(failed).toHaveBeenCalledWith('event-1', 'OPENROUTER_INVALID_RESPONSE');
  });
});

function postWebhook() {
  return request(
    '/webhooks/uazapi',
    {
      method: 'POST',
      body: JSON.stringify(realWebhookFixture),
      headers: { 'content-type': 'application/json' }
    },
    {
      ...testEnv,
      APP_ENV: 'production',
      AI_MODE: 'openrouter',
      OPENROUTER_API_KEY: 'test-key',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      UAZAPI_BASE_URL: 'https://uazapi.test',
      UAZAPI_TOKEN: 'test-token',
      UAZAPI_OUTBOUND_ENABLED: 'true',
      INBOUND_AUTOREPLY_ENABLED: 'true'
    }
  );
}

function mockSuccessfulProviders() {
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
    return new Response(JSON.stringify({ ok: true, id: 'provider-message-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function validOpenRouterResponse() {
  return {
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
  };
}
