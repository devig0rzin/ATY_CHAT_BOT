# Security

Secrets are supplied through Cloudflare Worker environment variables or local `.dev.vars`; they are not committed. `.dev.vars.example` contains placeholders only.

Admin routes require `Authorization: Bearer <ADMIN_API_KEY>`. Keys must not be placed in query strings.

Webhook authentication is configurable because official UAZAPI webhook security is not yet documented. Current modes are `off` for local development and `header` with `X-ATY-Webhook-Secret` for ATY-owned test clients. This does not claim UAZAPI supports that header.

PII includes phone numbers, names, emails, and message content. Logs mask phone numbers and redact message content unless `LOG_MESSAGE_CONTENT=true`.

SQL must be parameterized through D1 prepared statements. Repositories are the only business data access layer.

Incoming WhatsApp content is untrusted. It must never change system prompts, reveal secrets, execute backend operations, build SQL, select arbitrary URLs, or access admin functions.

Provider payloads are untrusted until schema-mapped and validated. UAZAPI normalization is disabled until official documentation and a real payload are supplied.

Dependencies are intentionally small. Run `npm audit` manually when reviewing dependency hygiene; do not treat audit output as a deploy trigger.
