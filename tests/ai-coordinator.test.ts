import { describe, expect, it } from 'vitest';
import { getConfig } from '../src/config/env';
import { AppError } from '../src/lib/errors';
import { createLogger } from '../src/lib/logger';
import { AiCoordinator } from '../src/services/ai-coordinator.service';

describe('AiCoordinator', () => {
  it('agrupa três inbounds persistidos em um único batch', async () => {
    const messages = [
      {
        id: 'm1',
        provider_message_id: 'p1',
        content: 'Oi',
        created_at: '2026-09-20T00:00:00.000Z'
      },
      {
        id: 'm2',
        provider_message_id: 'p2',
        content: 'Tenho uma clínica',
        created_at: '2026-09-20T00:00:01.000Z'
      },
      {
        id: 'm3',
        provider_message_id: 'p3',
        content: 'Quero automatizar meu WhatsApp',
        created_at: '2026-09-20T00:00:02.000Z'
      }
    ];
    const db = createD1(messages);
    const coordinator = new AiCoordinator(
      db as unknown as D1Database,
      config({ AI_MIN_REQUEST_INTERVAL_MS: '0' })
    );
    const batch = await coordinator.getInboundBatch('conversation-1');
    let aiCalls = 0;
    await coordinator.waitForConversation('conversation-1', logger(), async () => {
      aiCalls += 1;
      expect(batch).toHaveLength(3);
    });
    expect(aiCalls).toBe(1);
  });

  it('serializa duas execuções da mesma conversa', async () => {
    const db = createD1();
    const coordinator = new AiCoordinator(
      db as unknown as D1Database,
      config({ AI_MIN_REQUEST_INTERVAL_MS: '0' })
    );
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const first = coordinator.waitForConversation('conversation-1', logger(), async () => {
      order.push('first-start');
      await firstReleased;
      order.push('first-end');
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = coordinator.waitForConversation('conversation-1', logger(), async () => {
      order.push('second');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('recupera HTTP 429 com exatamente um retry', async () => {
    const db = createD1();
    const coordinator = new AiCoordinator(
      db as unknown as D1Database,
      config({ AI_MIN_REQUEST_INTERVAL_MS: '0', AI_RATE_LIMIT_MAX_RETRIES: '1' })
    );
    let calls = 0;
    const result = await coordinator.withGroqRateLimit(logger(), async () => {
      calls += 1;
      if (calls === 1) {
        throw new AppError({
          code: 'GROQ_RATE_LIMIT',
          httpStatus: 429,
          safeMessage: 'rate limited',
          metadata: { retry_after: '0' }
        });
      }
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('encerra após um retry 429 e não cria loop', async () => {
    const db = createD1();
    const coordinator = new AiCoordinator(
      db as unknown as D1Database,
      config({ AI_MIN_REQUEST_INTERVAL_MS: '0', AI_RATE_LIMIT_MAX_RETRIES: '1' })
    );
    let calls = 0;
    await expect(
      coordinator.withGroqRateLimit(logger(), async () => {
        calls += 1;
        throw new AppError({
          code: 'GROQ_RATE_LIMIT',
          httpStatus: 429,
          safeMessage: 'rate limited',
          metadata: { retry_after: '0' }
        });
      })
    ).rejects.toMatchObject({ code: 'GROQ_RATE_LIMIT' });
    expect(calls).toBe(2);
  });
});

function config(overrides: Record<string, string> = {}) {
  return getConfig({
    APP_ENV: 'local',
    AI_MODE: 'groq',
    GROQ_API_KEY: 'test-key',
    AI_RATE_LIMIT_GUARD_ENABLED: 'true',
    WEBHOOK_AUTH_MODE: 'off',
    TEST_ERROR_ALERT_NUMBER: '5511976388220',
    ...overrides
  });
}

function logger() {
  return createLogger({ LOG_LEVEL: 'error', LOG_MESSAGE_CONTENT: 'false' }, 'coordinator-test');
}

function createD1(messages: Array<Record<string, string>> = []) {
  const conversations = new Map<string, { lockedUntil: string | null }>();
  const providers = new Map<string, { lockedUntil: string | null; lastRequestAt: string | null }>();
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              if (sql.includes('INSERT OR IGNORE INTO ai_conversation_state')) {
                const id = String(values[0]);
                if (!conversations.has(id)) conversations.set(id, { lockedUntil: null });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE ai_conversation_state SET locked_until = NULL')) {
                const state = conversations.get(String(values[1]));
                if (state) state.lockedUntil = null;
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE ai_conversation_state SET locked_until')) {
                const id = String(values[2]);
                const now = String(values[3]);
                const state = conversations.get(id);
                if (state && (!state.lockedUntil || state.lockedUntil <= now)) {
                  state.lockedUntil = String(values[0]);
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              if (sql.includes('INSERT OR IGNORE INTO ai_provider_rate_state')) {
                const provider = String(values[0]);
                if (!providers.has(provider))
                  providers.set(provider, { lockedUntil: null, lastRequestAt: null });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE ai_provider_rate_state SET locked_until = ?')) {
                const provider = String(values[2]);
                const now = String(values[3]);
                const state = providers.get(provider);
                if (state && (!state.lockedUntil || state.lockedUntil <= now)) {
                  state.lockedUntil = String(values[0]);
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              if (sql.includes('UPDATE ai_provider_rate_state SET last_request_at')) {
                const state = providers.get(String(values[2]));
                if (state) state.lastRequestAt = String(values[0]);
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE ai_provider_rate_state SET locked_until = NULL')) {
                const state = providers.get(String(values[1]));
                if (state) state.lockedUntil = null;
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 1 } };
            },
            async first() {
              if (sql.includes('SELECT last_request_at')) {
                const state = providers.get(String(values[0]));
                return { last_request_at: state?.lastRequestAt ?? null };
              }
              return null;
            },
            async all() {
              return { results: sql.includes('FROM messages') ? messages : [] };
            }
          };
        }
      };
    }
  };
}
