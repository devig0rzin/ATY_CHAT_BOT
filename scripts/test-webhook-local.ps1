$ErrorActionPreference = "Stop"

$fixturePath = Join-Path $PSScriptRoot "..\tests\fixtures\uazapi.local-test.json"
$body = Get-Content -LiteralPath $fixturePath -Raw

Invoke-WebRequest `
  -Uri "http://127.0.0.1:8787/webhooks/uazapi" `
  -Method POST `
  -Headers @{ "content-type" = "application/json" } `
  -Body $body `
  -UseBasicParsing |
  Select-Object StatusCode, Content
