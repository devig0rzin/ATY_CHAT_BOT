import { AppError } from '../lib/errors';
import type { WebhookEventRecord } from '../types/database';

export type WebhookClaim =
  | { status: 'claimed'; eventId: string }
  | { status: 'processed'; eventId: string }
  | { status: 'processing'; eventId: string };

interface ExistingWebhookEvent {
  id: string;
  processing_status: 'received' | 'processing' | 'processed' | 'failed';
}

export class WebhookEventsRepository {
  constructor(private readonly db?: D1Database) {}

  get configured(): boolean {
    return Boolean(this.db);
  }

  async claim(record: WebhookEventRecord): Promise<WebhookClaim> {
    if (!this.db) return { status: 'claimed', eventId: record.id };
    try {
      await this.db
        .prepare(
          `INSERT INTO webhook_events
           (id, request_id, provider, provider_event_id, event_type, payload_sha256, payload_json,
            processing_status, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?)`
        )
        .bind(
          record.id,
          record.requestId,
          record.provider,
          record.providerEventId ?? null,
          record.eventType ?? null,
          record.payloadSha256,
          record.payloadJson,
          record.receivedAt
        )
        .run();
      return { status: 'claimed', eventId: record.id };
    } catch (cause) {
      if (isDuplicateError(cause)) return this.claimExisting(record);
      throw new AppError({
        code: 'DATABASE_ERROR',
        httpStatus: 500,
        safeMessage: 'Database operation failed',
        cause
      });
    }
  }

  async markProcessed(eventId: string, now: string): Promise<void> {
    if (!this.db) return;
    await this.db
      .prepare(
        "UPDATE webhook_events SET processing_status = 'processed', processed_at = ?, error_code = NULL WHERE id = ?"
      )
      .bind(now, eventId)
      .run();
  }

  async markFailed(eventId: string, errorCode: string): Promise<void> {
    if (!this.db) return;
    await this.db
      .prepare(
        "UPDATE webhook_events SET processing_status = 'failed', processed_at = NULL, error_code = ? WHERE id = ?"
      )
      .bind(errorCode, eventId)
      .run();
  }

  private async claimExisting(record: WebhookEventRecord): Promise<WebhookClaim> {
    if (!this.db) return { status: 'claimed', eventId: record.id };
    const existing = await this.findExisting(record);
    if (!existing) {
      throw new AppError({
        code: 'DATABASE_ERROR',
        httpStatus: 500,
        safeMessage: 'Webhook event claim failed'
      });
    }

    if (existing.processing_status === 'processed') {
      return { status: 'processed', eventId: existing.id };
    }
    if (existing.processing_status === 'processing') {
      return { status: 'processing', eventId: existing.id };
    }

    const claimed = await this.db
      .prepare(
        "UPDATE webhook_events SET processing_status = 'processing', processed_at = NULL, error_code = NULL WHERE id = ? AND processing_status IN ('received', 'failed')"
      )
      .bind(existing.id)
      .run();
    if (claimed.meta.changes === 1) {
      return { status: 'claimed', eventId: existing.id };
    }

    const refreshed = await this.findExisting(record);
    if (!refreshed) {
      throw new AppError({
        code: 'DATABASE_ERROR',
        httpStatus: 500,
        safeMessage: 'Webhook event claim failed'
      });
    }
    return refreshed.processing_status === 'processed'
      ? { status: 'processed', eventId: refreshed.id }
      : { status: 'processing', eventId: refreshed.id };
  }

  private async findExisting(record: WebhookEventRecord): Promise<ExistingWebhookEvent | null> {
    if (!this.db) return null;
    if (record.providerEventId) {
      return this.db
        .prepare(
          'SELECT id, processing_status FROM webhook_events WHERE provider = ? AND provider_event_id = ? LIMIT 1'
        )
        .bind(record.provider, record.providerEventId)
        .first<ExistingWebhookEvent>();
    }
    return this.db
      .prepare(
        'SELECT id, processing_status FROM webhook_events WHERE provider = ? AND payload_sha256 = ? ORDER BY received_at DESC LIMIT 1'
      )
      .bind(record.provider, record.payloadSha256)
      .first<ExistingWebhookEvent>();
  }
}

function isDuplicateError(cause: unknown): boolean {
  return cause instanceof Error && /unique constraint failed/i.test(cause.message);
}
