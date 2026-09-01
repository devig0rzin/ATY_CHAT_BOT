# UAZAPI Integration Pending

The application does not implement real UAZAPI HTTP endpoints yet because official documentation was not supplied.

Required information:

- Base URL
- Authentication method
- Token header
- Instance identifier
- Send text endpoint
- Send image endpoint
- Webhook event schema
- Inbound message payload
- Field that identifies messages sent by the bot itself
- Provider message ID
- Phone or JID format
- Delivery and read events
- Retry behavior
- Webhook authentication or signature capabilities

Anti-loop status:

```text
ANTI-LOOP IS NOT ACTIVE UNTIL UAZAPI PAYLOAD MAPPING IS VALIDATED.
```

Webhook capture mode stores the raw event and payload SHA-256 only. Normalization and outbound messaging must wait for official documentation and one real webhook payload.
