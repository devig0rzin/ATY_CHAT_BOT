# Local Development

Development and troubleshooting should be completed locally before any Git push or Cloudflare deployment.

Install dependencies:

```powershell
npm.cmd install
```

Create `.dev.vars` with safe local values only:

```text
AI_MODE=mock
AI_RECENT_MESSAGE_LIMIT=12
LOG_LEVEL=debug
LOG_MESSAGE_CONTENT=false
UAZAPI_DEBUG_PAYLOAD=true
WEBHOOK_AUTH_MODE=off
ADMIN_API_KEY=local-development-only
```

Start the Worker locally:

```powershell
npm.cmd run dev -- --ip 127.0.0.1 --port 8787
```

Health checks:

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:8787/" -UseBasicParsing
Invoke-WebRequest -Uri "http://127.0.0.1:8787/health" -UseBasicParsing
```

The `/` route may report `environment: "local-safe"` when `AI_MODE` is not `openai`. This is an intentional safe-development label, not a separate static configuration source.

Webhook fixture test:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-webhook-local.ps1
```

Direct `.ps1` execution may be blocked by the local Windows execution policy. The command above bypasses that policy only for this local test process.

The fixture is `LOCAL_TEST_FIXTURE_NOT_REAL_UAZAPI_SCHEMA`. It tests local application behavior only. Real UAZAPI cannot call `127.0.0.1` directly, so the real provider payload must be captured later during a controlled integration test.

Expected local webhook log order when `UAZAPI_DEBUG_PAYLOAD=true`:

```text
uazapi.runtime_env_probe
uazapi.debug_config
uazapi.debug_payload
webhook.captured
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
