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
});
