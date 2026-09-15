import { WebhookEventsRepository } from '../repositories/webhook-events.repository';
import { ContactsRepository } from '../repositories/contacts.repository';
import { ConversationsRepository } from '../repositories/conversations.repository';
import { MessagesRepository } from '../repositories/messages.repository';
import { MemoryRepository } from '../repositories/memory.repository';
import { LeadsRepository } from '../repositories/leads.repository';
import { HandoffsRepository } from '../repositories/handoffs.repository';
import { arbitraryJsonSchema } from '../schemas/webhook.schemas';
import { getConfig, isEnvConfigured } from '../config/env';
import { sha256Hex } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { createLogger } from '../lib/logger';
import { utcNow } from '../lib/time';
import { createAIProvider } from '../integrations/openai/client';
import { createUazapiProvider } from '../integrations/uazapi/client';
import {
  getUazapiAutoreplySkipReason,
  normalizeUazapiEvent
} from '../integrations/uazapi/normalizer';
import type { Env } from '../types/env';
import type { RequestContext } from '../types/api';
import type { NormalizedUazapiInboundMessage } from '../integrations/uazapi/types';

const maxBodyBytes = 256 * 1024;

export class WebhookService {
  private readonly repository: WebhookEventsRepository;
  private readonly contacts: ContactsRepository;
  private readonly conversations: ConversationsRepository;
  private readonly messages: MessagesRepository;
  private readonly memory: MemoryRepository;
  private readonly leads: LeadsRepository;
  private readonly handoffs: HandoffsRepository;

  constructor(private readonly env: Env) {
    this.repository = new WebhookEventsRepository(env.DB);
    this.contacts = new ContactsRepository(env.DB);
    this.conversations = new ConversationsRepository(env.DB);
    this.messages = new MessagesRepository(env.DB);
    this.memory = new MemoryRepository(env.DB);
    this.leads = new LeadsRepository(env.DB);
    this.handoffs = new HandoffsRepository(env.DB);
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
    const duplicateByMessageId = normalizedInbound?.messageId
      ? await this.repository.findByProviderEventId('uazapi', normalizedInbound.messageId)
      : false;
    const duplicate =
      duplicateByMessageId || (await this.repository.findByPayloadSha256(payloadSha256));
    if (duplicate) {
      logger.info('webhook.duplicate', { provider: 'uazapi', payload_sha256: payloadSha256 });
      return {
        status: 'duplicate',
        provider: 'uazapi',
        captured: true,
        database_configured: this.repository.configured,
        payload_sha256: payloadSha256
      };
    }

    const inserted = await this.repository.create({
      id: crypto.randomUUID(),
      requestId: context.requestId,
      provider: 'uazapi',
      providerEventId: normalizedInbound?.messageId,
      eventType: normalizedInbound?.event,
      payloadSha256,
      payloadJson: rawPayload,
      receivedAt
    });
    if (!inserted) {
      logger.info('webhook.duplicate', { provider: 'uazapi', payload_sha256: payloadSha256 });
      return {
        status: 'duplicate',
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

    const persistent = normalizedInbound
      ? await this.persistInbound(normalizedInbound, receivedAt, logger)
      : undefined;
    const autoreply = await this.maybeAutoreply(
      validJson.data,
      config,
      logger,
      context.requestId,
      persistent
    );

    return {
      status: 'received',
      provider: 'uazapi',
      captured: true,
      database_configured: this.repository.configured,
      payload_sha256: payloadSha256,
      ...(autoreply ? { autoreply } : {})
    };
  }

  private async maybeAutoreply(
    payload: unknown,
    config: ReturnType<typeof getConfig>,
    logger: ReturnType<typeof createLogger>,
    requestId: string,
    persistent?: { contactId: string; conversationId: string; aiEnabled: boolean }
  ) {
    if (config.APP_ENV !== 'local' || !config.LOCAL_INBOUND_AUTOREPLY_ENABLED) {
      return undefined;
    }

    const inbound = normalizeUazapiEvent(payload);
    if (!inbound) {
      const reason = getUazapiAutoreplySkipReason(payload) ?? 'message_not_normalized';
      logger.warn('uazapi.autoreply.skipped', {
        provider: 'uazapi',
        reason
      });
      return { sent: false, reason };
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

    if (!decision.should_reply || !decision.reply.trim()) {
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

    const result = await createUazapiProvider(this.env, requestId).sendText({
      number: inbound.phone,
      text: decision.reply,
      replyId: inbound.messageId
    });

    if (persistent) {
      await this.messages.create({
        conversationId: persistent.conversationId,
        contactId: persistent.contactId,
        providerMessageId: result.providerMessageId,
        direction: 'outbound',
        content: decision.reply,
        aiGenerated: true,
        now: utcNow()
      });
      logger.info('db.message.saved', { direction: 'outbound', ai_generated: true });
    }

    logger.info('uazapi.autoreply.completed', {
      provider: 'uazapi',
      status: result.status
    });

    return {
      sent: true,
      ai_validated: true,
      result
    };
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
