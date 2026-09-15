export interface ConversationRecord {
  id: string;
  contact_id: string;
  status: string;
}
export class ConversationsRepository {
  constructor(private readonly db?: D1Database) {}
  get configured(): boolean {
    return Boolean(this.db);
  }
  async getOrCreate(
    contactId: string,
    instanceName: string | undefined,
    now: string
  ): Promise<ConversationRecord | undefined> {
    if (!this.db) return undefined;
    const existing = await this.db
      .prepare(
        "SELECT id, contact_id, status FROM conversations WHERE contact_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1"
      )
      .bind(contactId)
      .first<ConversationRecord>();
    if (existing) {
      await this.touch(existing.id, now);
      return existing;
    }
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        'INSERT INTO conversations (id, contact_id, provider, provider_instance_id, status, started_at, last_message_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(id, contactId, 'uazapi', instanceName ?? null, 'open', now, now, now, now)
      .run();
    return { id, contact_id: contactId, status: 'open' };
  }
  async touch(id: string, now: string): Promise<void> {
    if (this.db)
      await this.db
        .prepare('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?')
        .bind(now, now, id)
        .run();
  }
}
