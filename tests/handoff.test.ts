import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, testEnv } from './helpers';
import { ContactsRepository } from '../src/repositories/contacts.repository';
import { HandoffsRepository } from '../src/repositories/handoffs.repository';
import { ConversationsRepository } from '../src/repositories/conversations.repository';
import { MessagesRepository } from '../src/repositories/messages.repository';

describe('Human handoff', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not call AI when ai_enabled=0 and resumes after re-enable', async () => {
    const phone = '5511999999999';
    const env = {
      ...testEnv,
      APP_ENV: 'local',
      LOCAL_INBOUND_AUTOREPLY_ENABLED: 'true',
      AI_MODE: 'openrouter',
      OPENROUTER_API_KEY: 'test',
      OPENROUTER_BASE_URL: 'https://openrouter.test/v1',
      UAZAPI_BASE_URL: 'https://uazapi.test',
      UAZAPI_TOKEN: 'test-token',
      UAZAPI_OUTBOUND_ENABLED: 'true'
    };

    // initial contact has ai_enabled = 0
    vi.spyOn(ContactsRepository.prototype, 'upsert').mockResolvedValue({
      id: 'contact-1',
      phone,
      name: 'Test',
      company: null,
      segment: null,
      ai_enabled: 0
    } as any);
    vi.spyOn(ConversationsRepository.prototype, 'getOrCreate').mockResolvedValue({
      id: 'conversation-1',
      contact_id: 'contact-1',
      status: 'open'
    } as any);
    vi.spyOn(MessagesRepository.prototype, 'create').mockResolvedValue(undefined);
    vi.spyOn(HandoffsRepository.prototype, 'hasBlocking').mockResolvedValue(false as any);

    const fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetch as any);

    // inbound while ai disabled -> no AI / send
    const res1 = await request(
      '/webhooks/uazapi',
      {
        method: 'POST',
        body: JSON.stringify({
          EventType: 'messages',
          message: { messageid: 'h1', sender_pn: phone, text: 'Oi' }
        }),
        headers: { 'content-type': 'application/json' }
      },
      env
    );
    expect(res1.status).toBe(202);
    expect(fetch).not.toHaveBeenCalled();

    // re-enable AI for next message by changing upsert return
    vi.spyOn(ContactsRepository.prototype, 'upsert').mockResolvedValue({
      id: 'contact-1',
      phone,
      name: 'Test',
      company: null,
      segment: null,
      ai_enabled: 1
    } as any);

    // now AI should be called (we return an AI response then an outbound send)
    const fetch2 = vi.fn(async (url: string) => {
      if (url.endsWith('/chat/completions')) {
        return new Response(
          JSON.stringify({
            model: 'm',
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    should_reply: true,
                    reply: 'Ok',
                    intent: 'x',
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
        return new Response(JSON.stringify({ ok: true, id: 'provider-message-2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch2 as any);

    const res2 = await request(
      '/webhooks/uazapi',
      {
        method: 'POST',
        body: JSON.stringify({
          EventType: 'messages',
          message: { messageid: 'h2', sender_pn: phone, text: 'Oi de novo' }
        }),
        headers: { 'content-type': 'application/json' }
      },
      env
    );
    expect(res2.status).toBe(202);
    expect(fetch2).toHaveBeenCalled();
  });
});
