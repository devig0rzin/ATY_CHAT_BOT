import { describe, expect, it, vi } from 'vitest';
import { getConfig } from '../src/config/env';
import { GeminiProvider, type GeminiClient } from '../src/integrations/gemini/provider';
import { AppError } from '../src/lib/errors';
import { ErrorAlertService } from '../src/services/error-alert.service';

const decision = {
  should_reply: true,
  reply: 'Olá! Posso ajudar.',
  intent: 'test',
  confidence: 0.9,
  handoff_requested: false,
  handoff_reason: null,
  lead_patch: {
    name: null,
    company: null,
    segment: null,
    service_interest: null,
    budget_status: null,
    urgency: null
  },
  memory_patch: { summary: null, facts_to_add: [], open_loops: [] }
};

function config(overrides: Record<string, string> = {}) {
  return getConfig({
    AI_MODE: 'gemini',
    GEMINI_API_KEY: 'gemini-secret',
    WEBHOOK_AUTH_MODE: 'off',
    TEST_ERROR_ALERT_ENABLED: 'true',
    TEST_ERROR_ALERT_NUMBER: '5511976388220',
    UAZAPI_OUTBOUND_ENABLED: 'true',
    UAZAPI_BASE_URL: 'https://uazapi.test',
    UAZAPI_TOKEN: 'uazapi-secret',
    ...overrides
  });
}

describe('GeminiProvider', () => {
  it.each([
    ['429', new AppError({ code: 'GEMINI_RATE_LIMIT', safeMessage: 'rate', httpStatus: 429 })],
    ['timeout', new AppError({ code: 'GEMINI_TIMEOUT', safeMessage: 'timeout', httpStatus: 504 })],
    [
      'invalid response',
      new AppError({ code: 'GEMINI_INVALID_RESPONSE', safeMessage: 'invalid', httpStatus: 502 })
    ]
  ])('preserves the classified %s error', async (_, error) => {
    const client: GeminiClient = { generate: vi.fn().mockRejectedValue(error) };
    await expect(
      new GeminiProvider(config(), client).generateReply({ message: 'oi', requestId: 'req-gemini' })
    ).rejects.toBe(error);
  });

  it('valida uma resposta estruturada do Gemini', async () => {
    const client: GeminiClient = {
      generate: vi.fn().mockResolvedValue({
        status: 200,
        model: 'gemini-3.7-flash',
        text: JSON.stringify(decision)
      })
    };
    await expect(
      new GeminiProvider(config(), client).generateReply({
        message: 'oi',
        requestId: 'valid-gemini'
      })
    ).resolves.toMatchObject(decision);
  });
});

describe('ErrorAlertService', () => {
  it('envia somente para o número fixo e sanitiza segredos e telefone do cliente', async () => {
    const sendText = vi.fn().mockResolvedValue({ status: 200, provider: 'uazapi' as const });
    await new ErrorAlertService(config(), { sendText }).notify(
      new AppError({
        code: 'GEMINI_RATE_LIMIT',
        safeMessage: 'x',
        httpStatus: 429,
        metadata: { api_key: 'gemini-secret', status: 429 }
      }),
      {
        requestId: 'abcdef123456',
        provider: 'Gemini',
        stage: 'AI',
        model: 'gemini-3.7-flash',
        processingStatus: 'failed'
      }
    );
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ number: '5511976388220' }));
    const message = sendText.mock.calls[0][0].text as string;
    expect(message).not.toContain('gemini-secret');
    expect(message).not.toContain('5511999999999');
  });

  it('não permite configuração com outro número', () => {
    expect(() => config({ TEST_ERROR_ALERT_NUMBER: '5511999999999' })).toThrow();
  });

  it('não duplica o mesmo request_id e aplica cooldown por código', async () => {
    const sendText = vi.fn().mockResolvedValue({ status: 200, provider: 'uazapi' as const });
    const service = new ErrorAlertService(config(), { sendText });
    const error = new AppError({ code: 'GEMINI_TIMEOUT', safeMessage: 'timeout', httpStatus: 504 });
    await service.notify(error, { requestId: 'same-request' });
    await service.notify(error, { requestId: 'same-request' });
    await service.notify(error, { requestId: 'different-request' });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('fica silencioso quando desabilitado', async () => {
    const sendText = vi.fn();
    await new ErrorAlertService(config({ TEST_ERROR_ALERT_ENABLED: 'false' }), { sendText }).notify(
      new AppError({ code: 'DATABASE_ERROR', safeMessage: 'db' })
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it('não propaga falha do alerta nem cria recursão UAZAPI', async () => {
    const sendText = vi
      .fn()
      .mockRejectedValue(
        new AppError({ code: 'UAZAPI_UPSTREAM_ERROR', safeMessage: 'uazapi', httpStatus: 502 })
      );
    const service = new ErrorAlertService(config(), { sendText });
    await expect(
      service.notify(new AppError({ code: 'UAZAPI_UPSTREAM_ERROR', safeMessage: 'original' }), {
        requestId: 'uazapi-request'
      })
    ).resolves.toBeUndefined();
    expect(sendText).toHaveBeenCalledTimes(1);
    await expect(
      service.notify(new AppError({ code: 'DATABASE_ERROR', safeMessage: 'db' }), {
        requestId: 'alert-request',
        isErrorAlert: true
      })
    ).resolves.toBeUndefined();
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});
