# AI Architecture

The application uses an `AIProvider` abstraction so route and service code do not depend on one model vendor.

Providers:

- `MockAIProvider` returns a validated no-reply decision for safe local and test defaults.
- `OpenAIProvider` exists as a configurable adapter but is not used by webhook capture mode.
- `OpenRouterProvider` calls OpenRouter through native `fetch` and validates the application-level `AIDecision`.

Provider selection is controlled by `AI_MODE`:

- `mock`
- `openai`
- `openrouter`

Default mode remains `mock`.

OpenRouter configuration:

```text
OPENROUTER_API_KEY=<local secret>
OPENROUTER_MODEL=openrouter/free
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
AI_TEMPERATURE=0.4
AI_REQUEST_TIMEOUT_MS=30000
OPENAI_MAX_OUTPUT_TOKENS=800
```

OpenRouter uses `POST /chat/completions` with `Authorization: Bearer <OPENROUTER_API_KEY>`. The project uses native Worker-compatible Web APIs and does not use a heavy SDK.

Structured validation:

- The app requests JSON Schema output through `response_format` when possible.
- If a compatible model rejects structured output, the provider falls back to explicit JSON instructions.
- Every result must parse as JSON and pass the Zod `AIDecision` schema.
- Invalid output returns a safe typed error instead of fabricating missing fields.

Timeouts use `AbortController`. A timeout becomes `AI_REQUEST_TIMEOUT`.

Error mapping:

- `401` or `403`: `OPENROUTER_AUTH_ERROR`
- `429`: `OPENROUTER_RATE_LIMITED`
- `5xx`: `OPENROUTER_UPSTREAM_ERROR`
- Network failure: `OPENROUTER_NETWORK_ERROR`
- Malformed provider JSON: `OPENROUTER_INVALID_RESPONSE`
- Invalid AI decision JSON/schema: `AI_INVALID_RESPONSE`

Safe logging events:

- `ai.request.started`
- `ai.request.completed`
- `ai.request.failed`

Logs include provider, model, request ID, duration, and status when relevant. They do not log API keys or full prompts by default.

Local full-pipeline testing is available through `POST /dev/chat-test` when `APP_ENV=local` and `LOCAL_DEV_ROUTES_ENABLED=true`. With `send_to_whatsapp=false`, the route runs only the AI provider and returns the validated `AIDecision`. With `send_to_whatsapp=true`, it also sends the generated reply through UAZAPI, which still requires `UAZAPI_OUTBOUND_ENABLED=true`.
