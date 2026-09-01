export class ErrorsRepository {
  constructor(private readonly db?: D1Database) {}
  get configured(): boolean {
    return Boolean(this.db);
  }
}
