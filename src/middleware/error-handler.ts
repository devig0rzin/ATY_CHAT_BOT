import type { ErrorHandler } from 'hono';
import { createLogger } from '../lib/logger';
import { errorResponse } from '../lib/response';
import { toAppError } from '../lib/errors';

export const errorHandler: ErrorHandler = (error, c) => {
  const appError = toAppError(error);
  const requestId = c.get('requestId') ?? crypto.randomUUID();
  const logger = createLogger(c.env ?? {}, requestId);
  logger.error('request.failed', {
    error_code: appError.code,
    safe_message: appError.safeMessage,
    metadata: appError.metadata
  });
  return errorResponse(
    c,
    {
      code: appError.code,
      message: appError.safeMessage
    },
    appError.httpStatus
  );
};
