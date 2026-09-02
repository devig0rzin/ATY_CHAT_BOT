# ATY WhatsApp AI Agent

Production foundation for the official Automation To You (ATY) WhatsApp AI Assistant.

This backend is designed for Cloudflare Workers, Cloudflare D1, UAZAPI webhooks, and a future OpenAI Responses API integration. It is currently in safe capture mode.

```text
WhatsApp
  -> UAZAPI
  -> Cloudflare Worker: aty-whatsapp-agent
  -> Cloudflare D1: contacts, conversations, messages, memory, leads, handoffs, raw webhook events
  -> future OpenAI provider
  -> future UAZAPI outbound messages
```

Prerequisites:

- Node.js
- npm
- Git
- Wrangler, installed locally through project dependencies

Setup:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run build:prompts
npm run dev
```

Local-first troubleshooting is documented in `docs/LOCAL_DEVELOPMENT.md`.

Health check:

```bash
curl http://127.0.0.1:8787/health
```

Webhook capture mode:

```bash
curl -X POST http://127.0.0.1:8787/webhooks/uazapi \
  -H "content-type: application/json" \
  -d "{\"sample\":true}"
```

Admin status requires:

```text
Authorization: Bearer <ADMIN_API_KEY>
```

Scripts:

- `npm run build:prompts`
- `npm run typecheck`
- `npm run lint`
- `npm run format`
- `npm run format:check`
- `npm run test`
- `npm run test:coverage`
- `npm run check`
- `npm run dev`
- `npm run deploy`
- `npm run db:migrate:local`
- `npm run db:migrate:remote`

D1:

No production D1 database UUID is committed. Create it later:

```bash
wrangler d1 create aty-whatsapp-agent-db
```

Then add the returned ID to the `DB` binding in `wrangler.jsonc`.

OpenAI:

Default local mode is `AI_MODE=mock`, which prevents accidental spending and keeps tests offline. `AI_MODE=openai` requires `OPENAI_API_KEY`. The provider is configurable through `OPENAI_MODEL`; the example uses `gpt-5-nano` as a cost-sensitive text model, and it can be replaced.

UAZAPI:

No UAZAPI endpoint or payload fields are invented. The webhook accepts arbitrary JSON in capture mode only. See `docs/UAZAPI_INTEGRATION_PENDING.md`.

Cloudflare Worker:

- Name: `aty-whatsapp-agent`
- Production URL: `https://aty-whatsapp-agent.igor-ameidaalves7.workers.dev`

Deployment principle:

Do not deploy, run remote migrations, configure production secrets, call OpenAI, or send WhatsApp messages until explicitly instructed.

GitHub and Cloudflare CI strategy:

Keep this repository as the source of truth. Later, connect the existing Cloudflare Worker to GitHub through Cloudflare Worker settings and let builds run `npm run check` before deployment.
