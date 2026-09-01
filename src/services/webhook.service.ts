import { WebhookEventsRepository } from '../repositories/webhook-events.repository';
import { arbitraryJsonSchema } from '../schemas/webhook.schemas';
import { sha256Hex } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { createLogger } from '../lib/logger';
import { utcNow } from '../lib/time';
import type { Env } from '../types/env';
import type { RequestContext } from '../types/api';

const maxBodyBytes = 256 * 1024;

export class WebhookService {
  private readonly repository: WebhookEventsRepository;

  constructor(private readonly env: Env) {
    this.repository = new WebhookEventsRepository(env.DB);
  }

  async captureUazapiEvent(request: Request, context: RequestContext) {
    const logger = createLogger(this.env, context.requestId);
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
    const receivedAt = utcNow();
    const duplicate = await this.repository.findByPayloadSha256(payloadSha256);
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

    return {
      status: 'received',
      provider: 'uazapi',
      captured: true,
      database_configured: this.repository.configured,
      payload_sha256: payloadSha256
    };
  }
}
