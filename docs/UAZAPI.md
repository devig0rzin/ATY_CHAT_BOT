# UAZAPI

UAZAPI outbound support is local-first and limited to text sending. The validated inbound payload is normalized from `EventType=messages` and can feed the local autoreply flow when explicitly enabled.

Audio is detected from `message.type`/`messageType` values `audio`, `ptt`, `myaudio`, `AudioMessage`, or `PttMessage`. Para mensagens sem `fileURL` direto, o resolver usa o identificador de download da mensagem e chama `POST /message/download` com `generate_mp3=true`, `return_base64=false` e `transcribe=false`. A URL retornada é temporária, usada somente em memória e nunca persistida ou registrada.

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

## Validated Inbound Payload

The adapter maps the real UAZAPI structure as follows:

```text
EventType                         -> event
message.messageid (or id)         -> messageId
message.id (or messageid)         -> mediaDownloadId
message.text (or content)         -> text
message.sender_pn (or chatid)     -> phone
message.senderName                -> senderName
message.fromMe                    -> fromMe
message.wasSentByApi              -> wasSentByApi
message.isGroup (or chat flag)    -> isGroup
message.type (or messageType)     -> messageType
message.fileURL                   -> audioMedia.url (when present)
message.content.mimetype          -> audioMedia.mimeType (when present)
message.messageTimestamp          -> timestamp
instanceName                      -> instanceName
owner                             -> owner
```

Only `EventType=messages` is eligible for autoreply. Messages sent by this instance,
sent by the API, group messages, unsupported messages, and empty text are skipped.

The marker for the captured structure is `REAL_UAZAPI_PAYLOAD_STRUCTURE_VALIDATED_2026_09_07`.

When D1 is configured, `message.messageid` is stored as `webhook_events.provider_event_id`
for persistent deduplication. Without D1, the runtime does not create an in-memory global
deduplication cache.

The UAZAPI API uses the message `id` as the canonical `/message/download` identifier when
it is available; the webhook's `messageid` remains the provider event/deduplication ID.

## Errors

- `UAZAPI_NOT_CONFIGURED`: missing base URL or token.
- `UAZAPI_OUTBOUND_DISABLED`: safety switch is off.
- `UAZAPI_AUTH_ERROR`: UAZAPI returned `401` or `403`.
- `UAZAPI_RATE_LIMITED`: UAZAPI returned `429`.
- `UAZAPI_UPSTREAM_ERROR`: UAZAPI returned `5xx`.
- `UAZAPI_NETWORK_ERROR`: network request failed.
- `UAZAPI_REQUEST_TIMEOUT`: request timed out.
- `UAZAPI_INVALID_RESPONSE`: malformed JSON or unsupported response.

## Audio transcription

The Groq transcription adapter is configured with the existing `GROQ_API_KEY`:

```text
GROQ_TRANSCRIPTION_ENABLED=true
GROQ_TRANSCRIPTION_MODEL=whisper-large-v3-turbo
GROQ_TRANSCRIPTION_LANGUAGE=pt
GROQ_TRANSCRIPTION_TIMEOUT_MS=30000
GROQ_TRANSCRIPTION_MAX_BYTES=24000000
```

The webhook first tries an explicit `message.fileURL`; otherwise it resolves the media through
`POST /message/download` and prefers the generated MP3. The adapter then downloads/decodes it
in memory and sends multipart data to Groq Whisper. It never stores binary audio, signed URLs,
tokens, transcripts, or API keys in logs or D1. Supported extensions are `ogg`, `mp3`, `mp4`,
`mpeg`, `mpga`, `m4a`, `wav`, `webm`, and `flac`.
