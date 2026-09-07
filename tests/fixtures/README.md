# Local Webhook Fixtures

`uazapi.local-test.json` is labeled `LOCAL_TEST_FIXTURE_NOT_REAL_UAZAPI_SCHEMA`.

It exists only to exercise local HTTP transport and logging behavior. It is not a provider contract, and the UAZAPI normalizer must not depend on this structure.

`uazapi.real-message.json` documents the validated inbound structure marker
`REAL_UAZAPI_PAYLOAD_STRUCTURE_VALIDATED_2026_09_07`. Its identifying fields are anonymized.
