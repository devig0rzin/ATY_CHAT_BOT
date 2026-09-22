import type { StoredInboundMessage } from './messages.repository';

interface CoordinationState {
  locked_until: string | null;
  last_processed_created_at: string | null;
  last_processed_message_id: string | null;
}

interface ProviderState {
  last_request_at: string | null;
}

export class AiCoordinationRepository {
  constructor(private readonly db?: D1Database) {}

  get configured(): boolean {
    return Boolean(this.db);
  }

  async acquireConversation(conversationId: string, leaseUntil: string, now: string) {
    if (!this.db) return true;
    await this.db
      .prepare(
        'INSERT OR IGNORE INTO ai_conversation_state (conversation_id, locked_until, updated_at) VALUES (?, NULL, ?)'
      )
      .bind(conversationId, now)
      .run();
    const result = await this.db
      .prepare(
        'UPDATE ai_conversation_state SET locked_until = ?, updated_at = ? WHERE conversation_id = ? AND (locked_until IS NULL OR locked_until <= ?)'
      )
      .bind(leaseUntil, now, conversationId, now)
      .run();
    return result.meta.changes === 1;
  }

  async releaseConversation(conversationId: string, now: string): Promise<void> {
    if (!this.db) return;
    await this.db
      .prepare(
        'UPDATE ai_conversation_state SET locked_until = NULL, updated_at = ? WHERE conversation_id = ?'
      )
      .bind(now, conversationId)
      .run();
  }

  async getInboundBatch(conversationId: string): Promise<StoredInboundMessage[]> {
    if (!this.db) return [];
    const state = await this.db
      .prepare(
        'SELECT locked_until, last_processed_created_at, last_processed_message_id FROM ai_conversation_state WHERE conversation_id = ?'
      )
      .bind(conversationId)
      .first<CoordinationState>();
    const createdAt = state?.last_processed_created_at ?? '';
    const messageId = state?.last_processed_message_id ?? '';
    const result = await this.db
      .prepare(
        `SELECT id, provider_message_id, content, source_type, transcription_status, created_at
         FROM messages
         WHERE conversation_id = ?
           AND direction = 'inbound'
           AND (? = '' OR created_at > ? OR (created_at = ? AND id > ?))
         ORDER BY created_at ASC, id ASC
         LIMIT 50`
      )
      .bind(conversationId, createdAt, createdAt, createdAt, messageId)
      .all<StoredInboundMessage>();
    return result.results;
  }

  async markConversationProcessed(
    conversationId: string,
    message: StoredInboundMessage,
    now: string
  ): Promise<void> {
    if (!this.db) return;
    await this.db
      .prepare(
        `INSERT INTO ai_conversation_state
           (conversation_id, locked_until, last_processed_created_at, last_processed_message_id, updated_at)
         VALUES (?, NULL, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           locked_until = NULL,
           last_processed_created_at = excluded.last_processed_created_at,
           last_processed_message_id = excluded.last_processed_message_id,
           updated_at = excluded.updated_at`
      )
      .bind(conversationId, message.created_at, message.id, now)
      .run();
  }

  async markWebhookEventsProcessed(providerMessageIds: string[], now: string): Promise<void> {
    if (!this.db || providerMessageIds.length === 0) return;
    for (const ids of chunks(providerMessageIds, 40)) {
      const placeholders = ids.map(() => '?').join(', ');
      await this.db
        .prepare(
          `UPDATE webhook_events
           SET processing_status = 'processed', processed_at = ?, error_code = NULL
           WHERE provider = 'uazapi' AND provider_event_id IN (${placeholders})`
        )
        .bind(now, ...ids)
        .run();
    }
  }

  async acquireProvider(provider: string, leaseUntil: string, now: string) {
    if (!this.db) return { acquired: true, lastRequestAt: null };
    await this.db
      .prepare(
        'INSERT OR IGNORE INTO ai_provider_rate_state (provider, locked_until, last_request_at, updated_at) VALUES (?, NULL, NULL, ?)'
      )
      .bind(provider, now)
      .run();
    const result = await this.db
      .prepare(
        'UPDATE ai_provider_rate_state SET locked_until = ?, updated_at = ? WHERE provider = ? AND (locked_until IS NULL OR locked_until <= ?)'
      )
      .bind(leaseUntil, now, provider, now)
      .run();
    if (result.meta.changes !== 1) return { acquired: false, lastRequestAt: null };
    const state = await this.db
      .prepare('SELECT last_request_at FROM ai_provider_rate_state WHERE provider = ?')
      .bind(provider)
      .first<ProviderState>();
    return { acquired: true, lastRequestAt: state?.last_request_at ?? null };
  }

  async markProviderRequest(provider: string, requestAt: string, now: string): Promise<void> {
    if (!this.db) return;
    await this.db
      .prepare(
        'UPDATE ai_provider_rate_state SET last_request_at = ?, updated_at = ? WHERE provider = ?'
      )
      .bind(requestAt, now, provider)
      .run();
  }

  async releaseProvider(provider: string, now: string): Promise<void> {
    if (!this.db) return;
    await this.db
      .prepare(
        'UPDATE ai_provider_rate_state SET locked_until = NULL, updated_at = ? WHERE provider = ?'
      )
      .bind(now, provider)
      .run();
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    result.push(items.slice(index, index + size));
  return result;
}
