$ErrorActionPreference = "Stop"

$body = @{
  message = "Ola, quero automatizar o atendimento da minha empresa. O que voces fazem?"
} | ConvertTo-Json

Invoke-WebRequest `
  -Uri "http://127.0.0.1:8787/dev/ai-test" `
  -Method POST `
  -Headers @{ "content-type" = "application/json" } `
  -Body $body `
  -UseBasicParsing |
  Select-Object StatusCode, Content
