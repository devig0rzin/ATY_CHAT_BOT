import { WebhookEventsRepository } from '../repositories/webhook-events.repository';
import { ContactsRepository } from '../repositories/contacts.repository';
import { ConversationsRepository } from '../repositories/conversations.repository';
import { MessagesRepository } from '../repositories/messages.repository';
import { MemoryRepository } from '../repositories/memory.repository';
import { LeadsRepository } from '../repositories/leads.repository';
import { HandoffsRepository } from '../repositories/handoffs.repository';
import { ErrorsRepository } from '../repositories/errors.repository';
import { arbitraryJsonSchema } from '../schemas/webhook.schemas';
import { getConfig, isEnvConfigured } from '../config/env';
import { sha256Hex } from '../lib/crypto';
import { AppError, toAppError } from '../lib/errors';
import { createLogger } from '../lib/logger';
import { utcNow } from '../lib/time';
import { splitWhatsAppReply } from '../lib/whatsapp-reply';
import { createAIProvider } from '../integrations/openai/client';
import { createUazapiProvider } from '../integrations/uazapi/client';
import { AudioTranscriptionService } from '../integrations/groq/audio-transcription.service';
import { UazapiMediaResolver, maskMessageId } from '../integrations/uazapi/media-resolver';
import {
  getUazapiAutoreplySkipReason,
  normalizeUazapiEvent
} from '../integrations/uazapi/normalizer';
import type { Env } from '../types/env';
import type { RequestContext } from '../types/api';
import type { NormalizedUazapiInboundMessage } from '../integrations/uazapi/types';
import type { UazapiSendTextResult } from '../integrations/uazapi/provider';
import type { UazapiProvider } from '../integrations/uazapi/provider';
import type { AIDecision } from '../schemas/ai.schemas';
import { ErrorAlertService } from './error-alert.service';
import type { ErrorAlertSender } from './error-alert.service';
import { AiCoordinator } from './ai-coordinator.service';

const maxBodyBytes = 256 * 1024;
const inboundReplyFallback = 'Oi! Recebi sua mensagem. Como posso ajudar?';

export class WebhookService {
  private readonly repository: WebhookEventsRepository;
  private readonly contacts: ContactsRepository;
  private readonly conversations: ConversationsRepository;
  private readonly messages: MessagesRepository;
  private readonly memory: MemoryRepository;
  private readonly leads: LeadsRepository;
  private readonly handoffs: HandoffsRepository;
  private readonly errors: ErrorsRepository;
  private readonly errorAlerts: ErrorAlertService;
  private readonly aiCoordinator: AiCoordinator;
  private readonly outboundSender?: Pick<UazapiProvider, 'sendText'>;
  private readonly decisionObserver?: (decision: AIDecision) => void;

  constructor(
    private readonly env: Env,
    dependencies: {
      outboundSender?: Pick<UazapiProvider, 'sendText'>;
      alertSender?: ErrorAlertSender;
      decisionObserver?: (decision: AIDecision) => void;
    } = {}
  ) {
    this.repository = new WebhookEventsRepository(env.DB);
    this.contacts = new ContactsRepository(env.DB);
    this.conversations = new ConversationsRepository(env.DB);
    this.messages = new MessagesRepository(env.DB);
    this.memory = new MemoryRepository(env.DB);
    this.leads = new LeadsRepository(env.DB);
    this.handoffs = new HandoffsRepository(env.DB);
    this.errors = new ErrorsRepository(env.DB);
    const config = getConfig(env);
    this.errorAlerts = new ErrorAlertService(config, dependencies.alertSender);
    this.aiCoordinator = new AiCoordinator(env.DB, config);
    this.outboundSender = dependencies.outboundSender;
    this.decisionObserver = dependencies.decisionObserver;
  }

  async captureUazapiEvent(request: Request, context: RequestContext) {
    const config = getConfig(this.env);
    const logger = createLogger(this.env, context.requestId);
    logger.warnDiagnostic('uazapi.runtime_env_probe', {
      uazapi_debug_payload_present: isEnvConfigured(this.env.UAZAPI_DEBUG_PAYLOAD),
      uazapi_debug_payload_type: typeof this.env.UAZAPI_DEBUG_PAYLOAD,
      uazapi_debug_payload_value: this.env.UAZAPI_DEBUG_PAYLOAD ?? '',
      ai_mode_present: isEnvConfigured(this.env.AI_MODE),
      log_level_present: isEnvConfigured(this.env.LOG_LEVEL),
      admin_api_key_present: isEnvConfigured(this.env.ADMIN_API_KEY)
    });

    const contentLength = Number(request.headers.get('content-length') ?? '0');
    if (contentLength > maxBodyBytes) {
      throw new AppError({
        code: 'WEBHOOK_INVALID_BODY',
        httpStatus: 413,
        safeMessage: 'Webhook body is too large'
      });
    }

    const rawPayload = await request.text();
    if (new TextEncoder().encode(rawPayload).byteLength > maxBodyBytes) {
      throw new AppError({
        code: 'WEBHOOK_INVALID_BODY',
        httpStatus: 413,
        safeMessage: 'Webhook body is too large'
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawPayload);
    } catch (cause) {
      throw new AppError({
        code: 'WEBHOOK_INVALID_BODY',
        httpStatus: 400,
        safeMessage: 'Webhook body must be valid JSON',
        cause
      });
    }

    const validJson = arbitraryJsonSchema.safeParse(parsed);
    if (!validJson.success) {
      throw new AppError({
        code: 'WEBHOOK_INVALID_BODY',
        httpStatus: 400,
        safeMessage: 'Webhook body must be a JSON value'
      });
    }

    const payloadSha256 = await sha256Hex(rawPayload);
    logger.warnDiagnostic('uazapi.debug_config', {
      debug_payload_configured: isEnvConfigured(this.env.UAZAPI_DEBUG_PAYLOAD),
      debug_payload_resolved: config.UAZAPI_DEBUG_PAYLOAD
    });

    if (config.UAZAPI_DEBUG_PAYLOAD) {
      logger.warnDiagnostic('uazapi.debug_payload', {
        provider: 'uazapi',
        payload_sha256: payloadSha256,
        payload: validJson.data
      });
    }

    const normalizedInbound = normalizeUazapiEvent(validJson.data);
    const receivedAt = utcNow();
    const claim = await this.repository.claim({
      id: crypto.randomUUID(),
      requestId: context.requestId,
      provider: 'uazapi',
      providerEventId: normalizedInbound?.messageId,
      eventType: normalizedInbound?.event,
      payloadSha256,
      payloadJson: rawPayload,
      receivedAt
    });
    if (claim.status === 'processed') {
      logger.info('webhook.duplicate', { provider: 'uazapi', payload_sha256: payloadSha256 });
      return {
        status: 'duplicate',
        provider: 'uazapi',
        captured: true,
        database_configured: this.repository.configured,
        payload_sha256: payloadSha256
      };
    }
    if (claim.status === 'processing') {
      logger.info('webhook.in_progress', { provider: 'uazapi', payload_sha256: payloadSha256 });
      return {
        status: 'processing',
        provider: 'uazapi',
        captured: true,
        database_configured: this.repository.configured,
        payload_sha256: payloadSha256
      };
    }

    logger.info('webhook.captured', {
      provider: 'uazapi',
      duration_ms: Date.now() - context.startedAt,
      database_configured: this.repository.configured,
      payload_sha256: payloadSha256
    });
    logger.info('webhook.claimed', {
      provider: 'uazapi',
      processing_status: 'processing'
    });

    try {
      const persistent = normalizedInbound
        ? await this.persistInbound(normalizedInbound, receivedAt, logger)
        : undefined;
      const autoreply = await this.maybeAutoreply(
        validJson.data,
        normalizedInbound,
        config,
        logger,
        context.requestId,
        persistent
      );
      await this.repository.markProcessed(claim.eventId, utcNow());
      logger.info('webhook.processed', { provider: 'uazapi' });

      return {
        status: 'received',
        provider: 'uazapi',
        captured: true,
        database_configured: this.repository.configured,
        payload_sha256: payloadSha256,
        ...(autoreply ? { autoreply } : {})
      };
    } catch (cause) {
      const error = toAppError(cause);
      await this.markFailed(claim.eventId, error, context.requestId, logger);
      throw error;
    }
  }

  private async maybeAutoreply(
    payload: unknown,
    inbound: NormalizedUazapiInboundMessage | undefined,
    config: ReturnType<typeof getConfig>,
    logger: ReturnType<typeof createLogger>,
    requestId: string,
    persistent?: { contactId: string; conversationId: string; aiEnabled: boolean },
    coordinated = false
  ): Promise<unknown> {
    if (!config.INBOUND_AUTOREPLY_ENABLED) {
      logger.info('uazapi.autoreply.skipped', {
        provider: 'uazapi',
        reason: 'inbound_autoreply_disabled'
      });
      return { sent: false, reason: 'inbound_autoreply_disabled' };
    }

    if (!inbound) {
      const reason = getUazapiAutoreplySkipReason(payload) ?? 'message_not_normalized';
      logger.warn('uazapi.autoreply.skipped', {
        provider: 'uazapi',
        reason
      });
      return { sent: false, reason };
    }

    if (inbound.isAudio && !coordinated) {
      const prepared = await this.prepareAudioInbound(inbound, logger, requestId, persistent);
      if (!prepared.inbound) return prepared.fallback;
      inbound = prepared.inbound;
    }

    if (config.APP_ENV === 'production' && config.AI_MODE === 'mock') {
      logger.error('configuration.invalid', {
        reason: 'production_autoreply_with_mock_ai'
      });
      return { sent: false, reason: 'invalid_configuration' };
    }

    if (
      persistent &&
      (!persistent.aiEnabled || (await this.handoffs.hasBlocking(persistent.contactId)))
    ) {
      logger.info('uazapi.autoreply.skipped', { provider: 'uazapi', reason: 'ai_disabled' });
      return { sent: false, reason: 'ai_disabled' };
    }

    if (
      !coordinated &&
      persistent &&
      inbound &&
      this.aiCoordinator.configured &&
      config.WHATSAPP_INBOUND_BUFFER_MS > 0
    ) {
      logger.info('ai.buffer.started', {
        provider: config.AI_MODE,
        buffer_ms: config.WHATSAPP_INBOUND_BUFFER_MS
      });
      await delay(config.WHATSAPP_INBOUND_BUFFER_MS);
      return this.aiCoordinator.waitForConversation(persistent.conversationId, logger, async () => {
        const batch = await this.aiCoordinator.getInboundBatch(persistent.conversationId);
        if (batch.length === 0) return { sent: false, reason: 'batch_empty' };
        if (batch.length > 1) {
          logger.info('ai.buffer.extended', { provider: config.AI_MODE, batch_size: batch.length });
        }
        logger.info('ai.batch.created', { provider: config.AI_MODE, batch_size: batch.length });
        const latest = batch[batch.length - 1];
        if (
          latest.source_type === 'audio' &&
          (latest.transcription_status !== 'completed' || !latest.content.trim())
        ) {
          throw new AppError({
            code: 'AUDIO_TRANSCRIPTION_PERSISTENCE_ERROR',
            httpStatus: 500,
            safeMessage: 'Buffered audio transcription is not ready'
          });
        }
        if (latest.source_type === 'audio') {
          logger.info('audio.transcription.reused', {
            provider: 'groq',
            masked_message_id: maskMessageId(latest.provider_message_id ?? undefined),
            transcript_length: latest.content.length
          });
        }
        const latestInbound: NormalizedUazapiInboundMessage = {
          ...inbound,
          messageId: latest.provider_message_id ?? inbound.messageId,
          text: latest.content
        };
        const result: unknown = await this.maybeAutoreply(
          payload,
          latestInbound,
          config,
          logger,
          requestId,
          persistent,
          true
        );
        await this.aiCoordinator.markBatchProcessed(persistent.conversationId, batch, utcNow());
        return result;
      });
    }

    logger.info('uazapi.message.normalized', {
      provider: inbound.provider,
      inbound_event: inbound.event,
      message_id: inbound.messageId,
      phone: inbound.phone,
      from_me: inbound.fromMe,
      was_sent_by_api: inbound.wasSentByApi,
      is_group: inbound.isGroup,
      inbound_type: inbound.messageType
    });

    logger.info('uazapi.autoreply.started', {
      provider: 'uazapi',
      inbound_message_id: inbound.messageId
    });

    const memory = persistent ? await this.memory.get(persistent.contactId) : undefined;
    const recent = persistent
      ? await this.messages.recent(persistent.conversationId, config.AI_RECENT_MESSAGE_LIMIT)
      : [];
    logger.info('memory.loaded', {
      provider: 'uazapi',
      has_memory: Boolean(memory),
      recent_count: recent.length
    });
    if (inbound.isAudio) {
      logger.info('audio.coordinator.started', {
        provider: config.AI_MODE,
        masked_message_id: maskMessageId(inbound.messageId)
      });
    }
    const decision = await this.aiCoordinator.withGroqRateLimit(logger, () =>
      createAIProvider(this.env).generateReply({
        message: inbound.text,
        requestId,
        memory,
        recent
      })
    );
    this.decisionObserver?.(decision);

    const aiReply = decision.reply.trim();
    const useReplyFallback = !decision.handoff_requested && (!decision.should_reply || !aiReply);
    if (useReplyFallback) {
      logger.warn('ai.decision.reply_fallback', {
        provider: 'openrouter',
        reason: !aiReply ? 'empty_reply' : 'should_reply_false'
      });
    }

    if ((!decision.should_reply || !aiReply) && !useReplyFallback) {
      logger.info('uazapi.autoreply.skipped', {
        provider: 'uazapi',
        reason: 'ai_no_reply'
      });
      return { sent: false, reason: 'ai_no_reply' };
    }

    if (persistent) {
      await this.memory.merge(
        persistent.contactId,
        decision.memory_patch,
        decision.intent,
        inbound.messageId,
        utcNow()
      );
      await this.leads.merge(persistent.contactId, decision.lead_patch, utcNow());
      await this.contacts.mergeProfile(
        persistent.contactId,
        { ...decision.lead_patch, email: decision.lead_patch.email },
        utcNow()
      );
      logger.info('memory.updated', { provider: 'uazapi' });
      logger.info('lead.updated', { provider: 'uazapi' });
      if (decision.handoff_requested) {
        await this.handoffs.request(
          persistent.contactId,
          persistent.conversationId,
          decision.handoff_reason,
          utcNow()
        );
        await this.contacts.setAiEnabled(persistent.contactId, false, utcNow());
        logger.info('handoff.requested', { provider: 'uazapi' });
        return { sent: false, reason: 'handoff_requested' };
      }
    }

    const chunks = splitWhatsAppReply(
      useReplyFallback ? aiReply || inboundReplyFallback : aiReply,
      {
        softLimit: config.WHATSAPP_REPLY_SOFT_LIMIT,
        maxChunks: config.WHATSAPP_REPLY_MAX_CHUNKS
      }
    );
    const outbound = this.outboundSender ?? createUazapiProvider(this.env, requestId);
    const sentResults: UazapiSendTextResult[] = [];

    for (const [index, text] of chunks.entries()) {
      let result;
      try {
        result = await outbound.sendText({
          number: inbound.phone,
          text,
          replyId: inbound.messageId
        });
      } catch (cause) {
        if (sentResults.length === 0) throw cause;

        const error = toAppError(cause);
        await this.errors.create({
          requestId,
          errorCode: 'UAZAPI_PARTIAL_OUTBOUND_FAILURE',
          safeMessage: 'WhatsApp reply was partially sent',
          now: utcNow()
        });
        logger.error('uazapi.autoreply.partial_failure', {
          provider: 'uazapi',
          sent_chunks: sentResults.length,
          total_chunks: chunks.length,
          failed_chunk: index + 1,
          error_code: error.code
        });
        logger.info('uazapi.autoreply.completed', {
          provider: 'uazapi',
          status: sentResults[sentResults.length - 1].status,
          chunks_sent: sentResults.length,
          chunks_total: chunks.length,
          partial: true
        });
        return {
          sent: true,
          partial: true,
          ai_validated: true,
          chunks_sent: sentResults.length,
          chunks_total: chunks.length,
          result: sentResults[0]
        };
      }

      sentResults.push(result);
      if (persistent) {
        await this.messages.create({
          conversationId: persistent.conversationId,
          contactId: persistent.contactId,
          providerMessageId: result.providerMessageId,
          direction: 'outbound',
          content: text,
          aiGenerated: true,
          now: utcNow()
        });
        logger.info('db.message.saved', { direction: 'outbound', ai_generated: true });
      }
    }

    const result = sentResults[sentResults.length - 1];
    logger.info('uazapi.autoreply.completed', {
      provider: 'uazapi',
      status: result.status,
      chunks_sent: sentResults.length,
      chunks_total: chunks.length,
      partial: false
    });
    if (inbound.isAudio) {
      logger.info('audio.processing.completed', {
        provider: 'uazapi',
        masked_message_id: maskMessageId(inbound.messageId),
        transcript_length: inbound.text.length
      });
    }

    return {
      sent: true,
      ai_validated: true,
      chunks_sent: sentResults.length,
      chunks_total: chunks.length,
      result
    };
  }

  private async markFailed(
    eventId: string,
    error: AppError,
    requestId: string,
    logger: ReturnType<typeof createLogger>
  ) {
    try {
      await this.repository.markFailed(eventId, error.code);
      await this.errors.create({
        requestId,
        errorCode: error.code,
        safeMessage: error.safeMessage,
        now: utcNow()
      });
    } catch {
      logger.error('webhook.failure_recording_failed', { error_code: error.code });
    }
    await this.errorAlerts.notify(error, {
      requestId,
      provider: this.alertProvider(error.code),
      stage: this.alertProvider(error.code) === 'uazapi' ? 'webhook' : 'ai',
      httpStatus: error.httpStatus,
      retryAfter:
        typeof error.metadata?.retry_after === 'string' ? error.metadata.retry_after : undefined,
      model:
        typeof error.metadata?.model === 'string'
          ? error.metadata.model
          : typeof error.metadata?.resolved_model === 'string'
            ? error.metadata.resolved_model
            : undefined,
      processingStatus: 'failed',
      isErrorAlert: false
    });
    logger.error('webhook.failed', { error_code: error.code });
  }

  private alertProvider(errorCode: string): string {
    if (errorCode.startsWith('GEMINI_')) return 'gemini';
    if (errorCode.startsWith('GROQ_')) return 'groq';
    if (errorCode.startsWith('OPENROUTER_')) return 'openrouter';
    if (errorCode.startsWith('OPENAI_')) return 'openai';
    if (errorCode.startsWith('UAZAPI_')) return 'uazapi';
    return 'worker';
  }

  private async persistInbound(
    inbound: NormalizedUazapiInboundMessage,
    now: string,
    logger: ReturnType<typeof createLogger>
  ) {
    const contact = await this.contacts.upsert({
      phone: inbound.phone,
      name: inbound.senderName,
      now
    });
    if (!contact) return undefined;
    logger.info('db.contact.upserted', { provider: 'uazapi', phone: inbound.phone });
    const conversation = await this.conversations.getOrCreate(
      contact.id,
      inbound.instanceName,
      now
    );
    if (!conversation) return undefined;
    logger.info('db.conversation.loaded', { provider: 'uazapi', status: conversation.status });
    await this.messages.create({
      conversationId: conversation.id,
      contactId: contact.id,
      providerMessageId: inbound.messageId,
      direction: 'inbound',
      messageType: inbound.messageType,
      content: inbound.text,
      sourceType: inbound.isAudio ? 'audio' : 'text',
      transcriptionStatus: inbound.isAudio ? 'pending' : undefined,
      now
    });
    logger.info('db.message.saved', { direction: 'inbound', message_type: inbound.messageType });
    return {
      contactId: contact.id,
      conversationId: conversation.id,
      aiEnabled: contact.ai_enabled === 1
    };
  }

  private async prepareAudioInbound(
    inbound: NormalizedUazapiInboundMessage,
    logger: ReturnType<typeof createLogger>,
    requestId: string,
    persistent?: { contactId: string; conversationId: string; aiEnabled: boolean }
  ): Promise<{ inbound?: NormalizedUazapiInboundMessage; fallback: unknown }> {
    logger.info('audio.inbound.detected', {
      provider: 'uazapi',
      message_type: inbound.messageType ?? null,
      masked_message_id: maskMessageId(inbound.messageId),
      audio_media_status: inbound.audioMediaStatus ?? 'unconfirmed'
    });
    const storedTranscription = persistent
      ? await this.messages.getInboundTranscription(inbound.messageId)
      : undefined;
    if (
      storedTranscription?.transcription_status === 'completed' &&
      storedTranscription.content.trim()
    ) {
      logger.info('audio.transcription.reused', {
        provider: storedTranscription.transcription_provider ?? 'groq',
        model: storedTranscription.transcription_model,
        masked_message_id: maskMessageId(inbound.messageId),
        transcript_length: storedTranscription.content.length
      });
      return {
        fallback: undefined,
        inbound: {
          ...inbound,
          text: storedTranscription.content,
          audioMediaStatus: 'resolved'
        }
      };
    }
    if (storedTranscription?.transcription_status === 'processing') {
      logger.warn('audio.processing.skipped', {
        provider: 'uazapi',
        reason: 'transcription_processing',
        masked_message_id: maskMessageId(inbound.messageId)
      });
      return { fallback: { sent: false, reason: 'audio_transcription_processing' } };
    }
    if (storedTranscription?.transcription_status === 'failed') {
      logger.warn('audio.processing.skipped', {
        provider: 'uazapi',
        reason: 'transcription_failed',
        masked_message_id: maskMessageId(inbound.messageId)
      });
      return { fallback: await this.sendAudioFallback(inbound, persistent, requestId) };
    }
    let audioMedia = inbound.audioMedia;
    const mediaDownloadId = inbound.mediaDownloadId ?? inbound.messageId;
    if (!audioMedia && mediaDownloadId) {
      try {
        audioMedia = await new UazapiMediaResolver(getConfig(this.env), requestId).resolveAudio(
          mediaDownloadId
        );
      } catch (cause) {
        const error = toAppError(cause);
        logger.warn('audio.processing.skipped', {
          provider: 'uazapi',
          reason: 'media_resolution_failed',
          masked_message_id: maskMessageId(inbound.messageId),
          error_code: error.code
        });
        await this.messages.updateTranscriptionStatus(inbound.messageId, 'failed');
        await this.errorAlerts.notify(error, {
          requestId,
          provider: 'uazapi',
          stage: 'audio_media_resolution',
          model: getConfig(this.env).GROQ_TRANSCRIPTION_MODEL
        });
        return { fallback: await this.sendAudioFallback(inbound, persistent, requestId) };
      }
    }
    if (!audioMedia) {
      const error = new AppError({
        code: 'AUDIO_MEDIA_DOWNLOAD_ERROR',
        httpStatus: 502,
        safeMessage: 'Audio media message id is missing',
        metadata: { reason: 'missing_message_id' }
      });
      logger.warn('audio.processing.skipped', {
        provider: 'uazapi',
        reason: 'missing_message_id'
      });
      await this.messages.updateTranscriptionStatus(inbound.messageId, 'unconfirmed');
      await this.errorAlerts.notify(error, {
        requestId,
        provider: 'groq',
        stage: 'audio_transcription',
        model: getConfig(this.env).GROQ_TRANSCRIPTION_MODEL
      });
      return { fallback: await this.sendAudioFallback(inbound, persistent, requestId) };
    }

    logger.info('audio.media.resolved', {
      provider: 'uazapi',
      masked_message_id: maskMessageId(inbound.messageId),
      mime_type: audioMedia.mimeType ?? null,
      audio_size_bytes: audioMedia.sizeBytes ?? null
    });
    try {
      await this.messages.updateTranscriptionStatus(inbound.messageId, 'processing');
    } catch (cause) {
      const error = toAppError(cause);
      logger.error('audio.transcription.persist.failed', {
        provider: 'uazapi',
        masked_message_id: maskMessageId(inbound.messageId),
        error_code: error.code
      });
      throw error;
    }

    let transcription: Awaited<ReturnType<AudioTranscriptionService['transcribe']>>;
    try {
      transcription = await new AudioTranscriptionService(getConfig(this.env)).transcribe({
        media: audioMedia,
        requestId
      });
    } catch (cause) {
      const error = toAppError(cause);
      logger.warn('audio.processing.skipped', {
        provider: 'uazapi',
        reason: 'transcription_failed',
        masked_message_id: maskMessageId(inbound.messageId),
        error_code: error.code
      });
      await this.messages.updateTranscriptionStatus(inbound.messageId, 'failed');
      await this.errorAlerts.notify(error, {
        requestId,
        provider: 'groq',
        stage: 'audio_transcription',
        model: getConfig(this.env).GROQ_TRANSCRIPTION_MODEL,
        retryAfter:
          typeof error.metadata?.retry_after === 'string' ? error.metadata.retry_after : undefined
      });
      return { fallback: await this.sendAudioFallback(inbound, persistent, requestId) };
    }

    logger.info('audio.transcription.persist.started', {
      provider: 'uazapi',
      transcription_provider: transcription.provider,
      model: transcription.model,
      masked_message_id: maskMessageId(inbound.messageId)
    });
    try {
      await this.messages.updateInboundTranscription({
        providerMessageId: inbound.messageId,
        content: transcription.text,
        transcriptionProvider: transcription.provider,
        transcriptionModel: transcription.model,
        now: utcNow()
      });
    } catch (cause) {
      const error = toAppError(cause);
      logger.error('audio.transcription.persist.failed', {
        provider: 'uazapi',
        transcription_provider: transcription.provider,
        model: transcription.model,
        masked_message_id: maskMessageId(inbound.messageId),
        error_code: error.code
      });
      throw error;
    }
    logger.info('audio.transcription.persist.completed', {
      provider: 'uazapi',
      transcription_provider: transcription.provider,
      model: transcription.model,
      masked_message_id: maskMessageId(inbound.messageId),
      transcript_length: transcription.text.length
    });
    return {
      fallback: undefined,
      inbound: {
        ...inbound,
        text: transcription.text,
        audioMedia,
        audioMediaStatus: 'resolved'
      }
    };
  }

  private async sendAudioFallback(
    inbound: NormalizedUazapiInboundMessage,
    persistent: { contactId: string; conversationId: string; aiEnabled: boolean } | undefined,
    requestId: string
  ): Promise<unknown> {
    const text =
      'Não consegui entender esse áudio. Pode enviar novamente ou me mandar a mensagem por texto?';
    const outbound = this.outboundSender ?? createUazapiProvider(this.env, requestId);
    const result = await outbound.sendText({
      number: inbound.phone,
      text,
      replyId: inbound.messageId
    });
    if (persistent) {
      await this.messages.create({
        conversationId: persistent.conversationId,
        contactId: persistent.contactId,
        providerMessageId: result.providerMessageId,
        direction: 'outbound',
        content: text,
        aiGenerated: false,
        now: utcNow()
      });
    }
    return {
      sent: true,
      ai_validated: false,
      reason: 'audio_transcription_failed',
      chunks_sent: 1,
      chunks_total: 1,
      result
    };
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
