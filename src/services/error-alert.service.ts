import type { AppConfig } from '../config/env';
import { createLogger } from '../lib/logger';
import { toAppError } from '../lib/errors';
import { UazapiProvider } from '../integrations/uazapi/provider';

const ALLOWED_NUMBER = '5511976388220';
const ALERT_CODES = new Set([
  'GEMINI_RATE_LIMIT',
  'GEMINI_TIMEOUT',
  'GEMINI_UPSTREAM_ERROR',
  'GEMINI_INVALID_RESPONSE',
  'GROQ_RATE_LIMIT',
  'GROQ_TIMEOUT',
  'GROQ_UPSTREAM_ERROR',
  'GROQ_INVALID_RESPONSE',
  'GROQ_CONFIGURATION_ERROR',
  'GROQ_TRANSCRIPTION_RATE_LIMIT',
  'GROQ_TRANSCRIPTION_TIMEOUT',
  'GROQ_TRANSCRIPTION_UPSTREAM_ERROR',
  'GROQ_TRANSCRIPTION_INVALID_RESPONSE',
  'AUDIO_MEDIA_DOWNLOAD_ERROR',
  'AUDIO_TOO_LARGE',
  'AUDIO_UNSUPPORTED_FORMAT',
  'OPENROUTER_INVALID_RESPONSE',
  'OPENROUTER_TIMEOUT',
  'OPENROUTER_UPSTREAM_ERROR',
  'OPENAI_INVALID_RESPONSE',
  'OPENAI_TIMEOUT',
  'OPENAI_UPSTREAM_ERROR',
  'DATABASE_ERROR',
  'D1_ERROR',
  'VALIDATION_ERROR',
  'UNEXPECTED_PROCESSING_ERROR',
  'CONFIGURATION_ERROR',
  'configuration.invalid',
  'AI_REQUEST_TIMEOUT',
  'OPENAI_REQUEST_FAILED',
  'OPENROUTER_NETWORK_ERROR',
  'UAZAPI_ERROR',
  'UAZAPI_UPSTREAM_ERROR',
  'UAZAPI_REQUEST_TIMEOUT',
  'UAZAPI_INVALID_RESPONSE'
]);

export interface ErrorAlertContext {
  requestId?: string;
  provider?: string;
  stage?: string;
  model?: string;
  httpStatus?: number;
  providerEventId?: string;
  finishReason?: string;
  retryAfter?: string;
  processingStatus?: string;
  isErrorAlert?: boolean;
}

export interface ErrorAlertSender {
  sendText(input: { number: string; text: string }): Promise<unknown>;
}

export class ErrorAlertService {
  private readonly sentRequestIds = new Set<string>();
  private readonly lastByCode = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly sender: ErrorAlertSender = new UazapiProvider(config)
  ) {}

  async notify(error: unknown, context: ErrorAlertContext = {}): Promise<void> {
    const appError = toAppError(error);
    const logger = createLogger(this.config, context.requestId ?? crypto.randomUUID());
    if (!this.config.TEST_ERROR_ALERT_ENABLED)
      return logger.info('error.alert.skipped', { reason: 'disabled' });
    if (context.isErrorAlert)
      return logger.warn('error.alert.skipped', {
        reason: 'uazapi_alert_recursion',
        error_code: appError.code
      });
    if (this.config.TEST_ERROR_ALERT_NUMBER !== ALLOWED_NUMBER)
      return logger.error('error.alert.skipped', { reason: 'not_allowed' });
    if (!ALERT_CODES.has(appError.code))
      return logger.info('error.alert.skipped', {
        reason: 'not_allowed',
        error_code: appError.code
      });
    const requestId = context.requestId;
    if (requestId && this.sentRequestIds.has(requestId))
      return logger.info('error.alert.skipped', { reason: 'duplicate' });
    const now = Date.now();
    const last = this.lastByCode.get(appError.code) ?? 0;
    if (now - last < this.config.TEST_ERROR_ALERT_COOLDOWN_SECONDS * 1000)
      return logger.info('error.alert.skipped', { reason: 'cooldown', error_code: appError.code });
    logger.info('error.alert.started', { error_code: appError.code });
    if (requestId) this.sentRequestIds.add(requestId);
    try {
      await this.sender.sendText({
        number: ALLOWED_NUMBER,
        text: formatAlert(appError.code, appError.metadata, context)
      });
      this.lastByCode.set(appError.code, now);
      logger.info('error.alert.completed', { error_code: appError.code });
    } catch (cause) {
      logger.error('error.alert.failed', {
        error_code: appError.code,
        alert_error_code: toAppError(cause).code
      });
    }
  }
}

function formatAlert(
  code: string,
  metadata: Record<string, unknown> | undefined,
  context: ErrorAlertContext
): string {
  const status = context.httpStatus ?? numberValue(metadata?.status);
  const request = maskId(context.requestId);
  const event = maskId(context.providerEventId);
  return [
    '\u{1F6A8} ATY BOT TEST ALERT',
    field('Provider', context.provider),
    field('Stage', context.stage),
    field('Error', code),
    field('HTTP', status),
    field(
      'Model',
      context.model ?? stringValue(metadata?.model) ?? stringValue(metadata?.resolved_model)
    ),
    field('Request', request),
    field('Event', event),
    field('Finish', context.finishReason),
    field('Retry', context.retryAfter ?? stringValue(metadata?.retry_after)),
    field('Webhook', context.processingStatus),
    field('Time', new Date().toISOString())
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 700);
}

function field(label: string, value: unknown): string {
  return value === undefined || value === null || value === '' ? '' : `${label}: ${String(value)}`;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
function maskId(value: string | undefined): string | undefined {
  return value ? `${value.slice(0, 4)}***${value.slice(-2)}` : undefined;
}
