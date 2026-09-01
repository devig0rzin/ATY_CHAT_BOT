export class HandoffsRepository {
  constructor(private readonly db?: D1Database) {}
  get configured(): boolean {
    return Boolean(this.db);
  }
}
