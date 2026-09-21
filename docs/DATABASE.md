# Database

Cloudflare D1 is the production database target. The desired binding is `DB`; the desired database name is `aty-whatsapp-agent-db`.

No production D1 database UUID is included. Create the real database later:

```bash
wrangler d1 create aty-whatsapp-agent-db
```

Then add the returned database ID to `wrangler.jsonc` under a `d1_databases` binding named `DB`.

Migrations:

- `0001_initial_schema.sql` creates contacts, conversations, messages, conversation memory, leads, handoffs, webhook events, outbound messages, and processing errors.
- `0002_indexes.sql` adds lookup and idempotency indexes.
- `0003_persistent_conversation_indexes.sql` adds persistent conversation lookup indexes.
- `0004_ai_coordination.sql` adds D1-backed AI conversation locks, batch cursors, and provider rate-limit state.

Local migrations:

```bash
npm run db:migrate:local
```

Local development notes:

- The D1 binding name expected by the application is `DB` and the database name is `aty-whatsapp-agent-db` (see `wrangler.jsonc`).
- Use the provided npm scripts when working locally:

```bash
npm run dev:local        # Run wrangler in local mode for development
npm run db:migrate:local # Apply migrations to the local D1 database
npm run db:migrate:apply:local # Alias for db:migrate:local
```

Do not run remote migrations or create remote databases unless explicitly intended for production.

Remote migrations, only when explicitly intended:

```bash
npm run db:migrate:remote
```

Secrets, bearer values, and API keys must never be stored in D1.

`webhook_events.payload_json` is retained for webhook audit and deduplication diagnostics.
It can contain personal data from the provider payload, so normal logs must not print it and
its retention period should be defined before enabling production D1 traffic.
The `0004_ai_coordination.sql` migration adds only coordination state for the development AI guard: a persistent conversation lock/batch cursor and a provider rate-limit lock/timestamp. Inbound messages remain individually stored in `messages`, and webhook deduplication remains in `webhook_events`.
