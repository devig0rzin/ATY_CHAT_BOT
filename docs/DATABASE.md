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

Local migrations:

```bash
npm run db:migrate:local
```

Remote migrations, only when explicitly intended:

```bash
npm run db:migrate:remote
```

Secrets, bearer values, and API keys must never be stored in D1.
