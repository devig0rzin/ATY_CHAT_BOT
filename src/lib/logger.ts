import { maskPhone } from './phone';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const secretKeys = ['OPENAI_API_KEY', 'UAZAPI_TOKEN', 'ADMIN_API_KEY', 'WEBHOOK_SECRET'];

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

  error(event: string, fields: Record<string, unknown> = {}) {
    this.write('error', event, fields);
  }

  private write(level: LogLevel, event: string, fields: Record<string, unknown>) {
    if (levelRank[level] < levelRank[this.minLevel]) return;
    console[level === 'debug' ? 'log' : level](
      JSON.stringify(
        redact(
          {
            level,
            event,
            request_id: this.requestId,
            ...fields
          },
          this.logMessageContent
        )
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
