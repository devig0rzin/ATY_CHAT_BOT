export interface ContactRecord {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  segment: string | null;
  ai_enabled: number;
}
export class ContactsRepository {
  constructor(private readonly db?: D1Database) {}
  get configured(): boolean {
    return Boolean(this.db);
  }
  async upsert(input: {
    phone: string;
    name?: string;
    now: string;
  }): Promise<ContactRecord | undefined> {
    if (!this.db) return undefined;
    const existing = await this.db
      .prepare(
        'SELECT id, phone, name, email, company, segment, ai_enabled FROM contacts WHERE phone = ?'
      )
      .bind(input.phone)
      .first<ContactRecord>();
    if (existing) {
      const name = input.name?.trim() || existing.name;
      await this.db
        .prepare('UPDATE contacts SET name = ?, last_seen_at = ?, updated_at = ? WHERE id = ?')
        .bind(name, input.now, input.now, existing.id)
        .run();
      return { ...existing, name };
    }
    const id = crypto.randomUUID();
    const name = input.name?.trim() || null;
    await this.db
      .prepare(
        'INSERT INTO contacts (id, phone, name, email, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(id, input.phone, name, null, input.now, input.now, input.now)
      .run();
    return {
      id,
      phone: input.phone,
      name,
      email: null,
      company: null,
      segment: null,
      ai_enabled: 1
    };
  }
  async setAiEnabled(contactId: string, enabled: boolean, now: string): Promise<void> {
    if (!this.db) return;
    await this.db
      .prepare('UPDATE contacts SET ai_enabled = ?, updated_at = ? WHERE id = ?')
      .bind(enabled ? 1 : 0, now, contactId)
      .run();
  }
  async mergeProfile(
    contactId: string,
    patch: {
      name: string | null;
      email?: string | null;
      company: string | null;
      segment: string | null;
    },
    now: string
  ): Promise<void> {
    if (!this.db) return;
    await this.db
      .prepare(
        'UPDATE contacts SET name = COALESCE(?, name), email = COALESCE(?, email), company = COALESCE(?, company), segment = COALESCE(?, segment), updated_at = ? WHERE id = ?'
      )
      .bind(
        nonEmpty(patch.name),
        nonEmpty(patch.email),
        nonEmpty(patch.company),
        nonEmpty(patch.segment),
        now,
        contactId
      )
      .run();
  }
}
function nonEmpty(value: string | null | undefined): string | null {
  return value?.trim() || null;
}
