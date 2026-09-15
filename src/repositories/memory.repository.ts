export interface MemoryRecord {
  summary: string | null;
  facts_json: string | null;
  goals_json: string | null;
  open_loops_json: string | null;
  current_intent: string | null;
}
export class MemoryRepository {
  constructor(private readonly db?: D1Database) {}
  get configured(): boolean {
    return Boolean(this.db);
  }
  async get(contactId: string): Promise<MemoryRecord | undefined> {
    if (!this.db) return undefined;
    return (
      (await this.db
        .prepare(
          'SELECT summary, facts_json, goals_json, open_loops_json, current_intent FROM conversation_memory WHERE contact_id = ?'
        )
        .bind(contactId)
        .first<MemoryRecord>()) ?? undefined
    );
  }
  async merge(
    contactId: string,
    patch: { summary: string | null; facts_to_add: string[]; open_loops: string[] },
    intent: string,
    lastMessageId: string | undefined,
    now: string
  ): Promise<void> {
    if (!this.db) return;
    const previous = await this.get(contactId);
    const facts = unique([...jsonArray(previous?.facts_json), ...patch.facts_to_add]);
    const loops = unique(
      patch.open_loops.length ? patch.open_loops : jsonArray(previous?.open_loops_json)
    );
    await this.db
      .prepare(
        `INSERT INTO conversation_memory (contact_id, summary, facts_json, goals_json, open_loops_json, current_intent, memory_version, last_summarized_message_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(contact_id) DO UPDATE SET summary=excluded.summary, facts_json=excluded.facts_json, open_loops_json=excluded.open_loops_json, current_intent=excluded.current_intent, last_summarized_message_id=excluded.last_summarized_message_id, updated_at=excluded.updated_at, memory_version=conversation_memory.memory_version + 1`
      )
      .bind(
        contactId,
        patch.summary ?? previous?.summary ?? null,
        JSON.stringify(facts),
        previous?.goals_json ?? '[]',
        JSON.stringify(loops),
        intent || (previous?.current_intent ?? null),
        lastMessageId ?? null,
        now
      )
      .run();
  }
}
function jsonArray(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}
function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
