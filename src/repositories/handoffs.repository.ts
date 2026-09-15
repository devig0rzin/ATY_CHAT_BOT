export class HandoffsRepository {
  constructor(private readonly db?: D1Database) {}
  get configured(): boolean {
    return Boolean(this.db);
  }
  async hasBlocking(contactId: string): Promise<boolean> {
    if (!this.db) return false;
    return Boolean(
      await this.db
        .prepare(
          "SELECT id FROM handoffs WHERE contact_id = ? AND status IN ('requested', 'active') LIMIT 1"
        )
        .bind(contactId)
        .first()
    );
  }
  async request(
    contactId: string,
    conversationId: string,
    reason: string | null,
    now: string
  ): Promise<void> {
    if (this.db)
      await this.db
        .prepare(
          "INSERT INTO handoffs (id, contact_id, conversation_id, status, reason, requested_at) VALUES (?, ?, ?, 'requested', ?, ?)"
        )
        .bind(crypto.randomUUID(), contactId, conversationId, reason, now)
        .run();
  }
  async setStatus(contactId: string, status: 'active' | 'resolved', now: string): Promise<void> {
    if (!this.db) return;
    const field = status === 'active' ? 'accepted_at' : 'resolved_at';
    await this.db
      .prepare(
        `UPDATE handoffs SET status = ?, ${field} = ? WHERE id = (SELECT id FROM handoffs WHERE contact_id = ? AND status IN ('requested', 'active') ORDER BY requested_at DESC LIMIT 1)`
      )
      .bind(status, now, contactId)
      .run();
  }
}
