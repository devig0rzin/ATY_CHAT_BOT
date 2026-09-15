export class LeadsRepository {
  constructor(private readonly db?: D1Database) {}
  get configured(): boolean {
    return Boolean(this.db);
  }
  async merge(
    contactId: string,
    patch: {
      service_interest: string | null;
      budget_status: string | null;
      urgency: string | null;
    },
    now: string
  ): Promise<void> {
    if (!this.db || !Object.values(patch).some(Boolean)) return;
    await this.db
      .prepare(
        `INSERT INTO leads (id, contact_id, service_interest, budget_status, urgency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(contact_id) DO UPDATE SET service_interest=COALESCE(excluded.service_interest, leads.service_interest), budget_status=COALESCE(excluded.budget_status, leads.budget_status), urgency=COALESCE(excluded.urgency, leads.urgency), updated_at=excluded.updated_at`
      )
      .bind(
        crypto.randomUUID(),
        contactId,
        patch.service_interest,
        patch.budget_status,
        patch.urgency,
        now,
        now
      )
      .run();
  }
}
