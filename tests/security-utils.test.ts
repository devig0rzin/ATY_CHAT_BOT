import { describe, expect, it } from 'vitest';
import { AppError, toAppError } from '../src/lib/errors';
import { maskPhone } from '../src/lib/phone';
import { redact } from '../src/lib/logger';

describe('security utilities', () => {
  it('masks phone numbers', () => {
    expect(maskPhone('5511945177464')).toBe('*********7464');
  });

  it('redacts secrets and message content by default', () => {
    expect(
      redact({
        OPENAI_API_KEY: 'secret',
        Authorization: 'Bearer secret',
        phone: '5511945177464',
        message: 'hello'
      })
    ).toEqual({
      OPENAI_API_KEY: '[REDACTED]',
      Authorization: '[REDACTED]',
      phone: '*********7464',
      message: '[REDACTED]'
    });
  });

  it('serializes unknown errors safely', () => {
    const appError = toAppError(new Error('private stack detail'));
    expect(appError.safeMessage).toBe('Internal server error');
    expect(appError.code).toBe('INTERNAL_ERROR');
  });

  it('preserves typed app errors', () => {
    const error = new AppError({ code: 'VALIDATION_ERROR', safeMessage: 'Safe' });
    expect(toAppError(error)).toBe(error);
  });
});
