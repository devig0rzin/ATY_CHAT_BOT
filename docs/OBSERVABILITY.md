# Observability

Logs are structured JSON and include `request_id` for correlation.

Standard events:

- `request.started`
- `request.completed`
- `request.failed`
- `webhook.received`
- `webhook.duplicate`
- `webhook.captured`
- `database.error`
- `ai.request.started`
- `ai.request.completed`
- `ai.request.failed`
- `uazapi.send.started`
- `uazapi.send.completed`
- `uazapi.send.failed`
- `handoff.requested`
- `handoff.activated`
- `handoff.resolved`

Current capture mode emits webhook capture and error events. Future processing should keep the same event naming style and never log secrets, authorization headers, full phone numbers, or message content by default.
