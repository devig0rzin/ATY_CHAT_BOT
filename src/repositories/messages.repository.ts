export interface StoredMessage {
  direction: string;
  message_type: string | null;
  content: string | null;
  created_at: string;
}

export interface StoredInboundMessage {
  id: string;
  provider_message_id: string | null;
  content: string;
  created_at: string;
}
export class MessagesRepository {
  constructor(private readonly db?: D1Database) {}
  get configured(): boolean {
    return Boolean(this.db);
  }
  async create(input: {
    conversationId: string;
    contactId: string;
    providerMessageId?: string;
    direction: 'inbound' | 'outbound';
    messageType?: string;
    sourceType?: 'text' | 'audio';
    transcriptionProvider?: string;
    transcriptionModel?: string;
    transcriptionStatus?: string;
    content: string;
    aiGenerated?: boolean;
    now: string;
  }): Promise<void> {
    if (!this.db) return;
    await this.db
      .prepare(
        `INSERT INTO messages
         (id, conversation_id, contact_id, provider, provider_message_id, direction, message_type, content,
          ai_generated, created_at, source_type, transcription_provider, transcription_model, transcription_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        input.conversationId,
        input.contactId,
        'uazapi',
        input.providerMessageId ?? null,
        input.direction,
        input.messageType ?? 'text',
        input.content,
        input.aiGenerated ? 1 : 0,
        input.now,
        input.sourceType ?? 'text',
        input.transcriptionProvider ?? null,
        input.transcriptionModel ?? null,
        input.transcriptionStatus ?? null
      )
      .run();
  }
  async updateInboundTranscription(input: {
    providerMessageId?: string;
    content: string;
    provider: string;
    model: string;
    now: string;
  }): Promise<void> {
    if (!this.db || !input.providerMessageId) return;
    await this.db
      .prepare(
        `UPDATE messages SET content = ?, transcription_provider = ?, transcription_model = ?,
         transcription_status = 'completed' WHERE provider = ? AND provider_message_id = ? AND direction = 'inbound'`
      )
      .bind(input.content, input.provider, input.model, input.provider, input.providerMessageId)
      .run();
  }
  async updateTranscriptionStatus(
    providerMessageId: string | undefined,
    status: string
  ): Promise<void> {
    if (!this.db || !providerMessageId) return;
    await this.db
      .prepare(
        "UPDATE messages SET transcription_status = ? WHERE provider = ? AND provider_message_id = ? AND direction = 'inbound'"
      )
      .bind(status, 'uazapi', providerMessageId)
      .run();
  }
  async recent(conversationId: string, limit: number): Promise<StoredMessage[]> {
    if (!this.db) return [];
    const result = await this.db
      .prepare(
        'SELECT direction, message_type, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?'
      )
      .bind(conversationId, limit)
      .all<StoredMessage>();
    return result.results.reverse();
  }
}
