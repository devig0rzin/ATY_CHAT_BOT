# UAZAPI

UAZAPI outbound support is local-first and currently limited to text sending. The real inbound webhook remains capture-only until the production UAZAPI payload mapping is finalized.

## Local Configuration

Configure `.env` locally only:

```text
UAZAPI_BASE_URL=
UAZAPI_TOKEN=
UAZAPI_OUTBOUND_ENABLED=false
UAZAPI_DEBUG_PAYLOAD=true
UAZAPI_REQUEST_TIMEOUT_MS=30000
TEST_WHATSAPP_NUMBER=
```

Never commit `.env`. Production Cloudflare secrets will be configured later.

## Text Sending

The provider sends:

```text
POST {UAZAPI_BASE_URL}/send/text
Content-Type: application/json
token: <UAZAPI_TOKEN>
```

Request body:

```json
{
  "number": "5511999999999",
  "text": "Teste local ATY"
}
```

The token header is set internally and must never be printed in logs, API responses, tests, docs, or commits.

## Safety Switch

Real WhatsApp sending requires:

```text
UAZAPI_OUTBOUND_ENABLED=true
```

The default is `false`. When disabled, `sendText()` refuses with `UAZAPI_OUTBOUND_DISABLED`.

## Local Test Routes

`POST /dev/uazapi-send-test` sends a local text test. The request body can omit `number` when `TEST_WHATSAPP_NUMBER` is configured in `.env`.

`POST /dev/chat-test` simulates an inbound message, runs the configured AI provider, validates the `AIDecision`, and optionally sends the generated reply through UAZAPI when `send_to_whatsapp=true`.

Both routes return `404` unless `APP_ENV=local` and `LOCAL_DEV_ROUTES_ENABLED=true`.

## Errors

- `UAZAPI_NOT_CONFIGURED`: missing base URL or token.
- `UAZAPI_OUTBOUND_DISABLED`: safety switch is off.
- `UAZAPI_AUTH_ERROR`: UAZAPI returned `401` or `403`.
- `UAZAPI_RATE_LIMITED`: UAZAPI returned `429`.
- `UAZAPI_UPSTREAM_ERROR`: UAZAPI returned `5xx`.
- `UAZAPI_NETWORK_ERROR`: network request failed.
- `UAZAPI_REQUEST_TIMEOUT`: request timed out.
- `UAZAPI_INVALID_RESPONSE`: malformed JSON or unsupported response.
