import { AppError } from '../../lib/errors';
import type { AppConfig } from '../../config/env';
import { createLogger } from '../../lib/logger';
import type { SendImageInput, SendTextInput } from './types';

export interface UazapiSendTextResult {
  status: number;
  provider: 'uazapi';
  providerMessageId?: string;
}

export class UazapiProvider {
  constructor(
    private readonly config: AppConfig,
    private readonly requestId = crypto.randomUUID()
  ) {}

  async sendText(input: SendTextInput): Promise<UazapiSendTextResult> {
    const logger = createLogger(
      {
        LOG_LEVEL: this.config.LOG_LEVEL,
        LOG_MESSAGE_CONTENT: String(this.config.LOG_MESSAGE_CONTENT)
      },
      this.requestId
    );

    if (!this.config.UAZAPI_OUTBOUND_ENABLED) {
      throw new AppError({
        code: 'UAZAPI_OUTBOUND_DISABLED',
        httpStatus: 403,
        safeMessage: 'UAZAPI outbound sending is disabled'
      });
    }

    if (!this.config.UAZAPI_BASE_URL || !this.config.UAZAPI_TOKEN) {
      throw notConfigured();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.UAZAPI_REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();

    logger.info('uazapi.send.started', {
      provider: 'uazapi',
      endpoint: '/send/text'
    });

    try {
      const response = await fetch(`${this.config.UAZAPI_BASE_URL.replace(/\/+$/, '')}/send/text`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          token: this.config.UAZAPI_TOKEN
        },
        body: JSON.stringify({
          number: input.number,
          text: input.text
        })
      });

      if (!response.ok) {
        throw mapUazapiStatus(response.status);
      }

      const payload = await parseJson(response);

      const result = {
        status: response.status,
        provider: 'uazapi' as const,
        ...(extractProviderMessageId(payload)
          ? { providerMessageId: extractProviderMessageId(payload) as string }
          : {})
      };

      logger.info('uazapi.send.completed', {
        provider: 'uazapi',
        status: response.status,
        duration_ms: Date.now() - startedAt
      });

      return result;
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new AppError({
          code: 'UAZAPI_REQUEST_TIMEOUT',
          httpStatus: 504,
          safeMessage: 'UAZAPI request timed out',
          cause
        });
      }
      throw new AppError({
        code: 'UAZAPI_NETWORK_ERROR',
        httpStatus: 502,
        safeMessage: 'UAZAPI network request failed',
        cause
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async sendImage(input: SendImageInput): Promise<never> {
    void input;
    throw notConfigured();
  }

  async markAsRead(providerMessageId: string): Promise<never> {
    void providerMessageId;
    throw notConfigured();
  }

  async getInstanceStatus(): Promise<never> {
    throw notConfigured();
  }
}

function extractProviderMessageId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const candidates = [
    record.id,
    record.messageId,
    record.message_id,
    record.msgId,
    record.msg_id,
    record.key && typeof record.key === 'object'
      ? (record.key as Record<string, unknown>).id
      : undefined,
    record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>).id
      : undefined
  ];
  const found = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
  return typeof found === 'string' ? found : undefined;
}

function notConfigured(): AppError {
  return new AppError({
    code: 'UAZAPI_NOT_CONFIGURED',
    httpStatus: 503,
    safeMessage: 'UAZAPI outbound configuration is missing'
  });
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new AppError({
      code: 'UAZAPI_INVALID_RESPONSE',
      httpStatus: 502,
      safeMessage: 'UAZAPI returned malformed JSON',
      cause,
      metadata: { status: response.status }
    });
  }
}

function mapUazapiStatus(status: number): AppError {
  if (status === 401 || status === 403) {
    return new AppError({
      code: 'UAZAPI_AUTH_ERROR',
      httpStatus: 401,
      safeMessage: 'UAZAPI authentication failed',
      metadata: { status }
    });
  }
  if (status === 429) {
    return new AppError({
      code: 'UAZAPI_RATE_LIMITED',
      httpStatus: 429,
      safeMessage: 'UAZAPI rate limit reached',
      metadata: { status }
    });
  }
  if (status >= 500) {
    return new AppError({
      code: 'UAZAPI_UPSTREAM_ERROR',
      httpStatus: 502,
      safeMessage: 'UAZAPI upstream error',
      metadata: { status }
    });
  }
  return new AppError({
    code: 'UAZAPI_INVALID_RESPONSE',
    httpStatus: 502,
    safeMessage: 'UAZAPI request failed',
    metadata: { status }
  });
}
