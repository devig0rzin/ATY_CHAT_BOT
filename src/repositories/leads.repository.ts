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
      role?: string | null;
      current_process?: string | null;
      main_pain?: string | null;
      desired_outcome?: string | null;
      volume?: string | null;
      meeting_interest?: boolean | null;
      preferred_meeting_date?: string | null;
      preferred_meeting_time?: string | null;
    },
    now: string
  ): Promise<void> {
    if (!this.db || !Object.values(patch).some(Boolean)) return;
    await this.db
      .prepare(
        `INSERT INTO leads
         (id, contact_id, service_interest, budget_status, urgency, role, current_process, main_pain,
          desired_outcome, volume, meeting_interest, preferred_meeting_date, preferred_meeting_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(contact_id) DO UPDATE SET
          service_interest=COALESCE(excluded.service_interest, leads.service_interest),
          budget_status=COALESCE(excluded.budget_status, leads.budget_status),
          urgency=COALESCE(excluded.urgency, leads.urgency),
          role=COALESCE(excluded.role, leads.role),
          current_process=COALESCE(excluded.current_process, leads.current_process),
          main_pain=COALESCE(excluded.main_pain, leads.main_pain),
          desired_outcome=COALESCE(excluded.desired_outcome, leads.desired_outcome),
          volume=COALESCE(excluded.volume, leads.volume),
          meeting_interest=COALESCE(excluded.meeting_interest, leads.meeting_interest),
          preferred_meeting_date=COALESCE(excluded.preferred_meeting_date, leads.preferred_meeting_date),
          preferred_meeting_time=COALESCE(excluded.preferred_meeting_time, leads.preferred_meeting_time),
          updated_at=excluded.updated_at`
      )
      .bind(
        crypto.randomUUID(),
        contactId,
        patch.service_interest,
        patch.budget_status,
        patch.urgency,
        nonEmpty(patch.role),
        nonEmpty(patch.current_process),
        nonEmpty(patch.main_pain),
        nonEmpty(patch.desired_outcome),
        nonEmpty(patch.volume),
        patch.meeting_interest === null || patch.meeting_interest === undefined
          ? null
          : patch.meeting_interest
            ? 1
            : 0,
        nonEmpty(patch.preferred_meeting_date),
        nonEmpty(patch.preferred_meeting_time),
        now,
        now
      )
      .run();
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  return value?.trim() || null;
}
