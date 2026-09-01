import { AppError } from '../../lib/errors';

export function normalizeUazapiEvent(): never {
  throw new AppError({
    code: 'UAZAPI_NOT_CONFIGURED',
    httpStatus: 503,
    safeMessage: 'UAZAPI event normalization is pending official documentation'
  });
}
