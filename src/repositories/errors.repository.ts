export class ErrorsRepository {
  constructor(private readonly db?: D1Database) {}
  get configured(): boolean {
    return Boolean(this.db);
  }

  async create(input: {
    requestId: string;
    errorCode: string;
    safeMessage: string;
    now: string;
  }): Promise<void> {
    if (!this.db) return;
    await this.db
      .prepare(
        'INSERT INTO processing_errors (id, request_id, error_code, safe_message, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(crypto.randomUUID(), input.requestId, input.errorCode, input.safeMessage, input.now)
      .run();
  }
}
