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
import {
  getUazapiAutoreplySkipReason,
  normalizeUazapiEvent
} from '../integrations/uazapi/normalizer';
import type { Env } from '../types/env';
import type { RequestContext } from '../types/api';
import type { NormalizedUazapiInboundMessage } from '../integrations/uazapi/types';
import type { UazapiSendTextResult } from '../integrations/uazapi/provider';
import { ErrorAlertService } from './error-alert.service';

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

  constructor(private readonly env: Env) {
    this.repository = new WebhookEventsRepository(env.DB);
    this.contacts = new ContactsRepository(env.DB);
    this.conversations = new ConversationsRepository(env.DB);
    this.messages = new MessagesRepository(env.DB);
    this.memory = new MemoryRepository(env.DB);
    this.leads = new LeadsRepository(env.DB);
    this.handoffs = new HandoffsRepository(env.DB);
    this.errors = new ErrorsRepository(env.DB);
    this.errorAlerts = new ErrorAlertService(getConfig(env));
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
    persistent?: { contactId: string; conversationId: string; aiEnabled: boolean }
  ) {
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
    const decision = await createAIProvider(this.env).generateReply({
      message: inbound.text,
      requestId,
      memory,
      recent
    });

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
      await this.contacts.mergeProfile(persistent.contactId, decision.lead_patch, utcNow());
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
    const outbound = createUazapiProvider(this.env, requestId);
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
      now
    });
    logger.info('db.message.saved', { direction: 'inbound', message_type: inbound.messageType });
    return {
      contactId: contact.id,
      conversationId: conversation.id,
      aiEnabled: contact.ai_enabled === 1
    };
  }
}
