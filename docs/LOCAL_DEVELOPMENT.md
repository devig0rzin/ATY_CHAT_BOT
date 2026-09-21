# Local Development

Development and troubleshooting should be completed locally before any Git push or Cloudflare deployment.

Install dependencies:

```powershell
npm.cmd install
```

Create `.env` with safe local values only. This file is local-only and must never be committed:

```text
APP_ENV=local
AI_MODE=openrouter
GEMINI_API_KEY=<LOCAL SECRET WHEN AI_MODE=gemini>
GEMINI_MODEL=gemini-3.7-flash
OPENROUTER_API_KEY=<LOCAL SECRET>
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openrouter/free
AI_TEMPERATURE=0.4
AI_REQUEST_TIMEOUT_MS=30000
AI_RECENT_MESSAGE_LIMIT=12
OPENAI_MAX_OUTPUT_TOKENS=800
UAZAPI_BASE_URL=
UAZAPI_TOKEN=
UAZAPI_OUTBOUND_ENABLED=false
UAZAPI_DEBUG_PAYLOAD=true
UAZAPI_REQUEST_TIMEOUT_MS=30000
TEST_WHATSAPP_NUMBER=
LOCAL_DEV_ROUTES_ENABLED=true
LOG_LEVEL=debug
LOG_MESSAGE_CONTENT=false
WEBHOOK_AUTH_MODE=off
ADMIN_API_KEY=local-development-only
```

Wrangler local development loads `.env`. If `.dev.vars` exists, `.env` is not loaded, so this repo keeps `.dev.vars` ignored only as legacy protection.

Start the Worker locally:

````powershell
npm.cmd run dev -- --ip 127.0.0.1 --port 8787

Local memory test script:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-memory-local.ps1
````

````

Health checks:

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:8787/" -UseBasicParsing
Invoke-WebRequest -Uri "http://127.0.0.1:8787/health" -UseBasicParsing
````

The `/` route may report `environment: "local-safe"` when `AI_MODE` is not `openai`. This is an intentional safe-development label, not a separate static configuration source.

Webhook fixture test:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-webhook-local.ps1
```

Direct `.ps1` execution may be blocked by the local Windows execution policy. The command above bypasses that policy only for this local test process.

The fixture `tests/fixtures/uazapi.real-message.json` preserves the validated UAZAPI
structure with anonymized identifying fields. The marker is
`REAL_UAZAPI_PAYLOAD_STRUCTURE_VALIDATED_2026_09_07`.

Expected local webhook log order when `UAZAPI_DEBUG_PAYLOAD=true`:

```text
uazapi.runtime_env_probe
uazapi.debug_config
uazapi.debug_payload
webhook.captured
uazapi.message.normalized
ai.request.started
ai.request.completed
uazapi.send.started
uazapi.send.completed
```

Wrangler logs are printed in the terminal running `npm.cmd run dev`. Do not paste secrets into local logs.

Run the test suite:

```powershell
npm.cmd run build:prompts
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test
npm.cmd run check
```

## Local OpenRouter AI Test

OpenRouter testing is local-only. The local webhook autoreply remains disabled unless
`LOCAL_INBOUND_AUTOREPLY_ENABLED=true` is explicitly set.

Add these local values to `.env` manually when you want to run the real OpenRouter test:

```text
APP_ENV=local
AI_MODE=openrouter
OPENROUTER_API_KEY=<LOCAL SECRET>
OPENROUTER_MODEL=openrouter/free
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
AI_TEMPERATURE=0.4
AI_REQUEST_TIMEOUT_MS=30000
LOCAL_DEV_ROUTES_ENABLED=true
```

Never commit `.env` and never paste the API key into chat or logs.

To test Gemini locally, set `AI_MODE=gemini` and paste the key only after `GEMINI_API_KEY=` in the project-root `.env` file. Tests use mocked clients and do not call Gemini.

To test the Groq provider locally with mocks, use `AI_MODE=groq`, set `GROQ_API_KEY` only in `.env`, and keep `GROQ_MODEL=openai/gpt-oss-20b`. Never place `GROQ_API_KEY` in `wrangler.jsonc`, Git, fixtures, public vars, or logs. The automated tests do not call Groq.

For the free-tier development guard, use `AI_RATE_LIMIT_GUARD_ENABLED=true`, `AI_MIN_REQUEST_INTERVAL_MS=8000`, `AI_RATE_LIMIT_MAX_RETRIES=1`, and `WHATSAPP_INBOUND_BUFFER_MS=3000`. The guard uses D1-backed locks/state, so it does not depend on Worker-global maps or timers. A 429 is retried at most once, using `Retry-After` when available; a final failure is recorded and sent through the existing technical alert path. These conservative values may be reduced or disabled when using a paid provider.

Run the local Worker:

```powershell
npm.cmd run dev -- --ip 127.0.0.1 --port 8787
```

Run the local AI test:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-ai-local.ps1
```

The default model `openrouter/free` is intended for cheap/free development. OpenRouter may apply rate limits or route to different free model capacity depending on account and provider availability. Change `OPENROUTER_MODEL` in `.env` without changing source code.

`POST /dev/ai-test` is available only when `APP_ENV=local` and `LOCAL_DEV_ROUTES_ENABLED=true`. Otherwise it behaves as not found.

## Local UAZAPI Outbound Test

Real WhatsApp outbound is guarded by `UAZAPI_OUTBOUND_ENABLED=false` by default. To send one local test message, set `UAZAPI_BASE_URL`, `UAZAPI_TOKEN`, `TEST_WHATSAPP_NUMBER`, and explicitly set `UAZAPI_OUTBOUND_ENABLED=true` in `.env`.

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-uazapi-send-local.ps1
```

`POST /dev/uazapi-send-test` is available only when `APP_ENV=local` and `LOCAL_DEV_ROUTES_ENABLED=true`; real sending still refuses with `UAZAPI_OUTBOUND_DISABLED` unless the outbound switch is enabled.

## Local Full Chat Test

Run OpenRouter only:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-chat-local.ps1 -Mode ai
```

Run OpenRouter and then send the generated reply through UAZAPI:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-chat-local.ps1 -Mode whatsapp
```

`POST /dev/chat-test` simulates inbound WhatsApp text locally. It does not connect to `POST /webhooks/uazapi`.
