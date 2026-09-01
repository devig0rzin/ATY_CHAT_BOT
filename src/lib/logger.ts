import { maskPhone } from './phone';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const secretKeys = ['OPENAI_API_KEY', 'UAZAPI_TOKEN', 'ADMIN_API_KEY', 'WEBHOOK_SECRET'];
const credentialLikeKeys = new Set([
  'token',
  'apikey',
  'authorization',
  'password',
  'secret',
  'accesstoken',
  'refreshtoken'
]);

export class Logger {
  constructor(
    private readonly requestId: string,
    private readonly minLevel: LogLevel = 'info',
    private readonly logMessageContent = false
  ) {}

  debug(event: string, fields: Record<string, unknown> = {}) {
    this.write('debug', event, fields);
  }

  info(event: string, fields: Record<string, unknown> = {}) {
    this.write('info', event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}) {
    this.write('warn', event, fields);
  }

  warnDiagnosticPayload(event: string, fields: Record<string, unknown> = {}) {
    this.write('warn', event, fields, redactCredentialFields, true);
  }

  error(event: string, fields: Record<string, unknown> = {}) {
    this.write('error', event, fields);
  }

  private write(
    level: LogLevel,
    event: string,
    fields: Record<string, unknown>,
    redactForLog: (value: unknown) => unknown = (value) => redact(value, this.logMessageContent),
    force = false
  ) {
    if (!force && levelRank[level] < levelRank[this.minLevel]) return;
    console[level === 'debug' ? 'log' : level](
      JSON.stringify(
        redactForLog({
          level,
          event,
          request_id: this.requestId,
          ...fields
        })
      )
    );
  }
}

export function createLogger(
  env: { LOG_LEVEL?: string; LOG_MESSAGE_CONTENT?: string },
  requestId: string
) {
  const configured =
    env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'warn' || env.LOG_LEVEL === 'error'
      ? env.LOG_LEVEL
      : 'info';
  return new Logger(requestId, configured, env.LOG_MESSAGE_CONTENT === 'true');
}

export function redact(value: unknown, logMessageContent = false): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, logMessageContent));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, raw]) => {
      if (secretKeys.includes(key) || /authorization/i.test(key)) return [key, '[REDACTED]'];
      if (/phone/i.test(key) && typeof raw === 'string') return [key, maskPhone(raw)];
      if (!logMessageContent && /content|message/i.test(key) && typeof raw === 'string') {
        return [key, '[REDACTED]'];
      }
      return [key, redact(raw, logMessageContent)];
    })
  );
}

export function redactCredentialFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactCredentialFields(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, raw]) => {
      if (isCredentialLikeKey(key)) return [key, '[REDACTED]'];
      return [key, redactCredentialFields(raw)];
    })
  );
}

function isCredentialLikeKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return credentialLikeKeys.has(normalized);
}
