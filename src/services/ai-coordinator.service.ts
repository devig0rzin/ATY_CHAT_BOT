import type { AppConfig } from '../config/env';
import { AppError, toAppError } from '../lib/errors';
import { createLogger } from '../lib/logger';
import { utcNow } from '../lib/time';
import { AiCoordinationRepository } from '../repositories/ai-coordination.repository';

const conversationLeaseMs = 120_000;
const providerLeaseMs = 120_000;
const lockPollMs = 250;
const retryMarginMs = 250;

export class AiCoordinator {
  private readonly repository: AiCoordinationRepository;

  constructor(
    private readonly db: D1Database | undefined,
    private readonly config: AppConfig
  ) {
    this.repository = new AiCoordinationRepository(db);
  }

  get configured(): boolean {
    return this.repository.configured;
  }

  async waitForConversation<T>(
    conversationId: string,
    logger: ReturnType<typeof createLogger>,
    callback: () => Promise<T>
  ): Promise<T> {
    if (!this.db) return callback();
    let waitingLogged = false;
    while (true) {
      const now = Date.now();
      const acquired = await this.repository.acquireConversation(
        conversationId,
        new Date(now + conversationLeaseMs).toISOString(),
        new Date(now).toISOString()
      );
      if (acquired) break;
      if (!waitingLogged) {
        logger.info('ai.queue.waiting', { scope: 'conversation' });
        waitingLogged = true;
      }
      await delay(lockPollMs);
    }
    logger.info('ai.queue.started', { scope: 'conversation' });
    try {
      return await callback();
    } finally {
      await this.repository.releaseConversation(conversationId, utcNow());
    }
  }

  async withGroqRateLimit<T>(
    logger: ReturnType<typeof createLogger>,
    callback: () => Promise<T>
  ): Promise<T> {
    if (this.config.AI_MODE !== 'groq' || !this.config.AI_RATE_LIMIT_GUARD_ENABLED || !this.db) {
      return callback();
    }

    let waitingLogged = false;
    while (true) {
      const now = Date.now();
      const state = await this.repository.acquireProvider(
        'groq',
        new Date(now + providerLeaseMs).toISOString(),
        new Date(now).toISOString()
      );
      if (state.acquired) {
        try {
          const waitMs = intervalRemaining(
            state.lastRequestAt,
            this.config.AI_MIN_REQUEST_INTERVAL_MS
          );
          if (waitMs > 0) {
            waitingLogged = true;
            logger.info('ai.rate_limit.waiting', { provider: 'groq', wait_ms: waitMs });
            await delay(waitMs);
          }
          return await this.executeWithRetry(logger, callback);
        } finally {
          await this.repository.releaseProvider('groq', utcNow());
        }
      }
      if (!waitingLogged) {
        logger.info('ai.rate_limit.waiting', { provider: 'groq', wait_ms: lockPollMs });
        waitingLogged = true;
      }
      await delay(lockPollMs);
    }
  }

  async getInboundBatch(conversationId: string) {
    return this.repository.getInboundBatch(conversationId);
  }

  async markBatchProcessed(
    conversationId: string,
    messages: Array<{
      id: string;
      provider_message_id: string | null;
      content: string;
      created_at: string;
    }>,
    now: string
  ): Promise<void> {
    const last = messages[messages.length - 1];
    if (!last) return;
    await this.repository.markConversationProcessed(conversationId, last, now);
    await this.repository.markWebhookEventsProcessed(
      messages.flatMap((message) =>
        message.provider_message_id ? [message.provider_message_id] : []
      ),
      now
    );
  }

  private async executeWithRetry<T>(
    logger: ReturnType<typeof createLogger>,
    callback: () => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      await this.repository.markProviderRequest('groq', utcNow(), utcNow());
      try {
        const result = await callback();
        if (attempt > 0) logger.info('ai.rate_limit.recovered', { provider: 'groq' });
        return result;
      } catch (cause) {
        const error = toAppError(cause);
        if (error.code !== 'GROQ_RATE_LIMIT' || attempt >= this.config.AI_RATE_LIMIT_MAX_RETRIES) {
          if (error.code === 'GROQ_RATE_LIMIT') {
            logger.error('ai.rate_limit.exhausted', { provider: 'groq', attempts: attempt + 1 });
          }
          throw error;
        }
        const retryAfterMs = retryAfterMilliseconds(error, this.config.AI_MIN_REQUEST_INTERVAL_MS);
        logger.info('ai.rate_limit.retry', {
          provider: 'groq',
          retry_after_ms: retryAfterMs,
          attempt: attempt + 1
        });
        await delay(retryAfterMs);
      }
    }
  }
}

function intervalRemaining(lastRequestAt: string | null, minimumIntervalMs: number): number {
  if (!lastRequestAt) return 0;
  const elapsed = Date.now() - Date.parse(lastRequestAt);
  return Math.max(0, minimumIntervalMs - (Number.isFinite(elapsed) ? elapsed : minimumIntervalMs));
}

function retryAfterMilliseconds(error: AppError, fallbackMs: number): number {
  const retryAfter = error.metadata?.retry_after;
  const seconds = typeof retryAfter === 'number' ? retryAfter : Number(retryAfter);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 + retryMarginMs : fallbackMs;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
