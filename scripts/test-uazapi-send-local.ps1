$ErrorActionPreference = "Stop"

$body = @{
  text = "ATY Chat Bot - teste local UAZAPI funcionando."
} | ConvertTo-Json

Invoke-WebRequest `
  -Uri "http://127.0.0.1:8787/dev/uazapi-send-test" `
  -Method POST `
  -Headers @{ "content-type" = "application/json" } `
  -Body $body `
  -UseBasicParsing |
  Select-Object StatusCode, Content
