import { WebhookEventsRepository } from '../repositories/webhook-events.repository';
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

const maxBodyBytes = 256 * 1024;

export class WebhookService {
  private readonly repository: WebhookEventsRepository;

  constructor(private readonly env: Env) {
    this.repository = new WebhookEventsRepository(env.DB);
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

    await this.repository.create({
      id: crypto.randomUUID(),
      requestId: context.requestId,
      provider: 'uazapi',
      providerEventId: normalizedInbound?.messageId,
      eventType: normalizedInbound?.event,
      payloadSha256,
      payloadJson: rawPayload,
      receivedAt
    });

    logger.info('webhook.captured', {
      provider: 'uazapi',
      duration_ms: Date.now() - context.startedAt,
      database_configured: this.repository.configured,
      payload_sha256: payloadSha256
    });

    const autoreply = await this.maybeAutoreply(validJson.data, config, logger, context.requestId);

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
    requestId: string
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

    const decision = await createAIProvider(this.env).generateReply({
      message: inbound.text,
      requestId
    });

    if (!decision.should_reply || !decision.reply.trim()) {
      logger.info('uazapi.autoreply.skipped', {
        provider: 'uazapi',
        reason: 'ai_no_reply'
      });
      return { sent: false, reason: 'ai_no_reply' };
    }

    const result = await createUazapiProvider(this.env, requestId).sendText({
      number: inbound.phone,
      text: decision.reply,
      replyId: inbound.messageId
    });

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
}
