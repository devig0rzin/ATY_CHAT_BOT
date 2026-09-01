# Operations

When investigating any issue, collect the `request_id`, route, timestamp, Worker logs, and whether `DB` was configured.

Worker returns 500:
Check `request.failed`, environment validation errors, and whether required variables are missing for the active mode.

Webhook arrives twice:
Check `payload_sha256`, future provider event IDs, and `webhook.duplicate` logs. Duplicate events must acknowledge safely and never generate duplicate replies.

OpenAI unavailable:
Current capture mode does not call OpenAI. Future AI failures should log `ai.request.failed`, avoid sending malformed content, and fall back safely.

UAZAPI unavailable:
Current outbound methods throw `UAZAPI_NOT_CONFIGURED`. Future send failures should log `uazapi.send.failed` and update outbound message attempt state.

DB unavailable:
Capture mode returns success with `database_configured: false` during local bootstrap. Production should configure D1 before webhook traffic is enabled.

AI responding while human is talking:
Check `contact.ai_enabled`, handoff status, and anti-loop mapping. Anti-loop is not active until UAZAPI payload mapping is validated.

Duplicate response:
Check webhook idempotency, outbound message records, provider message IDs, and whether retries were acknowledged.

Secrets missing:
Check Cloudflare Worker variables and local `.dev.vars`. Never print secret values.

Migration failure:
Review the failing migration number, D1 database binding, SQL error, and whether the command was local or remote.
