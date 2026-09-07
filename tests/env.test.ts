import { describe, expect, it } from 'vitest';
import { getConfig, isEnvConfigured, parseBooleanEnv } from '../src/config/env';

describe('environment boolean parsing', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['true', true],
    ['1', true],
    ['yes', true],
    ['on', true]
  ])('resolves UAZAPI_DEBUG_PAYLOAD=%s to %s', (value, expected) => {
    expect(parseBooleanEnv(value)).toBe(expected);
    expect(
      getConfig({ WEBHOOK_AUTH_MODE: 'off', UAZAPI_DEBUG_PAYLOAD: value }).UAZAPI_DEBUG_PAYLOAD
    ).toBe(expected);
  });

  it('tracks whether an env value was actually configured', () => {
    expect(isEnvConfigured(undefined)).toBe(false);
    expect(isEnvConfigured('')).toBe(false);
    expect(isEnvConfigured('false')).toBe(true);
    expect(isEnvConfigured('true')).toBe(true);
  });

  it('parses local OpenRouter and UAZAPI outbound configuration explicitly', () => {
    const config = getConfig({
      APP_ENV: 'local',
      AI_MODE: 'openrouter',
      OPENROUTER_API_KEY: 'test-openrouter-key',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENROUTER_MODEL: 'openrouter/free',
      AI_TEMPERATURE: '0.4',
      AI_REQUEST_TIMEOUT_MS: '30000',
      AI_RECENT_MESSAGE_LIMIT: '12',
      OPENAI_MAX_OUTPUT_TOKENS: '800',
      UAZAPI_BASE_URL: 'https://example.uazapi.test',
      UAZAPI_TOKEN: 'test-uazapi-token',
      UAZAPI_OUTBOUND_ENABLED: 'true',
      UAZAPI_DEBUG_PAYLOAD: 'false',
      UAZAPI_REQUEST_TIMEOUT_MS: '30000',
      TEST_WHATSAPP_NUMBER: '5511999999999',
      LOCAL_DEV_ROUTES_ENABLED: 'true',
      LOG_LEVEL: 'debug',
      LOG_MESSAGE_CONTENT: 'false',
      WEBHOOK_AUTH_MODE: 'off',
      ADMIN_API_KEY: 'local-development-only'
    });

    expect(config.AI_MODE).toBe('openrouter');
    expect(config.OPENAI_MAX_OUTPUT_TOKENS).toBe(800);
    expect(config.UAZAPI_OUTBOUND_ENABLED).toBe(true);
    expect(config.UAZAPI_DEBUG_PAYLOAD).toBe(false);
    expect(config.LOCAL_DEV_ROUTES_ENABLED).toBe(true);
  });
});
