import { AppError } from '../lib/errors';
import type { WebhookEventRecord } from '../types/database';

export class WebhookEventsRepository {
  constructor(private readonly db?: D1Database) {}

  get configured(): boolean {
    return Boolean(this.db);
  }

  async findByPayloadSha256(payloadSha256: string): Promise<boolean> {
    if (!this.db) return false;
    const result = await this.db
      .prepare('SELECT id FROM webhook_events WHERE payload_sha256 = ? LIMIT 1')
      .bind(payloadSha256)
      .first<{ id: string }>();
    return Boolean(result);
  }

  async findByProviderEventId(provider: 'uazapi', providerEventId: string): Promise<boolean> {
    if (!this.db) return false;
    const result = await this.db
      .prepare('SELECT id FROM webhook_events WHERE provider = ? AND provider_event_id = ? LIMIT 1')
      .bind(provider, providerEventId)
      .first<{ id: string }>();
    return Boolean(result);
  }

  async create(record: WebhookEventRecord): Promise<void> {
    if (!this.db) return;
    try {
      await this.db
        .prepare(
          `INSERT INTO webhook_events
           (id, request_id, provider, provider_event_id, event_type, payload_sha256, payload_json,
            processing_status, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?)`
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
    } catch (cause) {
      throw new AppError({
        code: 'DATABASE_ERROR',
        httpStatus: 500,
        safeMessage: 'Database operation failed',
        cause
      });
    }
  }
}
