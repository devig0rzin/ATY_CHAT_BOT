import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, testEnv } from './helpers';
import { ContactsRepository } from '../src/repositories/contacts.repository';
import { ConversationsRepository } from '../src/repositories/conversations.repository';
import { MessagesRepository } from '../src/repositories/messages.repository';
import { MemoryRepository } from '../src/repositories/memory.repository';

describe('Memory integration (local, mocked repos)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('builds long-term memory across multiple messages', async () => {
    const phone = '5511999999999';
    const env = {
      ...testEnv,
      APP_ENV: 'local',
      LOCAL_INBOUND_AUTOREPLY_ENABLED: 'true',
      AI_MODE: 'openrouter',
      OPENROUTER_API_KEY: 'test'
    };

    const savedMessages: any[] = [];

    vi.spyOn(ContactsRepository.prototype, 'upsert').mockResolvedValue({
      id: 'contact-1',
      phone,
      name: 'Lucas',
      company: null,
      segment: null,
      ai_enabled: 1
    } as any);
    vi.spyOn(ConversationsRepository.prototype, 'getOrCreate').mockResolvedValue({
      id: 'conv-1',
      contact_id: 'contact-1',
      status: 'open'
    } as any);
    vi.spyOn(MessagesRepository.prototype, 'create').mockImplementation(async (input: any) => {
      savedMessages.push(input);
    });

    const memoryMerge = vi
      .spyOn(MemoryRepository.prototype, 'merge')
      .mockResolvedValue(undefined as any);

    const fetch = vi.fn(async (url: string) => {
      // AI provider
      if (url.endsWith('/chat/completions')) {
        return new Response(
          JSON.stringify({
            model: 'resolved/free-model',
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    should_reply: true,
                    reply: 'Resposta.',
                    intent: 'automation_consulting',
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
                      facts_to_add: ['Possui uma clínica', 'Usa WhatsApp'],
                      open_loops: ['Sem número de atendimentos']
                    }
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      // UAZAPI outbound
      if (url.endsWith('/send/text')) {
        return new Response(JSON.stringify({ ok: true, id: 'provider-message-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch as any);

    // message 1
    await request(
      '/webhooks/uazapi',
      {
        method: 'POST',
        body: JSON.stringify({
          EventType: 'messages',
          message: { messageid: 'm1', sender_pn: phone, text: 'Meu nome é Lucas' }
        }),
        headers: { 'content-type': 'application/json' }
      },
      env
    );
    // message 2
    await request(
      '/webhooks/uazapi',
      {
        method: 'POST',
        body: JSON.stringify({
          EventType: 'messages',
          message: { messageid: 'm2', sender_pn: phone, text: 'Tenho uma clínica' }
        }),
        headers: { 'content-type': 'application/json' }
      },
      env
    );
    // message 3
    await request(
      '/webhooks/uazapi',
      {
        method: 'POST',
        body: JSON.stringify({
          EventType: 'messages',
          message: {
            messageid: 'm3',
            sender_pn: phone,
            text: 'Quero automatizar o atendimento pelo WhatsApp'
          }
        }),
        headers: { 'content-type': 'application/json' }
      },
      env
    );

    expect(savedMessages.length).toBeGreaterThanOrEqual(3);
    expect(memoryMerge).toHaveBeenCalled();
    const lastCall = memoryMerge.mock.calls[memoryMerge.mock.calls.length - 1];
    const [contactId, patch] = lastCall;
    expect(contactId).toBe('contact-1');
    expect(Array.isArray(patch.facts_to_add)).toBe(true);
    expect(patch.facts_to_add.join(' ')).toContain('clínica');
    expect(patch.facts_to_add.join(' ')).toContain('WhatsApp');
  });
});
