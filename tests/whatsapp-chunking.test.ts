import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContactsRepository } from '../src/repositories/contacts.repository';
import { ConversationsRepository } from '../src/repositories/conversations.repository';
import { ErrorsRepository } from '../src/repositories/errors.repository';
import { MessagesRepository } from '../src/repositories/messages.repository';
import { WebhookEventsRepository } from '../src/repositories/webhook-events.repository';
import { request, testEnv } from './helpers';

const phone = '5511999999999';
const longReply = [
  'Para uma clinica odontologica, o bot pode atender pacientes no WhatsApp e responder duvidas frequentes.',
  'Ele tambem faz uma triagem inicial, entende o assunto e encaminha cada pessoa para a equipe certa.',
  'Quando necessario, ajuda com o agendamento e reduz bastante o trabalho manual da recepcao.',
  'Assim a equipe ganha tempo para cuidar dos atendimentos que realmente precisam de uma pessoa.'
].join(' ');

describe('WhatsApp autoreply chunking', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends and persists two natural chunks only after each UAZAPI confirmation', async () => {
    const savedMessages: Array<{ direction: string; content: string; providerMessageId?: string }> =
      [];
    mockPersistentConversation(savedMessages);
    const fetch = mockProviders([200, 200]);

    const response = await postWebhook();
    const body = (await response.json()) as {
      data: { autoreply: { sent: boolean; chunks_sent: number; chunks_total: number } };
    };

    expect(response.status).toBe(202);
    expect(body.data.autoreply).toMatchObject({ sent: true, chunks_sent: 2, chunks_total: 2 });
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/send/text'))).toHaveLength(2);
    const outbound = savedMessages.filter((message) => message.direction === 'outbound');
    expect(outbound.map((message) => message.content).join(' ')).toBe(longReply);
    expect(outbound).toHaveLength(2);
    expect(outbound.every((message) => message.providerMessageId)).toBe(true);
  });

  it('does not retry the first chunk when the second UAZAPI send fails', async () => {
    const savedMessages: Array<{ direction: string; content: string; providerMessageId?: string }> =
      [];
    mockPersistentConversation(savedMessages);
    const errors = vi.spyOn(ErrorsRepository.prototype, 'create').mockResolvedValue(undefined);
    const processed = vi.spyOn(WebhookEventsRepository.prototype, 'markProcessed');
    const failed = vi.spyOn(WebhookEventsRepository.prototype, 'markFailed');
    const fetch = mockProviders([200, 502]);

    const response = await postWebhook();
    const body = (await response.json()) as {
      data: {
        autoreply: {
          sent: boolean;
          partial: boolean;
          chunks_sent: number;
          chunks_total: number;
        };
      };
    };

    expect(response.status).toBe(202);
    expect(body.data.autoreply).toMatchObject({
      sent: true,
      partial: true,
      chunks_sent: 1,
      chunks_total: 2
    });
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/send/text'))).toHaveLength(2);
    expect(savedMessages.filter((message) => message.direction === 'outbound')).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'UAZAPI_PARTIAL_OUTBOUND_FAILURE' })
    );
    expect(processed).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
  });

  it('uses one safe outbound fallback when the AI returns a silent decision', async () => {
    const savedMessages: Array<{ direction: string; content: string; providerMessageId?: string }> =
      [];
    mockPersistentConversation(savedMessages);
    const fetch = mockProviders([200], '', false);

    const response = await postWebhook();
    const body = (await response.json()) as {
      data: { autoreply: { sent: boolean; chunks_sent: number; chunks_total: number } };
    };

    expect(response.status).toBe(202);
    expect(body.data.autoreply).toMatchObject({ sent: true, chunks_sent: 1, chunks_total: 1 });
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/send/text'))).toHaveLength(1);
    expect(savedMessages.filter((message) => message.direction === 'outbound')).toEqual([
      expect.objectContaining({ content: expect.any(String) })
    ]);
    expect(savedMessages.find((message) => message.direction === 'outbound')?.content).not.toBe('');
  });
});

function mockPersistentConversation(
  savedMessages: Array<{ direction: string; content: string; providerMessageId?: string }>
) {
  vi.spyOn(ContactsRepository.prototype, 'upsert').mockResolvedValue({
    id: 'contact-1',
    phone,
    name: 'Lucas',
    company: 'Clinica',
    segment: 'odontologia',
    ai_enabled: 1
  } as never);
  vi.spyOn(ConversationsRepository.prototype, 'getOrCreate').mockResolvedValue({
    id: 'conversation-1',
    contact_id: 'contact-1',
    status: 'open'
  } as never);
  vi.spyOn(MessagesRepository.prototype, 'create').mockImplementation(async (input) => {
    savedMessages.push({
      direction: input.direction,
      content: input.content,
      providerMessageId: input.providerMessageId
    });
  });
}

function mockProviders(outboundStatuses: number[], reply = longReply, shouldReply = true) {
  let outboundIndex = 0;
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/chat/completions')) {
      return new Response(
        JSON.stringify({
          model: 'resolved/free-model',
          choices: [{ message: { content: JSON.stringify(validDecision(reply, shouldReply)) } }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    const status = outboundStatuses[outboundIndex++];
    return new Response(
      JSON.stringify({ ok: status === 200, id: `provider-message-${outboundIndex}` }),
      {
        status,
        headers: { 'content-type': 'application/json' }
      }
    );
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function postWebhook() {
  return request(
    '/webhooks/uazapi',
    {
      method: 'POST',
      body: JSON.stringify({
        EventType: 'messages',
        message: { messageid: crypto.randomUUID(), sender_pn: phone, text: 'Como funciona?' }
      }),
      headers: { 'content-type': 'application/json' }
    },
    {
      ...testEnv,
      APP_ENV: 'production',
      AI_MODE: 'openrouter',
      OPENROUTER_API_KEY: 'test-key',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENROUTER_MODEL: 'openrouter/free',
      UAZAPI_BASE_URL: 'https://uazapi.test',
      UAZAPI_TOKEN: 'test-token',
      UAZAPI_OUTBOUND_ENABLED: 'true',
      INBOUND_AUTOREPLY_ENABLED: 'true',
      WHATSAPP_REPLY_SOFT_LIMIT: '280',
      WHATSAPP_REPLY_MAX_CHUNKS: '2'
    }
  );
}

function validDecision(reply: string, shouldReply = true) {
  return {
    should_reply: shouldReply,
    reply,
    intent: 'automation_consulting',
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
    memory_patch: { summary: null, facts_to_add: [], open_loops: [] }
  };
}
