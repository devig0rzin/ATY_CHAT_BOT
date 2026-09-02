export type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'DATABASE_ERROR'
  | 'WEBHOOK_INVALID_BODY'
  | 'WEBHOOK_UNAUTHORIZED'
  | 'OPENAI_NOT_CONFIGURED'
  | 'OPENAI_REQUEST_FAILED'
  | 'OPENAI_INVALID_RESPONSE'
  | 'OPENROUTER_NOT_CONFIGURED'
  | 'OPENROUTER_AUTH_ERROR'
  | 'OPENROUTER_RATE_LIMITED'
  | 'OPENROUTER_UPSTREAM_ERROR'
  | 'OPENROUTER_NETWORK_ERROR'
  | 'OPENROUTER_INVALID_RESPONSE'
  | 'AI_REQUEST_TIMEOUT'
  | 'AI_INVALID_RESPONSE'
  | 'UAZAPI_NOT_CONFIGURED'
  | 'UAZAPI_REQUEST_FAILED'
  | 'DUPLICATE_EVENT'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly httpStatus: number;
  readonly safeMessage: string;
  readonly metadata?: Record<string, unknown>;

  constructor(input: {
    code: AppErrorCode;
    httpStatus?: number;
    safeMessage: string;
    cause?: unknown;
    metadata?: Record<string, unknown>;
  }) {
    super(input.safeMessage);
    this.name = 'AppError';
    this.code = input.code;
    this.httpStatus = input.httpStatus ?? 500;
    this.safeMessage = input.safeMessage;
    this.cause = input.cause;
    this.metadata = input.metadata;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError({
    code: 'INTERNAL_ERROR',
    httpStatus: 500,
    safeMessage: 'Internal server error',
    cause: error
  });
}
