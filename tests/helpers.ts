import app from '../src/app';
import type { Env } from '../src/types/env';

export const testEnv: Env = {
  AI_MODE: 'mock',
  WEBHOOK_AUTH_MODE: 'off',
  ADMIN_API_KEY: 'test-admin-key',
  LOG_LEVEL: 'error',
  LOG_MESSAGE_CONTENT: 'false',
  AI_RECENT_MESSAGE_LIMIT: '12'
};

export function request(path: string, init?: RequestInit, env: Env = testEnv) {
  return app.fetch(new Request(`https://worker.test${path}`, init), env);
}
