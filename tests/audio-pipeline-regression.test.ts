import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessagesRepository } from '../src/repositories/messages.repository';
import { WebhookEventsRepository } from '../src/repositories/webhook-events.repository';
import { ContactsRepository } from '../src/repositories/contacts.repository';
import { ConversationsRepository } from '../src/repositories/conversations.repository';
import { MemoryRepository } from '../src/repositories/memory.repository';
import { LeadsRepository } from '../src/repositories/leads.repository';
import { HandoffsRepository } from '../src/repositories/handoffs.repository';
import { ErrorsRepository } from '../src/repositories/errors.repository';
import { AiCoordinator } from '../src/services/ai-coordinator.service';
import { WebhookService } from '../src/services/webhook.service';
import { createLogger } from '../src/lib/logger';
import type { AIDecision } from '../src/schemas/ai.schemas';
import type { Env } from '../src/types/env';
import type { NormalizedUazapiInboundMessage } from '../src/integrations/uazapi/types';

const transcript =
  'Meu nome é Lucas Ferreira, tenho uma clínica e minha funcionária demora para responder o WhatsApp.';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Persistência da transcrição de áudio', () => {
  it('mantém provider=uazapi e grava os metadados Groq na mesma mensagem', async () => {
    const row = {
      provider: 'uazapi',
      provider_message_id: 'audio-1',
      direction: 'inbound',
      content: '',
      transcription_provider: null as string | null,
      transcription_model: null as string | null,
      transcription_status: 'pending'
    };
    const db = updateOnlyD1(row, 1);
    const repository = new MessagesRepository(db);

    await repository.updateInboundTranscription({
      providerMessageId: 'audio-1',
      content: transcript,
      transcriptionProvider: 'groq',
      transcriptionModel: 'whisper-large-v3-turbo',
      now: new Date().toISOString()
    });

    expect(row).toEqual({
      provider: 'uazapi',
      provider_message_id: 'audio-1',
      direction: 'inbound',
      content: transcript,
      transcription_provider: 'groq',
      transcription_model: 'whisper-large-v3-turbo',
      transcription_status: 'completed'
    });
    expect(db.lastChanges()).toBe(1);
  });

  it('rejeita explicitamente update de transcrição com zero linhas', async () => {
    const repository = new MessagesRepository(updateOnlyD1(undefined, 0));

    await expect(
      repository.updateInboundTranscription({
        providerMessageId: 'inexistente',
        content: transcript,
        transcriptionProvider: 'groq',
        transcriptionModel: 'whisper-large-v3-turbo',
        now: new Date().toISOString()
      })
    ).rejects.toMatchObject({ code: 'AUDIO_TRANSCRIPTION_PERSISTENCE_ERROR' });
  });
});

describe('Idempotência do pipeline de áudio', () => {
  it('reutiliza uma transcrição completed sem resolver mídia ou chamar Whisper', async () => {
    const env = audioEnv();
    vi.spyOn(MessagesRepository.prototype, 'getInboundTranscription').mockResolvedValue({
      content: transcript,
      transcription_status: 'completed',
      transcription_provider: 'groq',
      transcription_model: 'whisper-large-v3-turbo'
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const service = new WebhookService(env, {
      outboundSender: { sendText: vi.fn() },
      alertSender: { sendText: vi.fn() }
    });

    const result = await (service as any).prepareAudioInbound(
      normalizedAudio(),
      createLogger(env, 'reuse-request'),
      'reuse-request',
      { contactId: 'contact-1', conversationId: 'conversation-1', aiEnabled: true }
    );

    expect(result.inbound.text).toBe(transcript);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('transcreve uma vez, persiste, reutiliza no buffer e preserva dedup', async () => {
    const state = {
      content: '',
      status: 'pending',
      transcriptionProvider: null as string | null,
      transcriptionModel: null as string | null
    };
    let claimCount = 0;
    const claim = vi
      .spyOn(WebhookEventsRepository.prototype, 'claim')
      .mockImplementation(async () =>
        claimCount++ === 0
          ? { status: 'claimed', eventId: 'event-1' }
          : { status: 'processed', eventId: 'event-1' }
      );
    vi.spyOn(WebhookEventsRepository.prototype, 'markProcessed').mockResolvedValue();
    vi.spyOn(ContactsRepository.prototype, 'upsert').mockResolvedValue({
      id: 'contact-1',
      phone: '5511999999999',
      name: null,
      email: null,
      company: null,
      segment: null,
      ai_enabled: 1
    });
    vi.spyOn(ContactsRepository.prototype, 'mergeProfile').mockResolvedValue();
    vi.spyOn(ConversationsRepository.prototype, 'getOrCreate').mockResolvedValue({
      id: 'conversation-1',
      contact_id: 'contact-1',
      status: 'open'
    });
    vi.spyOn(MessagesRepository.prototype, 'create').mockImplementation(async (input) => {
      if (input.direction === 'inbound') {
        state.content = input.content;
        state.status = input.transcriptionStatus ?? 'pending';
      }
    });
    vi.spyOn(MessagesRepository.prototype, 'getInboundTranscription').mockImplementation(
      async () => ({
        content: state.content,
        transcription_status: state.status,
        transcription_provider: state.transcriptionProvider,
        transcription_model: state.transcriptionModel
      })
    );
    vi.spyOn(MessagesRepository.prototype, 'updateTranscriptionStatus').mockImplementation(
      async (_messageId, status) => {
        state.status = status;
      }
    );
    vi.spyOn(MessagesRepository.prototype, 'updateInboundTranscription').mockImplementation(
      async (input) => {
        state.content = input.content;
        state.transcriptionProvider = input.transcriptionProvider;
        state.transcriptionModel = input.transcriptionModel;
        state.status = 'completed';
      }
    );
    vi.spyOn(MessagesRepository.prototype, 'recent').mockResolvedValue([]);
    vi.spyOn(MemoryRepository.prototype, 'get').mockResolvedValue(undefined);
    vi.spyOn(MemoryRepository.prototype, 'merge').mockResolvedValue(undefined as any);
    vi.spyOn(LeadsRepository.prototype, 'merge').mockResolvedValue(undefined as any);
    vi.spyOn(HandoffsRepository.prototype, 'hasBlocking').mockResolvedValue(false);
    vi.spyOn(ErrorsRepository.prototype, 'create').mockResolvedValue(undefined as any);
    vi.spyOn(AiCoordinator.prototype, 'configured', 'get').mockReturnValue(true);
    vi.spyOn(AiCoordinator.prototype, 'waitForConversation').mockImplementation(
      async (_conversationId, _logger, callback) => callback()
    );
    vi.spyOn(AiCoordinator.prototype, 'getInboundBatch').mockImplementation(async () => [
      {
        id: 'db-message-1',
        provider_message_id: 'provider-audio-1',
        content: state.content,
        source_type: 'audio',
        transcription_status: state.status,
        created_at: new Date().toISOString()
      }
    ]);
    vi.spyOn(AiCoordinator.prototype, 'markBatchProcessed').mockResolvedValue();
    vi.spyOn(AiCoordinator.prototype, 'withGroqRateLimit').mockImplementation(
      async (_logger, callback) => callback()
    );

    let mediaResolverCalls = 0;
    let mediaDownloadCalls = 0;
    let whisperCalls = 0;
    let aiCalls = 0;
    const decision = salesDecision();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/message/download')) {
          mediaResolverCalls += 1;
          return json({ fileURL: 'https://media.test/voice.mp3', mimetype: 'audio/mpeg' });
        }
        if (url === 'https://media.test/voice.mp3') {
          mediaDownloadCalls += 1;
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'audio/mpeg' }
          });
        }
        if (url.endsWith('/audio/transcriptions')) {
          whisperCalls += 1;
          return json({ text: transcript });
        }
        if (url.endsWith('/chat/completions')) {
          aiCalls += 1;
          return json({
            model: 'openai/gpt-oss-20b',
            choices: [{ message: { content: JSON.stringify(decision) }, finish_reason: 'stop' }]
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      })
    );
    const outbound = {
      sendText: vi.fn(async () => ({ status: 200, provider: 'uazapi' as const }))
    };
    const observed: AIDecision[] = [];
    const service = new WebhookService(audioEnv(), {
      outboundSender: outbound,
      alertSender: { sendText: vi.fn(async () => ({ status: 200 })) },
      decisionObserver: (value) => observed.push(value)
    });
    const invoke = () =>
      service.captureUazapiEvent(
        new Request('https://worker.test/webhooks/uazapi', {
          method: 'POST',
          body: JSON.stringify(audioPayload())
        }),
        { requestId: crypto.randomUUID(), startedAt: Date.now() }
      );

    const first = await invoke();
    const second = await invoke();

    expect(first.status).toBe('received');
    expect(second.status).toBe('duplicate');
    expect(claim).toHaveBeenCalledTimes(2);
    expect(mediaResolverCalls).toBe(1);
    expect(mediaDownloadCalls).toBe(1);
    expect(whisperCalls).toBe(1);
    expect(aiCalls).toBe(1);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      should_reply: true,
      lead_patch: {
        name: 'Lucas Ferreira',
        segment: 'clínica',
        main_pain: expect.stringMatching(/demora/i)
      }
    });
    expect(state).toEqual({
      content: transcript,
      status: 'completed',
      transcriptionProvider: 'groq',
      transcriptionModel: 'whisper-large-v3-turbo'
    });
    expect(outbound.sendText).toHaveBeenCalledOnce();
  });
});

function audioEnv(): Env {
  return {
    DB: {} as D1Database,
    APP_ENV: 'local',
    AI_MODE: 'groq',
    GROQ_API_KEY: 'test-groq-key',
    GROQ_MODEL: 'openai/gpt-oss-20b',
    GROQ_BASE_URL: 'https://api.groq.com/openai/v1',
    GROQ_TRANSCRIPTION_ENABLED: 'true',
    GROQ_TRANSCRIPTION_MODEL: 'whisper-large-v3-turbo',
    GROQ_TRANSCRIPTION_LANGUAGE: 'pt',
    UAZAPI_BASE_URL: 'https://uazapi.test',
    UAZAPI_TOKEN: 'test-uazapi-token',
    UAZAPI_OUTBOUND_ENABLED: 'false',
    INBOUND_AUTOREPLY_ENABLED: 'true',
    WHATSAPP_INBOUND_BUFFER_MS: '1',
    WEBHOOK_AUTH_MODE: 'off',
    LOG_LEVEL: 'error',
    LOG_MESSAGE_CONTENT: 'false',
    TEST_ERROR_ALERT_ENABLED: 'false'
  };
}

function audioPayload() {
  return {
    EventType: 'messages',
    instanceName: 'TEST',
    message: {
      id: 'uazapi-audio-1',
      messageid: 'provider-audio-1',
      type: 'media',
      chatid: '5511999999999@s.whatsapp.net',
      sender_pn: '5511999999999',
      fromMe: false,
      wasSentByApi: false,
      isGroup: false,
      content: { mimetype: 'audio/ogg; codecs=opus' }
    }
  };
}

function normalizedAudio(): NormalizedUazapiInboundMessage {
  return {
    provider: 'uazapi',
    event: 'messages',
    messageId: 'provider-audio-1',
    mediaDownloadId: 'uazapi-audio-1',
    phone: '5511999999999',
    text: '',
    isAudio: true,
    audioMediaStatus: 'unconfirmed',
    fromMe: false,
    wasSentByApi: false,
    isGroup: false,
    messageType: 'media'
  };
}

function salesDecision(): AIDecision {
  return {
    should_reply: true,
    reply: 'Entendi, Lucas. Quantas mensagens vocês recebem por dia?',
    intent: 'sales_qualification',
    confidence: 0.95,
    handoff_requested: false,
    handoff_reason: null,
    lead_patch: {
      name: 'Lucas Ferreira',
      company: null,
      segment: 'clínica',
      service_interest: 'automação de WhatsApp',
      budget_status: null,
      urgency: null,
      email: null,
      role: null,
      current_process: null,
      main_pain: 'demora para responder clientes',
      desired_outcome: null,
      volume: null,
      meeting_interest: null,
      preferred_meeting_date: null,
      preferred_meeting_time: null
    },
    memory_patch: {
      summary: 'Lucas Ferreira tem uma clínica e enfrenta demora no atendimento pelo WhatsApp.',
      facts_to_add: ['Nome: Lucas Ferreira', 'Segmento: clínica'],
      open_loops: ['Volume diário de mensagens']
    }
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function updateOnlyD1(
  row:
    | {
        provider: string;
        provider_message_id: string;
        direction: string;
        content: string;
        transcription_provider: string | null;
        transcription_model: string | null;
        transcription_status: string;
      }
    | undefined,
  forcedChanges: number
) {
  let changes = 0;
  const db = {
    prepare: () => ({
      bind: (
        content: string,
        transcriptionProvider: string,
        transcriptionModel: string,
        messageProvider: string,
        providerMessageId: string
      ) => ({
        run: async () => {
          changes =
            forcedChanges > 0 &&
            row?.provider === messageProvider &&
            row.provider_message_id === providerMessageId &&
            row.direction === 'inbound'
              ? 1
              : 0;
          if (changes && row) {
            row.content = content;
            row.transcription_provider = transcriptionProvider;
            row.transcription_model = transcriptionModel;
            row.transcription_status = 'completed';
          }
          return { meta: { changes } };
        }
      })
    }),
    lastChanges: () => changes
  };
  return db as unknown as D1Database & { lastChanges(): number };
}
