# Architecture

ATY WhatsApp AI Agent is designed as a Cloudflare Worker because production must not depend on a developer laptop, a local terminal, or local filesystem state. The Worker receives webhooks, validates them, writes durable state to Cloudflare D1, and later will call AI and messaging providers through adapters.

Text diagram:

```text
WhatsApp -> UAZAPI -> Cloudflare Worker -> D1
                                |          |
                                |          + raw events, contacts, messages, memory, leads, handoffs
                                |
                                + future OpenAI Responses API
                                + future UAZAPI outbound messages
```

The webhook accepts arbitrary JSON, hashes the raw body, logs a structured event, and persists the raw event when `DB` is configured. The validated UAZAPI `messages` payload is normalized by the provider adapter. Local autoreply is explicitly gated by `APP_ENV=local` and `LOCAL_INBOUND_AUTOREPLY_ENABLED`; production remains disabled until that operational switch is intentionally enabled.

Architecture choices:

- Hono keeps HTTP routing small and Worker-native.
- Zod validates runtime boundaries.
- D1 is used directly with repositories to keep SQL transparent and avoid ORM complexity in the foundation phase.
- Services own business workflows; routes stay thin.
- OpenAI and UAZAPI are adapters, so the application is not tightly coupled to one provider implementation.
- Prompts are Markdown source files compiled into TypeScript at build time.
- Memory has raw history, short-term recent messages, and long-term structured memory.
- Human handoff is modeled from day one so AI can be stopped safely.
- Idempotency starts with payload SHA-256 until provider event/message IDs are documented.
- Anti-loop detection is documented but inactive until official UAZAPI payload mapping is validated.
- WhatsApp content is untrusted and cannot control system instructions, secrets, SQL, provider URLs, or admin functions.
